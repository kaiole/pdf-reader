import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CACHE_VERSION, nowIso, writeCatalog } from "../src/core";
import { boundedToolResult, parseCommandWords, registerPdfTools } from "../src/tools";

function mockPi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	let active = ["read", "unrelated_extension_tool"];
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); active.push(definition.name); },
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getActiveTools() { return [...active]; },
		setActiveTools(names: string[]) { active = [...names]; },
		getAllTools() { return [...tools.values()]; },
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	} as any;
	const ctx = { cwd: process.cwd(), hasUI: true, ui: { notify(message: string, level: string) { notifications.push({ message, level }); } } };
	return { pi, tools, commands, handlers, ctx, notifications, active: () => active };
}

test("registers compatibility surface but starts with exactly four active PDF tools", async () => {
	const mock = mockPi();
	registerPdfTools(mock.pi);
	assert.equal(mock.tools.size, 14);
	assert.deepEqual([...mock.commands.keys()].sort(), ["pdf-index", "pdf-tools"]);
	for (const handler of mock.handlers.get("session_start") ?? []) await handler({}, mock.ctx);
	const activePdf = mock.active().filter((name) => name.startsWith("pdf_"));
	assert.deepEqual(activePdf.sort(), ["pdf_inspect", "pdf_read", "pdf_render", "pdf_search"]);
	assert.ok(mock.active().includes("read"));
	assert.ok(mock.active().includes("unrelated_extension_tool"));
	for (const name of ["pdf_library_scan", "pdf_info", "pdf_outline", "pdf_resolve_reference", "pdf_extract", "pdf_index_build", "pdf_index_update", "pdf_render_page", "pdf_ocr", "pdf_extract_images"]) {
		assert.equal(typeof mock.tools.get(name)?.execute, "function", `${name} remains registered and callable`);
		assert.equal(mock.tools.get(name)?.promptSnippet, undefined, `${name} has no lazy prompt snippet`);
		assert.equal(mock.tools.get(name)?.promptGuidelines, undefined, `${name} has no lazy prompt guidelines`);
	}
});

test("pdf-tools lazily enables and disables optional tools without touching unrelated tools", async () => {
	const mock = mockPi();
	registerPdfTools(mock.pi);
	for (const handler of mock.handlers.get("session_start") ?? []) await handler({}, mock.ctx);
	const command = mock.commands.get("pdf-tools");
	await command.handler("enable ocr", mock.ctx);
	assert.ok(mock.active().includes("pdf_ocr"));
	assert.ok(mock.active().includes("unrelated_extension_tool"));
	await command.handler("enable images", mock.ctx);
	assert.ok(mock.active().includes("pdf_extract_images"));
	await command.handler("disable all", mock.ctx);
	assert.ok(!mock.active().includes("pdf_ocr"));
	assert.ok(!mock.active().includes("pdf_extract_images"));
	assert.ok(mock.active().includes("unrelated_extension_tool"));
	await command.handler("enable unknown", mock.ctx);
	assert.match(mock.notifications.at(-1)?.message ?? "", /Usage:/);
});

test("pdf-index parses status and rejects unknown operations without model output", async () => {
	const mock = mockPi();
	registerPdfTools(mock.pi);
	const command = mock.commands.get("pdf-index");
	await command.handler("status", mock.ctx);
	assert.match(mock.notifications.at(-1)?.message ?? "", /PDF index:/);
	await command.handler("explode", mock.ctx);
	assert.match(mock.notifications.at(-1)?.message ?? "", /Usage:/);
});

test("common bounding preserves underlying truncation metadata and guidance", () => {
	const result = boundedToolResult("already shortened", { truncated: true, omittedChars: 42, truncationGuidance: "Continue with pages 3-4." });
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.truncationGuidance, "Continue with pages 3-4.");
	assert.equal((result.details as any).omittedChars, 42);
});

test("common bounding accounts for JSON escaping in the complete result", () => {
	for (const text of ["\\".repeat(35_000), '"'.repeat(35_000), "\t".repeat(35_000)]) {
		const result = boundedToolResult(text, {});
		assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 50_000);
		assert.ok(result.content[0]!.text.split("\n").length <= 2_000);
		assert.equal(result.details.truncated, true);
	}
});

test("command parsing supports quoted and escaped library roots", () => {
	assert.deepEqual(parseCommandWords('update "/tmp/library with spaces"'), ["update", "/tmp/library with spaces"]);
	assert.deepEqual(parseCommandWords("build /tmp/library\\ with\\ spaces"), ["build", "/tmp/library with spaces"]);
	assert.throws(() => parseCommandWords('update "/tmp/unclosed'), /Unterminated/);
});

test("headless commands emit concise stdout", async () => {
	const mock = mockPi();
	registerPdfTools(mock.pi);
	const output: string[] = [];
	const original = console.log;
	console.log = (message?: unknown) => { output.push(String(message)); };
	try { await mock.commands.get("pdf-tools").handler("list", { ...mock.ctx, hasUI: false }); }
	finally { console.log = original; }
	assert.match(output.join("\n"), /Optional PDF tools:/);
});

test("pdf-index status never counts missing stale catalog paths as indexed", async () => {
	const oldCache = process.env.XDG_CACHE_HOME;
	const root = await mkdtemp(join(tmpdir(), "pi-pdf-status-root-"));
	const cache = await mkdtemp(join(tmpdir(), "pi-pdf-status-cache-"));
	process.env.XDG_CACHE_HOME = cache;
	try {
		await writeCatalog({ version: CACHE_VERSION, root, generatedAt: nowIso(), documents: [{ id: "missing", path: join(root, "missing.pdf"), pages: 1, sizeBytes: 1, mtimeMs: 1, encrypted: false, hasOutline: false, textQuality: "good", indexed: true, sha256: "stale" }] });
		const mock = mockPi();
		registerPdfTools(mock.pi);
		await mock.commands.get("pdf-index").handler(`status ${JSON.stringify(root)}`, mock.ctx);
		assert.match(mock.notifications.at(-1)?.message ?? "", /0\/1 fully indexed/);
		assert.match(mock.notifications.at(-1)?.message ?? "", /missing 1/);
	} finally {
		if (oldCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = oldCache;
	}
});

test("inspect defaults to no outline and read rejects pages plus section", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pdf-tools-"));
	const path = join(dir, "fixture.pdf");
	await writeFile(path, "fixture");
	const mock = mockPi();
	let outlineCalls = 0;
	mock.pi.exec = async (command: string, args: string[]) => {
		if (command === "pdfinfo") return { stdout: "Pages: 1\nEncrypted: no\n", stderr: "", code: 0 };
		if (command === "pdftotext") return { stdout: "readable fixture text", stderr: "", code: 0 };
		if (command === "qpdf") {
			if (args.includes("--json-key=outlines")) outlineCalls++;
			return { stdout: args.includes("--json-key=pagelabels") ? '{"pagelabels":[]}' : '{"outlines":[]}', stderr: "", code: 0 };
		}
		throw new Error(`unexpected command ${command}`);
	};
	registerPdfTools(mock.pi);
	const inspect = mock.tools.get("pdf_inspect");
	const inspected = await inspect.execute("id", { path }, undefined, undefined, mock.ctx);
	assert.equal(outlineCalls, 0);
	assert.equal(inspected.details.outlineIncluded, false);
	assert.match(inspect.parameters.properties.includeOutline.description, /Defaults to false/);
	await assert.rejects(mock.tools.get("pdf_read").execute("id", { path, pages: "1", section: "intro" }, undefined, undefined, mock.ctx), /either pages or section/);
});

test("model-facing remediation never names the inactive index tool", async () => {
	const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/core.ts", import.meta.url), "utf8"));
	assert.doesNotMatch(source, /run pdf_index_update/);
	assert.match(source, /run \/pdf-index update/);
});
