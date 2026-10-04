import * as mupdf from 'mupdf';
import { DEFAULT_HIGHLIGHT_OPACITY } from './highlight-style.mjs';

const supported = new Set(['Highlight', 'Text']);
const LOCKED = mupdf.PDFAnnotation.IS_READ_ONLY | mupdf.PDFAnnotation.IS_LOCKED | mupdf.PDFAnnotation.IS_LOCKED_CONTENTS;
const point = (x, y, m) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const colorHex = color => {
  const rgb = color.length === 1 ? [color[0], color[0], color[0]] : color.length === 3 ? color : [1, .82, .3];
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
};
const colorRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

export function open(bytes, password = '') {
  const doc = new mupdf.PDFDocument(bytes);
  try {
    if (doc.needsPassword() && !doc.authenticatePassword(password)) throw new Error('Se necesita la contraseña correcta para guardar este PDF.');
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
  return supported.has(annotation.getType()) && !(annotation.getFlags() & LOCKED);
}

function identity(annotation, page) {
  const name = annotation.getObject().get('NM').asString();
  return name.startsWith('Folio:') ? name.slice(6) : `pdf-${page}-${annotation.getObject().asIndirect()}`;
}

function read(annotation, page, transform) {
  const inverse = mupdf.Matrix.invert(transform);
  const kind = annotation.getType() === 'Text' ? 'note' : 'highlight';
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
    ...(kind === 'highlight' ? { quads: quads.map(q => {
      const result = [];
      for (let i = 0; i < 8; i += 2) result.push(...point(q[i], q[i + 1], inverse));
      return result;
    }) } : {}),
  };
}

export function save(doc, options = 'garbage=4,compress=yes,encrypt=keep') {
  const buffer = doc.saveToBuffer(options);
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
    const annotations = [];
    if (canAnnotate) for (let index = 0; index < doc.countPages(); index++) {
      const page = doc.loadPage(index);
      try {
        for (const annotation of [...page.getAnnotations()]) if (editable(annotation)) {
          annotations.push(read(annotation, index + 1, page.getTransform()));
          page.deleteAnnotation(annotation);
        }
      } finally { page.destroy(); }
    }
    return { annotations, canAnnotate, signed, canEdit: doc.hasPermission('edit') && !signed,
      canAssemble: doc.hasPermission('assemble') && !signed, canFill: doc.hasPermission('form') && !signed,
      canCopy: doc.hasPermission('copy'), canPrint: doc.hasPermission('print'), pages: doc.countPages(),
      previewBytes: annotations.length ? save(doc) : undefined };
  } finally { doc.destroy(); mupdf.emptyStore(); }
}

function validate(annotations, pages) {
  const ids = new Set();
  for (const a of annotations) {
    if (!a.id || ids.has(a.id) || !Number.isInteger(a.page) || a.page < 1 || a.page > pages ||
      !['note', 'highlight'].includes(a.kind) || !Array.isArray(a.rect) || a.rect.length !== 4 ||
      !a.rect.every(Number.isFinite) || !/^#[\da-f]{6}$/i.test(a.color) || typeof a.text !== 'string' || a.text.length > 5000)
      throw new Error('Una anotación contiene datos inválidos. No se modificó el original.');
    if (a.quads && (!Array.isArray(a.quads) || a.quads.length > 5000 || a.quads.some(q => !Array.isArray(q) || q.length !== 8 || !q.every(Number.isFinite))))
      throw new Error('Las coordenadas del resaltado no son válidas.');
    if (a.opacity !== undefined && (!Number.isFinite(a.opacity) || a.opacity < 0 || a.opacity > 1))
      throw new Error('La opacidad del resaltado no es válida.');
    ids.add(a.id);
  }
}

/** Save ISO PDF Text/Highlight annotations with Unicode contents and AP streams. */
export function writeAnnotations(bytes, annotations, password = '') {
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
          // Existing geometry, appearance, author and other dictionary keys survive.
          if (existing.getContents() !== value.text) {
            existing.setContents(value.text);
            existing.setModificationDate(new Date());
            existing.update();
          }
        }
        const transform = page.getTransform();
        for (const value of pending.values()) {
          const annotation = page.createAnnotation(value.kind === 'note' ? 'Text' : 'Highlight');
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
    return save(doc);
  } finally { doc.destroy(); mupdf.emptyStore(); }
}
