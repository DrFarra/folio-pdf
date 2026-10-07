import * as mupdf from 'mupdf';
import { DEFAULT_HIGHLIGHT_OPACITY } from './highlight-style.mjs';

const supported = new Set(['Highlight', 'Text', 'Ink', 'Square', 'Circle', 'Line']);
// Shapes keep styles Folio does not draw (clouds, dashes, captions), so only its own are managed.
const shapes = { Square: 'rect', Circle: 'ellipse', Line: 'line' };
const LOCKED = mupdf.PDFAnnotation.IS_READ_ONLY | mupdf.PDFAnnotation.IS_LOCKED | mupdf.PDFAnnotation.IS_LOCKED_CONTENTS;
const point = (x, y, m) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const colorHex = color => {
  const rgb = color.length === 1 ? [color[0], color[0], color[0]] : color.length === 3 ? color : [1, .82, .3];
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
};
const colorRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

// A large PDF is read from its bytes on demand instead of being copied into
// the WASM heap, so a 1 GB book does not need another gigabyte to open.
const LARGE_SOURCE = 32 * 1024 * 1024;
const source = bytes => bytes.length < LARGE_SOURCE ? bytes : new mupdf.Stream({
  fileSize: () => bytes.length,
  read(memory, offset, length, position) { const count = Math.max(0, Math.min(length, bytes.length - position)); memory.set(bytes.subarray(position, position + count), offset); return count; },
  close() {},
});

export function open(bytes, password = '') {
  const doc = new mupdf.PDFDocument(source(bytes));
  try {
    if (doc.needsPassword()) { if (!doc.authenticatePassword(password)) throw new Error('Este PDF está protegido. Escribe su contraseña.'); }
    // A PDF with only an owner password opens without one; that password still grants its owner permissions.
    // A failed attempt clears the stored keys, so the empty user password is authenticated again.
    else if (password && !doc.authenticatePassword(password)) doc.authenticatePassword('');
    doc.disableJS();
    return doc;
  } catch (e) { doc.destroy(); throw e; }
}

export function hasSignature(doc) {
  const root = doc.getTrailer().get('Root');
  if (!root.get('Perms', 'DocMDP').isNull()) return true;
  const fields = root.get('AcroForm', 'Fields');
  const seen = new Set();
  function walk(array, depth = 0, inheritedType = '') {
    if (depth > 32) throw new Error('La estructura de campos del PDF es demasiado compleja.');
    for (let i = 0; i < array.length; i++) {
      const field = array.get(i), ref = field.asIndirect();
      if (ref && seen.has(ref)) continue;
      if (ref) seen.add(ref);
      const fieldType = field.get('FT').asName() || inheritedType;
      if (fieldType === 'Sig' && !field.get('V').isNull()) return true;
      if (walk(field.get('Kids'), depth + 1, fieldType)) return true;
    }
    return false;
  }
  return walk(fields);
}

function editable(annotation) {
  const type = annotation.getType();
  return supported.has(type) && !(annotation.getFlags() & LOCKED) && (!shapes[type] || annotation.getObject().get('NM').asString().startsWith('Folio:'));
}

function identity(annotation, page) {
  const name = annotation.getObject().get('NM').asString();
  return name.startsWith('Folio:') ? name.slice(6) : `pdf-${page}-${annotation.getObject().asIndirect()}`;
}

function shapeData(annotation, type, inverse) {
  const fill = annotation.hasInteriorColor() ? annotation.getInteriorColor() : [];
  const line = type === 'Line' ? annotation.getLine().flatMap(p => point(p[0], p[1], inverse)) : undefined;
  const arrow = type === 'Line' && annotation.getLineEndingStyles().end !== 'None';
  return { shape: arrow ? 'arrow' : shapes[type], fill: fill.length ? colorHex(fill) : null, strokeWidth: annotation.getBorderWidth(), ...(line ? { line } : {}) };
}

function read(annotation, page, transform) {
  const inverse = mupdf.Matrix.invert(transform);
  const type = annotation.getType(), kind = type === 'Text' ? 'note' : type === 'Ink' ? 'ink' : shapes[type] ? 'shape' : 'highlight';
  const quads = kind === 'highlight' ? annotation.getQuadPoints() : [];
  const xs = quads.flatMap(q => [q[0], q[2], q[4], q[6]]);
  const ys = quads.flatMap(q => [q[1], q[3], q[5], q[7]]);
  const nativeRect = kind === 'highlight' && quads.length
    ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    : annotation.hasRect() ? annotation.getRect() : annotation.getBounds();
  const rect = mupdf.Rect.transform(nativeRect, inverse);
  const anchor = point(nativeRect[0], nativeRect[1], inverse);
  const creation = annotation.getCreationDate().getTime();
  return {
    id: identity(annotation, page), page, kind,
    rect: kind === 'note' ? [anchor[0], anchor[1], anchor[0], anchor[1]] : rect,
    text: annotation.getContents(), color: colorHex(annotation.getColor()),
    created: Number.isFinite(creation) ? creation : 0,
    author: annotation.getAuthor(), opacity: annotation.getOpacity(),
    sourceRef: annotation.getObject().asIndirect(),
    originalName: annotation.getObject().get('NM').asString(),
    ...(kind === 'shape' ? shapeData(annotation, type, inverse) : {}),
    ...(kind === 'ink' ? { inkPaths: annotation.getInkList().map(path => path.flatMap(p => point(p[0], p[1], inverse))), strokeWidth: annotation.getBorderWidth() || 1 } : {}),
    ...(kind === 'highlight' ? { quads: quads.map(q => {
      const result = [];
      for (let i = 0; i < 8; i += 2) result.push(...point(q[i], q[i + 1], inverse));
      return result;
    }) } : {}),
  };
}

export function save(doc, options = 'garbage=4,compress=yes,encrypt=keep') {
  let buffer;
  // The whole output must fit in the engine's memory (about 1.8 GB), which a book near 1 GB exceeds.
  try { buffer = doc.saveToBuffer(options); }
  catch (error) { throw /alloc \(\d+ bytes\) failed/.test(error?.message) ? new Error('Este PDF es demasiado grande para que Folio lo guarde modificado. El documento no cambió y tus anotaciones siguen guardadas en Folio.') : error; }
  try { return new Uint8Array(buffer.asUint8Array()); }
  finally { buffer.destroy(); }
}

/** Inspect real PDF annotations and produce a reading copy without the editable ones.
 * The original bytes are retained separately; other annotation types stay intact. */
export function inspectDocument(bytes, password = '') {
  const doc = open(bytes, password);
  try {
    const signed = hasSignature(doc);
    const canAnnotate = doc.hasPermission('annotate') && !signed;
    const annotations = [], hidden = [];
    if (canAnnotate) for (let index = 0; index < doc.countPages(); index++) {
      // Loading a page is the slow part. A book's pages often carry only links,
      // so read the annotation types first and load just the pages that matter.
      const annots = doc.findPage(index).get('Annots');
      let relevant = false;
      for (let i = 0; i < annots.length && !relevant; i++) relevant = supported.has(annots.get(i).get('Subtype').asName());
      if (!relevant) continue;
      // PDF.js names an annotation by its reference, generation included when not 0.
      const generations = new Map();
      for (let i = 0; i < annots.length; i++) { const [num, gen] = annots.get(i).toString().split(' '); generations.set(Number(num), gen); }
      const page = doc.loadPage(index);
      try {
        for (const annotation of [...page.getAnnotations()]) if (editable(annotation)) {
          const value = read(annotation, index + 1, page.getTransform()), gen = generations.get(value.sourceRef) || '0';
          annotations.push(value); hidden.push(gen === '0' ? `${value.sourceRef}R` : `${value.sourceRef}R${gen}`);
          page.deleteAnnotation(annotation);
        }
      } finally { page.destroy(); }
    }
    // Folio draws these annotations itself. A small PDF is rewritten without them;
    // rewriting a large book would exceed the engine's memory, so the reader hides
    // them by reference instead.
    const large = bytes.length >= LARGE_SOURCE;
    return { annotations, canAnnotate, signed, canEdit: doc.hasPermission('edit') && !signed,
      canAssemble: doc.hasPermission('assemble') && !signed, canFill: doc.hasPermission('form') && !signed,
      canCopy: doc.hasPermission('copy'), canPrint: doc.hasPermission('print'), pages: doc.countPages(),
      previewBytes: annotations.length && !large ? save(doc) : undefined, hidden: large ? hidden : [] };
  } finally { doc.destroy(); mupdf.emptyStore(); }
}

function validate(annotations, pages) {
  const ids = new Set();
  for (const a of annotations) {
    if (!a.id || ids.has(a.id) || !Number.isInteger(a.page) || a.page < 1 || a.page > pages ||
      !['note', 'highlight', 'ink', 'shape'].includes(a.kind) || !Array.isArray(a.rect) || a.rect.length !== 4 ||
      !a.rect.every(Number.isFinite) || !/^#[\da-f]{6}$/i.test(a.color) || typeof a.text !== 'string' || a.text.length > 5000)
      throw new Error('Una anotación contiene datos inválidos. No se modificó el original.');
    if (a.quads && (!Array.isArray(a.quads) || a.quads.length > 5000 || a.quads.some(q => !Array.isArray(q) || q.length !== 8 || !q.every(Number.isFinite))))
      throw new Error('Las coordenadas del resaltado no son válidas.');
    if (a.opacity !== undefined && (!Number.isFinite(a.opacity) || a.opacity < 0 || a.opacity > 1))
      throw new Error('La opacidad del resaltado no es válida.');
    if (a.kind === 'shape' && (!['rect', 'ellipse', 'line', 'arrow'].includes(a.shape) || !Number.isFinite(a.strokeWidth) || a.strokeWidth < 0 || a.strokeWidth > 50 ||
      !(a.fill === null || a.fill === undefined || /^#[\da-f]{6}$/i.test(a.fill)) || (['line', 'arrow'].includes(a.shape) ? !Array.isArray(a.line) || a.line.length !== 4 || !a.line.every(Number.isFinite) : a.line !== undefined)))
      throw new Error('La forma contiene datos inválidos.');
    if (a.kind === 'ink' && (!Number.isFinite(a.strokeWidth) || a.strokeWidth <= 0 || a.strokeWidth > 50 || !Array.isArray(a.inkPaths) || !a.inkPaths.length || a.inkPaths.length > 500 || a.inkPaths.some(p => !Array.isArray(p) || p.length < 4 || p.length > 20000 || p.length % 2 || !p.every(Number.isFinite)))) throw new Error('El dibujo contiene coordenadas o un grosor inválidos.');
    ids.add(a.id);
  }
}

const sameRect = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < .01);
function writeShape(annotation, value, transform) {
  const a = point(value.rect[0], value.rect[1], transform), b = point(value.rect[2], value.rect[3], transform);
  if (value.line) {
    annotation.setLine(point(value.line[0], value.line[1], transform), point(value.line[2], value.line[3], transform));
    annotation.setLineEndingStyles('None', value.shape === 'arrow' ? 'OpenArrow' : 'None');
  } else annotation.setRect([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
  if (value.shape !== 'line' && value.shape !== 'arrow') annotation.setInteriorColor(value.fill ? colorRgb(value.fill) : []);
  annotation.setBorderWidth(value.strokeWidth);
  annotation.setOpacity(value.opacity ?? 1);
}

/** Save ISO PDF Text/Highlight annotations with Unicode contents and AP streams. */
export function writeAnnotations(bytes, annotations, password = '', incremental = false) {
  const doc = open(bytes, password);
  try {
    if (hasSignature(doc)) throw new Error('Este PDF contiene una firma. La edición está bloqueada para conservarla.');
    if (!doc.hasPermission('annotate')) throw new Error('Los permisos de este PDF no permiten anotaciones.');
    validate(annotations, doc.countPages());
    const byPage = new Map();
    for (const a of annotations) {
      if (!byPage.has(a.page)) byPage.set(a.page, []);
      byPage.get(a.page).push(a);
    }
    for (let index = 0; index < doc.countPages(); index++) {
      const page = doc.loadPage(index);
      try {
        const pending = new Map((byPage.get(index + 1) || []).map(a => [a.id, a]));
        for (const existing of [...page.getAnnotations()]) {
          if (!editable(existing)) continue;
          const id = identity(existing, index + 1), value = pending.get(id);
          if (!value) { page.deleteAnnotation(existing); continue; }
          pending.delete(id);
          // Existing geometry, author and other dictionary keys survive; the
          // appearance is regenerated only when the text, color or opacity changed.
          let changed = false;
          if (existing.getContents() !== value.text) { existing.setContents(value.text); changed = true; }
          if (colorHex(existing.getColor()) !== value.color.toLowerCase()) { existing.setColor(colorRgb(value.color)); changed = true; }
          if (value.opacity !== undefined && Math.abs(existing.getOpacity() - value.opacity) > .001) { existing.setOpacity(value.opacity); changed = true; }
          // Shapes move and change style; rewrite their geometry when anything differs.
          if (value.kind === 'shape' && JSON.stringify(shapeData(existing, existing.getType(), mupdf.Matrix.invert(page.getTransform()))) !== JSON.stringify({ shape: value.shape, fill: value.fill ?? null, strokeWidth: value.strokeWidth, ...(value.line ? { line: value.line } : {}) })
            || value.kind === 'shape' && !sameRect(read(existing, index + 1, page.getTransform()).rect, value.rect)) { writeShape(existing, value, page.getTransform()); changed = true; }
          if (changed) { existing.setModificationDate(new Date()); existing.update(); }
        }
        const transform = page.getTransform();
        for (const value of pending.values()) {
          const annotation = page.createAnnotation(value.kind === 'note' ? 'Text' : value.kind === 'ink' ? 'Ink' : value.kind === 'shape' ? { rect: 'Square', ellipse: 'Circle' }[value.shape] || 'Line' : 'Highlight');
          annotation.setContents(value.text);
          annotation.setName('Folio:' + value.id);
          annotation.setAuthor(value.author || 'Folio');
          annotation.setCreationDate(new Date(value.created || Date.now()));
          annotation.setModificationDate(new Date());
          annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
          annotation.setColor(colorRgb(value.color));
          if (value.kind === 'note') {
            const p = point(value.rect[0], value.rect[1], transform);
            annotation.setRect([p[0], p[1], p[0] + 20, p[1] + 20]);
            annotation.setIcon('Note');
          } else if (value.kind === 'shape') {
            writeShape(annotation, value, transform);
          } else if (value.kind === 'ink') {
            annotation.setInkList(value.inkPaths.map(path => { const points = []; for (let i = 0; i < path.length; i += 2) points.push(point(path[i], path[i + 1], transform)); return points; }));
            annotation.setBorderWidth(value.strokeWidth);
            annotation.setOpacity(value.opacity ?? 1);
          } else {
            const box = [Math.min(value.rect[0], value.rect[2]), Math.min(value.rect[1], value.rect[3]), Math.max(value.rect[0], value.rect[2]), Math.max(value.rect[1], value.rect[3])];
            const quad = [box[0], box[3], box[2], box[3], box[0], box[1], box[2], box[1]];
            annotation.setQuadPoints((value.quads?.length ? value.quads : [quad]).map(q => {
              const transformed = [];
              for (let i = 0; i < 8; i += 2) transformed.push(...point(q[i], q[i + 1], transform));
              return transformed;
            }));
            annotation.setOpacity(value.opacity ?? DEFAULT_HIGHLIGHT_OPACITY);
          }
          annotation.update();
        }
      } finally { page.destroy(); }
    }
    return save(doc, incremental && doc.canBeSavedIncrementally() ? 'incremental=yes,encrypt=keep' : undefined);
  } finally { doc.destroy(); mupdf.emptyStore(); }
}
