import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export * from "./constants";
export * from "./types";

import {
	CACHE_VERSION,
	DEFAULT_EXTRACT_MAX_CHARS,
	HARD_EXTRACT_MAX_CHARS,
	MAX_PAGES_PER_OPERATION,
	PDF_TEXT_CHUNK_SIZE,
	SEARCH_PAGE_MATCH_LIMIT,
} from "./constants";
import { hasFreshSqliteDocument, replaceSqliteDocument, searchSqliteIndex, sqliteDocumentStates } from "./index-db";

import type {
	CachedPage,
	Catalog,
	CatalogDocument,
	FlatOutlineEntry,
	OutlineEntry,
	PageLabel,
	PageCacheMetadata,
	PdfInfo,
	ResolvedReference,
	SearchResult,
	TextQuality,
} from "./types";

export function nowIso(): string {
	return new Date().toISOString();
}

export function home(): string {
	return process.env.HOME || homedir();
}

export function expandHome(input: string): string {
	if (input === "~") return home();
	if (input.startsWith("~/")) return join(home(), input.slice(2));
	return input;
}

export function stripAtPrefix(input: string): string {
	return input.startsWith("@") ? input.slice(1) : input;
}

export function resolveUserPath(input: string, cwd: string): string {
	const cleaned = expandHome(stripAtPrefix(input.trim()));
	return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

export function cacheRoot(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	return xdg ? join(xdg, "pi-pdf") : join(home(), ".cache", "pi-pdf");
}

export function catalogPath(root = cacheRoot()): string {
	return join(root, "catalog.json");
}

export function pageCachePath(docId: string, root = cacheRoot()): string {
	return join(root, "pages", `${docId}.jsonl`);
}

export function pageCacheMetaPath(docId: string, root = cacheRoot()): string {
	return join(root, "pages", `${docId}.meta.json`);
}

export function outlineCachePath(docId: string, root = cacheRoot()): string {
	return join(root, "outlines", `${docId}.json`);
}

export function renderDir(docId: string, root = cacheRoot()): string {
	return join(root, "renders", docId);
}

export function ocrDir(docId: string, root = cacheRoot()): string {
	return join(root, "ocr", docId);
}

export async function ensureCacheDirs(root = cacheRoot()): Promise<void> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700).catch(() => undefined);
	for (const name of ["pages", "outlines", "renders", "ocr", "images"]) {
		const path = join(root, name);
		await mkdir(path, { recursive: true, mode: 0o700 });
		await chmod(path, 0o700).catch(() => undefined);
	}
}

async function atomicWriteJsonLines(path: string, values: unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	const file = await open(temp, "wx", 0o600);
	try {
		for (const value of values) await file.write(`${JSON.stringify(value)}\n`);
		await file.sync();
		await file.close();
		await rename(temp, path);
	} catch (error) {
		await file.close().catch(() => undefined);
		await rm(temp, { force: true });
		throw error;
	}
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	try {
		await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true }).catch(() => undefined);
	}
}

export async function sourceFingerprint(path: string): Promise<string> {
	return sha256File(path);
}

export async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

export function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

export async function documentId(path: string): Promise<string> {
	return sha1(await canonicalPath(path));
}

export async function sha256File(path: string): Promise<string> {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

export function parseKeyValueOutput(output: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^([^:]+):\s*(.*)$/);
		if (!match) continue;
		result[match[1].trim()] = match[2].trim();
	}
	return result;
}

export function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number.parseInt(value.replace(/,/g, ""), 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function cleanOptional(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed || /^\(?none\)?$/i.test(trimmed) || /^untitled$/i.test(trimmed)) return undefined;
	return trimmed;
}

export async function runCommand(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	signal?: AbortSignal,
	timeout = 120_000,
): Promise<{ stdout: string; stderr: string; code: number | null; killed?: boolean }> {
	const result = (await pi.exec(command, args, { signal, timeout })) as {
		stdout?: string;
		stderr?: string;
		code?: number | null;
		killed?: boolean;
	};
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const code = result.code ?? (result.killed ? 1 : 0);
	if (code !== 0) {
		const rawDetail = (stderr || stdout || `exit code ${code}`).trim();
		const detail = Buffer.from(rawDetail).subarray(0, 4_000).toString("utf8").replace(/\uFFFD$/u, "");
		throw new Error(`${command} failed: ${detail}${Buffer.byteLength(rawDetail) > 4_000 ? "\n[diagnostic truncated]" : ""}`);
	}
	return { stdout, stderr, code, killed: result.killed };
}

export async function getPdfInfo(pi: ExtensionAPI, path: string, signal?: AbortSignal): Promise<PdfInfo> {
	const [infoResult, fileStat] = await Promise.all([
		runCommand(pi, "pdfinfo", [path], signal),
		stat(path),
	]);
	const raw = parseKeyValueOutput(infoResult.stdout);
	return {
		path,
		title: cleanOptional(raw.Title),
		author: cleanOptional(raw.Author),
		subject: cleanOptional(raw.Subject),
		creator: cleanOptional(raw.Creator),
		producer: cleanOptional(raw.Producer),
		pages: parsePositiveInt(raw.Pages) ?? 0,
		sizeBytes: fileStat.size,
		mtimeMs: fileStat.mtimeMs,
		pdfVersion: cleanOptional(raw["PDF version"]),
		encrypted: /^yes/i.test(raw.Encrypted ?? ""),
		pageSize: cleanOptional(raw["Page size"]),
		raw,
	};
}

export function normalizeText(text: string): string {
	return text
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export function estimateTextQuality(text: string): TextQuality {
	const compact = text.replace(/\s+/g, "");
	if (compact.length < 25) return "none";
	const replacement = (text.match(/[\uFFFD□■�]/g) ?? []).length;
	const cid = (text.match(/\(cid:\d+\)/gi) ?? []).length;
	const alnum = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
	const punctuation = (text.match(/[{}()[\]<>;:#*_+=|\\/~`^$%&@.,!?-]/g) ?? []).length;
	const usefulRatio = (alnum + punctuation) / Math.max(1, compact.length);
	if (replacement / compact.length > 0.01 || cid > 5 || usefulRatio < 0.35) return "poor";
	return "good";
}

export function splitPopplerPages(output: string): string[] {
	return output.replace(/\f+$/g, "").split("\f");
}

export async function extractTextRange(
	pi: ExtensionAPI,
	path: string,
	firstPage: number,
	lastPage: number,
	mode: "plain" | "layout",
	signal?: AbortSignal,
): Promise<string> {
	const args = ["-q", "-enc", "UTF-8", "-f", String(firstPage), "-l", String(lastPage)];
	if (mode === "layout") args.push("-layout");
	args.push(path, "-");
	return (await runCommand(pi, "pdftotext", args, signal, 180_000)).stdout;
}

export async function sampleTextQuality(pi: ExtensionAPI, path: string, pages: number, signal?: AbortSignal): Promise<TextQuality> {
	if (pages <= 0) return "unknown";
	try {
		const last = Math.min(pages, 5);
		const text = await extractTextRange(pi, path, 1, last, "plain", signal);
		return estimateTextQuality(text);
	} catch {
		return "unknown";
	}
}

export function parseOutlineNode(node: any, depth: number, maxDepth: number): OutlineEntry | undefined {
	const title = typeof node?.title === "string" ? node.title.trim() : "";
	if (!title) return undefined;
	const page = Number.isFinite(node.destpageposfrom1) ? Number(node.destpageposfrom1) : undefined;
	const entry: OutlineEntry = { title, page, depth };
	if (depth < maxDepth && Array.isArray(node.kids) && node.kids.length > 0) {
		const children = node.kids
			.map((kid: any) => parseOutlineNode(kid, depth + 1, maxDepth))
			.filter(Boolean) as OutlineEntry[];
		if (children.length > 0) entry.children = children;
	}
	return entry;
}

export async function getOutline(pi: ExtensionAPI, path: string, maxDepth = 10, signal?: AbortSignal): Promise<OutlineEntry[]> {
	const { stdout } = await runCommand(pi, "qpdf", ["--json", "--json-key=outlines", path], signal, 120_000);
	let json: { outlines?: unknown };
	try { json = JSON.parse(stdout) as { outlines?: unknown }; }
	catch (error: any) { throw new Error(`qpdf returned malformed outline JSON for ${path}: ${error?.message ?? error}`); }
	if (json.outlines !== undefined && !Array.isArray(json.outlines)) throw new Error(`qpdf returned an invalid outline structure for ${path}`);
	return ((json.outlines ?? []) as any[])
		.map((node) => parseOutlineNode(node, 1, Math.max(1, maxDepth)))
		.filter(Boolean) as OutlineEntry[];
}

export function parsePageLabels(json: any, pageCount: number): PageLabel[] {
	const ranges = Array.isArray(json?.pagelabels) ? json.pagelabels : [];
	if (ranges.length === 0) return [];
	const sorted = ranges
		.map((item: any) => ({ index: Number(item?.index), spec: item?.label ?? {} }))
		.filter((item: any) => Number.isInteger(item.index) && item.index >= 0 && item.index < pageCount)
		.sort((a: any, b: any) => a.index - b.index);
	const roman = (value: number, upper: boolean) => {
		const table: Array<[number, string]> = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
		let n = value, out = "";
		for (const [amount, symbol] of table) while (n >= amount) { out += symbol; n -= amount; }
		return upper ? out : out.toLowerCase();
	};
	const alpha = (value: number, upper: boolean) => {
		let n = value, out = "";
		while (n > 0) { n--; out = String.fromCharCode(65 + n % 26) + out; n = Math.floor(n / 26); }
		return upper ? out : out.toLowerCase();
	};
	const result: PageLabel[] = [];
	for (let r = 0; r < sorted.length; r++) {
		const { index, spec } = sorted[r]!;
		const end = Math.min(pageCount, sorted[r + 1]?.index ?? pageCount);
		const get = (key: string) => spec[key] ?? spec[`/${key}`];
		const decodeQpdfString = (value: unknown) => {
			const text = String(value ?? "");
			if (text.startsWith("u:")) return text.slice(2);
			if (text.startsWith("b:")) {
				try { return Buffer.from(text.slice(2), "hex").toString("latin1"); } catch { return text.slice(2); }
			}
			return text;
		};
		for (let offset = 0; index + offset < end; offset++) {
			const value = Number(get("St") ?? 1) + offset;
			const style = String(get("S") ?? "").replace(/^\//, "");
			const suffix = style === "D" ? String(value) : style === "R" ? roman(value, true) : style === "r" ? roman(value, false) : style === "A" ? alpha(value, true) : style === "a" ? alpha(value, false) : "";
			result.push({ page: index + offset + 1, label: `${decodeQpdfString(get("P"))}${suffix}` });
		}
	}
	return result.filter((item) => item.label.length > 0);
}

export async function getPageLabels(pi: ExtensionAPI, path: string, pageCount: number, signal?: AbortSignal): Promise<PageLabel[]> {
	const { stdout } = await runCommand(pi, "qpdf", ["--json", "--json-key=pagelabels", path], signal, 120_000);
	return parsePageLabels(JSON.parse(stdout), pageCount);
}

export function flattenOutline(entries: OutlineEntry[]): FlatOutlineEntry[] {
	const flat: FlatOutlineEntry[] = [];
	const visit = (entry: OutlineEntry) => {
		flat.push({ title: entry.title, page: entry.page, depth: entry.depth });
		for (const child of entry.children ?? []) visit(child);
	};
	for (const entry of entries) visit(entry);
	return flat;
}

export function formatOutline(entries: OutlineEntry[], maxEntries = 250): string {
	const lines: string[] = [];
	let count = 0;
	const visit = (entry: OutlineEntry) => {
		if (count >= maxEntries) return;
		count++;
		const indent = "  ".repeat(Math.max(0, entry.depth - 1));
		const page = entry.page ? ` p.${entry.page}` : "";
		lines.push(`${indent}- ${entry.title}${page}`);
		for (const child of entry.children ?? []) visit(child);
	};
	for (const entry of entries) visit(entry);
	if (count >= maxEntries) lines.push(`[outline truncated after ${maxEntries} entries]`);
	return lines.join("\n");
}

export function pagesToRangeString(pages: number[]): string {
	if (pages.length === 0) return "";
	const sorted = [...new Set(pages)].sort((a, b) => a - b);
	const parts: string[] = [];
	let start = sorted[0]!;
	let prev = sorted[0]!;
	for (const page of sorted.slice(1)) {
		if (page === prev + 1) {
			prev = page;
			continue;
		}
		parts.push(start === prev ? String(start) : `${start}-${prev}`);
		start = prev = page;
	}
	parts.push(start === prev ? String(start) : `${start}-${prev}`);
	return parts.join(",");
}

export function parsePageSpec(spec: string, pageCount?: number, maxPages = MAX_PAGES_PER_OPERATION): number[] {
	const trimmed = spec.trim().toLowerCase();
	if (!trimmed) throw new Error("Page specification must not be empty.");
	if (trimmed === "all" || trimmed === "*") {
		if (!pageCount || pageCount <= 0) throw new Error("Cannot use pages=all without knowing the PDF page count.");
		if (pageCount > maxPages) throw new Error(`Page request resolves to ${pageCount} pages; maximum per operation is ${maxPages}.`);
		return Array.from({ length: pageCount }, (_, i) => i + 1);
	}
	const intervals: Array<[number, number]> = [];
	for (const rawPart of trimmed.split(/[,+]/)) {
		const part = rawPart.trim();
		if (!part) continue;
		const match = part.match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
		if (!match) throw new Error(`Invalid page spec segment: ${rawPart}`);
		let start = Number(match[1]), end = Number(match[2] ?? match[1]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) throw new Error(`Invalid page spec segment: ${rawPart}`);
		if (end < start) [start, end] = [end, start];
		const rawSpan = end - start + 1;
		if (rawSpan > Math.max(maxPages * 100, (pageCount ?? 0) * 100)) throw new Error(`Pathological PDF page range ${start}-${end} is too large to process.`);
		if (pageCount) {
			if (start > pageCount) throw new Error(`PDF page range ${start}-${end} is outside the valid range 1-${pageCount}.`);
			end = Math.min(end, pageCount);
		}
		intervals.push([start, end]);
	}
	let requested = 0;
	for (const [start, end] of intervals) {
		requested += end - start + 1;
		if (requested > maxPages) throw new Error(`Page request exceeds the maximum of ${maxPages} pages per operation.`);
	}
	const pages = new Set<number>();
	for (const [start, end] of intervals) for (let page = start; page <= end; page++) pages.add(page);
	if (pages.size > maxPages) throw new Error(`Page request exceeds the maximum of ${maxPages} pages per operation.`);
	return [...pages].sort((a, b) => a - b);
}

export function groupContiguous(pages: number[]): Array<{ first: number; last: number }> {
	const sorted = [...new Set(pages)].sort((a, b) => a - b);
	if (sorted.length === 0) return [];
	const groups: Array<{ first: number; last: number }> = [];
	let first = sorted[0]!;
	let last = sorted[0]!;
	for (const page of sorted.slice(1)) {
		if (page === last + 1) {
			last = page;
			continue;
		}
		groups.push({ first, last });
		first = last = page;
	}
	groups.push({ first, last });
	return groups;
}

export function tsvUnescape(value: string): string {
	return value.replace(/\\t/g, "\t").replace(/\\n/g, "\n");
}

export async function extractBlocksRange(
	pi: ExtensionAPI,
	path: string,
	firstPage: number,
	lastPage: number,
	signal?: AbortSignal,
): Promise<Record<number, Array<{ left: number; top: number; width: number; height: number; text: string }>>> {
	const { stdout } = await runCommand(
		pi,
		"pdftotext",
		["-q", "-enc", "UTF-8", "-tsv", "-f", String(firstPage), "-l", String(lastPage), path, "-"],
		signal,
		180_000,
	);
	const lines = stdout.split(/\r?\n/).filter(Boolean);
	const byPage: Record<number, Map<string, { left: number; top: number; right: number; bottom: number; words: string[] }>> = {};
	for (const line of lines.slice(1)) {
		const cols = line.split("\t");
		if (cols.length < 12) continue;
		const level = Number(cols[0]);
		if (level !== 5) continue;
		const page = Number(cols[1]);
		const par = cols[2];
		const block = cols[3];
		const lineNo = cols[4];
		const left = Number(cols[6]);
		const top = Number(cols[7]);
		const width = Number(cols[8]);
		const height = Number(cols[9]);
		const text = tsvUnescape(cols.slice(11).join("\t"));
		if (!Number.isFinite(page) || !Number.isFinite(left) || !text || text.startsWith("###")) continue;
		const key = `${par}:${block}:${lineNo}`;
		byPage[page] ??= new Map();
		const existing = byPage[page]!.get(key);
		if (!existing) {
			byPage[page]!.set(key, { left, top, right: left + width, bottom: top + height, words: [text] });
		} else {
			existing.left = Math.min(existing.left, left);
			existing.top = Math.min(existing.top, top);
			existing.right = Math.max(existing.right, left + width);
			existing.bottom = Math.max(existing.bottom, top + height);
			existing.words.push(text);
		}
	}
	const result: Record<number, Array<{ left: number; top: number; width: number; height: number; text: string }>> = {};
	for (const [page, map] of Object.entries(byPage)) {
		result[Number(page)] = [...map.values()]
			.sort((a, b) => a.top - b.top || a.left - b.left)
			.map((line) => ({
				left: Number(line.left.toFixed(2)),
				top: Number(line.top.toFixed(2)),
				width: Number((line.right - line.left).toFixed(2)),
				height: Number((line.bottom - line.top).toFixed(2)),
				text: line.words.join(" "),
			}));
	}
	return result;
}

export async function extractPages(
	pi: ExtensionAPI,
	path: string,	
	pages: number[],
	mode: "plain" | "layout" | "blocks" | "markdown",
	signal?: AbortSignal,
): Promise<CachedPage[]> {
	const result: CachedPage[] = [];
	for (const group of groupContiguous(pages)) {
		if (mode === "blocks") {
			const blocks = await extractBlocksRange(pi, path, group.first, group.last, signal);
			for (let page = group.first; page <= group.last; page++) {
				result.push({
					page,
					text: JSON.stringify({ page, blocks: blocks[page] ?? [] }, null, 2),
					quality: estimateTextQuality((blocks[page] ?? []).map((b) => b.text).join("\n")),
				});
			}
			continue;
		}

		const extractionMode = mode === "plain" ? "plain" : "layout";
		const raw = await extractTextRange(pi, path, group.first, group.last, extractionMode, signal);
		const parts = splitPopplerPages(raw);
		for (let page = group.first; page <= group.last; page++) {
			const text = parts[page - group.first] ?? "";
			result.push({ page, text, quality: estimateTextQuality(text) });
		}
	}
	return result;
}

async function* extractPageChunks(
	pi: ExtensionAPI,
	path: string,
	pageCount: number,
	mode: "plain" | "layout",
	chunkSize = PDF_TEXT_CHUNK_SIZE,
	signal?: AbortSignal,
): AsyncGenerator<CachedPage[]> {
	const total = Math.max(1, pageCount);
	for (let first = 1; first <= total; first += Math.max(1, chunkSize)) {
		const last = Math.min(total, first + Math.max(1, chunkSize) - 1);
		const raw = await extractTextRange(pi, path, first, last, mode, signal);
		const split = splitPopplerPages(raw);
		yield Array.from({ length: last - first + 1 }, (_, index) => {
			const page = first + index;
			const text = split[index] ?? "";
			return { page, text, quality: estimateTextQuality(text) };
		});
	}
}

export function layoutToMarkdown(text: string): string {
	const lines = text.replace(/[ \t]+$/gm, "").split(/\r?\n/);
	return lines
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed) return "";
			if (/^(chapter\s+\d+|\d+(?:\.\d+)*\s+\S)/i.test(trimmed) && trimmed.length < 100) return `### ${trimmed}`;
			if (/^(abstract|introduction|conclusion|references)$/i.test(trimmed)) return `## ${trimmed}`;
			return line;
		})
		.join("\n");
}

export function formatExtractedPages(path: string, pages: CachedPage[], mode: "plain" | "layout" | "blocks" | "markdown"): string {
	const chunks: string[] = [];
	for (const page of pages) {
		let text = page.text ?? "";
		if (mode === "markdown") text = layoutToMarkdown(text);
		chunks.push(`--- ${path} :: PDF page ${page.page} ---\n${text.trimEnd()}`);
	}
	return chunks.join("\n\n");
}

export function truncateToolText(text: string, maxChars?: number): { text: string; truncated: boolean; omittedChars: number } {
	const charLimit = Math.max(1_000, Math.min(HARD_EXTRACT_MAX_CHARS, maxChars ?? DEFAULT_EXTRACT_MAX_CHARS));
	const byteLimit = Math.min(DEFAULT_MAX_BYTES, 50_000);
	const lineLimit = Math.min(DEFAULT_MAX_LINES, 2_000);
	const withinLimits = text.length <= charLimit && Buffer.byteLength(text) <= byteLimit && text.split("\n").length <= lineLimit;
	if (withinLimits) return { text, truncated: false, omittedChars: 0 };
	const notice = "[Output truncated. Request a narrower page range or continue with explicit later pages.]";
	const contentLineLimit = Math.max(1, lineLimit - 1);
	let out = text.split("\n").slice(0, contentLineLimit).join("\n").slice(0, Math.max(0, charLimit - notice.length - 1));
	const contentByteLimit = byteLimit - Buffer.byteLength(notice) - 1;
	if (Buffer.byteLength(out) > contentByteLimit) out = Buffer.from(out).subarray(0, contentByteLimit).toString("utf8").replace(/\uFFFD$/, "");
	out = out.trimEnd();
	const omittedChars = Math.max(0, text.length - out.length);
	return { text: `${out}\n${notice}`, truncated: true, omittedChars };
}

export async function findPdfs(root: string): Promise<string[]> {
	const rootStat = await stat(root).catch((error: any) => { throw new Error(`PDF library root is missing or unreadable: ${root}: ${error.message}`); });
	if (!rootStat.isDirectory()) throw new Error(`PDF library root is not a directory: ${root}`);
	const results: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error: any) {
			throw new Error(`Cannot read PDF library directory ${dir}: ${error.message}`);
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.isDirectory()) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
				results.push(full);
			}
		}
	}
	await walk(root);
	return results.sort((a, b) => a.localeCompare(b));
}

export async function readCatalog(root = cacheRoot()): Promise<Catalog | undefined> {
	try {
		const parsed = JSON.parse(await readFile(catalogPath(root), "utf8")) as Catalog;
		if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.documents)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export async function writeCatalog(catalog: Catalog, root = cacheRoot()): Promise<void> {
	await ensureCacheDirs(root);
	const path = catalogPath(root);
	await withFileMutationQueue(path, async () => {
		await atomicWrite(path, `${JSON.stringify(catalog, null, 2)}\n`);
	});
}

export async function readPageCacheMetadata(docId: string, root = cacheRoot()): Promise<PageCacheMetadata | undefined> {
	try {
		const metadata = JSON.parse(await readFile(pageCacheMetaPath(docId, root), "utf8")) as PageCacheMetadata;
		return metadata.version === CACHE_VERSION ? metadata : undefined;
	} catch {
		return undefined;
	}
}

export async function writePageCacheMetadata(
	docId: string,
	source: Pick<PdfInfo, "path" | "pages" | "sizeBytes" | "mtimeMs"> & { fingerprint: string },
	root = cacheRoot(),
): Promise<void> {
	await ensureCacheDirs(root);
	const path = pageCacheMetaPath(docId, root);
	const metadata: PageCacheMetadata = {
		version: CACHE_VERSION,
		path: source.path,
		pages: source.pages,
		sizeBytes: source.sizeBytes,
		mtimeMs: source.mtimeMs,
		indexedAt: nowIso(),
		fingerprint: source.fingerprint,
	};
	await withFileMutationQueue(path, async () => {
		await atomicWrite(path, `${JSON.stringify(metadata, null, 2)}\n`);
	});
}

export async function readCachedPages(docId: string, root = cacheRoot(), metadata?: PageCacheMetadata): Promise<CachedPage[] | undefined> {
	const manifest = metadata ?? await readPageCacheMetadata(docId, root);
	const path = manifest?.dataFile ? join(root, "pages", manifest.dataFile) : pageCachePath(docId, root);
	try {
		const content = await readFile(path, "utf8");
		return content
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as CachedPage);
	} catch {
		return undefined;
	}
}

export async function cacheOutline(docId: string, fingerprint: string, outline: OutlineEntry[], root = cacheRoot()): Promise<void> {
	await ensureCacheDirs(root);
	const path = outlineCachePath(docId, root);
	await withFileMutationQueue(path, async () => atomicWrite(path, `${JSON.stringify({ version: CACHE_VERSION, fingerprint, outline }, null, 2)}\n`));
}

export async function loadCachedOutline(docId: string, fingerprint: string, root = cacheRoot()): Promise<OutlineEntry[] | undefined> {
	try {
		const cached = JSON.parse(await readFile(outlineCachePath(docId, root), "utf8"));
		return cached?.version === CACHE_VERSION && cached?.fingerprint === fingerprint && Array.isArray(cached.outline) ? cached.outline : undefined;
	} catch {
		return undefined;
	}
}

export function isIndexedFresh(doc: CatalogDocument | undefined, fileStat: { size: number; mtimeMs: number }): boolean {
	if (!doc?.indexed) return false;
	if (doc.sizeBytes !== fileStat.size) return false;
	if (doc.mtimeMs !== fileStat.mtimeMs) return false;
	return true;
}

export async function hasFreshPageCache(
	docId: string,
	fileStat: { size: number; mtimeMs: number },
	doc?: CatalogDocument,
	root = cacheRoot(),
): Promise<boolean> {
	const metadata = await readPageCacheMetadata(docId, root);
	if (metadata) {
		const dataPath = metadata.dataFile ? join(root, "pages", metadata.dataFile) : pageCachePath(docId, root);
		if (!(await exists(dataPath))) return false;
		if (metadata.sizeBytes !== fileStat.size || metadata.mtimeMs !== fileStat.mtimeMs) return false;
		return metadata.fingerprint === await sourceFingerprint(metadata.path);
	}
	if (!(await exists(pageCachePath(docId, root)))) return false;
	if (!isIndexedFresh(doc, fileStat) || !doc?.sha256) return false;
	return doc.sha256 === await sourceFingerprint(doc.path);
}

export function mergeCatalogDocuments(base: CatalogDocument[], updates: CatalogDocument[]): CatalogDocument[] {
	const byPath = new Map(base.map((doc) => [resolve(doc.path), doc]));
	for (const update of updates) {
		const key = resolve(update.path);
		const previous = byPath.get(key);
		byPath.set(key, {
			...previous,
			...update,
			sha256: update.sha256 ?? previous?.sha256,
			indexedAt: update.indexedAt ?? previous?.indexedAt,
		});
	}
	return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function catalogCoversPaths(catalog: Catalog | undefined, root: string, paths: string[]): catalog is Catalog {
	if (!catalog || catalog.partial || catalog.root !== root) return false;
	const catalogPaths = new Set(catalog.documents.map((doc) => resolve(doc.path)));
	if (catalogPaths.size !== paths.length) return false;
	return paths.every((path) => catalogPaths.has(resolve(path)));
}

export async function scanOnePdf(pi: ExtensionAPI, path: string, signal?: AbortSignal): Promise<CatalogDocument> {
	const [info, id] = await Promise.all([getPdfInfo(pi, path, signal), documentId(path)]);
	const outline = await getOutline(pi, path, 3, signal);
	const quality = await sampleTextQuality(pi, path, info.pages, signal);
	const indexed = await hasFreshPageCache(id, { size: info.sizeBytes, mtimeMs: info.mtimeMs });
	return {
		id,
		path,
		title: info.title,
		pages: info.pages,
		sizeBytes: info.sizeBytes,
		mtimeMs: info.mtimeMs,
		encrypted: info.encrypted,
		hasOutline: outline.length > 0,
		textQuality: quality,
		indexed,
	};
}

export async function indexOnePdf(pi: ExtensionAPI, path: string, ocrPoorPages: boolean, signal?: AbortSignal): Promise<CatalogDocument> {
	const id = await documentId(path);
	await ensureCacheDirs();
	// One queue key covers extraction, source revalidation, and publication.
	return withFileMutationQueue(pageCacheMetaPath(id), async () => {
		const info = await getPdfInfo(pi, path, signal);
		const fingerprint = await sourceFingerprint(path);
		const outline = await getOutline(pi, path, 10, signal);
		let ocrReady = false;
		if (ocrPoorPages) { try { await assertTesseractLanguage(pi, "eng", signal); ocrReady = true; } catch { /* indexing still preserves extracted text */ } }
		const sampleTexts: string[] = [];
		const cachedPages: CachedPage[] = [];
		for await (const chunk of extractPageChunks(pi, path, Math.max(1, info.pages), "layout", PDF_TEXT_CHUNK_SIZE, signal)) {
			for (const extracted of chunk) {
				let text = extracted.text;
				let quality = extracted.quality ?? estimateTextQuality(text);
				let ocr = false;
				if (ocrReady && (quality === "none" || quality === "poor") && text.trim().length < 200) {
					try { text = await ocrOnePage(pi, path, id, extracted.page, 300, "eng", signal, fingerprint, true); quality = estimateTextQuality(text); ocr = true; } catch { /* retain extracted text */ }
				}
				const cachedPage = { page: extracted.page, text, quality, ocr } satisfies CachedPage;
				cachedPages.push(cachedPage);
				if (sampleTexts.length < 5) sampleTexts.push(text);
			}
		}
		const current = await stat(path);
		const currentFingerprint = await sourceFingerprint(path);
		if (current.size !== info.sizeBytes || current.mtimeMs !== info.mtimeMs || currentFingerprint !== fingerprint) throw new Error(`PDF changed while indexing; previous valid cache retained: ${path}`);
		const previousMetadata = await readPageCacheMetadata(id);
		const generation = `${id}.${fingerprint}.${Date.now()}.jsonl`;
		const metadata: PageCacheMetadata = { version: CACHE_VERSION, path: info.path, pages: info.pages, sizeBytes: info.sizeBytes, mtimeMs: info.mtimeMs, indexedAt: nowIso(), fingerprint, dataFile: generation };
		// Publish immutable data first and switch readers with one atomic manifest rename.
		await atomicWriteJsonLines(join(dirname(pageCachePath(id)), generation), cachedPages);
		await atomicWrite(pageCacheMetaPath(id), `${JSON.stringify(metadata, null, 2)}\n`);
		await cacheOutline(id, fingerprint, outline);
		const document = { id, path, title: info.title, pages: info.pages, sizeBytes: info.sizeBytes, mtimeMs: info.mtimeMs, sha256: fingerprint, encrypted: info.encrypted, hasOutline: outline.length > 0, textQuality: estimateTextQuality(sampleTexts.join("\n")), indexed: true, indexedAt: metadata.indexedAt } satisfies CatalogDocument;
		replaceSqliteDocument(cacheRoot(), document, fingerprint, cachedPages);
		// Keep the current and immediately previous immutable generations; older
		// files are no longer reachable after both publications succeeded.
		const keep = new Set([generation, previousMetadata?.dataFile].filter(Boolean));
		for (const name of await readdir(dirname(pageCachePath(id)))) {
			if (name.startsWith(`${id}.`) && name.endsWith(".jsonl") && !keep.has(name)) await rm(join(dirname(pageCachePath(id)), name), { force: true });
		}
		return document;
	});
}

export async function readFreshCachedPagesForSearch(path: string, doc: CatalogDocument | undefined): Promise<CachedPage[] | undefined> {
	const id = doc?.id ?? (await documentId(path));
	const fileStat = await stat(path);
	if (!(await hasFreshPageCache(id, fileStat, doc))) return undefined;
	const metadata = await readPageCacheMetadata(id);
	if (!metadata || metadata.fingerprint !== await sourceFingerprint(path)) return undefined;
	return readCachedPages(id, cacheRoot(), metadata);
}

export function makeLineMatcher(query: string, regex: boolean, caseSensitive: boolean): (line: string) => boolean {
	if (!regex) {
		const needle = caseSensitive ? query : query.toLowerCase();
		return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
	}
	const flags = caseSensitive ? "" : "i";
	return (line) => new RegExp(query, flags).test(line);
}

export function searchPage(
	pageText: string,
	query: string,
	regex: boolean,
	caseSensitive: boolean,
	contextLines: number,
): string[] {
	const matches: string[] = [];
	const matcher = makeLineMatcher(query, regex, caseSensitive);
	const lines = pageText.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (!matcher(lines[i] ?? "")) continue;
		const start = Math.max(0, i - contextLines);
		const end = Math.min(lines.length, i + contextLines + 1);
		const snippet = lines
			.slice(start, end)
			.map((line) => line.trim())
			.filter(Boolean)
			.join("\n");
		if (snippet) matches.push(snippet);
		if (matches.length >= SEARCH_PAGE_MATCH_LIMIT) break;
	}
	return matches;
}

export function formatSearchResults(query: string, results: SearchResult[], fromIndex: number, direct: number, failures: Array<{ path: string; error: string }> = [], stale = 0): string {
	if (results.length === 0) {
		const note = direct > 0 ? " Direct extraction was used for some unindexed PDFs; build an index for faster repeated searches." : "";
		const staleNote = stale ? ` ${stale} stale index document(s) detected${direct > 0 ? " and direct extraction was attempted" : " but the result limit prevented direct fallback"}; run /pdf-index update.` : "";
		const failureNote = failures.length ? ` ${failures.length} document(s) failed: ${failures.slice(0, 5).map((item) => `${item.path}: ${item.error}`).join("; ")}` : "";
		return `No PDF matches found for ${JSON.stringify(query)}.${note}${staleNote}${failureNote}`;
	}
	const lines = [`Found ${results.length} PDF match${results.length === 1 ? "" : "es"} for ${JSON.stringify(query)}:`];
	results.forEach((result, index) => {
		const title = result.title ? ` (${result.title})` : "";
		lines.push(`\n${index + 1}. ${result.path}${title} :: PDF page ${result.page}`);
		lines.push(result.snippet);
	});
	lines.push(`\n[Search sources: ${fromIndex} indexed document(s), ${direct} direct extraction document(s), ${stale} stale index document(s), ${failures.length} failed document(s). Cache: ${cacheRoot()}]`);
	if (failures.length) lines.push(`[Failures: ${failures.slice(0, 10).map((item) => `${item.path}: ${item.error}`).join("; ")}${failures.length > 10 ? "; additional failures omitted" : ""}]`);
	return lines.join("\n");
}

export function bestOutlineMatch(flat: FlatOutlineEntry[], reference: string): { entry: FlatOutlineEntry; index: number; score: number } | undefined {
	const ref = normalizeText(reference);
	if (!ref) return undefined;
	const refWords = new Set(ref.split(/\s+/).filter(Boolean));
	let best: { entry: FlatOutlineEntry; index: number; score: number } | undefined;
	flat.forEach((entry, index) => {
		const title = normalizeText(entry.title);
		if (!title) return;
		let score = 0;
		if (title === ref) score += 100;
		if (title.includes(ref)) score += 70;
		if (ref.includes(title) && title.length > 2) score += 30;
		for (const word of refWords) if (title.includes(word)) score += 5;

		const chapter = ref.match(/^chapter\s+(\d+)/i)?.[1];
		if (chapter && new RegExp(`^(chapter\\s+)?${chapter}(\\D|$)`, "i").test(entry.title.trim())) score += 50;

		const section = ref.match(/^section\s+([0-9.]+)/i)?.[1];
		if (section && entry.title.trim().startsWith(section)) score += 60;

		if (score > (best?.score ?? 0)) best = { entry, index, score };
	});
	return best && best.score >= 25 ? best : undefined;
}

export function rangeForOutlineMatch(flat: FlatOutlineEntry[], matchIndex: number, pageCount: number): { pages: string; notes?: string } {
	const match = flat[matchIndex]!;
	const start = match.page ?? 1;
	let end = pageCount;
	for (const later of flat.slice(matchIndex + 1)) {
		if (later.page && later.page > start && later.depth <= match.depth) {
			end = later.page - 1;
			break;
		}
	}
	let notes: string | undefined;
	if (end < start) end = start;
	if (end - start + 1 > 25) {
		end = start + 24;
		notes = "Outline section is long; capped to the first 25 PDF pages. Request a narrower subsection or explicit pages to continue.";
	}
	return { pages: `${start}-${Math.min(end, pageCount || end)}`, notes };
}

export async function resolveReferenceInternal(
	pi: ExtensionAPI,
	path: string,
	reference: string,
	signal?: AbortSignal,
): Promise<ResolvedReference> {
	const info = await getPdfInfo(pi, path, signal);
	const explicitPdfPage = reference.match(/^\s*pdf\s*page\s+(\d+)\s*$/i)?.[1];
	if (explicitPdfPage) {
		const page = Number(explicitPdfPage);
		if (page < 1 || page > info.pages) throw new Error(`PDF page ${page} is outside the valid range 1-${info.pages}.`);
		return { pages: String(page), confidence: "high", method: "heuristic", notes: "Explicit PDF page number." };
	}
	const labelMatch = reference.match(/^\s*((?:printed|labeled?)\s+)?page\s+(.+?)\s*$/i);
	const labelReference = labelMatch?.[2];
	if (labelReference) {
		const explicitlyLabeled = Boolean(labelMatch?.[1]);
		const labels = await getPageLabels(pi, path, info.pages, signal).catch(() => []);
		const matches = labels.filter((item) => item.label.toLowerCase() === labelReference.toLowerCase());
		if (matches.length === 1) return { pages: String(matches[0]!.page), confidence: explicitlyLabeled ? "high" : "low", method: "page-label", notes: `${explicitlyLabeled ? "Explicit" : "Ambiguous unqualified"} page label ${JSON.stringify(matches[0]!.label)} maps to PDF page ${matches[0]!.page}.` };
		if (matches.length > 1) return { pages: pagesToRangeString(matches.map((item) => item.page)), confidence: "low", method: "page-label", notes: `Ambiguous page label occurs on ${matches.length} PDF pages.` };
		if (/^\d+$/.test(labelReference)) {
			const page = Number(labelReference);
			if (page < 1 || page > info.pages) throw new Error(`Page ${page} is outside the valid PDF range 1-${info.pages}.`);
			return { pages: labelReference, confidence: "low", method: "heuristic", notes: "Ambiguous unqualified page reference: no matching PDF page label. Use 'PDF page N' to address the physical PDF page explicitly." };
		}
	}
	const bare = reference.match(/^\s*(\d+)\s*$/)?.[1];
	if (bare) {
		const page = Number(bare);
		if (page < 1 || page > info.pages) throw new Error(`Page ${page} is outside the valid PDF range 1-${info.pages}.`);
		return { pages: bare, confidence: "low", method: "heuristic", notes: "Ambiguous bare number; interpreted as a tentative PDF page. Use 'PDF page N' for certainty." };
	}

	const id = await documentId(path);
	const fingerprint = await sourceFingerprint(path);
	const outline = (await loadCachedOutline(id, fingerprint)) ?? (await getOutline(pi, path, 10, signal));
	const flat = flattenOutline(outline).filter((entry) => entry.page);
	const match = bestOutlineMatch(flat, reference);
	if (match) {
		const range = rangeForOutlineMatch(flat, match.index, info.pages);
		return {
			pages: range.pages,
			confidence: match.score >= 70 ? "high" : "medium",
			method: "outline",
			notes: [`Matched outline entry: ${match.entry.title}`, range.notes].filter(Boolean).join(" ") || undefined,
		};
	}

	try {
		const search = await searchPdfDocuments(pi, reference, [path], false, false, 1, 0, signal);
		if (search.results[0]) {
			const page = search.results[0].page;
			return {
				pages: `${page}-${Math.min(info.pages, page + 2)}`,
				confidence: "low",
				method: "search",
				notes: "No outline match; using first text search hit and two following pages.",
			};
		}
	} catch {
		// Fall through to heuristic.
	}

	const fallbackEnd = Math.max(1, Math.min(5, info.pages));
	return {
		pages: fallbackEnd === 1 ? "1" : `1-${fallbackEnd}`,
		confidence: "low",
		method: "heuristic",
		notes: `Could not resolve reference from outline or search; returned the first ${fallbackEnd} PDF page${fallbackEnd === 1 ? "" : "s"} as a safe starting point.`,
	};
}

const searchFingerprintMemo = new Map<string, { identity: string; fingerprint: string }>();

export async function hasFreshSearchIndex(path: string, knownFingerprint?: string): Promise<boolean> {
	try {
		const fileStat = await stat(path);
		const identity = `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`;
		const cached = searchFingerprintMemo.get(resolve(path));
		const fingerprint = knownFingerprint ?? (cached?.identity === identity ? cached.fingerprint : await sourceFingerprint(path));
		if (cached?.identity !== identity) {
			searchFingerprintMemo.set(resolve(path), { identity, fingerprint });
			if (searchFingerprintMemo.size > 5000) searchFingerprintMemo.delete(searchFingerprintMemo.keys().next().value!);
		}
		return hasFreshSqliteDocument(cacheRoot(), path, fileStat.size, fileStat.mtimeMs, fingerprint);
	} catch {
		return false;
	}
}

export async function searchPdfDocuments(
	pi: ExtensionAPI,
	query: string,
	paths: string[],
	regex: boolean,
	caseSensitive: boolean,
	maxResults: number,
	contextLines: number,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[]; indexedDocuments: number; directDocuments: number; staleDocuments: number; failures: Array<{ path: string; error: string }> }> {
	if (!query.trim()) throw new Error("query must not be empty");
	if (regex) {
		try {
			new RegExp(query);
		} catch (error: any) {
			throw new Error(`Invalid regular expression: ${error.message}`);
		}
	}
	const catalog = await readCatalog();
	const byPath = new Map(!catalog?.partial ? (catalog?.documents ?? []).map((doc) => [resolve(doc.path), doc]) : []);
	const results: SearchResult[] = [];
	let indexedDocuments = 0;
	let directDocuments = 0;
	let staleDocuments = 0;
	const failures: Array<{ path: string; error: string }> = [];

	const appendMatches = (pdfPath: string, doc: CatalogDocument | undefined, pages: CachedPage[]) => {
		for (const page of pages) {
			if (results.length >= maxResults) break;
			const snippets = searchPage(page.text ?? page.layoutText ?? "", query, regex, caseSensitive, Math.max(0, contextLines));
			for (const snippet of snippets) {
				results.push({ path: pdfPath, title: doc?.title, page: page.page, snippet, score: 0.8 });
				if (results.length >= maxResults) break;
			}
		}
	};

	// Literal, case-insensitive library search is served by FTS5. Verify each
	// source generation before allowing its row into the ranked result set.
	const ftsPaths: string[] = [];
	const directPaths: string[] = [];
	if (!regex && !caseSensitive) {
		const states = sqliteDocumentStates(cacheRoot(), paths);
		for (const path of paths) {
			const state = states.get(resolve(path));
			try {
				const fileStat = await stat(path);
				const identity = `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`;
				const memo = searchFingerprintMemo.get(resolve(path));
				const fingerprint = memo?.identity === identity ? memo.fingerprint : await sourceFingerprint(path);
				searchFingerprintMemo.set(resolve(path), { identity, fingerprint });
				if (state?.status === "indexed" && state.sizeBytes === fileStat.size && state.mtimeMs === fileStat.mtimeMs && state.fingerprint === fingerprint) ftsPaths.push(path);
				else { if (state?.status === "indexed") staleDocuments++; if (state?.status === "failed") failures.push({ path, error: state.error ?? "indexing failed" }); directPaths.push(path); }
			} catch (error: any) { failures.push({ path, error: error?.message ?? String(error) }); }
		}
		if (ftsPaths.length) {
			const searched = searchSqliteIndex(cacheRoot(), query, ftsPaths, maxResults, contextLines);
			results.push(...searched.results);
			indexedDocuments = searched.indexedPaths.size;
			failures.push(...searched.failed);
			if (!searched.representable) directPaths.unshift(...ftsPaths);
		}
	} else {
		// Regex and case-sensitive semantics are not provided by FTS5. Extract
		// directly rather than reverting to whole-corpus JSONL parsing.
		directPaths.push(...paths);
	}

	for (const pdfPath of directPaths) {
		if (results.length >= maxResults) break;
		const doc = byPath.get(resolve(pdfPath));
		try {
			directDocuments++;
			const info = await getPdfInfo(pi, pdfPath, signal);
			for await (const chunk of extractPageChunks(pi, pdfPath, Math.max(1, info.pages), "layout", PDF_TEXT_CHUNK_SIZE, signal)) {
				appendMatches(pdfPath, doc, chunk);
				if (results.length >= maxResults) break;
			}
		} catch (error: any) {
			failures.push({ path: pdfPath, error: error?.message ?? String(error) });
		}
	}
	return { results: results.slice(0, maxResults), indexedDocuments, directDocuments, staleDocuments, failures };
}

export async function renderOnePage(
	pi: ExtensionAPI,
	path: string,
	docId: string,
	page: number,
	dpi: number,
	signal?: AbortSignal,
	expectedFingerprint?: string,
): Promise<string> {
	const fingerprint = expectedFingerprint ?? await sourceFingerprint(path);
	const dir = join(renderDir(docId), fingerprint);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const finalPath = join(dir, `page-${page}-dpi-${dpi}.png`);
	if (await exists(finalPath)) {
		if (await sourceFingerprint(path) !== fingerprint) throw new Error(`PDF changed before cached render could be used: ${path}`);
		return finalPath;
	}
	const tempDir = await mkdtemp(join(dir, ".render-"));
	try {
		const prefix = join(tempDir, "page");
		await runCommand(pi, "pdftoppm", ["-singlefile", "-png", "-r", String(dpi), "-f", String(page), "-l", String(page), path, prefix], signal, 180_000);
		if (await sourceFingerprint(path) !== fingerprint) throw new Error(`PDF changed while rendering; artifact was not published: ${path}`);
		const generated = (await readdir(tempDir)).find((name) => name.endsWith(".png"));
		if (!generated) throw new Error("pdftoppm finished, but no rendered PNG was found");
		await rename(join(tempDir, generated), finalPath).catch(async (error: any) => { if (!(error?.code === "EEXIST" && await exists(finalPath))) throw error; });
		return finalPath;
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function assertTesseractLanguage(pi: ExtensionAPI, language: string, signal?: AbortSignal): Promise<void> {
	const { stdout } = await runCommand(pi, "tesseract", ["--list-langs"], signal, 30_000);
	const installed = new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/list of available/i.test(line)));
	const missing = language.split("+").filter((lang) => !installed.has(lang));
	if (missing.length) throw new Error(`Tesseract language data unavailable: ${missing.join(", ")}. Installed: ${[...installed].join(", ") || "none"}. Install the requested tessdata language pack or choose an installed language.`);
}

export async function ocrOnePage(
	pi: ExtensionAPI,
	path: string,
	docId: string,
	page: number,
	dpi: number,
	language: string,
	signal?: AbortSignal,
	expectedFingerprint?: string,
	languagePreflighted = false,
): Promise<string> {
	if (!languagePreflighted) await assertTesseractLanguage(pi, language, signal);
	const fingerprint = expectedFingerprint ?? await sourceFingerprint(path);
	const dir = join(ocrDir(docId), fingerprint);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const safeLanguage = language.replace(/[^a-zA-Z0-9_+-]/g, "_");
	const textPath = join(dir, `page-${page}-dpi-${dpi}-lang-${safeLanguage}.txt`);
	if (await exists(textPath)) {
		if (await sourceFingerprint(path) !== fingerprint) throw new Error(`PDF changed before cached OCR could be used: ${path}`);
		return readFile(textPath, "utf8");
	}
	const imagePath = await renderOnePage(pi, path, docId, page, dpi, signal, fingerprint);
	const { stdout } = await runCommand(pi, "tesseract", [imagePath, "stdout", "-l", language, "--dpi", String(dpi)], signal, 240_000);
	if (await sourceFingerprint(path) !== fingerprint) throw new Error(`PDF changed during OCR; artifact was not published: ${path}`);
	await withFileMutationQueue(textPath, async () => atomicWrite(textPath, stdout));
	return stdout;
}

export function parsePdfImagesList(output: string): Array<{ page: number; num: number; type?: string; width?: number; height?: number; color?: string; encoding?: string }> {
	const rows: Array<{ page: number; num: number; type?: string; width?: number; height?: number; color?: string; encoding?: string }> = [];
	for (const line of output.split(/\r?\n/)) {
		if (!/^\s*\d+\s+\d+\s+/.test(line)) continue;
		const cols = line.trim().split(/\s+/);
		const page = Number(cols[0]);
		const num = Number(cols[1]);
		if (!Number.isFinite(page) || !Number.isFinite(num)) continue;
		rows.push({
			page,
			num,
			type: cols[2],
			width: Number(cols[3]) || undefined,
			height: Number(cols[4]) || undefined,
			color: cols[5],
			encoding: cols[8],
		});
	}
	return rows;
}

