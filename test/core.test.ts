import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { documentId, findPdfs, formatExtractedPages, formatSearchResults, getOutline, indexOnePdf, parseOutlineNode, parsePageLabels, parsePageSpec, readCachedPages, hasFreshPageCache, resolveReferenceInternal, runCommand, truncateToolText } from "../src/core";
import { boundedToolResult } from "../src/tools";

test("page specs reject pathological, excessive, and out-of-range ranges", () => {
  assert.throws(() => parsePageSpec("1-999999999", 10), /Pathological/);
  assert.throws(() => parsePageSpec("1-101", 200), /maximum of 100/);
  assert.throws(() => parsePageSpec("11", 10), /outside the valid range/);
  assert.deepEqual(parsePageSpec("3-1,5", 10), [1, 2, 3, 5]);
  assert.deepEqual(parsePageSpec("8-12", 10), [8, 9, 10]);
});

test("qpdf page labels map roman front matter and decimal body", () => {
  const labels = parsePageLabels({ pagelabels: [
    { index: 0, label: { "/S": "/r", "/St": 1 } },
    { index: 2, label: { "/S": "/D", "/St": 1 } }
  ] }, 5);
  assert.deepEqual(labels, [
    { page: 1, label: "i" }, { page: 2, label: "ii" },
    { page: 3, label: "1" }, { page: 4, label: "2" }, { page: 5, label: "3" }
  ]);
  assert.deepEqual(parsePageLabels({ pagelabels: [
    { index: 0, label: { "/S": "/r", "/P": "u:front-" } },
    { index: 1, label: { "/S": "/D", "/P": "b:4170702d" } }
  ] }, 2), [{ page: 1, label: "front-i" }, { page: 2, label: "App-1" }]);
});

test("reference resolution distinguishes explicit PDF pages from labels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-pdf-ref-"));
  const path = join(dir, "fixture.pdf");
  await writeFile(path, "generated fixture");
  const pi = { exec: async (command: string) => {
    if (command === "pdfinfo") return { stdout: "Pages: 5\nEncrypted: no\n", stderr: "", code: 0 };
    if (command === "qpdf") return { stdout: JSON.stringify({ pagelabels: [{ index: 0, label: { "/S": "/r" } }, { index: 2, label: { "/S": "/D" } }] }), stderr: "", code: 0 };
    throw new Error(`unexpected command ${command}`);
  } } as any;
  assert.deepEqual(await resolveReferenceInternal(pi, path, "PDF page 4"), { pages: "4", confidence: "high", method: "heuristic", notes: "Explicit PDF page number." });
  const labeled = await resolveReferenceInternal(pi, path, "printed page ii");
  assert.equal(labeled.pages, "2");
  assert.equal(labeled.method, "page-label");
  assert.equal(labeled.confidence, "high");
  assert.equal((await resolveReferenceInternal(pi, path, "page ii")).confidence, "low");
  await assert.rejects(resolveReferenceInternal(pi, path, "PDF page 6"), /outside the valid range/);
});

test("tool text respects Pi byte and line limits with continuation guidance", () => {
  const result = truncateToolText(Array.from({ length: 3000 }, () => "x".repeat(100)).join("\n"));
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 50_000);
  assert.ok(result.text.split("\n").length <= 2000);
  assert.match(result.text, /narrower page range|continue/);
  const lineBoundary = truncateToolText(Array.from({ length: 3000 }, () => "x").join("\n"), 48_000);
  assert.equal(lineBoundary.text.split("\n").length, 2000);
  assert.ok(Buffer.byteLength(lineBoundary.text) <= 50_000);
  const unicodeBoundary = truncateToolText("🧪".repeat(30_000), 48_000);
  assert.ok(Buffer.byteLength(unicodeBoundary.text) <= 50_000);
  assert.ok(!unicodeBoundary.text.includes("�"));
});

test("subprocess diagnostics and complete tool responses are bounded", async () => {
  const pi = { exec: async () => ({ stdout: "", stderr: "E".repeat(100_000), code: 1 }) } as any;
  await assert.rejects(runCommand(pi, "qpdf", []), (error: any) => Buffer.byteLength(error.message) < 5_000 && /diagnostic truncated/.test(error.message));
  const result = boundedToolResult("line\n".repeat(20_000), { title: "T".repeat(100_000), rows: Array.from({ length: 1_000 }, (_, i) => ({ i, text: "X".repeat(2_000) })) }, "Narrow the query; pagination is unavailable.");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 50_000);
  assert.ok(result.content[0].text.split("\n").length <= 2_000);
  assert.match(String(result.details.truncationGuidance), /Narrow/);
});

test("outline distinguishes valid empty data from qpdf and JSON failures", async () => {
  const ok = { exec: async () => ({ stdout: '{"outlines":[]}', stderr: "", code: 0 }) } as any;
  assert.deepEqual(await getOutline(ok, "empty.pdf"), []);
  const malformed = { exec: async () => ({ stdout: "not-json", stderr: "", code: 0 }) } as any;
  await assert.rejects(getOutline(malformed, "bad.pdf"), /malformed outline JSON/);
  const failed = { exec: async () => ({ stdout: "", stderr: "broken pdf", code: 2 }) } as any;
  await assert.rejects(getOutline(failed, "bad.pdf"), /qpdf failed: broken pdf/);
});

test("production formatters retain page citations", () => {
  assert.match(formatExtractedPages("book.pdf", [{ page: 2, text: "evidence", quality: "good" }], "layout"), /book\.pdf :: PDF page 2/);
  assert.match(formatSearchResults("needle", [{ path: "book.pdf", page: 3, snippet: "needle" }], 1, 0), /book\.pdf :: PDF page 3/);
});

test("missing library root is an explicit failure and valid empty root is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-pdf-test-"));
  assert.deepEqual(await findPdfs(dir), []);
  await assert.rejects(findPdfs(join(dir, "missing")), /missing or unreadable/);
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "nested", "fixture.pdf"), "generated non-private fixture");
  assert.deepEqual(await findPdfs(dir), [join(dir, "nested", "fixture.pdf")]);
});

test("qpdf outline nodes retain nested PDF destinations", () => {
  assert.deepEqual(parseOutlineNode({ title: "Chapter", destpageposfrom1: 3, kids: [{ title: "Section", destpageposfrom1: 4 }] }, 1, 3), {
    title: "Chapter", page: 3, depth: 1, children: [{ title: "Section", page: 4, depth: 2 }]
  });
});

test("concurrent production indexing serializes publication into complete generations", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-pdf-index-"));
  const oldCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = home;
  try {
    const path = join(home, "source.pdf");
    await writeFile(path, "stable source");
    let extraction = 0;
    const pi = { exec: async (command: string) => {
      if (command === "pdfinfo") return { stdout: "Pages: 1\nEncrypted: no\n", stderr: "", code: 0 };
      if (command === "qpdf") return { stdout: '{"outlines":[]}', stderr: "", code: 0 };
      if (command === "pdftotext") {
        const value = ++extraction;
        await new Promise((resolve) => setTimeout(resolve, value === 1 ? 20 : 1));
        return { stdout: `generation-${value}\f`, stderr: "", code: 0 };
      }
      throw new Error(`unexpected ${command}`);
    } } as any;
    await Promise.all([indexOnePdf(pi, path, false), indexOnePdf(pi, path, false)]);
    const pages = await readCachedPages(await documentId(path));
    assert.equal(pages?.length, 1);
    assert.match(pages?.[0]?.text ?? "", /^generation-[12]$/);
  } finally {
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = oldCache;
  }
});

test("cache manifest selects one immutable generation and verifies fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pdf-cache-"));
  const pagesDir = join(root, "pages");
  await mkdir(pagesDir);
  const source = join(root, "source.pdf");
  await writeFile(source, "AAAA");
  const sourceStat = await import("node:fs/promises").then(({ stat }) => stat(source));
  const { createHash } = await import("node:crypto");
  const fingerprint = createHash("sha256").update("AAAA").digest("hex");
  await writeFile(join(pagesDir, "doc.old.jsonl"), '{"page":1,"text":"old"}\n');
  await writeFile(join(pagesDir, "doc.new.jsonl"), '{"page":1,"text":"new"}\n');
  const metadata = { version: 2, path: source, pages: 1, sizeBytes: sourceStat.size, mtimeMs: sourceStat.mtimeMs, indexedAt: new Date().toISOString(), fingerprint, dataFile: "doc.old.jsonl" };
  await writeFile(join(pagesDir, "doc.meta.json"), JSON.stringify(metadata));
  assert.equal((await readCachedPages("doc", root))?.[0]?.text, "old");
  assert.equal(await hasFreshPageCache("doc", sourceStat, undefined, root), true);
  await writeFile(join(pagesDir, "doc.meta.json"), JSON.stringify({ ...metadata, dataFile: "doc.new.jsonl" }));
  assert.equal((await readCachedPages("doc", root))?.[0]?.text, "new");
  await writeFile(source, "BBBB");
  const changedStat = await import("node:fs/promises").then(({ stat }) => stat(source));
  assert.equal(await hasFreshPageCache("doc", { size: changedStat.size, mtimeMs: sourceStat.mtimeMs }, undefined, root), false);
});

test("unresolved references stay inside short PDFs and preserve PDF citations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-pdf-short-"));
  const path = join(dir, "fixture.pdf");
  await writeFile(path, "fixture");
  const pi = { exec: async (command: string) => {
    if (command === "pdfinfo") return { stdout: "Pages: 3\nEncrypted: no\n", stderr: "", code: 0 };
    if (command === "qpdf") return { stdout: "{}", stderr: "", code: 0 };
    if (command === "pdftotext") return { stdout: "", stderr: "", code: 0 };
    throw new Error(`unexpected command ${command}`);
  } } as any;
  const result = await resolveReferenceInternal(pi, path, "not present");
  assert.equal(result.pages, "1-3");
  assert.match(`--- ${path} :: PDF page 2 ---`, /:: PDF page 2/);
});
