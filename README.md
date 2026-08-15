# pi-pdf-reader

Local Pi extension for reading technical PDFs with Poppler, qpdf, Tesseract, and SQLite FTS5.

## Core model-facing tools

Exactly four PDF tools are active by default:

- `pdf_inspect` — metadata, extraction quality, compact page-label samples, index freshness, and opt-in bounded outline.
- `pdf_search` — BM25-ranked, page-cited indexed search; direct/regex/case-sensitive fallback is traversal ordered.
- `pdf_read` — bounded explicit pages or one resolved section in plain/layout/blocks/markdown modes; `pages` and `section` are mutually exclusive.
- `pdf_render` — render one page to PNG for visual inspection with Pi's `read` tool.

Legacy tool names remain registered for resumed-session compatibility but are inactive. Optional OCR and embedded-image tools can be enabled explicitly without disabling tools from other extensions.

## Commands

Index maintenance stays outside ordinary model context:

```text
/pdf-index status
/pdf-index update [library-root]
/pdf-index build [library-root]
```

Optional tools are lazy and disabled at session start:

```text
/pdf-tools list
/pdf-tools enable ocr
/pdf-tools enable images
/pdf-tools enable all
/pdf-tools disable ocr
/pdf-tools disable all
```

Enabling OCR exposes `pdf_ocr`; enabling images exposes `pdf_extract_images`. A new/reloaded session returns to the four core PDF tools.

## Structure

- `index.ts` — Pi extension entry point.
- `src/tools.ts` — core/compatibility tools and maintenance commands.
- `src/core.ts` — PDF/cache/search/render/OCR backend helpers.
- `src/index-db.ts` — transactional SQLite FTS5 index.
- `src/constants.ts` / `src/types.ts` — limits and shared types.
- `skills/pdf-reading/SKILL.md` — progressively disclosed reading workflow.

## Requirements

Use Node.js 22.5 or newer with built-in `node:sqlite` and SQLite FTS5 (Node 24+ recommended). System tools:

```bash
pdftotext pdfinfo qpdf pdftoppm pdfimages tesseract
```

Install the Tesseract language packs you use (for example `tesseract-ocr-eng`). OCR checks requested language data before running.

## Use

```bash
pi -e .
```

Or install locally:

```bash
pi install /home/red/dotfiles/pi/picosystem/pdf-reader
```

## Storage and correctness

The search index is `~/.cache/pi-pdf/search-index.sqlite3`. It stores original page text for quotations/citations plus normalized FTS text that repairs line-wrap hyphenation. Artifact identities include source fingerprints and relevant options, so replacing a PDF does not reuse old text, outlines, OCR, renders, or images.

Cache files can contain sensitive extracted text and images; private permissions are requested where supported. Remove `~/.cache/pi-pdf` to clear retained content. Per-document writer serialization is process-local, so avoid concurrent index writers from multiple Pi processes.

Model-requested page operations are bounded to 100 pages. Every tool response is capped at Pi's 50 KB / 2,000-line limits. Search reports stale/failed documents and uses direct extraction when appropriate.
