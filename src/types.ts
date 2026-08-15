export type TextQuality = "good" | "poor" | "none" | "unknown";

export type PdfInfo = {
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

export type OutlineEntry = {
	title: string;
	page?: number;
	depth: number;
	children?: OutlineEntry[];
};

export type FlatOutlineEntry = {
	title: string;
	page?: number;
	depth: number;
};

export type CatalogDocument = {
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

export type Catalog = {
	version: number;
	root: string;
	generatedAt: string;
	documents: CatalogDocument[];
	partial?: boolean;
	notes?: string;
};

// Sidecar metadata lets us verify page-cache freshness even when catalog.json is
// missing, stale, or intentionally not persisted for a maxDocuments test run.
export type PageCacheMetadata = {
	version: number;
	path: string;
	pages: number;
	sizeBytes: number;
	mtimeMs: number;
	indexedAt: string;
	fingerprint: string;
	/** Immutable generation file selected by this atomically published manifest. */
	dataFile?: string;
};

export type CachedPage = {
	page: number;
	text: string;
	/** Legacy cache field; new caches persist only authoritative text. */
	layoutText?: string;
	quality?: TextQuality;
	ocr?: boolean;
};

export type SearchResult = {
	path: string;
	title?: string;
	page: number;
	snippet: string;
	score?: number;
};

export type PageLabel = {
	page: number;
	label: string;
};

export type ResolvedReference = {
	pages: string;
	confidence: "high" | "medium" | "low";
	method: "outline" | "toc" | "page-label" | "search" | "heuristic";
	notes?: string;
};
