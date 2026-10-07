import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from '../platform';
import { assetUrl } from '../assets';
import type { TextOptions } from '../engine/operations.mjs';

// Text written in Editar uses, in order: the PDF's own font when it has every
// character; the same family installed on the computer; then the closest of
// Helvetica, Times or Courier. "family" values: 'original', 'helvetica',
// 'times', 'courier', 'dm-sans' or 'system:<family name>'.

export type FontFields = Pick<TextOptions, 'font' | 'fontName' | 'fontFamily' | 'fontIndex' | 'originalFont'>;
export type FontRequest = { family: string; bold: boolean; italic: boolean };

/** "ABCDEF+TimesNewRomanPS-BoldItalicMT" → Times New Roman, bold, italic. */
export function parseFontName(name: string): { family: string; bold: boolean; italic: boolean; kind: 'sans' | 'serif' | 'mono' } {
  const plain = name.replace(/^[A-Z]{6}\+/, '');
  const [base, ...rest] = plain.split(/[-,]/), style = rest.join(' ') + ' ' + base;
  const family = base.replace(/(PSMT|PS|MT|Std|LTStd|Pro)$/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').trim() || plain;
  const bold = /bold|black|heavy|semi|demi|medi(?!um)/i.test(style), italic = /italic|oblique|ital\b/i.test(style);
  const kind = /courier|mono|consol|code|typewriter|cmtt/i.test(plain) ? 'mono' : /times|roman|serif|georgia|garamond|cambria|book|palatino|minion|baskerville|caslon|nimbusrom|cmr\d|cmti|century/i.test(plain) ? 'serif' : 'sans';
  return { family, bold, italic, kind };
}

const standard = {
  helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
} as const;
const standardName = (family: keyof typeof standard, bold: boolean, italic: boolean) => standard[family][(bold ? 1 : 0) + (italic ? 2 : 0)];

const fileCache = new Map<string, Promise<Uint8Array>>();
const fetchFont = (url: string) => {
  let request = fileCache.get(url);
  if (!request) {
    request = fetch(url).then(async response => { if (!response.ok) throw new Error('No se pudo cargar la fuente.'); return new Uint8Array(await response.arrayBuffer()); });
    fileCache.set(url, request); request.catch(() => fileCache.delete(url));
  }
  return request;
};

type SystemFace = { id: number; family: string; index: number; postScriptName: string };
const systemCache = new Map<string, Promise<SystemFace | null>>();
/** A font installed on this computer (Windows and macOS only). */
export function systemFace(name: string, bold: boolean, italic: boolean): Promise<SystemFace | null> {
  if (!isDesktop) return Promise.resolve(null);
  const key = `${name}|${bold}|${italic}`;
  let request = systemCache.get(key);
  if (!request) { request = invoke<SystemFace | null>('system_font_match', { name, bold, italic }).catch(() => null); systemCache.set(key, request); }
  return request;
}
let families: Promise<string[]> | undefined;
export const systemFamilies = () => families ??= isDesktop ? invoke<string[]>('system_font_families').catch(() => []) : Promise.resolve([]);
async function systemFields(face: SystemFace): Promise<FontFields> {
  let request = fileCache.get(`system:${face.id}`);
  if (!request) { request = invoke<ArrayBuffer>('system_font_data', { id: face.id }).then(data => new Uint8Array(data)); fileCache.set(`system:${face.id}`, request); request.catch(() => fileCache.delete(`system:${face.id}`)); }
  return { font: await request, fontFamily: face.postScriptName || face.family, fontIndex: face.index };
}

/** The engine options for a font choice. `original` is the font name of the replaced text. */
export async function fontFields(request: FontRequest, original?: string): Promise<{ fields: FontFields; label: string }> {
  const { family, bold, italic } = request;
  if (family === 'original' && original) {
    // The same family, as installed or as its closest standard font.
    const parsed = parseFontName(original), exact = !!parsed.bold === bold && !!parsed.italic === italic;
    const face = await systemFace(exact ? original.replace(/^[A-Z]{6}\+/, '') : parsed.family, bold, italic) || await systemFace(parsed.family, bold, italic);
    if (face) return { fields: await systemFields(face), label: face.family };
    const fallback = parsed.kind === 'serif' ? 'times' : parsed.kind === 'mono' ? 'courier' : 'helvetica';
    return { fields: { fontName: standardName(fallback, bold, italic) }, label: fallback[0].toUpperCase() + fallback.slice(1) };
  }
  if (family.startsWith('system:')) {
    const face = await systemFace(family.slice(7), bold, italic);
    if (face) return { fields: await systemFields(face), label: face.family };
  }
  if (family === 'dm-sans') return { fields: { font: await fetchFont(assetUrl(`/fonts/dm-sans-${bold ? 'semibold' : 'regular'}.ttf`)) }, label: 'DM Sans' };
  const name = family === 'times' || family === 'courier' ? family : 'helvetica';
  return { fields: { fontName: standardName(name, bold, italic) }, label: name[0].toUpperCase() + name.slice(1) };
}

/** Whether every character can be drawn with the font the PDF already uses for this text. */
export const originalCovers = (text: string, glyphs = '') => glyphs === '*' || [...text].every(c => !c.trim() || glyphs.includes(c));
