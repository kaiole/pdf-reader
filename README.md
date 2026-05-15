# pi-pdf-reader

Pi extension for reading technical PDFs with Poppler/qpdf/Tesseract tools.

## Tools

- `pdf_library_scan` — scan `~/vault/sources` or another root and refresh a compact catalog.
- `pdf_info` — detailed metadata for one PDF.
- `pdf_outline` — extract bookmarks/table of contents.
- `pdf_resolve_reference` — resolve `chapter 5`, `section 7.3`, `page 214`, or topic text to PDF pages.
- `pdf_extract` — page-bounded text extraction with `plain`, `layout`, `blocks`, or `markdown` modes.
- `pdf_search` — page-cited search in one PDF or the library, using cache when available.
- `pdf_index_build` / `pdf_index_update` — build/update the page-text cache under `~/.cache/pi-pdf`.
- `pdf_render_page` — render a page to PNG for visual inspection via Pi's `read` tool.
- `pdf_ocr` — OCR selected pages with Tesseract; cached per page/dpi/language.
- `pdf_extract_images` — extract embedded PDF images/figures.

## Structure

- `index.ts` — Pi extension entry point.
- `src/tools.ts` — `pi.registerTool(...)` definitions and tool orchestration.
- `src/core.ts` — PDF/cache/search/render/OCR backend helpers.
- `src/constants.ts` — defaults and limits.
- `src/types.ts` — shared TypeScript types.
- `skills/pdf-reading/SKILL.md` — workflow skill for PDF reading/searching/summarization.

## Requirements

The extension uses existing system tools:

```bash
pdftotext pdfinfo qpdf pdftoppm pdfimages tesseract
```

## Use

From this directory:

```bash
pi -e .
```

Install globally:

```bash
pi install /home/red/dotfiles/pi/picosystem/pdf-reader
```

Or add it to project settings as a local package.

## Notes

The first version intentionally avoids runtime npm dependencies. The index is a JSONL page cache plus `catalog.json` in `~/.cache/pi-pdf`; this keeps search fast after indexing without native SQLite dependencies. A future version can add SQLite FTS or a PyMuPDF backend for better structured layout extraction.
