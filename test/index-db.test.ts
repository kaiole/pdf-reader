import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cacheRoot, documentId, searchPdfDocuments, sourceFingerprint } from "../src/core";
import { hasFreshSqliteDocument, normalizeSearchText, recordSqliteFailure, replaceSqliteDocument, searchSqliteIndex } from "../src/index-db";
import type { CatalogDocument } from "../src/types";

function doc(path: string, fingerprint: string, pages: number): CatalogDocument {
	return { id: "id", path, title: path.split("/").at(-1), pages, sizeBytes: 10, mtimeMs: 20, sha256: fingerprint, encrypted: false, hasOutline: false, textQuality: "good", indexed: true };
}

test("search normalization joins line-wrap hyphenation without changing original page text", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pdf-sqlite-"));
	const path = join(root, "book.pdf");
	replaceSqliteDocument(root, doc(path, "a", 1), "a", [{ page: 7, text: "An inter-\nnational systems text." }]);
	assert.equal(normalizeSearchText("An inter-\nnational  systems"), "An international systems");
	const found = searchSqliteIndex(root, "international", [path], 10, 1);
	assert.equal(found.results[0]?.page, 7);
	assert.match(found.results[0]?.snippet ?? "", /inter-/);
	assert.match(found.results[0]?.snippet ?? "", /national/);
});

test("literal FTS verification preserves phrase order, punctuation, and late dehyphenated snippets", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pdf-sqlite-"));
	const path = join(root, "literal.pdf");
	replaceSqliteDocument(root, doc(path, "a", 2), "a", [
		{ page: 1, text: "beta appears before alpha; plain C language" },
		{ page: 2, text: "Unrelated heading\nmore preface\nAn inter-\nnational C++ standard says alpha beta." },
	]);
	assert.equal(searchSqliteIndex(root, "alpha beta", [path], 10, 0).results[0]?.page, 2);
	assert.equal(searchSqliteIndex(root, "C++", [path], 10, 0).results[0]?.page, 2);
	assert.equal(searchSqliteIndex(root, "++", [path], 10, 0).representable, false);
	assert.match(searchSqliteIndex(root, "international", [path], 10, 0).results[0]?.snippet ?? "", /inter-/);
	assert.doesNotMatch(searchSqliteIndex(root, "international", [path], 10, 0).results[0]?.snippet ?? "", /Unrelated/);
});

test("literal verification continues past saturated nonliteral BM25 candidates", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pdf-sqlite-"));
	const path = join(root, "saturation.pdf");
	const pages = Array.from({ length: 150 }, (_, i) => ({ page: i + 1, text: "alpha noise noise beta alpha beta".replace("alpha beta", "alpha ... beta") }));
	pages.push({ page: 151, text: `${"padding ".repeat(100)}alpha beta` });
	replaceSqliteDocument(root, doc(path, "a", pages.length), "a", pages);
	assert.equal(searchSqliteIndex(root, "alpha beta", [path], 1, 0).results[0]?.page, 151);
});

test("tokenizer-unrepresentable literals fall back and long snippets retain evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pdf-sqlite-"));
	const path = join(root, "snippet.pdf");
	const line = `${"prefix ".repeat(600)}late literal evidence${" suffix".repeat(100)}`;
	replaceSqliteDocument(root, doc(path, "a", 1), "a", [{ page: 1, text: line }]);
	assert.equal(searchSqliteIndex(root, "___", [path], 1, 0).representable, false);
	const snippet = searchSqliteIndex(root, "late literal evidence", [path], 1, 0).results[0]?.snippet ?? "";
	assert.ok(snippet.length <= 2000);
	assert.match(snippet, /late literal evidence/);
});

test("path filtering is not constrained by SQLite variable limits", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pdf-sqlite-"));
	const path = join(root, "needle.pdf");
	replaceSqliteDocument(root, doc(path, "a", 1), "a", [{ page: 1, text: "needle" }]);
	const paths = Array.from({ length: 33_000 }, (_, i) => join(root, `missing-${i}.pdf`)); paths.push(path);
	assert.equal(searchSqliteIndex(root, "needle", paths, 1, 0).results.length, 1);
});

test("transactional replacement rolls back and failure status is visible", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pdf-sqlite-"));
	const path = join(root, "atomic.pdf");
	replaceSqliteDocument(root, doc(path, "old", 1), "old", [{ page: 1, text: "stable generation" }]);
	assert.throws(() => replaceSqliteDocument(root, doc(path, "new", 2), "new", [
		{ page: 1, text: "partial replacement" }, { page: 1, text: "duplicate page aborts transaction" },
	]), /UNIQUE constraint failed/);
	assert.equal(searchSqliteIndex(root, "stable", [path], 10, 0).results.length, 1);
	assert.equal(searchSqliteIndex(root, "partial", [path], 10, 0).results.length, 0);
	recordSqliteFailure(root, path, "later extraction failed");
	assert.equal(searchSqliteIndex(root, "stable", [path], 10, 0).results.length, 0);
	assert.equal(searchSqliteIndex(root, "stable", [path], 10, 0).failed.length, 1);
	assert.equal(hasFreshSqliteDocument(root, path, 10, 20, "old"), false);
});

test("BM25 ranks a focused page before a weak long-page match and keeps PDF citations", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pdf-sqlite-"));
	const focused = join(root, "focused.pdf");
	const weak = join(root, "weak.pdf");
	replaceSqliteDocument(root, doc(weak, "w", 1), "w", [{ page: 9, text: `${"noise ".repeat(500)}mutex` }]);
	replaceSqliteDocument(root, doc(focused, "f", 1), "f", [{ page: 3, text: "mutex mutex mutex synchronization" }]);
	const results = searchSqliteIndex(root, "mutex", [weak, focused], 10, 0).results;
	assert.equal(results[0]?.path, focused);
	assert.equal(results[0]?.page, 3);
});

test("failed indexing status is visible to search diagnostics", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pdf-sqlite-"));
	const path = join(root, "broken.pdf");
	recordSqliteFailure(root, path, "malformed PDF");
	const result = searchSqliteIndex(root, "anything", [path], 10, 0);
	assert.deepEqual(result.failed, [{ path, error: "malformed PDF" }]);
});

test("library search uses SQLite and never parses the legacy JSONL corpus", async () => {
	const temp = await mkdtemp(join(tmpdir(), "pi-pdf-library-"));
	const previousXdg = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = join(temp, "cache");
	try {
		const path = join(temp, "indexed.pdf");
		await writeFile(path, "source generation");
		const file = await import("node:fs/promises").then(({ stat }) => stat(path));
		const fingerprint = await sourceFingerprint(path);
		const indexedDoc = { ...doc(path, fingerprint, 1), sizeBytes: file.size, mtimeMs: file.mtimeMs };
		replaceSqliteDocument(cacheRoot(), indexedDoc, fingerprint, [{ page: 4, text: "transactional lexical retrieval" }]);
		const id = await documentId(path);
		await mkdir(join(cacheRoot(), "pages"), { recursive: true });
		await writeFile(join(cacheRoot(), "pages", `${id}.jsonl`), "this is deliberately not json\n");
		const pi = { exec: async () => { throw new Error("direct extraction must not run"); } } as any;
		const result = await searchPdfDocuments(pi, "lexical retrieval", [path], false, false, 10, 0);
		assert.equal(result.indexedDocuments, 1);
		assert.equal(result.directDocuments, 0);
		assert.equal(result.results[0]?.page, 4);
		assert.match(result.results[0]?.snippet ?? "", /lexical retrieval/);

		await writeFile(path, "changed generation");
		const stale = await searchPdfDocuments(pi, "lexical retrieval", [path], false, false, 10, 0);
		assert.equal(stale.staleDocuments, 1);
		assert.equal(stale.indexedDocuments, 0);
		assert.match(stale.failures[0]?.error ?? "", /direct extraction must not run/);
	} finally {
		if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = previousXdg;
	}
});
