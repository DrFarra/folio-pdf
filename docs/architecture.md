# How Folio fits together

For finding a symbol, use `graphify query/path/explain` or `graphify-out/wiki/index.md`.
This page holds what the graph cannot show: the paths a document takes and the
rules that break things when ignored. Read the files named before changing them.

## Layers

| Layer | Where | Role |
|---|---|---|
| UI (React) | `src/App.tsx` (shell, tabs, open/save, undo), `src/components/*` | One big `App()`; tools live in `Workbench.tsx`. |
| Reader | `src/components/PDFPage.tsx`, `src/pdf.ts` | PDF.js renders pages; virtualized with `useNearby`. |
| Editor (desktop) | `src/edit/*` | Edits on the reader pages: `store.ts` state, `EditLayer.tsx` per page, `actions.ts` commits, `fonts.ts`. |
| Editor (touch) | `Workbench` → `PdfContentPicker.tsx` + `ContentEditor.tsx` | Tablet inline, phone modal. |
| Engine | `src/engine/operations.mjs` (`operateDocument`), `mupdf-engine.mjs` (open, save, annotations) | MuPDF WASM in a Web Worker (`pdf.worker.ts`), called through `client.ts` (`processPdf`, `splitPdf`, `getPageContent`…). |
| Platform glue | `src/platform.ts`, `src/binary.ts`, `src/nativePdf.ts`, `src/drive.ts`, `src/storage.ts` | Picks web / desktop / iOS / Android paths. |
| Native | `src-tauri/src/lib.rs` (desktop commands), `ios_commands.rs`, `android_commands.rs`, `drive*.rs`, `binary_ipc.rs`; shared Rust in `crates/folio-core` | File access by token, atomic writes, Drive, system fonts. |
| Native plugins | `src-tauri/plugins/folio-ios` (Swift, PDFKit reader for big PDFs), `folio-android` (Kotlin) | |

## A document's life

1. **Open**: `loadDocument` in `App.tsx`. Native files are read by token (`read_document` / `read_document_range` in chunks); iOS PDFs over 32 MB stay file-backed in PDFKit (`openNativePdf`, `isNativePdfDocument`) and most tools refuse them. Bytes are lent to the engine (`inspectOwnedPdf`) so a big book is held twice, not three times. `inspectDocument` removes the annotations Folio draws itself (highlight, note, ink, its own shapes) from the PDF.js copy.
2. **Read**: `pageStack` renders `PDFPage` per page, keyed by page number; a new revision swaps pixels in place.
3. **Annotate**: annotations live in React state (`commitAnnotations`, undo stack) and the session (`storage.ts`); written into the PDF only on save/export (`exportAnnotated` → `writeAnnotations`).
4. **Edit content**: `applyOperation` → `exportAnnotated` (skipped when unchanged, `bytesAnnotations`) → `processPdf` → `openDocument(output, { preserveHistory, quiet })` → undo snapshot. `quiet` keeps scroll and hides the loading screen.
5. **Draft**: every modified revision is stored as a draft (`ensureDraft`, IndexedDB on web, Rust store natively) and recovered on reopen.
6. **Save**: `download()` → `savePdf` / `saveOriginalPdf` / Drive (`saveDriveDocument`). Native writes need an output token from `choose_output`/`choose_export`/`choose_folder` and go through `write_*` (`atomic_write`, `protect_original`).

## Rules that bite

- Engine memory: MuPDF WASM caps near 1.8 GB and saves to an in-heap buffer; PDFs over ~0.75 GB cannot be saved modified (`save()` gives a Spanish error). Open PDFs ≥ 32 MB are streamed, not copied.
- Workers: one request each; a worker that errored or handled > 32 MB is discarded (`client.ts`). Long jobs keep alive by posting progress (`split` parts).
- Content edits are redaction + redraw (`redactPage`, `appendDrawing`), always followed by `verifyRetainedGlyphs`; failures never return a partial PDF. `appendDrawing` must not re-wrap q/Q per edit.
- Page item ids (`text-paragraph-b3`, `image-2`) are positional: valid only for the revision they were read from.
- Shapes are Folio annotations (Square/Circle/Line), editable only when created by Folio (`NM` starts with `Folio:`).
- The PDF's own drawings (boxes, rules) are read from the page's content streams (`pageDrawings`) and edited by rewriting their operators in place (`editDrawing`), so stacking order is kept; paths inside Form XObjects are not listed. Ids `graphic-N` are positional like the others.
- Editar's saves use `QUICK` (no object deduplication): deduplicating a PDF with thousands of objects takes seconds per edit.
- Binary IPC: Android sends base64 in 2 MiB slices; the bridge cap is 128 MiB (`binary_ipc.rs`).
- Layout: `useDeviceLayout` — web is desktop unless a narrow coarse pointer; tablet needs an Android/iPad UA. The desktop app is always desktop.
- CI builds with `cargo --locked`; there is no Rust toolchain on the Windows dev PC, so Rust only compiles in CI.

## Tests

Plain Node + Playwright scripts in `scripts/tests` (`npm run test:<name>`; `npm test` runs all after a build). Engine suites import the engine directly; UI suites serve `dist/` with `vite preview`. Desktop editor: `edit-mode-ui.mjs` (also in WebKit on the Mac build); touch editor suites run as an Android tablet (`ui-helpers.mjs`). Mac packaging requires named evidence files (`scripts/package-macos.py`).
