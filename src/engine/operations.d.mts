export type Area = { page: number; rect: [number, number, number, number] };
export type AreaContentInfo = { text: string; size: number; color: string; fontName: string; mixedStyle: boolean; rotated: boolean };
export type PageContentItem = { id: string; kind: 'text' | 'image'; level?: 'line' | 'paragraph'; rect: Area['rect']; text?: string; size?: number; color?: string; fontName?: string; mixedStyle?: boolean; rotated?: boolean; editable: boolean; reason?: string; baselineOffset?: number; lineHeight?: number };
export type PageContentInfo = { items: PageContentItem[]; warnings: string[] };
/** Intrinsic pixels and the quarter turn used to display one safe image instance. */
export type PageImageInfo = { bytes: Uint8Array; width: number; height: number; opacity: number; rotation: 0 | 90 | 180 | 270 };
export type TextOptions = { text: string; size: number; color: string; font?: Uint8Array; fontName?: string; align?: 'left' | 'center' | 'right'; lineHeight?: number; wrap?: boolean; sourceRect?: Area['rect']; baselineOffset?: number };
export type ImageOptions = { image: Uint8Array; fit?: 'contain' | 'cover' | 'stretch'; opacity?: number; rotation?: 0 | 90 | 180 | 270; sourceRect?: Area['rect'] };
export type Field = Area & { id: string; name: string; label: string; type: string; value: string; readOnly: boolean; multiline: boolean; maxLength: number; options: string[]; exportOptions: string[]; checked: boolean; buttonValue: string };
export type PageEntry = { page?: number; source?: number; blank?: [number, number]; rotation?: number };
export type Operation =
  | { operation: 'fields' | 'text' | 'compress' | 'sanitize' | 'unprotect' }
  | ({ operation: 'area-info' } & Area)
  | { operation: 'page-content'; page: number }
  | { operation: 'page-image'; page: number; id: string }
  | { operation: 'pages'; plan: PageEntry[]; sources?: { bytes: Uint8Array; password?: string }[] }
  | { operation: 'fill'; values: Record<string, string | boolean>; flatten?: boolean }
  | { operation: 'ocr'; pages: { page: number; words: { text: string; rect: [number, number, number, number] }[] }[]; font?: Uint8Array }
  | ({ operation: 'create-field'; name: string; fieldType: 'text' | 'checkbox' | 'combobox'; options?: string[]; multiline?: boolean } & Area)
  | ({ operation: 'add-text' | 'replace-text' } & TextOptions & Area)
  | ({ operation: 'add-image' | 'replace-image' } & ImageOptions & Area)
  | ({ operation: 'remove-image' | 'crop' } & Area)
  | { operation: 'redact'; areas: Area[]; sanitize?: boolean }
  | { operation: 'protect'; userPassword: string; ownerPassword: string; permissions?: number };
export function operateDocument(bytes: Uint8Array, options: Operation, password?: string): Uint8Array | Field[] | string[] | AreaContentInfo | PageContentInfo | PageImageInfo;
