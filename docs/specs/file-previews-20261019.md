# A19 · Files show documents · 19 October 2026

Opening TASKS.md currently shows raw table markup. Files should choose a useful view by type and keep source editing available.

- Markdown (`.md`, `.markdown`) opens rendered by default: headings, GFM tables, links, code blocks and local pictures use the existing MarkdownText styles. Source opens the existing editor; switching views preserves unsaved text. A line reference opens source at its lines.
- PDFs open an actual document viewer, never a textarea of bytes. Existing raster images remain pictures. HTML keeps its built-in browser route; code keeps language coloring, line marks, find and save.
- Preview assets require the private same-origin session and existing canonical path checks. Embedded Markdown assets resolve from the document folder within the project; remote or escaping assets do not load automatically. No raw Markdown HTML executes. The asset route serves only validated raster images/PDFs, with a bounded size.
- Missing, oversized or unsupported documents show a truthful message and retain existing explicit external-open actions. Saving still checks modification time and preserves unsaved drafts on failure.

Implementation: add typed PDF/image asset metadata to the current file read/store, a narrow authenticated asset response, optional file-scoped Markdown link/image resolution and shared Button view controls. No editor rewrite, packages, native changes, cache changes or arbitrary-format support claims.

Acceptance: first capture old-code failures for rendered Markdown and PDF routing; then focused API security/read/save checks and real UI actions (preview/source/edit/save, relative link/image, PDF content, images, code, HTML). Inspect light/dark captures from a private local fixture after one coordinated Next build. No real profile, external calls or install. Root reviews/integrates; revert the focused commit if needed.
