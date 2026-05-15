import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export * from "./constants";
export * from "./types";

import { CACHE_VERSION, DEFAULT_EXTRACT_MAX_CHARS, HARD_EXTRACT_MAX_CHARS, PDF_TEXT_CHUNK_SIZE } from "./constants";
import type {
	CachedPage,
	Catalog,
	CatalogDocument,
	FlatOutlineEntry,
	OutlineEntry,
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
	await mkdir(join(root, "pages"), { recursive: true });
	await mkdir(join(root, "outlines"), { recursive: true });
	await mkdir(join(root, "renders"), { recursive: true });
	await mkdir(join(root, "ocr"), { recursive: true });
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
		const detail = (stderr || stdout || `exit code ${code}`).trim();
		throw new Error(`${command} failed: ${detail}`);
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

export function parsePageSpec(spec: string, pageCount?: number): number[] {
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
		if (!/^\d+$/.test(part)) throw new Error(`Invalid page spec segment: ${rawPart}`);
		const single = Number.parseInt(part, 10);
		if (!Number.isFinite(single) || single <= 0) throw new Error(`Invalid page spec segment: ${rawPart}`);
		pages.add(single);
	}

	const result = [...pages].filter((page) => page > 0).sort((a, b) => a - b);
	if (pageCount && pageCount > 0) return result.filter((page) => page <= pageCount);
	return result;
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
			result.push({ page, text, layoutText: extractionMode === "layout" ? text : undefined, quality: estimateTextQuality(text) });
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
			return { page, text, layoutText: mode === "layout" ? text : undefined, quality: estimateTextQuality(text) };
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

export async function findPdfs(root: string): Promise<string[]> {
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
		await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
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
	source: Pick<PdfInfo, "path" | "pages" | "sizeBytes" | "mtimeMs">,
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
	};
	await withFileMutationQueue(path, async () => {
		await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
	});
}

export async function readCachedPages(docId: string, root = cacheRoot()): Promise<CachedPage[] | undefined> {
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

export async function cacheOutline(docId: string, outline: OutlineEntry[], root = cacheRoot()): Promise<void> {
	await ensureCacheDirs(root);
	const path = outlineCachePath(docId, root);
	await withFileMutationQueue(path, async () => {
		await writeFile(path, `${JSON.stringify(outline, null, 2)}\n`, "utf8");
	});
}

export async function loadCachedOutline(docId: string, root = cacheRoot()): Promise<OutlineEntry[] | undefined> {
	try {
		const outline = JSON.parse(await readFile(outlineCachePath(docId, root), "utf8"));
		return Array.isArray(outline) ? (outline as OutlineEntry[]) : undefined;
	} catch {
		return undefined;
	}
}

export function isIndexedFresh(doc: CatalogDocument | undefined, fileStat: { size: number; mtimeMs: number }): boolean {
	if (!doc?.indexed) return false;
	if (doc.sizeBytes !== fileStat.size) return false;
	if (Math.abs(doc.mtimeMs - fileStat.mtimeMs) > 2_000) return false;
	return true;
}

export async function hasFreshPageCache(
	docId: string,
	fileStat: { size: number; mtimeMs: number },
	doc?: CatalogDocument,
	root = cacheRoot(),
): Promise<boolean> {
	if (!(await exists(pageCachePath(docId, root)))) return false;
	const metadataPath = pageCacheMetaPath(docId, root);
	const metadataFileExists = await exists(metadataPath);
	const metadata = metadataFileExists ? await readPageCacheMetadata(docId, root) : undefined;
	if (metadataFileExists) {
		if (!metadata) return false;
		if (metadata.sizeBytes !== fileStat.size) return false;
		if (Math.abs(metadata.mtimeMs - fileStat.mtimeMs) > 2_000) return false;
		return true;
	}
	return isIndexedFresh(doc, fileStat);
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

export async function indexOnePdf(
	pi: ExtensionAPI,
	path: string,
	ocrPoorPages: boolean,
	signal?: AbortSignal,
): Promise<CatalogDocument> {
	const [info, id] = await Promise.all([getPdfInfo(pi, path, signal), documentId(path)]);
	const outline = await getOutline(pi, path, 10, signal);
	const sampleTexts: string[] = [];
	await ensureCacheDirs();
	// Invalidate old freshness metadata before rewriting the page cache. If
	// extraction fails midway, future searches will not trust a partial cache.
	await writeFile(pageCacheMetaPath(id), "", "utf8").catch(() => undefined);
	const cachePath = pageCachePath(id);
	await withFileMutationQueue(cachePath, async () => {
		await writeFile(cachePath, "", "utf8");
		for await (const chunk of extractPageChunks(pi, path, Math.max(1, info.pages), "layout", PDF_TEXT_CHUNK_SIZE, signal)) {
			const prepared: CachedPage[] = [];
			for (const extracted of chunk) {
				let text = extracted.text;
				let quality = extracted.quality ?? estimateTextQuality(text);
				let ocr = false;
				if (ocrPoorPages && (quality === "none" || quality === "poor") && text.trim().length < 200) {
					try {
						text = await ocrOnePage(pi, path, id, extracted.page, 300, "eng", signal);
						quality = estimateTextQuality(text);
						ocr = true;
					} catch {
						// Keep the normal extraction if OCR fails.
					}
				}
				prepared.push({ page: extracted.page, text, layoutText: text, quality, ocr });
				if (sampleTexts.length < 5) sampleTexts.push(text);
			}
			if (prepared.length > 0) {
				await writeFile(cachePath, `${prepared.map((page) => JSON.stringify(page)).join("\n")}\n`, { encoding: "utf8", flag: "a" });
			}
		}
	});
	await writePageCacheMetadata(id, info);
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
		textQuality: estimateTextQuality(sampleTexts.join("\n")),
		indexed: true,
		indexedAt: nowIso(),
	};
}

export async function readFreshCachedPagesForSearch(path: string, doc: CatalogDocument | undefined): Promise<CachedPage[] | undefined> {
	const id = doc?.id ?? (await documentId(path));
	const fileStat = await stat(path);
	if (!(await hasFreshPageCache(id, fileStat, doc))) return undefined;
	return readCachedPages(id);
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

export function formatSearchResults(query: string, results: SearchResult[], fromIndex: number, direct: number): string {
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

export async function searchPdfDocuments(
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
	const byPath = new Map(!catalog?.partial ? (catalog?.documents ?? []).map((doc) => [resolve(doc.path), doc]) : []);
	const results: SearchResult[] = [];
	let indexedDocuments = 0;
	let directDocuments = 0;

	const appendMatches = (pdfPath: string, doc: CatalogDocument | undefined, pages: CachedPage[], fromIndex: boolean) => {
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
	};

	for (const pdfPath of paths) {
		if (results.length >= maxResults) break;
		const doc = byPath.get(resolve(pdfPath));
		try {
			const cached = await readFreshCachedPagesForSearch(pdfPath, doc);
			if (cached) {
				indexedDocuments++;
				appendMatches(pdfPath, doc, cached, true);
				continue;
			}

			directDocuments++;
			const info = await getPdfInfo(pi, pdfPath, signal);
			for await (const chunk of extractPageChunks(pi, pdfPath, Math.max(1, info.pages), "layout", PDF_TEXT_CHUNK_SIZE, signal)) {
				appendMatches(pdfPath, doc, chunk, false);
				if (results.length >= maxResults) break;
			}
		} catch {
			continue;
		}
	}
	return { results, indexedDocuments, directDocuments };
}

export async function renderOnePage(
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

export async function ocrOnePage(
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

