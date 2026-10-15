export type Area = { page: number; rect: [number, number, number, number] };
export type AreaContentInfo = { text: string; size: number; color: string; fontName: string; mixedStyle: boolean; rotated: boolean };
export type PageContentItem = { id: string; kind: 'text' | 'image' | 'graphic'; level?: 'line' | 'paragraph'; rect: Area['rect']; text?: string; size?: number; color?: string; fontName?: string; mixedStyle?: boolean; rotated?: boolean; editable: boolean; reason?: string; areaReplaceable?: boolean; baselineOffset?: number; lineHeight?: number;
  /** Text: the characters the item's subset font painted on this page, or '*' for a complete font. Image: its opacity, quarter turn and transparency. */
  fontGlyphs?: string; opacity?: number; rotation?: 0 | 90 | 180 | 270; transparent?: boolean;
  /** Graphic: the colours it paints with (null for a pattern), and whether its path also clips. */
  fill?: string | null; stroke?: string | null; clip?: boolean };
export type PageContentInfo = { items: PageContentItem[]; warnings: string[] };
/** A PNG of the page around an item, drawn without it, and the PDF area it covers. */
export type PagePlate = { png: Uint8Array; rect: Area['rect'] };
/** A line of a rebuilt scan, written as real text: its ink box in page points (y down), colour (0–1) and weight. */
export type RebuiltLine = { text: string; box: [number, number, number, number]; color: [number, number, number]; bold: boolean };
/** How many text runs a page paints and how many it keeps invisible (an OCR layer). */
export type TextLayers = { page: number; visible: number; hidden: number };
/** Intrinsic pixels and the quarter turn used to display one safe image instance. JPEG data stays compressed. */
export type PageImageInfo = { bytes: Uint8Array; type: 'image/png' | 'image/jpeg'; width: number; height: number; opacity: number; rotation: 0 | 90 | 180 | 270 };
export type TextOptions = { text: string; size: number; color: string; font?: Uint8Array; fontName?: string; fontFamily?: string; fontIndex?: number; originalFont?: boolean; align?: 'left' | 'center' | 'right'; lineHeight?: number; wrap?: boolean; sourceRect?: Area['rect']; sourceId?: string; baselineOffset?: number };
export type ImageOptions = { image: Uint8Array; fit?: 'contain' | 'cover' | 'stretch'; opacity?: number; rotation?: 0 | 90 | 180 | 270; sourceRect?: Area['rect'] };
export type Field = Area & { id: string; pages: number[]; name: string; label: string; type: string; value: string; readOnly: boolean; multiline: boolean; maxLength: number; options: string[]; exportOptions: string[]; checked: boolean; buttonValue: string };
export type PageEntry = { page?: number; source?: number; blank?: [number, number]; rotation?: number };
export type Operation =
  | { operation: 'fields' | 'text' | 'compress' | 'sanitize' | 'unprotect' }
  | ({ operation: 'area-info' } & Area)
  | { operation: 'page-content'; page: number; graphics?: boolean }
  | { operation: 'page-image'; page: number; id: string }
  | ({ operation: 'page-plate'; id: string; kind: 'text' | 'image' | 'graphic'; scale: number } & Area)
  | { operation: 'pages'; plan: PageEntry[]; sources?: { bytes: Uint8Array; password?: string }[] }
  | { operation: 'split'; parts: PageEntry[][] }
  | { operation: 'fill'; values: Record<string, string | boolean>; flatten?: boolean }
  /** angle turns the page clockwise first (degrees); image replaces it with a flattened scan of size [width, height] points. */
  | { operation: 'ocr'; pages: { page: number; words: { text: string; rect: [number, number, number, number] }[]; angle?: number; image?: Uint8Array; size?: [number, number]; lines?: RebuiltLine[] }[]; font?: Uint8Array }
  | { operation: 'text-layers'; pages: number[] }
  | ({ operation: 'create-field'; name: string; fieldType: 'text' | 'checkbox' | 'combobox'; options?: string[]; multiline?: boolean } & Area)
  | ({ operation: 'add-text' | 'replace-text' } & TextOptions & Area)
  | ({ operation: 'add-image' | 'replace-image' } & ImageOptions & Area)
  | ({ operation: 'remove-content'; id: string; kind: 'text' | 'image' } & Area)
  | ({ operation: 'move-text'; sourceId: string; sourceRect: Area['rect']; copy?: boolean } & Area)
  | ({ operation: 'move-image'; sourceId: string; sourceRect: Area['rect']; copy?: boolean; rotation?: 0 | 90 | 180 | 270; opacity?: number } & Area)
  | ({ operation: 'remove-image' | 'crop' } & Area)
  | ({ operation: 'move-graphic'; sourceId: string; sourceRect: Area['rect']; copy?: boolean } & Area)
  | ({ operation: 'remove-graphic'; sourceId: string; sourceRect: Area['rect'] } & Area)
  | ({ operation: 'recolor-graphic'; sourceId: string; sourceRect: Area['rect']; fill?: string; stroke?: string } & Area)
  | { operation: 'redact'; areas: Area[]; sanitize?: boolean }
  | { operation: 'protect'; userPassword: string; ownerPassword: string; permissions?: number };
export function operateDocument(bytes: Uint8Array, options: Operation, password?: string, onPart?: (index: number, part: Uint8Array) => void): number | Uint8Array | Field[] | string[] | AreaContentInfo | PageContentInfo | PageImageInfo | PagePlate | TextLayers[];
export const EDITS: Set<string>;
/** Several Editar changes to one page as one, each item found again by kind and place. */
export function editDocumentAll(doc: import('mupdf').PDFDocument, operations: Operation[]): void;
/** Applies one Editar change to an open document, checked in place; the caller discards or undoes it on failure. */
export function editDocument(doc: import('mupdf').PDFDocument, options: Operation): void;
export function readPage(doc: import('mupdf').PDFDocument, options: Extract<Operation, { operation: 'page-content' | 'page-image' }>): PageContentInfo | PageImageInfo;
export function pagePlate(doc: import('mupdf').PDFDocument, options: Extract<Operation, { operation: 'page-plate' }>): PagePlate;
export function renderPage(page: import('mupdf').PDFPage, matrix: import('mupdf').Matrix, box: import('mupdf').Rect, alpha?: boolean): import('mupdf').Pixmap;
/** One editable item drawn alone on transparent pixels (a drawing optionally in other colours); the document is not changed. */
export function itemSprite(doc: import('mupdf').PDFDocument, options: { page: number; id: string; kind: 'text' | 'image' | 'graphic'; rect: Area['rect']; scale: number; fill?: string; stroke?: string }): PagePlate;
