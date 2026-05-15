---
name: pdf-reading
description: Read, search, summarize, and analyze technical PDFs using the pi-pdf-reader tools. Use for books, research papers, specifications, C++/systems texts, diagrams, tables, OCR fallback, and page-cited explanations.
---

# PDF Reading

Use this skill when the user asks to find, read, summarize, explain, or compare material in PDFs.

Primary library root:

```text
~/vault/sources/
```

The library may contain subdirectories such as:

```text
~/vault/sources/books/
~/vault/sources/papers/
```

## Core workflow

1. Discover or identify the PDF.
   - Use `pdf_library_scan` for library discovery.
   - Use `pdf_search` when the user asks for a topic across books/papers.
   - Use `pdf_info` when working with a specific PDF for the first time.

2. For long PDFs, inspect structure before reading.
   - Use `pdf_outline` for books, specs, and PDFs with bookmarks.
   - Use `pdf_resolve_reference` for references like "chapter 5", "section 7.3", "Virtual Memory", or "page 214".

3. Extract narrowly.
   - Prefer `pdf_extract` with explicit `pages` or `section`.
   - Do not extract an entire long book unless the user explicitly asks.
   - For broad chapter requests, extract a small resolved range first, summarize, then continue if needed.

4. Preserve technical formatting.
   - Use `mode: "layout"` for code, tables, packet layouts, algorithms, diagrams-as-text, and C++ examples.
   - Use `mode: "plain"` for prose-heavy pages.
   - Use `mode: "blocks"` only when coordinates/layout structure matters.
   - Use `mode: "markdown"` for rough heading-oriented summaries.

5. Use visual/OCR fallbacks only when appropriate.
   - Use `pdf_render_page` for diagrams, formulas, figures, charts, complex tables, or broken extraction.
   - After `pdf_render_page`, inspect the returned `imagePath` with Pi's `read` tool.
   - Use `pdf_ocr` only when normal extraction is empty, scanned, or mojibake.
   - Use `pdf_extract_images` for embedded figures/diagrams when the user asks about images or figures.

## Citation requirements

Always include source citations in answers based on PDF content:

```text
<path> :: PDF page <n>
```

When summarizing multiple pages, cite the page range or representative page citations.

Do not cite printed book page numbers unless you have explicitly resolved them. PDF page numbers and printed page numbers often differ.

## Search strategy

For a topic in one PDF:

1. Use `pdf_outline` if it is a book/spec with bookmarks.
2. Use `pdf_search` with the PDF path for topic terms.
3. Use `pdf_extract` on the most relevant pages.
4. If text looks corrupted, render or OCR the relevant pages.

For a topic across the library:

1. Use `pdf_search` with `root: "~/vault/sources"`.
2. Compare snippets and page citations.
3. Extract only the most relevant pages from top hits.
4. Tell the user which sources were searched if results are sparse.

If repeated library search is slow, use `pdf_index_update` on `~/vault/sources`.

## Book workflow

For books and long technical manuals:

1. `pdf_info`
2. `pdf_outline` with `maxDepth: 3` to start
3. `pdf_resolve_reference` for the target chapter/section
4. `pdf_extract` with `mode: "layout"` for code-heavy sections
5. Summarize with page citations
6. Ask or continue with narrower subsections if the section is large

Avoid reading hundreds of pages at once.

## Research paper workflow

For research papers:

1. Use `pdf_info` to learn page count/title metadata.
2. Extract page 1 first in `layout` mode to identify title, authors, abstract, and section layout.
3. Use `pdf_search` for headings such as:
   - `Abstract`
   - `Introduction`
   - `Conclusion`
   - `References`
   - `Related Work`
   - `Evaluation`
4. Extract the relevant page ranges.
5. Use `pdf_render_page` for figures, plots, equations, and architecture diagrams.

When summarizing a paper, structure the answer around:

- problem/motivation
- key idea/contribution
- method/design
- evaluation/results
- limitations
- important figures/tables
- related work/references when relevant

## Troubleshooting

If `pdf_extract` output is empty or garbled:

1. Try `mode: "layout"` if not already used.
2. Use `pdf_render_page` to visually inspect the page.
3. Use `pdf_ocr` on the same page range if it is scanned or mojibake.

If page references seem wrong:

1. Use `pdf_outline` to get PDF page destinations.
2. Use `pdf_resolve_reference` for printed-page or chapter references.
3. State uncertainty if printed page numbers cannot be resolved.
