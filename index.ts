import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_LIBRARY_ROOT = "~/vault/sources";
const CACHE_VERSION = 1;
const DEFAULT_EXTRACT_MAX_CHARS = 45_000;
const HARD_EXTRACT_MAX_CHARS = 120_000;
const LARGE_DOCUMENT_PAGE_THRESHOLD = 25;
const DEFAULT_SEARCH_MAX_RESULTS = 20;
const SEARCH_PAGE_MATCH_LIMIT = 3;

type TextQuality = "good" | "poor" | "none" | "unknown";

type PdfInfo = {
	path: string;
	title?: string;
	author?: string;
	subject?: string;
	creator?: string;
	producer?: string;
	pages: number;
	sizeBytes: number;
	mtimeMs: number;
	pdfVersion?: string;
	encrypted: boolean;
	pageSize?: string;
	raw: Record<string, string>;
};

type OutlineEntry = {
	title: string;
	page?: number;
	depth: number;
	children?: OutlineEntry[];
};

type FlatOutlineEntry = {
	title: string;
	page?: number;
	depth: number;
};

type CatalogDocument = {
	id: string;
	path: string;
	title?: string;
	pages: number;
	sizeBytes: number;
	mtimeMs: number;
	sha256?: string;
	encrypted: boolean;
	hasOutline: boolean;
	textQuality: TextQuality;
	indexed: boolean;
	indexedAt?: string;
};

type Catalog = {
	version: number;
	root: string;
	generatedAt: string;
	documents: CatalogDocument[];
};

type CachedPage = {
	page: number;
	text: string;
	layoutText?: string;
	quality?: TextQuality;
	ocr?: boolean;
};

type SearchResult = {
	path: string;
	title?: string;
	page: number;
	snippet: string;
	score?: number;
};

type ResolvedReference = {
	pages: string;
	confidence: "high" | "medium" | "low";
	method: "outline" | "toc" | "page-label" | "search" | "heuristic";
	notes?: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

function home(): string {
	return process.env.HOME || homedir();
}

function expandHome(input: string): string {
	if (input === "~") return home();
	if (input.startsWith("~/")) return join(home(), input.slice(2));
	return input;
}

function stripAtPrefix(input: string): string {
	return input.startsWith("@") ? input.slice(1) : input;
}

function resolveUserPath(input: string, cwd: string): string {
	const cleaned = expandHome(stripAtPrefix(input.trim()));
	return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

function cacheRoot(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	return xdg ? join(xdg, "pi-pdf") : join(home(), ".cache", "pi-pdf");
}

function catalogPath(root = cacheRoot()): string {
	return join(root, "catalog.json");
}

function pageCachePath(docId: string, root = cacheRoot()): string {
	return join(root, "pages", `${docId}.jsonl`);
}

function outlineCachePath(docId: string, root = cacheRoot()): string {
	return join(root, "outlines", `${docId}.json`);
}

function renderDir(docId: string, root = cacheRoot()): string {
	return join(root, "renders", docId);
}

function ocrDir(docId: string, root = cacheRoot()): string {
	return join(root, "ocr", docId);
}

async function ensureCacheDirs(root = cacheRoot()): Promise<void> {
	await mkdir(join(root, "pages"), { recursive: true });
	await mkdir(join(root, "outlines"), { recursive: true });
	await mkdir(join(root, "renders"), { recursive: true });
	await mkdir(join(root, "ocr"), { recursive: true });
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

async function documentId(path: string): Promise<string> {
	return sha1(await canonicalPath(path));
}

async function sha256File(path: string): Promise<string> {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

function parseKeyValueOutput(output: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^([^:]+):\s*(.*)$/);
		if (!match) continue;
		result[match[1].trim()] = match[2].trim();
	}
	return result;
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number.parseInt(value.replace(/,/g, ""), 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function cleanOptional(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed || /^\(?none\)?$/i.test(trimmed) || /^untitled$/i.test(trimmed)) return undefined;
	return trimmed;
}

async function runCommand(
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
		const detail = (stderr || stdout || `exit code ${code}`).trim();
		throw new Error(`${command} failed: ${detail}`);
	}
	return { stdout, stderr, code, killed: result.killed };
}

async function getPdfInfo(pi: ExtensionAPI, path: string, signal?: AbortSignal): Promise<PdfInfo> {
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

function normalizeText(text: string): string {
	return text
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function estimateTextQuality(text: string): TextQuality {
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

function splitPopplerPages(output: string): string[] {
	return output.replace(/\f+$/g, "").split("\f");
}

async function extractTextRange(
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

async function sampleTextQuality(pi: ExtensionAPI, path: string, pages: number, signal?: AbortSignal): Promise<TextQuality> {
	if (pages <= 0) return "unknown";
	try {
		const last = Math.min(pages, 5);
		const text = await extractTextRange(pi, path, 1, last, "plain", signal);
		return estimateTextQuality(text);
	} catch {
		return "unknown";
	}
}

function parseOutlineNode(node: any, depth: number, maxDepth: number): OutlineEntry | undefined {
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

async function getOutline(pi: ExtensionAPI, path: string, maxDepth = 10, signal?: AbortSignal): Promise<OutlineEntry[]> {
	try {
		const { stdout } = await runCommand(pi, "qpdf", ["--json", "--json-key=outlines", path], signal, 120_000);
		const json = JSON.parse(stdout) as { outlines?: any[] };
		return (json.outlines ?? [])
			.map((node) => parseOutlineNode(node, 1, Math.max(1, maxDepth)))
			.filter(Boolean) as OutlineEntry[];
	} catch {
		return [];
	}
}

function flattenOutline(entries: OutlineEntry[]): FlatOutlineEntry[] {
	const flat: FlatOutlineEntry[] = [];
	const visit = (entry: OutlineEntry) => {
		flat.push({ title: entry.title, page: entry.page, depth: entry.depth });
		for (const child of entry.children ?? []) visit(child);
	};
	for (const entry of entries) visit(entry);
	return flat;
}

function formatOutline(entries: OutlineEntry[], maxEntries = 250): string {
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

function pagesToRangeString(pages: number[]): string {
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

function parsePageSpec(spec: string, pageCount?: number): number[] {
	const trimmed = spec.trim().toLowerCase();
	if (trimmed === "all" || trimmed === "*") {
		if (!pageCount || pageCount <= 0) throw new Error("Cannot use pages=all without knowing the PDF page count.");
		return Array.from({ length: pageCount }, (_, i) => i + 1);
	}

	const pages = new Set<number>();
	for (const rawPart of trimmed.split(/[,+]/)) {
		const part = rawPart.trim();
		if (!part) continue;
		const range = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
		if (range) {
			let start = Number.parseInt(range[1], 10);
			let end = Number.parseInt(range[2], 10);
			if (end < start) [start, end] = [end, start];
			for (let page = start; page <= end; page++) pages.add(page);
			continue;
		}
		const single = Number.parseInt(part, 10);
		if (!Number.isFinite(single) || single <= 0) throw new Error(`Invalid page spec segment: ${rawPart}`);
		pages.add(single);
	}

	const result = [...pages].filter((page) => page > 0).sort((a, b) => a - b);
	if (pageCount && pageCount > 0) return result.filter((page) => page <= pageCount);
	return result;
}

function groupContiguous(pages: number[]): Array<{ first: number; last: number }> {
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

function tsvUnescape(value: string): string {
	return value.replace(/\\t/g, "\t").replace(/\\n/g, "\n");
}

async function extractBlocksRange(
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

async function extractPages(
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
			result.push({ page, text, layoutText: extractionMode === "layout" ? text : undefined, quality: estimateTextQuality(text) });
		}
	}
	return result;
}

function layoutToMarkdown(text: string): string {
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

function formatExtractedPages(path: string, pages: CachedPage[], mode: "plain" | "layout" | "blocks" | "markdown"): string {
	const chunks: string[] = [];
	for (const page of pages) {
		let text = page.text ?? "";
		if (mode === "markdown") text = layoutToMarkdown(text);
		chunks.push(`--- ${path} :: PDF page ${page.page} ---\n${text.trimEnd()}`);
	}
	return chunks.join("\n\n");
}

function truncateToolText(text: string, maxChars?: number): { text: string; truncated: boolean; omittedChars: number } {
	const charLimit = Math.max(1_000, Math.min(HARD_EXTRACT_MAX_CHARS, maxChars ?? DEFAULT_EXTRACT_MAX_CHARS));
	const byteLimit = Math.max(4_096, Math.min(Math.max(DEFAULT_MAX_BYTES, charLimit * 2), HARD_EXTRACT_MAX_CHARS * 2));
	const truncated = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: byteLimit });
	let out = truncated.content;
	if (out.length > charLimit) out = out.slice(0, charLimit);
	const wasTruncated = out.length < text.length || truncated.truncated;
	const omittedChars = Math.max(0, text.length - out.length);
	if (!wasTruncated) return { text, truncated: false, omittedChars: 0 };
	return {
		text: `${out.trimEnd()}\n\n[Output truncated: omitted about ${omittedChars.toLocaleString()} characters. Request a narrower page range or increase maxChars up to ${HARD_EXTRACT_MAX_CHARS}.]`,
		truncated: true,
		omittedChars,
	};
}

async function findPdfs(root: string): Promise<string[]> {
	const results: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
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

async function readCatalog(root = cacheRoot()): Promise<Catalog | undefined> {
	try {
		const parsed = JSON.parse(await readFile(catalogPath(root), "utf8")) as Catalog;
		if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.documents)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

async function writeCatalog(catalog: Catalog, root = cacheRoot()): Promise<void> {
	await ensureCacheDirs(root);
	const path = catalogPath(root);
	await withFileMutationQueue(path, async () => {
		await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
	});
}

async function readCachedPages(docId: string, root = cacheRoot()): Promise<CachedPage[] | undefined> {
	const path = pageCachePath(docId, root);
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

async function writeCachedPages(docId: string, pages: CachedPage[], root = cacheRoot()): Promise<void> {
	await ensureCacheDirs(root);
	const path = pageCachePath(docId, root);
	const content = pages.map((page) => JSON.stringify(page)).join("\n") + "\n";
	await withFileMutationQueue(path, async () => {
		await writeFile(path, content, "utf8");
	});
}

async function cacheOutline(docId: string, outline: OutlineEntry[], root = cacheRoot()): Promise<void> {
	await ensureCacheDirs(root);
	const path = outlineCachePath(docId, root);
	await withFileMutationQueue(path, async () => {
		await writeFile(path, `${JSON.stringify(outline, null, 2)}\n`, "utf8");
	});
}

async function loadCachedOutline(docId: string, root = cacheRoot()): Promise<OutlineEntry[] | undefined> {
	try {
		const outline = JSON.parse(await readFile(outlineCachePath(docId, root), "utf8"));
		return Array.isArray(outline) ? (outline as OutlineEntry[]) : undefined;
	} catch {
		return undefined;
	}
}

function isIndexedFresh(doc: CatalogDocument | undefined, fileStat: { size: number; mtimeMs: number }): boolean {
	if (!doc?.indexed) return false;
	if (doc.sizeBytes !== fileStat.size) return false;
	if (Math.abs(doc.mtimeMs - fileStat.mtimeMs) > 2_000) return false;
	return true;
}

async function scanOnePdf(pi: ExtensionAPI, path: string, signal?: AbortSignal): Promise<CatalogDocument> {
	const [info, id] = await Promise.all([getPdfInfo(pi, path, signal), documentId(path)]);
	const outline = await getOutline(pi, path, 3, signal);
	const quality = await sampleTextQuality(pi, path, info.pages, signal);
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
		indexed: await exists(pageCachePath(id)),
	};
}

async function indexOnePdf(
	pi: ExtensionAPI,
	path: string,
	ocrPoorPages: boolean,
	signal?: AbortSignal,
): Promise<CatalogDocument> {
	const [info, id] = await Promise.all([getPdfInfo(pi, path, signal), documentId(path)]);
	const [outline, rawText] = await Promise.all([
		getOutline(pi, path, 10, signal),
		extractTextRange(pi, path, 1, Math.max(1, info.pages), "layout", signal),
	]);
	const split = splitPopplerPages(rawText);
	const pages: CachedPage[] = [];
	for (let page = 1; page <= Math.max(1, info.pages); page++) {
		let text = split[page - 1] ?? "";
		let quality = estimateTextQuality(text);
		let ocr = false;
		if (ocrPoorPages && (quality === "none" || quality === "poor") && text.trim().length < 200) {
			try {
				text = await ocrOnePage(pi, path, id, page, 300, "eng", signal);
				quality = estimateTextQuality(text);
				ocr = true;
			} catch {
				// Keep the normal extraction if OCR fails.
			}
		}
		pages.push({ page, text, layoutText: text, quality, ocr });
	}
	await writeCachedPages(id, pages);
	await cacheOutline(id, outline);
	return {
		id,
		path,
		title: info.title,
		pages: info.pages,
		sizeBytes: info.sizeBytes,
		mtimeMs: info.mtimeMs,
		sha256: await sha256File(path),
		encrypted: info.encrypted,
		hasOutline: outline.length > 0,
		textQuality: estimateTextQuality(pages.slice(0, Math.min(5, pages.length)).map((page) => page.text).join("\n")),
		indexed: true,
		indexedAt: nowIso(),
	};
}

async function pagesForSearch(
	pi: ExtensionAPI,
	path: string,
	doc: CatalogDocument | undefined,
	signal?: AbortSignal,
): Promise<{ pages: CachedPage[]; fromIndex: boolean; doc: CatalogDocument | undefined }> {
	const id = doc?.id ?? (await documentId(path));
	const fileStat = await stat(path);
	if (isIndexedFresh(doc, fileStat)) {
		const cached = await readCachedPages(id);
		if (cached) return { pages: cached, fromIndex: true, doc };
	}
	const info = await getPdfInfo(pi, path, signal);
	const raw = await extractTextRange(pi, path, 1, Math.max(1, info.pages), "layout", signal);
	const split = splitPopplerPages(raw);
	const pages = Array.from({ length: Math.max(1, info.pages) }, (_, i) => {
		const text = split[i] ?? "";
		return { page: i + 1, text, layoutText: text, quality: estimateTextQuality(text) } satisfies CachedPage;
	});
	return { pages, fromIndex: false, doc };
}

function makeLineMatcher(query: string, regex: boolean, caseSensitive: boolean): (line: string) => boolean {
	if (!regex) {
		const needle = caseSensitive ? query : query.toLowerCase();
		return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
	}
	const flags = caseSensitive ? "" : "i";
	return (line) => new RegExp(query, flags).test(line);
}

function searchPage(
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

function formatSearchResults(query: string, results: SearchResult[], fromIndex: number, direct: number): string {
	if (results.length === 0) {
		const note = direct > 0 ? " Direct extraction was used for some unindexed PDFs; build an index for faster repeated searches." : "";
		return `No PDF matches found for ${JSON.stringify(query)}.${note}`;
	}
	const lines = [`Found ${results.length} PDF match${results.length === 1 ? "" : "es"} for ${JSON.stringify(query)}:`];
	results.forEach((result, index) => {
		const title = result.title ? ` (${result.title})` : "";
		lines.push(`\n${index + 1}. ${result.path}${title} :: PDF page ${result.page}`);
		lines.push(result.snippet);
	});
	lines.push(`\n[Search sources: ${fromIndex} indexed document(s), ${direct} direct extraction document(s). Cache: ${cacheRoot()}]`);
	return lines.join("\n");
}

function bestOutlineMatch(flat: FlatOutlineEntry[], reference: string): { entry: FlatOutlineEntry; index: number; score: number } | undefined {
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

function rangeForOutlineMatch(flat: FlatOutlineEntry[], matchIndex: number, pageCount: number): { pages: string; notes?: string } {
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

async function resolveReferenceInternal(
	pi: ExtensionAPI,
	path: string,
	reference: string,
	signal?: AbortSignal,
): Promise<ResolvedReference> {
	const info = await getPdfInfo(pi, path, signal);
	const directPage = reference.match(/(?:pdf\s*)?page\s+(\d+)/i)?.[1] ?? reference.match(/^\s*(\d+)\s*$/)?.[1];
	if (directPage) {
		const page = Math.min(Math.max(1, Number.parseInt(directPage, 10)), Math.max(1, info.pages));
		return { pages: String(page), confidence: "high", method: "heuristic", notes: "Interpreted as a PDF page number." };
	}

	const id = await documentId(path);
	const outline = (await loadCachedOutline(id)) ?? (await getOutline(pi, path, 10, signal));
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

	return {
		pages: "1-5",
		confidence: "low",
		method: "heuristic",
		notes: "Could not resolve reference from outline or search; returned the first five PDF pages as a safe starting point.",
	};
}

async function searchPdfDocuments(
	pi: ExtensionAPI,
	query: string,
	paths: string[],
	regex: boolean,
	caseSensitive: boolean,
	maxResults: number,
	contextLines: number,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[]; indexedDocuments: number; directDocuments: number }> {
	if (!query.trim()) throw new Error("query must not be empty");
	if (regex) {
		try {
			new RegExp(query);
		} catch (error: any) {
			throw new Error(`Invalid regular expression: ${error.message}`);
		}
	}
	const catalog = await readCatalog();
	const byPath = new Map((catalog?.documents ?? []).map((doc) => [resolve(doc.path), doc]));
	const results: SearchResult[] = [];
	let indexedDocuments = 0;
	let directDocuments = 0;

	for (const pdfPath of paths) {
		if (results.length >= maxResults) break;
		const doc = byPath.get(resolve(pdfPath));
		let pages: CachedPage[];
		let fromIndex = false;
		try {
			const loaded = await pagesForSearch(pi, pdfPath, doc, signal);
			pages = loaded.pages;
			fromIndex = loaded.fromIndex;
		} catch {
			continue;
		}
		if (fromIndex) indexedDocuments++;
		else directDocuments++;

		for (const page of pages) {
			if (results.length >= maxResults) break;
			const snippets = searchPage(page.text ?? page.layoutText ?? "", query, regex, caseSensitive, Math.max(0, contextLines));
			for (const snippet of snippets) {
				results.push({
					path: pdfPath,
					title: doc?.title,
					page: page.page,
					snippet,
					score: fromIndex ? 1 : 0.8,
				});
				if (results.length >= maxResults) break;
			}
		}
	}
	return { results, indexedDocuments, directDocuments };
}

async function renderOnePage(
	pi: ExtensionAPI,
	path: string,
	docId: string,
	page: number,
	dpi: number,
	signal?: AbortSignal,
): Promise<string> {
	const dir = renderDir(docId);
	await mkdir(dir, { recursive: true });
	const prefix = join(dir, `page-${page}-dpi-${dpi}`);
	const before = new Set(await readdir(dir).catch(() => []));
	await runCommand(pi, "pdftoppm", ["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), path, prefix], signal, 180_000);
	const after = await readdir(dir);
	const created = after.find((name) => !before.has(name) && name.startsWith(basename(prefix)) && name.endsWith(".png"));
	if (created) return join(dir, created);
	const existing = after.find((name) => name.startsWith(basename(prefix)) && name.endsWith(".png"));
	if (existing) return join(dir, existing);
	throw new Error("pdftoppm finished, but no rendered PNG was found");
}

async function ocrOnePage(
	pi: ExtensionAPI,
	path: string,
	docId: string,
	page: number,
	dpi: number,
	language: string,
	signal?: AbortSignal,
): Promise<string> {
	const dir = ocrDir(docId);
	await mkdir(dir, { recursive: true });
	const safeLanguage = language.replace(/[^a-zA-Z0-9_+-]/g, "_");
	const textPath = join(dir, `page-${page}-dpi-${dpi}-lang-${safeLanguage}.txt`);
	if (await exists(textPath)) return readFile(textPath, "utf8");
	const imagePath = await renderOnePage(pi, path, docId, page, dpi, signal);
	const { stdout } = await runCommand(pi, "tesseract", [imagePath, "stdout", "-l", language, "--dpi", String(dpi)], signal, 240_000);
	await withFileMutationQueue(textPath, async () => {
		await writeFile(textPath, stdout, "utf8");
	});
	return stdout;
}

function parsePdfImagesList(output: string): Array<{ page: number; num: number; type?: string; width?: number; height?: number; color?: string; encoding?: string }> {
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

const pathSchema = Type.Object({
	path: Type.String({ description: "Path to a PDF file. Relative paths are resolved from the current working directory; leading @ is accepted." }),
});

export default function (pi: ExtensionAPI) {
	const sharedGuidelines = [
		"Use pdf_outline or pdf_search before pdf_extract when the user asks about a broad topic in a long PDF.",
		"Use pdf_extract with explicit pages or a resolved section; do not extract an entire long book unless the user explicitly asks.",
		"Use pdf_render_page for diagrams, equations, charts, tables, or pages with broken text extraction; then inspect the generated image with read.",
		"Use pdf_ocr only as a fallback when normal extraction is empty, scanned, or mojibake.",
	];

	pi.registerTool({
		name: "pdf_library_scan",
		label: "PDF library scan",
		description: `Scan a PDF library (default ${DEFAULT_LIBRARY_ROOT}) and refresh a compact catalog. Returns metadata only, never full text. Requires pdfinfo/qpdf/pdftotext.`,
		promptSnippet: "Scan the local PDF library and report compact metadata such as title, pages, size, outline, text quality, and indexed status.",
		promptGuidelines: sharedGuidelines,
		parameters: Type.Object({
			root: Type.Optional(Type.String({ description: `PDF library root. Defaults to ${DEFAULT_LIBRARY_ROOT}` })),
			maxDocuments: Type.Optional(Type.Number({ description: "Optional cap for quick scans." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			await ensureCacheDirs();
			const root = resolveUserPath(params.root ?? DEFAULT_LIBRARY_ROOT, ctx.cwd);
			const pdfs = await findPdfs(root);
			const selected = params.maxDocuments ? pdfs.slice(0, Math.max(1, params.maxDocuments)) : pdfs;
			const docs: CatalogDocument[] = [];
			for (let i = 0; i < selected.length; i++) {
				const path = selected[i]!;
				onUpdate?.({ content: [{ type: "text", text: `Scanning ${i + 1}/${selected.length}: ${path}` }] });
				try {
					docs.push(await scanOnePdf(pi, path, signal));
				} catch (error: any) {
					docs.push({
						id: sha1(path),
						path,
						pages: 0,
						sizeBytes: 0,
						mtimeMs: 0,
						encrypted: false,
						hasOutline: false,
						textQuality: "unknown",
						indexed: false,
					});
				}
			}
			const catalog: Catalog = { version: CACHE_VERSION, root, generatedAt: nowIso(), documents: docs };
			await writeCatalog(catalog);

			const compact = docs.map((doc) => ({
				id: doc.id,
				path: doc.path,
				title: doc.title,
				pages: doc.pages,
				sizeBytes: doc.sizeBytes,
				encrypted: doc.encrypted,
				hasOutline: doc.hasOutline,
				textQuality: doc.textQuality,
				indexed: doc.indexed,
			}));
			const text = JSON.stringify({ root, cache: cacheRoot(), documents: compact }, null, 2);
			const truncated = truncateToolText(text, 60_000);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: { root, cacheRoot: cacheRoot(), documents: compact, scanned: docs.length, totalFound: pdfs.length },
			};
		},
	});

	pi.registerTool({
		name: "pdf_info",
		label: "PDF info",
		description: "Return detailed metadata for a single PDF using pdfinfo/qpdf, including page count, title, author, encryption, page size, outline availability, text quality, and indexed status.",
		promptSnippet: "Inspect one PDF's metadata and extraction/index status before reading it.",
		promptGuidelines: sharedGuidelines,
		parameters: pathSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = resolveUserPath(params.path, ctx.cwd);
			const [info, id] = await Promise.all([getPdfInfo(pi, path, signal), documentId(path)]);
			const outline = await getOutline(pi, path, 2, signal);
			const quality = await sampleTextQuality(pi, path, info.pages, signal);
			const catalog = await readCatalog();
			const catalogDoc = catalog?.documents.find((doc) => resolve(doc.path) === resolve(path));
			const indexed = catalogDoc ? isIndexedFresh(catalogDoc, { size: info.sizeBytes, mtimeMs: info.mtimeMs }) : await exists(pageCachePath(id));
			const result = {
				id,
				path,
				title: info.title,
				author: info.author,
				subject: info.subject,
				creator: info.creator,
				producer: info.producer,
				pages: info.pages,
				sizeBytes: info.sizeBytes,
				pdfVersion: info.pdfVersion,
				encrypted: info.encrypted,
				pageSize: info.pageSize,
				hasOutline: outline.length > 0,
				textQuality: quality,
				indexed,
				cacheRoot: cacheRoot(),
			};
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "pdf_outline",
		label: "PDF outline",
		description: "Extract a PDF table of contents/bookmarks with qpdf. Use this to jump to chapters/sections without scanning hundreds of pages.",
		promptSnippet: "Read PDF bookmarks/outline entries with destination PDF pages.",
		promptGuidelines: sharedGuidelines,
		parameters: Type.Object({
			path: Type.String({ description: "Path to a PDF file." }),
			maxDepth: Type.Optional(Type.Number({ description: "Maximum bookmark nesting depth to return. Defaults to 6." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = resolveUserPath(params.path, ctx.cwd);
			const maxDepth = Math.max(1, Math.min(20, params.maxDepth ?? 6));
			const outline = await getOutline(pi, path, maxDepth, signal);
			const text = outline.length > 0 ? formatOutline(outline) : "No PDF outline/bookmarks found.";
			return { content: [{ type: "text", text }], details: { path, maxDepth, outline } };
		},
	});

	pi.registerTool({
		name: "pdf_resolve_reference",
		label: "PDF resolve reference",
		description: "Resolve a human reference like 'chapter 5', 'section 7.3', 'Virtual Memory', or 'page 214' to PDF page ranges using outlines first, then search/heuristics.",
		promptSnippet: "Turn chapter/section/topic/page references into concrete PDF page ranges.",
		promptGuidelines: sharedGuidelines,
		parameters: Type.Object({
			path: Type.String({ description: "Path to a PDF file." }),
			reference: Type.String({ description: "Reference to resolve, e.g. 'chapter 5', 'section 7.3', or 'Virtual Memory'." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = resolveUserPath(params.path, ctx.cwd);
			const result = await resolveReferenceInternal(pi, path, params.reference, signal);
			return { content: [{ type: "text", text: JSON.stringify({ path, reference: params.reference, ...result }, null, 2) }], details: { path, reference: params.reference, ...result } };
		},
	});

	pi.registerTool({
		name: "pdf_extract",
		label: "PDF extract",
		description: "Extract text from selected PDF pages or a resolved section. Defaults to refusing broad extraction for long PDFs. Modes: plain, layout (best for code/tables), blocks (line boxes via pdftotext -tsv), markdown (best-effort headings). Output is page-bounded and truncated by maxChars.",
		promptSnippet: "Read selected PDF pages/sections while preserving page citations and optionally layout/code indentation.",
		promptGuidelines: sharedGuidelines,
		parameters: Type.Object({
			path: Type.String({ description: "Path to a PDF file." }),
			pages: Type.Optional(Type.String({ description: "PDF page spec, e.g. '10', '10-20', '10,12,14-18', or explicit 'all'." })),
			section: Type.Optional(Type.String({ description: "Human section/chapter/topic reference to resolve before extraction." })),
			mode: Type.Optional(StringEnum(["plain", "layout", "blocks", "markdown"] as const, { description: "Extraction mode. Use layout for code/tables. Defaults to layout." })),
			maxChars: Type.Optional(Type.Number({ description: `Maximum characters to return. Defaults to ${DEFAULT_EXTRACT_MAX_CHARS}; hard-capped at ${HARD_EXTRACT_MAX_CHARS}.` })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = resolveUserPath(params.path, ctx.cwd);
			const info = await getPdfInfo(pi, path, signal);
			let pageSpec = params.pages;
			let resolution: ResolvedReference | undefined;
			if (!pageSpec && params.section) {
				resolution = await resolveReferenceInternal(pi, path, params.section, signal);
				pageSpec = resolution.pages;
			}
			if (!pageSpec) {
				if (info.pages > LARGE_DOCUMENT_PAGE_THRESHOLD) {
					const message = `Refusing to extract all ${info.pages} pages from a long PDF by default. Use pdf_outline or pdf_search, then call pdf_extract with pages or section. Source: ${path}`;
					return { content: [{ type: "text", text: message }], details: { path, pages: info.pages, refusedBroadExtraction: true } };
				}
				pageSpec = `1-${Math.max(1, info.pages)}`;
			}
			const pages = parsePageSpec(pageSpec, info.pages);
			if (pages.length === 0) throw new Error(`No valid pages resolved from ${JSON.stringify(pageSpec)}`);
			const mode = params.mode ?? "layout";
			const extracted = await extractPages(pi, path, pages, mode, signal);
			let text = formatExtractedPages(path, extracted, mode);
			if (resolution) {
				text = `[Resolved section ${JSON.stringify(params.section)} -> pages ${resolution.pages} (${resolution.confidence}, ${resolution.method}).${resolution.notes ? ` ${resolution.notes}` : ""}]\n\n${text}`;
			}
			const truncated = truncateToolText(text, params.maxChars);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: {
					path,
					pageSpec,
					pages,
					mode,
					resolution,
					truncated: truncated.truncated,
					omittedChars: truncated.omittedChars,
					qualityByPage: extracted.map((page) => ({ page: page.page, quality: page.quality })),
				},
			};
		},
	});

	pi.registerTool({
		name: "pdf_search",
		label: "PDF search",
		description: "Search one PDF or a whole library. Uses the local page cache/index when available; otherwise falls back to direct pdftotext extraction. Build an index with pdf_index_build for repeated full-library search.",
		promptSnippet: "Search PDFs by literal text or regex and return page-cited snippets.",
		promptGuidelines: sharedGuidelines,
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			path: Type.Optional(Type.String({ description: "Optional single PDF path. If omitted, searches root/library." })),
			root: Type.Optional(Type.String({ description: `Library root when path is omitted. Defaults to ${DEFAULT_LIBRARY_ROOT}.` })),
			regex: Type.Optional(Type.Boolean({ description: "Treat query as a JavaScript regular expression. Defaults to false." })),
			caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive matching. Defaults to false." })),
			maxResults: Type.Optional(Type.Number({ description: `Maximum snippets. Defaults to ${DEFAULT_SEARCH_MAX_RESULTS}.` })),
			context: Type.Optional(Type.Number({ description: "Number of context lines around each matching line. Defaults to 1." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const maxResults = Math.max(1, Math.min(100, params.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS));
			const contextLines = Math.max(0, Math.min(10, params.context ?? 1));
			let paths: string[];
			if (params.path) {
				paths = [resolveUserPath(params.path, ctx.cwd)];
			} else {
				const root = resolveUserPath(params.root ?? DEFAULT_LIBRARY_ROOT, ctx.cwd);
				const catalog = await readCatalog();
				paths = catalog?.root === root && catalog.documents.length > 0 ? catalog.documents.map((doc) => doc.path) : await findPdfs(root);
			}
			const search = await searchPdfDocuments(
				pi,
				params.query,
				paths,
				params.regex ?? false,
				params.caseSensitive ?? false,
				maxResults,
				contextLines,
				signal,
			);
			return {
				content: [{ type: "text", text: formatSearchResults(params.query, search.results, search.indexedDocuments, search.directDocuments) }],
				details: { query: params.query, results: search.results, indexedDocuments: search.indexedDocuments, directDocuments: search.directDocuments },
			};
		},
	});

	async function runIndexTool(
		params: { root?: string; force?: boolean; ocrPoorPages?: boolean; maxDocuments?: number },
		signal: AbortSignal | undefined,
		onUpdate: ((result: any) => void) | undefined,
		ctx: { cwd: string },
	) {
		await ensureCacheDirs();
		const root = resolveUserPath(params.root ?? DEFAULT_LIBRARY_ROOT, ctx.cwd);
		const pdfs = await findPdfs(root);
		const selected = params.maxDocuments ? pdfs.slice(0, Math.max(1, params.maxDocuments)) : pdfs;
		const previous = await readCatalog();
		const previousByPath = new Map((previous?.documents ?? []).map((doc) => [resolve(doc.path), doc]));
		const docs: CatalogDocument[] = [];
		let indexed = 0;
		let skipped = 0;
		let failed = 0;
		const failures: Array<{ path: string; error: string }> = [];
		for (let i = 0; i < selected.length; i++) {
			const path = selected[i]!;
			onUpdate?.({ content: [{ type: "text", text: `Indexing ${i + 1}/${selected.length}: ${path}` }] });
			try {
				const fileStat = await stat(path);
				const previousDoc = previousByPath.get(resolve(path));
				if (!params.force && isIndexedFresh(previousDoc, fileStat)) {
					docs.push(previousDoc!);
					skipped++;
					continue;
				}
				docs.push(await indexOnePdf(pi, path, params.ocrPoorPages ?? false, signal));
				indexed++;
			} catch (error: any) {
				failed++;
				failures.push({ path, error: error?.message ?? String(error) });
				const scanned = await scanOnePdf(pi, path, signal).catch(() => undefined);
				if (scanned) docs.push({ ...scanned, indexed: false });
			}
		}
		const catalog: Catalog = { version: CACHE_VERSION, root, generatedAt: nowIso(), documents: docs };
		await writeCatalog(catalog);
		const result = { root, cacheRoot: cacheRoot(), totalFound: pdfs.length, considered: selected.length, indexed, skipped, failed, failures };
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	}

	const indexParams = Type.Object({
		root: Type.Optional(Type.String({ description: `PDF library root. Defaults to ${DEFAULT_LIBRARY_ROOT}` })),
		force: Type.Optional(Type.Boolean({ description: "Rebuild all cached page text even when files appear unchanged." })),
		ocrPoorPages: Type.Optional(Type.Boolean({ description: "OCR pages with very poor/empty text while indexing. Slow; defaults to false." })),
		maxDocuments: Type.Optional(Type.Number({ description: "Optional cap for quick/test indexing." })),
	});

	pi.registerTool({
		name: "pdf_index_build",
		label: "PDF index build",
		description: `Build a local page-text cache under ${cacheRoot()} for fast repeated PDF searches. Uses pdftotext and optional OCR; no new dependencies.`,
		promptSnippet: "Build or rebuild the local PDF page-text cache for fast library search.",
		promptGuidelines: sharedGuidelines,
		parameters: indexParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runIndexTool({ ...params, force: params.force ?? true }, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "pdf_index_update",
		label: "PDF index update",
		description: `Update the local page-text cache under ${cacheRoot()} for new/changed PDFs only. Uses file size and mtime to skip unchanged documents.`,
		promptSnippet: "Update the PDF page-text cache for changed or new library PDFs.",
		promptGuidelines: sharedGuidelines,
		parameters: indexParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runIndexTool({ ...params, force: params.force ?? false }, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "pdf_render_page",
		label: "PDF render page",
		description: "Render one PDF page to a PNG image with pdftoppm. Use for diagrams, formulas, charts, complex tables, scanned pages, or broken text encoding. Inspect the returned imagePath with Pi's read tool.",
		promptSnippet: "Render a PDF page to PNG for visual inspection with the read tool.",
		promptGuidelines: sharedGuidelines,
		parameters: Type.Object({
			path: Type.String({ description: "Path to a PDF file." }),
			page: Type.Number({ description: "PDF page number to render." }),
			dpi: Type.Optional(Type.Number({ description: "Render DPI. Defaults to 180; clamped to 72-600." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = resolveUserPath(params.path, ctx.cwd);
			const page = Math.max(1, Math.floor(params.page));
			const dpi = Math.max(72, Math.min(600, Math.floor(params.dpi ?? 180)));
			const id = await documentId(path);
			const imagePath = await renderOnePage(pi, path, id, page, dpi, signal);
			const result = { path, page, dpi, imagePath };
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	pi.registerTool({
		name: "pdf_ocr",
		label: "PDF OCR",
		description: "OCR selected PDF pages with pdftoppm+tesseract. Use only as a fallback when normal extraction is empty, scanned, or mojibake. OCR text is cached per document/page/dpi/language.",
		promptSnippet: "OCR selected PDF pages and return page-bounded text.",
		promptGuidelines: sharedGuidelines,
		parameters: Type.Object({
			path: Type.String({ description: "Path to a PDF file." }),
			pages: Type.String({ description: "PDF page spec, e.g. '10', '10-20', '10,12,14-18'." }),
			dpi: Type.Optional(Type.Number({ description: "Render DPI for OCR. Defaults to 300; clamped to 150-600." })),
			language: Type.Optional(Type.String({ description: "Tesseract language. Defaults to 'eng'." })),
			maxChars: Type.Optional(Type.Number({ description: "Maximum OCR text characters to return." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const path = resolveUserPath(params.path, ctx.cwd);
			const info = await getPdfInfo(pi, path, signal);
			const pages = parsePageSpec(params.pages, info.pages);
			const dpi = Math.max(150, Math.min(600, Math.floor(params.dpi ?? 300)));
			const language = params.language ?? "eng";
			const id = await documentId(path);
			const chunks: string[] = [];
			const qualities: Array<{ page: number; quality: TextQuality; cached: boolean }> = [];
			for (let i = 0; i < pages.length; i++) {
				const page = pages[i]!;
				onUpdate?.({ content: [{ type: "text", text: `OCR ${i + 1}/${pages.length}: ${path} page ${page}` }] });
				const textPath = join(ocrDir(id), `page-${page}-dpi-${dpi}-lang-${language.replace(/[^a-zA-Z0-9_+-]/g, "_")}.txt`);
				const cached = await exists(textPath);
				const text = await ocrOnePage(pi, path, id, page, dpi, language, signal);
				const quality = estimateTextQuality(text);
				qualities.push({ page, quality, cached });
				chunks.push(`--- ${path} :: OCR PDF page ${page} (${language}, ${dpi} dpi, confidence unavailable, quality ${quality}) ---\n${text.trimEnd()}`);
			}
			const truncated = truncateToolText(chunks.join("\n\n"), params.maxChars);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: { path, pages, dpi, language, qualityByPage: qualities, truncated: truncated.truncated, cacheDir: ocrDir(id) },
			};
		},
	});

	pi.registerTool({
		name: "pdf_extract_images",
		label: "PDF extract images",
		description: "Extract embedded images from selected PDF pages with pdfimages. Useful for figures/diagrams. Returns output file paths and page/image metadata where Poppler can report it.",
		promptSnippet: "Extract embedded PDF images/figures from selected pages.",
		promptGuidelines: sharedGuidelines,
		parameters: Type.Object({
			path: Type.String({ description: "Path to a PDF file." }),
			pages: Type.Optional(Type.String({ description: "PDF page spec. Defaults to all pages; use a narrow range for large PDFs." })),
			minWidth: Type.Optional(Type.Number({ description: "Only report image metadata at least this wide." })),
			minHeight: Type.Optional(Type.Number({ description: "Only report image metadata at least this tall." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = resolveUserPath(params.path, ctx.cwd);
			const info = await getPdfInfo(pi, path, signal);
			const pages = params.pages ? parsePageSpec(params.pages, info.pages) : Array.from({ length: Math.max(1, info.pages) }, (_, i) => i + 1);
			if (pages.length > 50 && !params.pages) {
				return { content: [{ type: "text", text: `Refusing to extract images from all ${pages.length} pages by default. Provide a narrow pages range.` }], details: { path, refusedBroadExtraction: true, pages: info.pages } };
			}
			const id = await documentId(path);
			const dir = join(cacheRoot(), "images", id);
			await mkdir(dir, { recursive: true });
			const groups = groupContiguous(pages);
			const allMetadata: ReturnType<typeof parsePdfImagesList> = [];
			const before = new Set(await readdir(dir).catch(() => []));
			for (const group of groups) {
				const listArgs = ["-list", "-f", String(group.first), "-l", String(group.last), path];
				const list = await runCommand(pi, "pdfimages", listArgs, signal, 120_000).catch(() => ({ stdout: "" }));
				allMetadata.push(...parsePdfImagesList(list.stdout));
				await runCommand(pi, "pdfimages", ["-png", "-f", String(group.first), "-l", String(group.last), path, join(dir, `pages-${group.first}-${group.last}`)], signal, 240_000).catch(() => undefined);
			}
			let metadata = allMetadata;
			if (params.minWidth) metadata = metadata.filter((item) => (item.width ?? 0) >= params.minWidth!);
			if (params.minHeight) metadata = metadata.filter((item) => (item.height ?? 0) >= params.minHeight!);
			const after = await readdir(dir);
			const imagePaths = after.filter((name) => !before.has(name)).map((name) => join(dir, name));
			const result = { path, pages: pagesToRangeString(pages), outputDir: dir, imagePaths, metadata };
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}
