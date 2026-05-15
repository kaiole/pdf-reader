import { mkdir, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	DEFAULT_LIBRARY_ROOT,
	DEFAULT_EXTRACT_MAX_CHARS,
	HARD_EXTRACT_MAX_CHARS,
	LARGE_DOCUMENT_PAGE_THRESHOLD,
	DEFAULT_SEARCH_MAX_RESULTS,
	cacheRoot,
	catalogCoversPaths,
	documentId,
	ensureCacheDirs,
	extractPages,
	findPdfs,
	formatExtractedPages,
	formatOutline,
	formatSearchResults,
	getOutline,
	getPdfInfo,
	groupContiguous,
	hasFreshPageCache,
	indexOnePdf,
	mergeCatalogDocuments,
	ocrDir,
	ocrOnePage,
	pagesToRangeString,
	parsePageSpec,
	parsePdfImagesList,
	renderOnePage,
	resolveReferenceInternal,
	resolveUserPath,
	sampleTextQuality,
	scanOnePdf,
	searchPdfDocuments,
	sha1,
	truncateToolText,
	writeCatalog,
	readCatalog,
} from "./core";

const pathSchema = Type.Object({
	path: Type.String({ description: "Path to a PDF file. Relative paths are resolved from the current working directory; leading @ is accepted." }),
});

export function registerPdfTools(pi: ExtensionAPI) {
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
			const partialScan = selected.length !== pdfs.length;
			const previous = await readCatalog();
			let persistedCatalog = false;
			let catalogDocumentCount = docs.length;
			if (partialScan) {
				if (catalogCoversPaths(previous, root, pdfs)) {
					const merged = mergeCatalogDocuments(previous.documents, docs);
					await writeCatalog({ version: CACHE_VERSION, root, generatedAt: nowIso(), documents: merged });
					persistedCatalog = true;
					catalogDocumentCount = merged.length;
				}
			} else {
				await writeCatalog({ version: CACHE_VERSION, root, generatedAt: nowIso(), documents: docs });
				persistedCatalog = true;
			}

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
			const text = JSON.stringify({ root, cache: cacheRoot(), partialScan, persistedCatalog, catalogDocumentCount, documents: compact }, null, 2);
			const truncated = truncateToolText(text, 60_000);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: { root, cacheRoot: cacheRoot(), documents: compact, scanned: docs.length, totalFound: pdfs.length, partialScan, persistedCatalog, catalogDocumentCount },
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
			const catalogDoc = !catalog?.partial ? catalog?.documents.find((doc) => resolve(doc.path) === resolve(path)) : undefined;
			const indexed = await hasFreshPageCache(id, { size: info.sizeBytes, mtimeMs: info.mtimeMs }, catalogDoc);
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
				const discovered = await findPdfs(root);
				paths = catalogCoversPaths(catalog, root, discovered) ? catalog.documents.map((doc) => doc.path) : discovered;
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
		const previousFull = previous?.root === root && !previous.partial ? previous : undefined;
		const previousByPath = new Map((previousFull?.documents ?? []).map((doc) => [resolve(doc.path), doc]));
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
				const docId = previousDoc?.id ?? (await documentId(path));
				if (!params.force && (await hasFreshPageCache(docId, fileStat, previousDoc))) {
					docs.push(previousDoc ?? (await scanOnePdf(pi, path, signal)));
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
		const partialRun = selected.length !== pdfs.length;
		let persistedCatalog = false;
		let catalogDocumentCount = docs.length;
		if (partialRun) {
			if (catalogCoversPaths(previousFull, root, pdfs)) {
				const merged = mergeCatalogDocuments(previousFull.documents, docs);
				await writeCatalog({ version: CACHE_VERSION, root, generatedAt: nowIso(), documents: merged });
				persistedCatalog = true;
				catalogDocumentCount = merged.length;
			}
		} else {
			await writeCatalog({ version: CACHE_VERSION, root, generatedAt: nowIso(), documents: docs });
			persistedCatalog = true;
		}
		const result = { root, cacheRoot: cacheRoot(), totalFound: pdfs.length, considered: selected.length, indexed, skipped, failed, failures, partialRun, persistedCatalog, catalogDocumentCount };
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
			const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".jp2", ".ppm", ".pbm", ".pgm"]);
			const metadata: Array<ReturnType<typeof parsePdfImagesList>[number] & { imagePath?: string }> = [];
			const imagePathsSet = new Set<string>();
			for (const group of groups) {
				const listArgs = ["-list", "-f", String(group.first), "-l", String(group.last), path];
				const list = await runCommand(pi, "pdfimages", listArgs, signal, 120_000).catch(() => ({ stdout: "" }));
				const groupMetadata = parsePdfImagesList(list.stdout);
				const prefix = join(dir, `pages-${group.first}-${group.last}`);
				const prefixBase = basename(prefix);
				await runCommand(pi, "pdfimages", ["-png", "-f", String(group.first), "-l", String(group.last), path, prefix], signal, 240_000).catch(() => undefined);
				const files = (await readdir(dir))
					.filter((name) => name.startsWith(`${prefixBase}-`) && imageExtensions.has(name.slice(name.lastIndexOf(".")).toLowerCase()))
					.sort();

				if (groupMetadata.length === 0) {
					if (!params.minWidth && !params.minHeight) {
						for (const file of files) imagePathsSet.add(join(dir, file));
					}
					continue;
				}

				groupMetadata.forEach((item, index) => {
					if (params.minWidth && (item.width ?? 0) < params.minWidth) return;
					if (params.minHeight && (item.height ?? 0) < params.minHeight) return;
					const imagePath = files[index] ? join(dir, files[index]) : undefined;
					metadata.push({ ...item, imagePath });
					if (imagePath) imagePathsSet.add(imagePath);
				});
			}
			const imagePaths = [...imagePathsSet].sort();
			const result = { path, pages: pagesToRangeString(pages), outputDir: dir, imagePaths, metadata };
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}
