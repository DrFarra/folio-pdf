import type { Annotation } from '../types';
export type Inspection = { annotations: Annotation[]; canAnnotate: boolean; signed: boolean; canEdit: boolean; canAssemble: boolean; canFill: boolean; canCopy: boolean; canPrint: boolean; pages: number; previewBytes?: Uint8Array };
export function open(bytes: Uint8Array, password?: string): import('mupdf').PDFDocument;
export function hasSignature(doc: import('mupdf').PDFDocument): boolean;
export function save(doc: import('mupdf').PDFDocument, options?: string): Uint8Array;
export function inspectDocument(bytes: Uint8Array, password?: string): Inspection;
export function writeAnnotations(bytes: Uint8Array, annotations: Annotation[], password?: string, incremental?: boolean): Uint8Array;
