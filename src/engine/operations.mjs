import * as mupdf from 'mupdf';
import { open, hasSignature, save, folioAnnotation } from './mupdf-engine.mjs';
import { jpegOrientation, orientationMatrix } from './jpeg-orientation.mjs';

const fail = message => { throw new Error(message); };
const finite = values => Array.isArray(values) && values.every(Number.isFinite);
const rect = value => {
  if (!finite(value) || value.length !== 4) fail('Área inválida.');
  const box = [Math.min(value[0], value[2]), Math.min(value[1], value[3]), Math.max(value[0], value[2]), Math.max(value[1], value[3])];
  if (box[2] - box[0] < .1 || box[3] - box[1] < .1) fail('El área seleccionada es demasiado pequeña.');
  return box;
};
const pageIndex = (doc, number) => {
  if (!Number.isInteger(number) || number < 1 || number > doc.countPages()) fail('Número de página inválido.');
  return number - 1;
};
const allowed = (doc, permission) => {
  if (hasSignature(doc)) fail('El documento firmado está en modo lectura.');
  if (!doc.hasPermission(permission)) fail('Los permisos del PDF no permiten esta operación.');
};
const rgb = color => {
  if (!/^#[\da-f]{6}$/i.test(color)) fail('Color inválido.');
  return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
};
const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const quadBounds = q => [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];

// Scripts, launched files, submissions and media actions; links and in-document
// navigation remain. Chained actions are dropped from the actions that remain.
const unsafeActions = new Set(['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'Rendition', 'Sound', 'Movie', 'RichMediaExecute', 'GoToE']);
function stripActions(object) {
  if (!object.isDictionary()) return;
  object.delete('AA');
  const action = object.get('A');
  if (!action.isDictionary()) return;
  if (unsafeActions.has(action.get('S').asName())) object.delete('A'); else action.delete('Next');
}

function clearPrivateData(doc, removeOutlines = false) {
  const trailer = doc.getTrailer(), root = trailer.get('Root');
  trailer.delete('Info'); root.delete('Metadata'); root.delete('OpenAction'); root.delete('AA');
  const names = root.get('Names');
  if (!names.isNull()) { names.delete('EmbeddedFiles'); names.delete('JavaScript'); }
  root.delete('AF'); root.delete('Collection');
  if (removeOutlines) { root.delete('Outlines'); root.delete('Dests'); if (!names.isNull()) names.delete('Dests'); }
  // Outline items and form fields carry actions too; XFA forms carry scripts.
  const seen = new Set();
  function outline(item, depth = 0) {
    for (let count = 0; item.isDictionary() && count < 100000; item = item.get('Next'), count++) {
      const ref = item.asIndirect(); if (ref && seen.has(ref)) return; if (ref) seen.add(ref);
      stripActions(item); if (depth < 32) outline(item.get('First'), depth + 1);
    }
  }
  function formFields(array, depth = 0) {
    for (let i = 0; i < array.length && depth < 32; i++) {
      const field = array.get(i), ref = field.asIndirect(); if (!field.isDictionary() || ref && seen.has(ref)) continue; if (ref) seen.add(ref);
      stripActions(field); formFields(field.get('Kids'), depth + 1);
    }
  }
  outline(root.get('Outlines', 'First'));
  formFields(root.get('AcroForm', 'Fields'));
  if (root.get('AcroForm').isDictionary()) root.get('AcroForm').delete('XFA');
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      page.getObject().delete('Metadata'); page.getObject().delete('PieceInfo'); page.getObject().delete('AA');
      for (const a of [...page.getAnnotations()]) if (['FileAttachment', 'Sound', 'Movie', 'RichMedia', 'Screen'].includes(a.getType())) page.deleteAnnotation(a);
      const annotations = page.getObject().get('Annots');
      for (let n = 0; n < annotations.length; n++) stripActions(annotations.get(n));
    } finally { page.destroy(); }
  }
}

// Widgets of one field share its value: list it once, at its first widget.
// Radio buttons stay separate because each widget is one of the choices, and
// fields without a name because an empty name does not identify a field.
function fieldKey(widget, id) {
  if (widget.isRadioButton() || !widget.getName()) return id;
  let state = '';
  if (widget.isCheckbox()) widget.getObject().get('AP', 'N').forEach((_, key) => { if (key !== 'Off') state = key; });
  return widget.getName() + '\n' + state;
}

function fields(doc) {
  const result = [], groups = new Map();
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      for (const [position, widget] of page.getWidgets().entries()) {
        const id = `${i + 1}:${position}:${widget.getName()}`, key = fieldKey(widget, id), group = groups.get(key);
        if (group) { if (!group.pages.includes(i + 1)) group.pages.push(i + 1); continue; }
        let buttonValue = '';
        if (widget.isRadioButton()) {
          widget.getObject().get('AP', 'N').forEach((_, key) => { if (key !== 'Off') buttonValue = key; });
          // Groups with /Opt name their states 0, 1…; the option is the text people read.
          const options = widget.getObject().getInheritable('Opt');
          if (options.isArray() && /^\d+$/.test(buttonValue) && Number(buttonValue) < options.length) buttonValue = options.get(Number(buttonValue)).asString() || buttonValue;
        }
        const field = {
        id, name: widget.getName(), label: widget.getLabel() || widget.getName(),
        page: i + 1, pages: [i + 1], type: widget.getFieldType(), value: widget.getValue(), readOnly: widget.isReadOnly(),
        multiline: widget.isText() && widget.isMultiline(), maxLength: widget.isText() ? widget.getMaxLen() : 0,
        options: widget.isChoice() ? widget.getOptions(false) : [],
        exportOptions: widget.isChoice() ? widget.getOptions(true) : [],
        checked: (widget.isCheckbox() || widget.isRadioButton()) && widget.getObject().get('AS').asName() !== 'Off',
        buttonValue,
        rect: mupdf.Rect.transform(widget.getBounds(), mupdf.Matrix.invert(page.getTransform())),
        };
        groups.set(key, field); result.push(field);
      }
    } finally { page.destroy(); }
  }
  return result;
}

function sourceDestination(source, value) {
  if (value.isName() || value.isString()) {
    const name = value.isName() ? value.asName() : value.asString(), root = source.getTrailer().get('Root');
    const legacy = root.get('Dests', name);
    function find(node, depth = 0) {
      if (depth > 32) fail('El árbol de destinos es demasiado profundo.');
      const names = node.get('Names');
      for (let i = 0; i + 1 < names.length; i += 2) if (names.get(i).asString() === name) return names.get(i + 1);
      const kids = node.get('Kids');
      for (let i = 0; i < kids.length; i++) { const found = find(kids.get(i), depth + 1); if (found) return found; }
    }
    value = legacy.isNull() ? find(root.get('Names', 'Dests')) : legacy;
    if (!value) return null;
  }
  if (value.isDictionary()) value = value.get('D');
  return value.isArray() ? value : null;
}

function importAnnotations(doc, source, sourceIndex, targetIndex, map, pendingLinks, sourceNumber) {
  const from = source.findPage(sourceIndex), to = doc.findPage(targetIndex), originals = from.get('Annots'), copied = doc.newArray();
  for (let i = 0; i < originals.length; i++) {
    const original = originals.get(i), subtype = original.get('Subtype').asName();
    if (subtype === 'Popup') continue;
    const internalLink = subtype === 'Link' && (!original.get('Dest').isNull() || original.get('A', 'S').asName() === 'GoTo');
    const copy = doc.newDictionary();
    original.forEach((value, key) => { if (!['P', 'Parent', 'Popup', 'IRT', ...(internalLink ? ['Dest', 'A'] : [])].includes(key)) copy.put(key, map.graftObject(value)); });
    copy.put('P', to);
    const name = original.get('NM').asString(); if (name) copy.put('NM', doc.newString(`${name}-import-${to.asIndirect()}-${i}`));
    if (subtype === 'Widget') {
      for (const key of ['FT', 'Ff', 'V', 'DV', 'DA', 'Opt', 'MaxLen', 'Q']) {
        const value = original.getInheritable(key); if (!value.isNull()) copy.put(key, map.graftObject(value));
      }
      let label = original.get('T').asString(), parent = original.get('Parent'), depth = 0;
      while (!parent.isNull() && depth++ < 32) { label = [parent.get('T').asString(), label].filter(Boolean).join('.'); parent = parent.get('Parent'); }
      copy.put('T', doc.newString(`Imported${to.asIndirect()}_${i}_${(label || 'Field').replaceAll('.', '_')}`));
      // The renamed field keeps its original name as its label.
      if (label && copy.get('TU').isNull()) { const tooltip = original.getInheritable('TU'); copy.put('TU', tooltip.isNull() ? doc.newString(label) : map.graftObject(tooltip)); }
      const root = doc.getTrailer().get('Root'); let acro = root.get('AcroForm');
      if (acro.isNull()) { acro = doc.newDictionary(); acro.put('Fields', doc.newArray()); root.put('AcroForm', acro); }
      let resources = acro.get('DR'); if (resources.isNull()) { resources = doc.newDictionary(); acro.put('DR', resources); }
      let fonts = resources.get('Font'); if (fonts.isNull()) { fonts = doc.newDictionary(); resources.put('Font', fonts); }
      let appearance = copy.get('DA').asString() || source.getTrailer().get('Root', 'AcroForm', 'DA').asString();
      source.getTrailer().get('Root', 'AcroForm', 'DR', 'Font').forEach((value, key) => {
        const alias = `Imported${to.asIndirect()}_${key}`; fonts.put(alias, map.graftObject(value));
        appearance = appearance.split(`/${key} `).join(`/${alias} `);
      });
      if (appearance) copy.put('DA', doc.newString(appearance));
    }
    const ref = doc.addObject(copy); copied.push(ref);
    if (internalLink) {
      const dest = sourceDestination(source, original.get('Dest').isNull() ? original.get('A', 'D') : original.get('Dest'));
      if (dest) pendingLinks.push({ ref, page: to, sourceNumber, source, dest });
    }
    if (subtype === 'Widget') doc.getTrailer().get('Root', 'AcroForm', 'Fields').push(ref);
  }
  if (copied.length) to.put('Annots', copied);
}

function pruneFields(doc) {
  const active = new Set();
  for (let i = 0; i < doc.countPages(); i++) {
    const annotations = doc.findPage(i).get('Annots');
    for (let n = 0; n < annotations.length; n++) if (annotations.get(n).get('Subtype').asName() === 'Widget') {
      let field = annotations.get(n), depth = 0;
      while (!field.isNull() && depth++ < 32) { active.add(field.asIndirect()); field = field.get('Parent'); }
    }
  }
  function filter(array, depth = 0) {
    if (depth > 32) fail('La estructura de campos es demasiado profunda.');
    const kept = doc.newArray();
    for (let i = 0; i < array.length; i++) {
      const field = array.get(i); if (!active.has(field.asIndirect())) continue;
      if (!field.get('Kids').isNull()) field.put('Kids', filter(field.get('Kids'), depth + 1)); kept.push(field);
    }
    return kept;
  }
  const acro = doc.getTrailer().get('Root', 'AcroForm'); if (!acro.isNull()) acro.put('Fields', filter(acro.get('Fields')));
}

// The PostScript name (name table ID 6) of a TrueType/OpenType font or of the
// first face of a collection: embedded fonts keep their real name.
function postScriptName(bytes, index = 0) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let start = 0;
    if (view.getUint32(0) === 0x74746366) start = view.getUint32(12 + 4 * index);
    const tables = view.getUint16(start + 4);
    for (let i = 0; i < tables; i++) {
      const entry = start + 12 + 16 * i;
      if (view.getUint32(entry) !== 0x6e616d65) continue;
      const table = view.getUint32(entry + 8), count = view.getUint16(table + 2), strings = table + view.getUint16(table + 4);
      for (let j = 0; j < count; j++) {
        const record = table + 6 + 12 * j, platform = view.getUint16(record);
        if (view.getUint16(record + 6) !== 6) continue;
        const length = view.getUint16(record + 8), offset = strings + view.getUint16(record + 10);
        const raw = bytes.subarray(offset, offset + length);
        const name = platform === 1 ? String.fromCharCode(...raw) : String.fromCharCode(...Array.from({ length: length >> 1 }, (_, k) => view.getUint16(offset + 2 * k)));
        if (/^[\x21-\x7e]{1,63}$/.test(name)) return name;
      }
    }
  } catch {}
  return undefined;
}

const folioDrawing = object => {
  let buffer;
  try { buffer = object.readStream(); return /^q [-\d.e ]+ cm \/Folio\d+ Do Q\n$/.test(buffer.asString()); }
  catch { return false; } finally { buffer?.destroy(); }
};

// Turns a page's content about the centre of its visible area, clockwise as seen by
// `degrees`: the original drawing is kept, only its placement changes.
function turnContent(doc, page, degrees) {
  if (!Number.isFinite(degrees) || Math.abs(degrees) > 20) fail('Ángulo inválido.');
  const t = degrees * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const area = mupdf.Rect.transform(page.getBounds(), mupdf.Matrix.invert(page.getTransform())), cx = (area[0] + area[2]) / 2, cy = (area[1] + area[3]) / 2;
  const matrix = [cos, -sin, sin, cos, cx - cos * cx - sin * cy, cy + sin * cx - cos * cy];
  const object = page.getObject(), contents = object.get('Contents'), list = doc.newArray();
  list.push(doc.addStream(`q ${matrix.map(v => +v.toFixed(6)).join(' ')} cm\n`, {}));
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) list.push(contents.get(i));
  else if (!contents.isNull()) list.push(contents);
  list.push(doc.addStream('Q\n', {}));
  object.put('Contents', list);
}
// A scan flattened by Folio takes the page's place: the image shows the page as it
// was seen, so the page becomes upright and exactly that size.
function replaceWithImage(doc, index, bytes, size) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024) fail('Imagen de página inválida.');
  const [width, height] = Array.isArray(size) ? size.map(Number) : [];
  if (!(width > 0 && height > 0 && width <= 14400 && height <= 14400)) fail('Tamaño de página inválido.');
  const image = new mupdf.Image(bytes);
  try {
    const object = doc.findPage(index), resources = doc.newDictionary(), xobjects = doc.newDictionary();
    xobjects.put('FolioScan', doc.addImage(image)); resources.put('XObject', xobjects);
    for (const box of ['TrimBox', 'BleedBox', 'ArtBox']) object.delete(box);
    object.put('MediaBox', [0, 0, width, height]); object.put('CropBox', [0, 0, width, height]); object.put('Rotate', 0);
    object.put('Resources', resources);
    object.put('Contents', doc.addStream(`q ${width} 0 0 ${height} 0 0 cm /FolioScan Do Q\n`, {}));
  } finally { image.destroy(); }
}
// The faces a rebuilt line can take: the standard fonts, and the open fonts the caller
// brings that resemble books' own (Palatino, Century, Garamond, Calibri...). Each is
// measured: how far its capitals reach above the baseline, and its descenders below.
// Families with serifs; the rest are sans.
const SERIF = new Set(['Times', 'Caladea', 'Pagella', 'Schola', 'Bonum', 'EBGaramond', 'Arvo', 'Crimson', 'Rokkitt']);
// Slab serifs draw their strokes as evenly as a sans: stroke contrast cannot set them apart from one.
const SLAB = new Set(['Arvo', 'Rokkitt']);
const STANDARD_FACES = [
  ['Helvetica', 'Helvetica', false, false], ['Helvetica', 'Helvetica-Bold', true, false], ['Helvetica', 'Helvetica-Oblique', false, true],
  ['Times', 'Times-Roman', false, false], ['Times', 'Times-Bold', true, false], ['Times', 'Times-Italic', false, true],
];
function measured(font) {
  // Drawn at 100 px with the baseline at row 150, where its ink starts and ends (a font's
  // own bounds are its whole box, not the letter's).
  const reach = (c, top) => {
    const gid = font.encodeCharacter(c); if (!gid) return 0;
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 200, 200], false), device = new mupdf.DrawDevice(mupdf.Matrix.identity, pix), text = new mupdf.Text();
    try {
      pix.clear(255); text.showGlyph(font, [100, 0, 0, -100, 40, 150], gid, c.codePointAt(0));
      device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1); device.close();
      const data = pix.getPixels(), rows = [];
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) if (data[y * 200 + x] < 128) { rows.push(y); break; }
      if (!rows.length) return 0;
      return top ? (150 - rows[0]) / 100 : (rows[rows.length - 1] + 1 - 150) / 100;
    } finally { text.destroy(); device.destroy(); pix.destroy(); }
  };
  return { cap: reach('H', true) || .7, xheight: reach('x', true) || .5, descender: reach('p', false) || .2 };
}
function loadFaces(extra = []) {
  if (!Array.isArray(extra) || extra.length > 64) fail('Fuentes inválidas.');
  const faces = STANDARD_FACES.map(([family, name, bold, italic]) => ({ family, name, bold, italic, font: new mupdf.Font(name) }));
  try {
    for (const face of extra) {
      if (typeof face?.family !== 'string' || typeof face.name !== 'string' || face.name.length > 100 || !(face.file instanceof Uint8Array) || face.file.length > 4 * 1024 * 1024) fail('Fuente inválida.');
      faces.push({ family: face.family, name: face.name, bold: !!face.bold, italic: !!face.italic, font: new mupdf.Font(face.name, face.file) });
    }
    for (const face of faces) Object.assign(face, measured(face.font));
    return faces;
  } catch (error) { for (const face of faces) face.font.destroy(); throw error; }
}

/** The scan of a rebuilt page, in grey, and its pixels per point. */
function scanOf(bytes, width) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024) fail('Imagen de página inválida.');
  const image = new mupdf.Image(bytes), pix = image.toPixmap();
  try {
    const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), source = pix.getPixels(), gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = n >= 3 ? (source[i * n] * 299 + source[i * n + 1] * 587 + source[i * n + 2] * 114) / 1000 : source[i * n];
    return { gray, w, h, k: w / width };
  } finally { pix.destroy(); image.destroy(); }
}

/**
 * Where and how big a line's text goes in a face: its size from the words' widths in
 * that face (bounded by the ink's height), its baseline from the ink's bottom (lower when
 * letters reach below it).
 */
// The letters' size from the words' widths in a font: steadier than the ink's height, which takes
// in a neighbour's accents and stray marks (0 without words to measure).
function widthSize(font, line) {
  // Words of small letters when the line has them: a word in capitals may be letter-spaced («C A P Í T U L O»).
  const long = (line.words ?? []).filter(word => [...word.text].length >= 3), small = long.filter(word => /\p{Ll}/u.test(word.text));
  const widths = (small.length ? small : long).map(word => {
    const [a, , b] = word.box, wordUnits = [...word.text].reduce((n, c) => { const gid = font.encodeCharacter(c); return n + (gid ? font.advanceGlyph(gid) : 0); }, 0);
    return wordUnits ? (b - a) / wordUnits : 0;
  }).filter(Boolean).sort((p, q) => p - q);
  return widths.length ? widths[widths.length >> 1] : 0;
}
function placeIn(face, line, { size: fixed = 0, baseline = 0 } = {}) {
  const { font, cap, descender } = face, [x0, top, x1, bottom] = line.box;
  const glyphs = [...line.text].map(c => ({ c, gid: font.encodeCharacter(c) }));
  const units = glyphs.reduce((n, { c, gid }) => n + (gid ? font.advanceGlyph(gid) : /\s/.test(c) ? .25 : 0), 0);
  const tall = /[A-ZÁÉÍÓÚÜÑ0-9bdfhklt()¿¡?!áéíóúüñ'"]/.test(line.text), deep = /[gjpqyQ,;()]/.test(line.text);
  const byHeight = (bottom - top) / ((tall ? cap : cap * .7) + (deep ? descender : 0));
  // The width is the surer measure (the ink's height takes in stray marks); the height only bounds it.
  const byWidth = widthSize(font, line) || (units ? (x1 - x0) / units : byHeight);
  // `fixed`: the size of the line's whole style, which one line's measure only wobbles around.
  const size = fixed || (line.text.trim().length >= 4 ? Math.min(byHeight * 1.4, Math.max(byHeight * .6, byWidth)) : byHeight);
  return { glyphs, size, baseline: baseline || bottom - (deep ? descender * size : 0), x: x0 };
}
/**
 * Each word drawn where the scan has it, across its own box: letters land where the
 * scan's letters are (a whole line in another face drifts along its length). A space
 * follows each word, so copied and searched text keeps its spaces.
 */
// A character the face lacks (a Greek letter, a symbol) comes from the fallback face of its kind.
const glyphsOf = (chars, font, fallback) => [...chars].map(c => {
  const gid = font.encodeCharacter(c);
  if (gid || !fallback) return { c, gid, font };
  // A list of fallbacks is tried in turn (a made face lends from the face it stands for, then Times).
  for (const other of Array.isArray(fallback) ? fallback : [fallback]) { const found = other.encodeCharacter(c); if (found) return { c, gid: found, font: other }; }
  return { c, gid: 0, font };
});
// `width`: how much wider the scan's letters run than the face's, across the page; each word
// then keeps within 5% of it (a word's box is a pixel or two off, its letters are not).
function wordsText(font, { size, baseline }, words, limit = .4, fonts = [], fallback = null, width = 0) {
  const text = new mupdf.Text();
  for (const [n, word] of words.entries()) {
    font = fonts[n] ?? font;
    const space = font.encodeCharacter(' '), [a, , b] = word.box, glyphs = glyphsOf(word.text, font, fallback);
    const units = glyphs.reduce((n, { gid, font }) => n + (gid ? font.advanceGlyph(gid) : 0), 0);
    if (!units) continue;
    // Never into the next word's place: a space's worth before it stays clear.
    const own = (b - a) / (units * size), room = n + 1 < words.length ? (words[n + 1].box[0] - size * .2 - a) / (units * size) : Infinity;
    // The page's measure holds a word only near it: a heading or a title runs wider or narrower.
    // Within a tenth of it each word fills its own place (justified text sets its spaces, our face its letters).
    const held = width && Math.abs(own - width) > width * .1 && Math.abs(own - width) <= width * .2 ? Math.min(width * 1.1, Math.max(width * .9, own)) : own;
    // Into its room it always goes (a condensed title is narrower than any face we have).
    // A word of capitals may be a condensed or wide title face's: it may stretch further.
    const reach = /\p{Ll}/u.test(word.text) ? limit : Math.max(limit, .45), shown = glyphs.filter(({ gid }) => gid);
    // A word far wider than its letters would be is set with space between its letters
    // («C A P Í T U L O», mostly capitals): the letters keep their shape and the word its width.
    const spaced = own > (width || 1) * (/[a-zà-ÿ]/.test(word.text) ? 1.4 : 1.15) && shown.length >= 3;
    // Up to .06 em between letters (a reader of the text takes each letter for a word past about
    // a tenth: «C A P Í T U L O», unfound by search); the letters widen for the rest.
    const tracking = spaced ? Math.min(size * .06, Math.max(0, ((b - a) - units * size * (width || 1)) / (shown.length - 1))) : 0;
    const stretch = spaced ? Math.min(1 + reach, Math.max(width || 1, ((b - a) - tracking * (shown.length - 1)) / (units * size))) : Math.min(1 + reach, Math.max(Math.min(1 - reach, room), Math.min(room, held)));
    let x = a;
    for (const { c, gid, font } of glyphs) { if (gid) { text.showGlyph(font, [size * stretch, 0, 0, -size, x, baseline], gid, c.codePointAt(0)); x += font.advanceGlyph(gid) * size * stretch + tracking; } }
    x -= tracking;
    if (space) text.showGlyph(font, [size, 0, 0, -size, x, baseline], space, 32);
  }
  return text;
}
function textOf(font, { glyphs, size, baseline, x }, fallback = null) {
  const text = new mupdf.Text();
  for (const { c } of glyphs) { const [{ gid, font: from }] = glyphsOf(c, font, fallback); if (gid) text.showGlyph(from, [size, 0, 0, -size, x, baseline], gid, c.codePointAt(0)); x += (gid ? from.advanceGlyph(gid) : .25) * size; }
  return text;
}
const grey = rgb => rgb.reduce((t, v, i) => t + v * [.299, .587, .114][i], 0) * 255;

/**
 * How thick a line's strokes are, in ems: the typical width of the ink crossed
 * horizontally at full scan resolution, at half contrast (where a blurred edge still
 * sits), against the size of its letters.
 */
// How strongly a line's ink stands off its background: nearly its darkest (a thin stroke
// never reaches the ink's full colour, so the line's colour is not it).
function contrastOf(scan, line) {
  const [x0, top, x1, bottom] = line.box, k = scan.k, ground = grey(line.background ?? [1, 1, 1]), counts = new Uint32Array(256);
  let total = 0;
  for (let y = Math.max(0, Math.floor(top * k)); y < Math.min(scan.h, Math.ceil(bottom * k)); y++) for (let x = Math.max(0, Math.floor(x0 * k)); x < Math.min(scan.w, Math.ceil(x1 * k)); x++) { counts[Math.min(255, Math.round(Math.abs(scan.gray[y * scan.w + x] - ground)))]++; total++; }
  let v = 255; for (let seen = 0; v > 0 && seen < total * .02; v--) seen += counts[v];
  return Math.max(40, v);
}
// The width of each stroke the rows of an area cross, in pixels: the ink summed across it, the
// line's full contrast counting as one pixel (a pale or coloured line's strokes are no thinner). A blur spreads a stroke without changing its sum, so a thin
// stroke stays thinner than a bold one however soft the scan (counting dark pixels does not:
// at 3 pixels per point a stroke is 2 or 3 of them).
function strokes(scan, a, b, y0, y1, ground, contrast) {
  const runs = [];
  for (let y = y0; y < y1; y++) {
    let sum = 0, peak = 0, previous = 0;
    for (let x = a; x <= b; x++) {
      const v = x < b ? Math.min(1, Math.abs(scan.gray[y * scan.w + x] - ground) / contrast) : 0;
      if (v <= .2) { if (sum) runs.push(sum); sum = peak = previous = 0; continue; }
      // Small letters' strokes run together where the blur fills the gap between them: a clear dip parts them.
      if (sum && v > previous && previous < peak * .75) { runs.push(sum - previous / 2); sum = previous / 2; peak = previous; }
      sum += v; peak = Math.max(peak, v); previous = v;
    }
  }
  return runs;
}
function strokeWidth(scan, line, size, contrast) {
  const [x0, top, x1, bottom] = line.box, k = scan.k, ground = grey(line.background ?? [1, 1, 1]);
  const runs = strokes(scan, Math.max(0, Math.floor(x0 * k)), Math.min(scan.w, Math.ceil(x1 * k)), Math.max(0, Math.floor(top * k)), Math.min(scan.h, Math.ceil(bottom * k)), ground, contrast);
  if (runs.length < 20) return 0;
  runs.sort((p, q) => p - q);
  return runs[runs.length >> 1] / (size * k);
}

/**
 * Where a line's letters stand, in page points: the bottom of the band its small letters fill,
 * read from the ink. The box's bottom also takes in descenders and stray marks, and a box can
 * reach into the next line: of the bands of ink in it, the line's own is the one as tall as
 * small letters of its size (`size`, from the words' widths) and the fullest of those.
 */
function inkBand(scan, line, size) {
  const k = scan.k, [x0f, top, x1f, bottom] = line.box, text = grey(line.color), ground = grey(line.background ?? [1, 1, 1]);
  const x0 = Math.max(0, Math.floor(x0f * k)), x1 = Math.min(scan.w, Math.ceil(x1f * k)), y0 = Math.max(0, Math.floor(top * k)), y1 = Math.min(scan.h, Math.ceil(bottom * k));
  if (x1 - x0 < 10 || y1 - y0 < 6 || !size) return null;
  const counts = Array.from({ length: y1 - y0 }, (_, y) => { let n = 0; for (let x = x0; x < x1; x++) if (Math.abs(scan.gray[(y0 + y) * scan.w + x] - ground) > Math.abs(text - ground) / 2) n++; return n; });
  const peak = Math.max(...counts), expect = size * .48 * k, capitals = !/[a-zà-ÿ]/.test(line.text);
  const bands = [];
  for (let a = 0; a < counts.length; a++) {
    if (counts[a] < peak * .45) continue;
    let b = a, sum = 0; while (b < counts.length && counts[b] >= peak * .45) sum += counts[b++];
    // In a line of capitals (or figures) the band is the capitals' height, whatever the size
    // guessed from the widths (a condensed title is far taller than its width says).
    const height = b - a, fits = capitals ? height > expect * .5 : Math.abs(height - expect) < expect * .4;
    if (fits) bands.push({ a, b, sum, height });
    a = b;
  }
  // Of the bands with ink enough (a box overlapping the next line's holds its band too), the one
  // whose foot is nearest where the box puts the baseline (above its descenders).
  const deep = /[gjpqyQ,;()]/.test(line.text), guess = (y1 - y0) - (deep ? size * .21 * k : 0), most = Math.max(0, ...bands.map(band => band.sum));
  const best = bands.filter(band => band.sum >= most * .5).sort((p, q) => Math.abs(p.b - guess) - Math.abs(q.b - guess))[0] ?? null;
  if (best && capitals) {
    // Capitals' rows are not all full (an A's apex, the bowls of R and S thin out, a serif row
    // peaks): against the band's typical row, its top is the first row with a good share of it,
    // its bottom the last before it falls away (the next line's tops may follow).
    const rows = counts.slice(best.a, best.b).sort((p, q) => p - q), typical = rows[rows.length >> 1];
    let a = best.a, b = best.a;
    while (a > 0 && counts[a - 1] >= typical * .3) a--;
    while (b < counts.length && counts[b] >= typical * .6) b++;
    Object.assign(best, { a, b, height: b - a });
  }
  if (best) best.capitals = capitals;
  return best && { baseline: (y0 + best.b) / k, height: best.height / k, capitals: best.capitals };
}

/**
 * How much thicker a line's upright strokes are than its horizontal ones: the ink summed across
 * the stems (rows through its small letters) against the ink summed down through its bars and
 * curves (short runs down its columns). Serif faces are drawn with a broad pen, about twice as
 * thick upright as across; sans faces, Gill and Helvetica alike, are nearly even (under 1.5).
 */
function strokeContrast(scan, line, baseline, size, contrast) {
  const k = scan.k, ground = grey(line.background ?? [1, 1, 1]), base = baseline || line.box[3];
  const x0 = Math.max(0, Math.floor(line.box[0] * k)), x1 = Math.min(scan.w, Math.ceil(line.box[2] * k)), top = Math.max(1, Math.round((base - size * .45) * k)), bottom = Math.min(scan.h - 2, Math.round(base * k));
  if (bottom - top < 4 || x1 - x0 < 10) return 0;
  const ink = (x, y) => Math.min(1, Math.abs(scan.gray[y * scan.w + x] - ground) / contrast), across = [], down = [];
  for (let y = top + 1; y < bottom - 1; y++) for (let x = x0, sum = 0; x <= x1; x++) { const v = x < x1 ? ink(x, y) : 0; if (v > .25) sum += v; else if (sum) { across.push(sum); sum = 0; } }
  for (let x = x0; x < x1; x++) for (let y = top - 2, sum = 0, length = 0; y <= bottom + 2; y++) { const v = y < bottom + 2 ? ink(x, y) : 0; if (v > .25) { sum += v; length++; } else if (sum) { if (length < (bottom - top) * .4) down.push(sum); sum = length = 0; } }
  if (across.length < 20 || down.length < 20) return 0;
  const middle = values => values.sort((p, q) => p - q)[values.length >> 1];
  return middle(across) / middle(down);
}

/** The scan's ink around a line, in shades, at up to 4 pixels per point and 40 across its height (a title's shapes show at less). */
function inkAround(scan, line) {
  const [x0, top, x1, bottom] = line.box, k = Math.min(scan.k, 4, 40 / Math.max(1, bottom - top)), step = scan.k / k, margin = (bottom - top) * .4;
  const bx0 = Math.max(0, Math.floor((x0 - margin) * k)), by0 = Math.max(0, Math.floor((top - margin) * k));
  const bx1 = Math.min(Math.floor(scan.w / step), Math.ceil((x1 + margin) * k)), by1 = Math.min(Math.floor(scan.h / step), Math.ceil((bottom + margin) * k));
  const cw = bx1 - bx0, ch = by1 - by0;
  if (cw < 4 || ch < 4) return null;
  // How much ink each pixel holds: 0 on the background, 1 at the letters' own colour.
  const text = grey(line.color), ground = grey(line.background ?? [1, 1, 1]), tone = new Float32Array(cw * ch), span = text - ground || 1;
  // On a band of its own (a table's dark row), above and below it is another colour, not ink.
  const inBand = y => !line.band || ((by0 + y) / k >= top && (by0 + y) / k < bottom);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) tone[y * cw + x] = !inBand(y) ? 0 : (scan.gray[Math.min(scan.h - 1, Math.round((by0 + y) * step)) * scan.w + Math.min(scan.w - 1, Math.round((bx0 + x) * step))] - ground) / span;
  return { k, box: [bx0, by0, bx1, by1], cw, ch, tone };
}

/**
 * A word's own style, measured on the scan at full resolution: how thick its strokes
 * are (against the line's height) and how far they lean. The lean is the shear that
 * stacks its ink into the sharpest columns: upright letters' stems stand at 0°, italics
 * lean 9–20°.
 */
function wordStyle(scan, line, word, contrast) {
  const k = scan.k, [, top, , bottom] = line.box, [a, , b] = word.box, text = grey(line.color), ground = grey(line.background ?? [1, 1, 1]);
  const x0 = Math.max(0, Math.floor(a * k) - 2), x1 = Math.min(scan.w, Math.ceil(b * k) + 2), y0 = Math.max(0, Math.floor(top * k)), y1 = Math.min(scan.h, Math.ceil(bottom * k));
  const w = x1 - x0, h = y1 - y0;
  if (w < 6 || h < 6 || [...word.text].length < 3) return null;
  // How much ink each pixel holds (a blurred scan's letters are shades, not shapes).
  const ink = new Float32Array(w * h), runs = strokes(scan, x0, x1, y0, y1, ground, contrast);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink[y * w + x] = Math.max(0, Math.min(1, (scan.gray[(y0 + y) * scan.w + x0 + x] - ground) / ((text - ground) || 1)));
  if (runs.length < 8) return null;
  runs.sort((p, q) => p - q);
  const sharpness = degrees => {
    const t = Math.tan(degrees * Math.PI / 180), columns = new Float64Array(w + h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) columns[Math.round(x + (y - h) * t + h)] += ink[y * w + x];
    let sum = 0; for (const c of columns) sum += c * c; return sum;
  };
  let lean = 0, best = sharpness(0); const upright = best;
  for (let degrees = -6; degrees <= 24; degrees += 3) { const v = sharpness(degrees); if (v > best) { best = v; lean = degrees; } }
  // Against the letters' size, not the ink's height: a line with no descender is shorter in ink, not smaller.
  const tall = /[A-ZÁÉÍÓÚÜÑ0-9bdfhklt()¿¡?!áéíóúüñ'"]/.test(line.text), deep = /[gjpqyQ,;()]/.test(line.text);
  return { stroke: runs[runs.length >> 1] / (h / ((tall ? .7 : .5) + (deep ? .21 : 0))), italic: lean >= 9 && best > upright * 1.08, lean, gain: best / upright };
}

/**
 * How well a face's letters match a line's ink: the face's text drawn over the line's place,
 * word by word, softened like the scan and compared shade for shade (a correlation, -1 to 1),
 * nudged a few pixels each way; the best match, its nudge and the softening that fit.
 */
function faceScore(around, line, face, fixed = {}) {
  if (!around) return { dy: 0, score: 0 };
  const { k, box, cw, ch, tone } = around, pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, box, false), device = new mupdf.DrawDevice(mupdf.Matrix.scale(k, k), pix);
  let text, best = { dy: 0, score: -1 };
  try {
    pix.clear(255); const placed = placeIn(face, line, fixed); text = line.words?.length ? wordsText(face.font, placed, line.words, .35, [], fixed.fallback) : textOf(face.font, placed, fixed.fallback);
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1); device.close();
    const drawn = pix.getPixels(), mark = new Float32Array(drawn.length);
    for (let i = 0; i < drawn.length; i++) mark[i] = 1 - drawn[i] / 255;
    // Only the rows of this line's own letters, from the top of its tallest to the bottom of its
    // deepest and a little more: close lines' boxes overlap, and their letters are not this face's.
    const rows = []; for (let y = 0; y < ch; y++) { for (let x = 0; x < cw; x++) if (mark[y * cw + x] > .3) { rows.push(y); break; } }
    const spare = Math.max(2, Math.round(placed.size * k * .12)), from = rows.length ? Math.max(0, rows[0] - spare) : 0, to = rows.length ? Math.min(ch, rows[rows.length - 1] + 1 + spare) : ch;
    const match = (soft, dy, dx) => {
      let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = Math.max(from, -dy); y < Math.min(to, ch - dy); y++) for (let x = Math.max(0, -dx); x < Math.min(cw, cw - dx); x++) {
        const a = soft[y * cw + x], b = tone[(y + dy) * cw + x + dx];
        n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
      }
      return (sab - sa * sb / n) / Math.sqrt(Math.max(1e-9, (saa - sa * sa / n) * (sbb - sb * sb / n)));
    };
    // The face's letters softened as the scan softened its own (the blur is not known: the
    // closer of two, unless given), then matched shade for shade, nudged a pixel or two each way.
    const softened = r => blur(blur(mark, cw, ch, r), cw, ch, r);
    let r = fixed.blur, soft = r && softened(r);
    if (!r) {
      const options = [Math.max(1, Math.round(k / 4)), Math.max(2, Math.round(k / 2))].map(r => ({ r, soft: softened(r) })).map(option => ({ ...option, score: match(option.soft, 0, 0) }));
      ({ r, soft } = options[0].score >= options[1].score ? options[0] : options[1]);
    }
    // The best nudge, climbed to from no nudge (the match rises smoothly toward it): a pixel at a
    // time while a neighbour matches better.
    const tried = new Map(), at = (dy, dx) => { const key = dy * 8 + dx; if (!tried.has(key)) tried.set(key, match(soft, dy, dx)); return tried.get(key); };
    // Up and down by up to a tenth of the line's height (a baseline read off by a few pixels in big text).
    const reachY = Math.max(3, Math.round(ch * .1));
    let y = 0, x = 0;
    for (;;) {
      let next = null;
      for (const [sy, sx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const ny = y + sy, nx = x + sx; if (Math.abs(ny) <= reachY && Math.abs(nx) <= 3 && at(ny, nx) > (next ? at(...next) : at(y, x))) next = [ny, nx]; }
      if (!next) break;
      [y, x] = next;
    }
    // How much ink the face puts down against the scan's own, at half ink and that nudge: a face
    // too light or too heavy for the letters is off by it, whatever its shapes.
    let drawnInk = 0, scanInk = 0;
    for (let row = Math.max(from, -y); row < Math.min(to, ch - y); row++) for (let col = Math.max(0, -x); col < Math.min(cw, cw - x); col++) { if (soft[row * cw + col] > .5) drawnInk++; if (tone[(row + y) * cw + col + x] > .5) scanInk++; }
    best = { dy: y / k, score: at(y, x), blur: r, weight: scanInk ? drawnInk / scanInk : 1 };
    return best;
  } finally { text?.destroy(); device.destroy(); pix.destroy(); }
}
// A box blur of radius r, across then down.
function blur(values, w, h, r) {
  const across = new Float32Array(values.length), out = new Float32Array(values.length);
  for (let y = 0; y < h; y++) { let sum = 0; for (let x = -r; x < w + r; x++) { if (x + r < w && x + r >= 0) sum += values[y * w + x + r]; if (x - r - 1 >= 0 && x - r - 1 < w) sum -= values[y * w + x - r - 1]; if (x >= 0 && x < w) across[y * w + x] = sum / (2 * r + 1); } }
  for (let x = 0; x < w; x++) { let sum = 0; for (let y = -r; y < h + r; y++) { if (y + r < h && y + r >= 0) sum += across[(y + r) * w + x]; if (y - r - 1 >= 0 && y - r - 1 < h) sum -= across[(y - r - 1) * w + x]; if (y >= 0 && y < h) out[y * w + x] = sum / (2 * r + 1); } }
  return out;
}

/**
 * The face of each line of a page. Lines of one size, colour, weight and family are one
 * style and take one face. The family comes first, from a few of the style's longest
 * lines in every family's regular face; then the two closest families' regular, bold and
 * italic faces are tried on all of the style's lines.
 */
function pageFaces(scan, lines, faces) {
  if (!scan) return lines.map(() => ({ face: faces[0], dy: 0 }));
  const named = name => faces.find(face => face.name === name);
  // Each word's box drawn in to its own ink, left and right (the recogniser's boxes run into the
  // spaces): read across the middle of the line, clear of the lines above and below. Two words the
  // recogniser ran together («26Tumores», «laLTA») are parted at the space between them.
  for (const line of lines) {
    const k = scan.k, [, top, , bottom] = line.box, ground = grey(line.background ?? [1, 1, 1]), half = Math.abs(grey(line.color) - ground) / 2;
    const y0 = Math.max(0, Math.round((top + (bottom - top) * .25) * k)), y1 = Math.min(scan.h, Math.round((bottom - (bottom - top) * .2) * k));
    const inked = x => { for (let y = y0; y < y1; y++) if (Math.abs(scan.gray[y * scan.w + x] - ground) > half) return true; return false; };
    const tighten = ([a, t, b, u]) => {
      const x0 = Math.max(0, Math.floor(a * k)), x1 = Math.min(scan.w, Math.ceil(b * k));
      let first = x0, last = x1 - 1;
      while (first < last && !inked(first)) first++;
      while (last > first && !inked(last)) last--;
      // Out to ink the box cut off (a slanted letter's foot, a box set a little short), within a
      // fifth of the line's height and up to a clear column.
      if (first === x0) { const stop = Math.max(0, x0 - Math.round((bottom - top) * .2 * k)); while (first > stop && inked(first - 1)) first--; }
      if (last === x1 - 1) { const stop = Math.min(scan.w - 1, x1 - 1 + Math.round((bottom - top) * .2 * k)); while (last < stop && inked(last + 1)) last++; }
      return last - first >= 2 && (last + 1 - first) / k > (b - a) * .5 ? [first / k, t, (last + 1) / k, u] : [a, t, b, u];
    };
    // A word set letter-spaced in capitals («C A P Í T U L O») is read as several: three or more
    // runs of one to three capitals in a row, as far apart as their letters, are one word.
    const merged = [];
    for (let n = 0; n < (line.words ?? []).length;) {
      const caps = word => /^[\p{Lu}]{1,3}$/u.test(word.text);
      let end = n; while (end < line.words.length && caps(line.words[end]) && (end === n || line.words[end].box[0] - line.words[end - 1].box[2] < (bottom - top) * .8)) end++;
      if (end - n >= 3) {
        const run = line.words.slice(n, end);
        merged.push({ ...run[0], text: run.map(word => word.text).join(''), box: [run[0].box[0], run[0].box[1], run[run.length - 1].box[2], run[0].box[3]], letters: run.every(word => word.letters) ? run.flatMap(word => word.letters) : undefined });
        n = end;
      } else merged.push(line.words[n++]);
    }
    line.words = merged;
    line.words = (line.words ?? []).flatMap(word => {
      const box = tighten(word.box), joined = /^(\d+|\p{Ll}+)(\p{Lu}.*)$/u.exec(word.text);
      if (!joined) return [{ ...word, box }];
      // The widest blank run of columns inside the word, a space's width at least.
      let best = null;
      for (let x = Math.ceil(box[0] * k), run = 0; x <= Math.floor(box[2] * k); x++) {
        if (x < Math.floor(box[2] * k) && !inked(x)) { run++; continue; }
        if (run && (!best || run > best.run)) best = { run, at: x - run };
        run = 0;
      }
      if (!best || best.run / k < (bottom - top) * .15) return [{ ...word, box }];
      const cut = [...joined[1]].length;
      return [{ ...word, text: joined[1], box: tighten([box[0], box[1], best.at / k, box[3]]), letters: word.letters?.slice(0, cut) }, { ...word, text: joined[2], box: tighten([(best.at + best.run) / k, box[1], box[2], box[3]]), letters: word.letters?.slice(cut) }];
    });
    // The words' places from the ink itself when it parts plainly into as many runs as there are
    // words (gaps a space wide): the recogniser's boxes can sit a few pixels off and narrow.
    if (line.words.length >= 2) {
      const from = Math.max(0, Math.floor((line.words[0].box[0] - 1) * k)), to = Math.min(scan.w, Math.ceil((line.words[line.words.length - 1].box[2] + 1) * k)), space = (bottom - top) * .18 * k;
      const runs = []; let start = -1, blank = 0;
      for (let x = from; x <= to; x++) {
        if (x < to && inked(x)) { if (start < 0 || blank >= space) { if (start >= 0) runs[runs.length - 1][1] = x - blank; runs.push([x, x + 1]); start = x; } blank = 0; runs[runs.length - 1][1] = x + 1; }
        else if (start >= 0) blank++;
      }
      if (runs.length === line.words.length && runs.every(([a, b], n) => Math.abs((a + b) / 2 / k - (line.words[n].box[0] + line.words[n].box[2]) / 2) < (bottom - top))) line.words = line.words.map((word, n) => ({ ...word, box: [runs[n][0] / k, word.box[1], runs[n][1] / k, word.box[3]] }));
    }
    if (line.words.length) line.text = line.words.map(word => word.text).join(' ');
  }
  // Each line's letter size, from its words' widths in Times (the same yardstick for every line);
  // from the ink's height only when it has no words to measure.
  const sizes = lines.map(line => {
    const tall = /[A-ZÁÉÍÓÚÜÑ0-9bdfhklt()¿¡?!áéíóúüñ'"]/.test(line.text), deep = /[gjpqyQ,;()]/.test(line.text);
    return widthSize(named('Times-Roman').font, line) || (line.box[3] - line.box[1]) / ((tall ? .7 : .5) + (deep ? .21 : 0));
  });
  const arounds = lines.map(line => inkAround(scan, line)), strips = lines.map((line, i) => inkBand(scan, line, sizes[i])), baselines = strips.map(strip => strip?.baseline ?? 0), contrasts = lines.map(line => contrastOf(scan, line)), strokes = lines.map((line, i) => strokeWidth(scan, line, sizes[i], contrasts[i]));
  const scored = lines.map(() => new Map());
  // How much the scan softened its letters, once for the page, from a few of its longest lines in
  // Times: every face is then weighed at that blur (a thin face blurred more would pass for bold).
  const blurs = [...lines.keys()].sort((a, b) => lines[b].text.length - lines[a].text.length).slice(0, 8).map(i => faceScore(arounds[i], lines[i], named('Times-Roman'), { baseline: baselines[i] }).blur ?? 0).sort((p, q) => p - q);
  const blur = blurs[blurs.length >> 1] || 0;
  // Serif or sans, read from the strokes themselves (0 when there is too little ink to tell). Even
  // strokes say sans anywhere; uneven ones say serif in running text only (a bold heading's stems
  // are thick for its bars too).
  const penned = lines.map((line, i) => strokeContrast(scan, line, baselines[i], sizes[i], contrasts[i]));
  const kindOf = (value, sure) => !value ? null : value > (sure ? 2 : 1.75) ? 'serif' : value < (sure ? 1.45 : 1.55) ? 'sans' : null;
  // A line of capitals is drawn as tall as its capitals for the comparison (its widths tell its
  // size badly when its face is condensed or wide).
  // A line's size in a face: its letters as tall as the scan's, from the words' widths (unbounded by
  // the box's height, which can take in a neighbour) scaled to the ink's height; a line of capitals
  // by its capitals' height alone (a condensed or wide title face is far from ours in width).
  // The ink's height is read to a pixel (a sixth of a small letter here), the widths over a whole
  // line far closer: so a face's size is its widths' measure times one ratio for the page, how much
  // taller (or shorter) the scan's small letters are than the face's at that width.
  const ratios = new Map(), ratioOf = face => {
    if (!ratios.has(face)) {
      const found = lines.flatMap((line, i) => { const strip = strips[i], wide = (line.words?.length ?? 0) >= 4 && widthSize(face.font, line); return strip && !strip.capitals && wide ? [strip.height / face.xheight / wide] : []; }).sort((p, q) => p - q);
      // Too few lines in a bold or italic face (an italic's slanted rows read its height badly): its family's regular's.
      const regular = faces.find(other => other.family === face.family && !other.bold && !other.italic);
      ratios.set(face, found.length >= 3 && !face.italic ? Math.min(1.35, Math.max(.75, found[found.length >> 1])) : regular && regular !== face ? ratioOf(regular) : 1);
    }
    return ratios.get(face);
  };
  const measure = (i, face) => {
    const wide = widthSize(face.font, lines[i]), strip = strips[i];
    if (strip?.capitals) return strip.height / face.cap;
    // An italic by its height: italics differ in width far more than romans (ours run wider than Palatino's).
    if (face.italic && strip) return strip.height / face.xheight;
    if (wide) return wide * ratioOf(face);
    return strip ? strip.height / face.xheight : placeIn(face, lines[i]).size;
  };
  const score = (i, face) => { if (!scored[i].has(face.name)) scored[i].set(face.name, faceScore(arounds[i], lines[i], face, { baseline: baselines[i], blur, size: measure(i, face) })); return scored[i].get(face.name); };
  const groups = [];
  lines.forEach((line, i) => {
    const height = sizes[i], stroke = strokes[i];
    const group = groups.find(g => Math.abs(g.height - height) <= g.height * .15 && Math.hypot(...g.color.map((v, c) => v - line.color[c])) < .15 && Math.abs(g.stroke - stroke) <= g.stroke * .18);
    if (group) group.members.push(i); else groups.push({ height, color: line.color, stroke, members: [i] });
  });
  // A group splits by family when several of its lines clearly prefer each (serif text and a
  // sans note of one size), or when a line of it plainly is the other kind (one family's lines
  // differ by a few hundredths, two families' by a tenth); a line with no clear preference
  // follows the group's majority.
  const leaning = i => score(i, named('Times-Roman')).score - score(i, named('Helvetica')).score;
  for (const group of [...groups]) {
    const serif = group.members.filter(i => leaning(i) > .03), sans = group.members.filter(i => leaning(i) < -.03), toSerif = serif.length >= sans.length;
    const moved = serif.length >= 2 && sans.length >= 2 ? group.members.filter(i => toSerif ? leaning(i) < -.03 : leaning(i) > .03) : group.members.filter(i => toSerif ? leaning(i) < -.1 : leaning(i) > .1);
    if (!moved.length || moved.length === group.members.length) continue;
    group.members = group.members.filter(i => !moved.includes(i));
    groups.push({ ...group, members: moved });
  }
  // Weight by stroke thickness, against the page's own text: how thick a regular stroke
  // looks depends on the scan's blur, so bold is a style clearly heavier than most of the page.
  const median = values => { const sorted = values.filter(v => v > 0).sort((p, q) => p - q); return sorted.length ? sorted[sorted.length >> 1] : 0; };
  const usual = median(lines.flatMap((line, i) => Array(line.text.length).fill(strokes[i])));
  const regulars = faces.filter(face => !face.bold && !face.italic), chosen = [];
  // Ink varies across a scan (a darker band, a lighter corner): weight is judged against the
  // lines around a line, in its own column, not against the whole page.
  const near = lines.map((line, i) => lines.flatMap((other, j) => {
    const h = line.box[3] - line.box[1], gap = Math.abs((other.box[1] + other.box[3]) / 2 - (line.box[1] + line.box[3]) / 2);
    return j !== i && gap < h * 5 && Math.min(line.box[2], other.box[2]) > Math.max(line.box[0], other.box[0]) ? [j] : [];
  }));
  const wordStyles = lines.map((line, i) => (line.words ?? []).map(word => wordStyle(scan, line, word, contrasts[i])));
  // A whole line's lean, from all its ink at once: surer than a word's (a heading set in italic).
  const tilted = lines.map((line, i) => { const style = wordStyle(scan, line, { text: line.text, box: line.box }, contrasts[i]); return !!style && style.lean >= 6 && style.gain >= 1.05; });
  const mean = (face, among) => among.reduce((t, i) => t + score(i, face).score, 0) / among.length;
  // How evenly a face's widths match a set of lines' words: each word's width in the scan over its
  // width in the face is one size; in the face the text was set in, every word gives about the same
  // one, in another face they scatter (its letters are each wider or narrower in their own way).
  // Positions, not shapes: it holds where letters are a dozen pixels tall. The middle deviation,
  // with how many words gave it (null under 8: too few to tell).
  const scatter = (face, among) => {
    const ratios = among.flatMap(i => (lines[i].words ?? []).filter(word => /^[\p{L}]{4,}[.,;:]?$/u.test(word.text)).map(word => {
      const units = [...word.text].reduce((t, c) => { const gid = face.font.encodeCharacter(c); return t + (gid ? face.font.advanceGlyph(gid) : 0); }, 0);
      return units ? (word.box[2] - word.box[0]) / units : 0;
    }).filter(Boolean));
    if (ratios.length < 8) return null;
    const middle = median(ratios);
    return median(ratios.map(r => Math.abs(r - middle) / middle + 1e-9));
  };
  // The family whose widths fit a set of lines clearly best (a quarter less scattered than the
  // next), among `families`; null when none stands out or there are too few words.
  const widest = (among, families) => {
    const ranked = families.map(family => [family, scatter(regulars.find(face => face.family === family), among)]).filter(([, v]) => v !== null).sort((p, q) => p[1] - q[1]);
    return ranked.length >= 2 && ranked[0][1] < ranked[1][1] * .8 ? ranked[0][0] : null;
  };
  // Each style's families, ranked on a few of its longest lines in each family's regular or bold
  // face (a bold heading's family shows in its bold); the page's family is the one that fits its
  // text best overall (weighted by lines), so close faces do not alternate.
  const ranked = groups.map(({ members }) => {
    const sample = [...members].sort((a, b) => lines[b].text.length - lines[a].text.length).slice(0, 4), fits = new Map();
    for (const face of faces) if (!face.italic) fits.set(face.family, Math.max(fits.get(face.family) ?? -1, mean(face, sample)));
    return fits;
  });
  const overall = new Map(regulars.map(face => [face.family, groups.reduce((t, g, k) => t + ranked[k].get(face.family) * g.members.length, 0) / lines.length]));
  // Serif or sans is the surer call (Times against Helvetica); a closer family of that kind
  // (Garamond, Palatino, Calibri, a slab...) only when it fits clearly better than the plain one.
  const pick = (scores, kind) => {
    const plain = kind === 'serif' ? 'Times' : 'Helvetica', [family, value] = [...scores].filter(([family]) => SERIF.has(family) === (kind === 'serif')).sort((a, b) => b[1] - a[1])[0];
    return value - scores.get(plain) > .015 ? family : plain;
  };
  const main = pick(overall, overall.get('Times') > overall.get('Helvetica') ? 'serif' : 'sans');
  // The body text: the style with the most letters.
  const body = groups.reduce((best, g) => { const letters = g.members.reduce((t, i) => t + lines[i].text.length, 0); return letters > best.letters ? { ...g, letters } : best; }, { letters: -1 });
  const bodySize = median(body.members.map(i => sizes[i]));
  for (const [k, { members, color }] of groups.entries()) {
    const height = median(members.map(i => sizes[i]));
    // A style keeps the page's family unless it is clearly of the other kind (a sans heading on a
    // serif page): Helvetica fits it clearly better than Times, or the best sans family fits it
    // better than any serif one (a humanist sans such as Gill or Myriad is far from Helvetica).
    const lean = ranked[k].get('Times') - ranked[k].get('Helvetica'), kind = SERIF.has(main) ? 'serif' : 'sans';
    const best = serif => Math.max(...[...ranked[k]].filter(([family]) => SERIF.has(family) === serif).map(([, v]) => v));
    const other = kind === 'serif' ? lean < -.04 || best(false) - best(true) > .012 : lean > .04 || best(true) - best(false) > .012;
    // The words' widths, where there are enough of them, name the family outright.
    const families = [widest(members, [...new Set(regulars.map(face => face.family))]) ?? (other ? pick(ranked[k], kind === 'serif' ? 'sans' : 'serif') : main)];
    const candidates = faces.filter(face => families.includes(face.family)), total = new Map(candidates.map(face => [face, mean(face, members)]));
    const sum = filter => [...total].filter(([face]) => filter(face)).reduce((t, [, v]) => t + v, 0);
    const around = i => median(near[i].filter(j => !members.includes(j)).map(j => strokes[j])) || usual;
    // A whole style in bold is a heading or a label: it also differs from the body text in size
    // or colour (a body line printed a little darker is not bold), or it is a line or two,
    // clearly heavier, set apart from the body (a run-in heading).
    const ratio = median(members.map(i => strokes[i] / around(i)));
    const distinct = Math.abs(height - bodySize) > bodySize * .12 || Math.hypot(...color.map((v, c) => v - body.color[c])) > .15 || (members.length <= 2 && ratio > 1.25);
    // The bold face's shapes fitting the letters better, with strokes heavier than the text around,
    // or fitting them much better, with strokes at least not clearly thinner (stroke widths are a
    // pixel or two in a scan, a fit is noisy where lines crowd one another).
    const bolder = (sum(face => face.bold) - sum(face => !face.bold && !face.italic)) / families.length;
    const bold = usual > 0 && distinct && ((bolder > .008 && ratio > 1.1) || (bolder > .03 && ratio > .8));
    // Italic must win clearly, and more so in small text, where the blur blunts every shape.
    const margin = height < 11 ? .05 : .03;
    // A style is a guess (lines of one size and ink): each line still takes its own family, weight
    // and slant when its letters plainly say so (a sans table row among serif text of one size, a
    // bold paragraph, a heading set in italic).
    const home = families[0], away = pick(overall, SERIF.has(home) ? 'sans' : 'serif'), kinds = [...new Set(regulars.map(face => face.family))];
    const set = family => { const of = (bold, italic) => faces.find(face => face.family === family && face.bold === bold && face.italic === italic); return { regular: of(false, false) ?? faces[0], heavy: of(true, false), slant: of(false, true) }; };
    const fit = (i, family) => { const { regular, heavy } = set(family); return Math.max(score(i, regular).score, heavy ? score(i, heavy).score : -2); };
    members.forEach(i => {
      // The closest family of the other kind for this line (a humanist sans box on a serif page is
      // far from Helvetica). A heading or a label of a few words has little to tell its family by;
      // running text plenty, so it takes another family than its style's only when that one fits it
      // clearly better.
      const rival = kinds.filter(f => SERIF.has(f) !== SERIF.has(home)).reduce((best, f) => !best || score(i, set(f).regular).score > score(i, set(best).regular).score ? f : best, null) ?? away;
      const sure = kindOf(penned[i], true), plainly = sure === 'sans' || (lines[i].words?.length ?? 0) > 6 ? sure : null, against = plainly && (plainly === 'serif') !== SERIF.has(home) && !(plainly === 'sans' && SLAB.has(home));
      const family = against || fit(i, rival) - fit(i, home) > ((lines[i].words?.length ?? 0) <= 4 ? .015 : .03) ? rival : home, { regular, heavy, slant } = set(family);
      const plain = score(i, regular).score, thick = heavy ? score(i, heavy).score : -2, leaning = slant ? score(i, slant).score : -2;
      // Bold: the strokes are clearly heavier than the text around and the bold face fits about as
      // well, or the bold face fits better than the upright and the italic ones, with strokes at
      // least a little heavier in running text (where a word or two in italic tips the fit), not
      // thin for the text around in a heading, label or band (a few words: a paragraph of another
      // size, a box's text, is running text all the same).
      const heavier = strokes[i] / (median(near[i].map(j => strokes[j])) || usual || 1), shape = thick - Math.max(plain, leaning);
      const apart = lines[i].band || (lines[i].words?.length ?? 0) <= 6;
      // A title in capitals (too few shapes, a face unlike ours) is weighed by its ink: the bold face
      // when it lays down nearer the scan's ink than the regular.
      const inkCloser = strips[i]?.capitals && heavy && Math.abs(Math.log(score(i, heavy).weight || 1)) + .15 < Math.abs(Math.log(score(i, regular).weight || 1));
      const lineBold = !!heavy && (bold || inkCloser || (shape > .008 && (apart ? heavier > 1.05 || lines[i].band : heavier > 1.13)) || (heavier >= 1.15 && shape > -.03) || (apart && heavier >= 1.3 && shape > -.06));
      // On a band (white letters on a dark row), the OCR's word boxes sit a little off the letters
      // and a slanted face can make up for it: italic there only as its letters' own lean shows.
      const leans = lines[i].band ? wordStyles[i].filter(style => style?.italic).length * 2 > wordStyles[i].filter(Boolean).length : true;
      // Slant before weight: an italic's strokes run heavier than its roman's at one size, a bold face
      // fits it better than the roman, yet the italic fits it better still.
      const slanting = slant && leans && (leaning - Math.max(plain, thick) > (apart ? Math.min(margin, .02) : margin) || (tilted[i] && leaning > Math.max(plain, thick) - .02));
      const face = slanting ? slant : lineBold ? heavy : regular;
      // Within the line, each word keeps its own weight and slant (a bold «Fig. 4-9.», an
      // italic name).
      const sibling = (bold, italic) => faces.find(other => other.family === face.family && other.bold === bold && other.italic === italic && !(bold && italic)) ?? face;
      // How much better one face draws a word than another, on the word's own ink.
      const fits = (n, one, other) => {
        const word = lines[i].words[n], line = { ...lines[i], text: word.text, words: [word], box: [word.box[0], lines[i].box[1], word.box[2], lines[i].box[3]] }, around = inkAround(scan, line);
        const fixed = { baseline: baselines[i], size: measure(i, face), blur };
        return faceScore(around, line, one, fixed).score - faceScore(around, line, other, fixed).score;
      };
      // A line set in italic shows it in its letters' shapes even where the lean is too blurred to measure.
      const slanted = sibling(false, true), italicLine = !face.italic && slanted !== face && score(i, slanted).score - score(i, face).score > .025;
      // A word's weight against the other words of its own line (ink varies from line to line).
      // Bold comes in runs (a phrase, «Fig. 4-9.»): two or more heavier words side by side, which
      // the bold face draws better than the regular one taken together (one word's shape alone
      // says little in a soft scan, and a lone heavy word is the scan's ink).
      // Words in their own colour (a blue link) are weighed apart: their strokes read thinner against the line's ink.
      const plainWord = n => !lines[i].words?.[n]?.color;
      const own = wordStyles[i].filter((style, n) => style && plainWord(n)), common = own.length >= 3 ? median(own.map(style => style.stroke)) : 0;
      // Heavier: past the line's usual stroke by a good margin, or, in a line plainly of two weights
      // (half bold, half not), on the heavy side of the split that parts them most.
      const sorted = own.map(style => style.stroke).sort((p, q) => p - q), average = list => list.reduce((t, v) => t + v, 0) / list.length;
      let cut = common * 1.22, widest = 1.25;
      for (let k = 2; k <= sorted.length - 2; k++) { const low = average(sorted.slice(0, k)), high = average(sorted.slice(k)); if (high / low > widest) { widest = high / low; cut = Math.sqrt(low * high); } }
      const measured = wordStyles[i].flatMap((style, n) => style && plainWord(n) ? [n] : []), bolds = [];
      for (let m = 0; m < measured.length;) {
        let end = m; while (end < measured.length && !face.bold && common > 0 && wordStyles[i][measured[end]].stroke > cut) end++;
        const run = measured.slice(m, end);
        if (run.length >= 2 && run.reduce((t, n) => t + fits(n, sibling(true, false), sibling(false, false)), 0) > 0) run.forEach(n => bolds[n] = true);
        m = Math.max(end, m + 1);
      }
      // Italic: a word that leans, or one in a line set in italic, or one of small letters whose
      // strokes are clearly thinner than the line's other upright words (an italic is lighter than
      // its roman; capitals measure differently), leaning a little, and which the italic face
      // draws clearly better.
      const upright = median(wordStyles[i].flatMap((style, n) => style && !bolds[n] ? [style.stroke] : []));
      const measuredFaces = (lines[i].words ?? []).map((word, n) => {
        const style = wordStyles[i][n];
        if (!style) return null;
        const thin = !lines[i].band && slanted !== face && /[a-zà-ÿ]{3}/.test(word.text) && upright > 0 && style.stroke < upright * .92 && style.lean >= 3 && fits(n, slanted, face) > .01;
        const bold = face.bold || !!bolds[n], italic = !bold && (face.italic || style.italic || thin || (italicLine && !lines[i].band && fits(n, slanted, face) > .01));
        return sibling(bold, italic);
      });
      // A short word («de», «y», too short to measure) takes the style around it: of the words on
      // both sides when they share one, of the word before at the line's end, of the word after at
      // its start, else the line's own.
      const words = measuredFaces.map((known, n) => {
        if (known) return known;
        const before = measuredFaces.slice(0, n).reverse().find(Boolean), after = measuredFaces.slice(n + 1).find(Boolean);
        return before ? (!after || after === before ? before : face) : after ?? face;
      });
      // A line most of whose words are italic is an italic line (sized and placed in the italic).
      const italicWords = words.filter(other => other.italic).length;
      if (!face.italic && italicWords * 2 > words.length && slanted !== face) { chosen[i] = { face: slanted, dy: score(i, slanted).dy, size: 0, baseline: baselines[i], words: words.map(other => other.italic ? other : slanted), fallback: named(SERIF.has(face.family) ? 'Times-Roman' : 'Helvetica').font }; return; }
      chosen[i] = { face, dy: score(i, face).dy, size: 0, baseline: baselines[i], words, fallback: named(SERIF.has(face.family) ? 'Times-Roman' : 'Helvetica').font };
    });
  }
  // A paragraph is set in one family: its lines (each joined to the next below it in its column,
  // of its size) take the family most of them have, keeping their own weight and slant.
  const swapTo = (i, family) => {
    const swap = face => faces.find(other => other.family === family && other.bold === face.bold && other.italic === face.italic) ?? face;
    chosen[i] = { ...chosen[i], face: swap(chosen[i].face), words: chosen[i].words.map(swap), fallback: named(SERIF.has(family) ? 'Times-Roman' : 'Helvetica').font };
  };
  const neighbour = (i, below) => {
    const [x0, top, x1, bottom] = lines[i].box, h = bottom - top;
    return lines.map((line, j) => ({ line, j })).filter(({ line, j }) => j !== i && chosen[j] && Math.min(line.box[2], x1) > Math.max(line.box[0], x0) && Math.abs(sizes[j] - sizes[i]) < sizes[i] * .15
      && (below ? line.box[1] >= top + h * .5 && line.box[1] - bottom < h : line.box[3] <= bottom - h * .5 && top - line.box[3] < h))
      .sort((p, q) => below ? p.line.box[1] - q.line.box[1] : q.line.box[3] - p.line.box[3])[0]?.j;
  };
  // Running text only: a heading, a label or a band's few words keep the family they showed.
  const running = i => !lines[i].band && (lines[i].words?.length ?? 0) > 6;
  const paragraph = lines.map((_, i) => i), root = i => paragraph[i] === i ? i : (paragraph[i] = root(paragraph[i]));
  lines.forEach((_, i) => { const under = neighbour(i, true); if (under !== undefined && running(i) && running(under)) paragraph[root(under)] = root(i); });
  const members = new Map();
  lines.forEach((_, i) => members.set(root(i), [...(members.get(root(i)) ?? []), i]));
  // A paragraph of three lines or more holds far more letters than a line: its family is the one
  // that fits all of them best, which a line alone tells only faintly (at 15 pixels a humanist sans
  // and Times differ by a hundredth); else the family most of its lines took.
  const kinds = [...new Set(regulars.map(face => face.family))];
  for (const group of members.values()) {
    if (group.length < 3) continue;
    const count = family => group.filter(i => chosen[i].face.family === family).length;
    const usual = group.map(i => chosen[i].face.family).sort((a, b) => count(b) - count(a))[0];
    const together = family => { const face = regulars.find(other => other.family === family); return group.reduce((t, i) => t + score(i, face).score, 0) / group.length; };
    // Of the kind the paragraph's strokes show, when they show it plainly.
    const kind = kindOf(median(group.map(i => penned[i])), false), allowed = kinds.filter(family => !kind || SERIF.has(family) === (kind === 'serif') || (kind === 'sans' && SLAB.has(family)));
    const start = allowed.includes(usual) ? usual : allowed[0];
    const best = widest(group, allowed) ?? allowed.reduce((best, family) => together(family) > together(best) ? family : best, start);
    const family = best !== usual && (!allowed.includes(usual) || together(best) - together(usual) > .008) ? best : count(usual) * 2 > group.length ? usual : null;
    if (family) for (const i of group) if (chosen[i].face.family !== family) swapTo(i, family);
  }
  // A book sets its text in one serif family and one sans (a slide in one typeface): the page's
  // lines of each kind take the family that fits all of them best together, keeping their own
  // weight and slant (a line alone tells close families apart only faintly).
  const plainKinds = new Set(lines.flatMap((line, i) => strips[i]?.capitals ? [] : [kindOf(penned[i], true)]).filter(Boolean));
  const page = lines.reduce((t, line) => t + line.text.length, 0) < 1200 && plainKinds.size < 2 ? [null] : [true, false];
  for (const kind of page) {
    const members = lines.flatMap((_, i) => chosen[i] && !lines[i].band && (kind === null || SERIF.has(chosen[i].face.family) === kind) ? [i] : []);
    if (members.length < 2) continue;
    const candidates = [...new Set(regulars.filter(face => kind === null || SERIF.has(face.family) === kind).map(face => face.family))];
    const together = family => { const regular = regulars.find(face => face.family === family); return members.reduce((t, i) => t + score(i, regular).score * Math.min(40, lines[i].text.length), 0); };
    const best = candidates.reduce((best, family) => { const value = together(family); return value > best.value ? { family, value } : best; }, { family: null, value: -Infinity }).family;
    if (best) for (const i of members) if (chosen[i].face.family !== best) swapTo(i, best);
  }
  // On a slide (few letters) a list's items share one weight and one size: each line takes those
  // most of the lines of its family and about its size have (one line's weight and size, read alone
  // from a few large soft letters, wobble).
  if (page.length === 1) lines.forEach((line, i) => {
    if (!chosen[i] || line.band || strips[i]?.capitals) return;
    const size = chosen[i].size || measure(i, chosen[i].face), family = chosen[i].face.family;
    const peers = lines.flatMap((other, j) => chosen[j] && !other.band && !strips[j]?.capitals && chosen[j].face.family === family && Math.abs((chosen[j].size || measure(j, chosen[j].face)) - size) <= size * .2 ? [j] : []);
    if (peers.length < 3) return;
    // Not a line plainly heavier or lighter than the rest (a bold heading among its items).
    const stroke = j => strokes[j] / (median(near[j].map(n => strokes[n])) || usual || 1);
    if (stroke(i) > 1.28 || stroke(i) < .75) return;
    const heavy = peers.filter(j => chosen[j].face.bold).length * 2 > peers.length, italic = chosen[i].face.italic;
    const face = faces.find(other => other.family === family && other.bold === heavy && other.italic === italic && !(heavy && italic)) ?? chosen[i].face;
    const sizes = peers.map(j => chosen[j].size || measure(j, chosen[j].face)).sort((p, q) => p - q);
    chosen[i] = { ...chosen[i], face, words: chosen[i].words.map(() => face), size: sizes[sizes.length >> 1] };
  });
  // Light letters on a dark band fit heavier, rounder faces than they are (the light spreads into
  // the dark): a band takes the family of the text around it (the rest of its table).
  lines.forEach((line, i) => {
    if (!line.band || !chosen[i]) return;
    const families = near[i].filter(j => !lines[j].band && chosen[j]).map(j => chosen[j].face.family);
    const family = families.sort((a, b) => families.filter(f => f === b).length - families.filter(f => f === a).length)[0];
    if (!family || family === chosen[i].face.family) return;
    swapTo(i, family);
    // Its weight from that family's own faces: the first family's were weighed on other shapes.
    const regular = faces.find(face => face.family === family && !face.bold && !face.italic), heavy = faces.find(face => face.family === family && face.bold && !face.italic);
    if (regular && heavy) { const bold = score(i, heavy).score > score(i, regular).score, face = bold ? heavy : regular; chosen[i] = { ...chosen[i], face, words: chosen[i].words.map(() => face) }; }
  });
  // One size per face across the page: lines of one paragraph that a shade of ink set in two
  // styles still share their letters' size (each line's own measure only wobbles around it).
  for (const face of new Set(chosen.map(choice => choice.face))) {
    const members = chosen.flatMap((choice, i) => choice.face === face ? [i] : []), own = members.map(i => measure(i, face));
    // Lines of about one size are one size (each line's own measure is a pixel or two off); a
    // table's smaller text in the same face is another.
    members.forEach((i, m) => { chosen[i].size = median(members.flatMap((_, p) => Math.abs(own[p] - own[m]) <= own[m] * .1 ? [own[p]] : [])); });
    const widths = members.flatMap(i => (lines[i].words ?? []).flatMap((word, n) => {
      if (chosen[i].words[n] !== face || [...word.text].length < 3) return [];
      const units = glyphsOf(word.text, face.font, chosen[i].fallback).reduce((t, { gid, font }) => t + (gid ? font.advanceGlyph(gid) : 0), 0);
      return units ? [(word.box[2] - word.box[0]) / (units * (chosen[i].size || own[members.indexOf(i)]))] : [];
    }));
    const width = median(widths);
    if (widths.length >= 5) members.forEach(i => { chosen[i].width = width; });
  }
  // An italic line set among roman lines of its family takes their size (italics are measured on
  // fewer, slanted letters): the roman line just above or below, when within a sixth of it.
  lines.forEach((_, i) => {
    if (!chosen[i]?.face.italic) return;
    const [x0, top, x1, bottom] = lines[i].box, h = bottom - top;
    const near = lines.flatMap((line, j) => j !== i && chosen[j] && Math.min(line.box[2], x1) > Math.max(line.box[0], x0) && Math.abs((line.box[1] + line.box[3]) / 2 - (top + bottom) / 2) < h * 1.6 ? [j] : []);
    for (const j of near) {
      if (chosen[j].face.italic || chosen[j].face.family !== chosen[i].face.family || !chosen[j].size || !chosen[i].size) continue;
      if (Math.abs(chosen[j].size - chosen[i].size) <= chosen[j].size * .17) { chosen[i].size = chosen[j].size; break; }
    }
  });
  return chosen;
}

// A line of OCR text written as real text where the scan showed it, in `face`, its
// baseline nudged by `dy`. `box` is the ink of the line in page points (y down).
function checkLine(line) {
  if (typeof line?.text !== 'string' || !line.text.trim() || line.text.length > 2000) fail('Línea OCR inválida.');
  const color = line.color;
  if (!Array.isArray(color) || color.length !== 3 || !color.every(v => v >= 0 && v <= 1)) fail('Color de línea inválido.');
  if (line.background !== undefined && !(Array.isArray(line.background) && line.background.length === 3 && line.background.every(v => v >= 0 && v <= 1))) fail('Color de fondo inválido.');
  if (line.band !== undefined && typeof line.band !== 'boolean') fail('Línea OCR inválida.');
  if (line.words !== undefined && !(Array.isArray(line.words) && line.words.length <= 500 && line.words.every(word => typeof word?.text === 'string' && word.text.length <= 500))) fail('Palabras OCR inválidas.');
  const colour = value => Array.isArray(value) && value.length === 3 && value.every(v => v >= 0 && v <= 1) ? value : undefined;
  // Each letter's span across the page (x from, x to), when the recogniser gives them: one per character.
  const spans = (letters, text) => Array.isArray(letters) && letters.length === [...text].length && letters.every(span => Array.isArray(span) && span.length === 2 && span.every(Number.isFinite)) ? letters : undefined;
  return { ...line, box: rect(line.box), words: line.words?.map(word => ({ text: word.text, box: rect(word.box), color: colour(word.color), letters: spans(word.letters, word.text) })) };
}
function writeLine(doc, page, line, { face, dy, size = 0, baseline = 0, width = 0, words: wordFaces = [], fallback = null }) {
  const placed = placeIn(face, line, { size, baseline });
  if (!(placed.size >= 2 && placed.size <= 400)) return;
  placed.baseline += dy;
  appendDrawing(doc, page, device => {
    // Words at their own places when the line has them, letters up to nearly half narrower or wider
    // than the face's own (a condensed title; across a page, the face's own measure holds them).
    // A run of words in their own colour (a link, a term in red) is drawn in it, runs in reading order.
    if (!line.words?.length) { const text = textOf(face.font, placed, fallback); try { device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, line.color, 1); } finally { text.destroy(); } return; }
    const colourOf = word => word.color ?? line.color, same = (p, q) => p.every((v, c) => v === q[c]);
    for (let start = 0; start < line.words.length;) {
      let end = start + 1; while (end < line.words.length && same(colourOf(line.words[end]), colourOf(line.words[start]))) end++;
      const text = wordsText(face.font, placed, line.words.slice(start, end), .35, wordFaces.slice(start, end).map(other => other.font), fallback, width);
      try { device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, colourOf(line.words[start]), 1); } finally { text.destroy(); }
      start = end;
    }
  }, line.text);
}

// Write a drawing as a Form XObject, keeping the rest of the page streams intact.
// `own` marks text Folio writes: true, or the text it stands for.
function appendDrawing(doc, page, draw, own = false) {
  const bounds = page.getBounds();
  const buffer = new mupdf.Buffer(), writer = new mupdf.DocumentWriter(buffer, 'pdf', 'compress=yes');
  let generated, closed = false;
  try {
    const device = writer.beginPage(bounds);
    try { draw(device); } finally { try { writer.endPage(); } finally { device.destroy(); } }
    writer.close(); closed = true; generated = new mupdf.PDFDocument(buffer);
    // A system or CJK font would otherwise be embedded whole on every edit.
    generated.subsetFonts();
    const object = generated.findPage(0);
    const content = object.get('Contents').readStream();
    let form;
    try { form = doc.addStream(content, { Type: 'XObject', Subtype: 'Form', BBox: object.get('MediaBox').asJS(), Resources: doc.graftObject(object.get('Resources')) }); }
    finally { content.destroy(); }
    const target = page.getObject(), inherited = target.getInheritable('Resources');
    const resources = doc.newDictionary();
    if (!inherited.isNull()) inherited.forEach((value, key) => resources.put(key, value));
    const previous = resources.get('XObject'), xobjects = doc.newDictionary();
    if (!previous.isNull()) previous.forEach((value, key) => xobjects.put(key, value));
    const name = `Folio${form.asIndirect()}`; xobjects.put(name, form); resources.put('XObject', xobjects); target.put('Resources', resources);
    // Writer already converts top-left coordinates to PDF coordinates.
    const generatedPage = generated.loadPage(0);
    const transform = mupdf.Matrix.concat(generatedPage.getTransform(), mupdf.Matrix.invert(page.getTransform()));
    // Text Folio writes keeps the box it covers, in its own space: wherever its
    // wrapper later puts it, it is found and moved as a whole (folioTexts).
    if (own) {
      let structured, box = null, text = '';
      try { structured = generatedPage.toStructuredText(); text = structured.asText(); structured.walk({ beginTextBlock: bounds => { box = box ? [Math.min(box[0], bounds[0]), Math.min(box[1], bounds[1]), Math.max(box[2], bounds[2]), Math.max(box[3], bounds[3])] : [...bounds]; } }); }
      finally { structured?.destroy(); }
      // Its text too (as the caller drew it: the writer's own map can misname letters), since a neighbour's text overlapping it can share its box.
      if (box) { form.put('FolioBox', mupdf.Rect.transform(box, mupdf.Matrix.invert(generatedPage.getTransform()))); form.put('FolioText', doc.newString(typeof own === 'string' ? own : text)); }
    }
    generatedPage.destroy();
    const stream = doc.addStream(`q ${transform.join(' ')} cm /${name} Do Q\n`, {});
    const contents = target.get('Contents'), list = doc.newArray();
    if (contents.isArray() && contents.length > 2 && folioDrawing(contents.get(contents.length - 1))) {
      // The original content is already wrapped by an earlier drawing, and each
      // drawing restores its own state: wrapping again would nest q/Q per edit.
      for (let i = 0; i < contents.length; i++) list.push(contents.get(i));
    } else if (!contents.isNull()) {
      // Contents streams share graphics and text state. Restore the page defaults
      // after the original content, which may leave invisible OCR text (3 Tr),
      // transforms, clipping or transparency active for a subsequently added Form.
      list.push(doc.addStream('q\n', {}));
      if (contents.isArray()) for (let i = 0; i < contents.length; i++) list.push(contents.get(i));
      else list.push(contents);
      list.push(doc.addStream('Q\n', {}));
    }
    list.push(stream); target.put('Contents', list);
    return form;
  } finally {
    if (!closed) { try { writer.close(); } catch {} }
    generated?.destroy(); writer.destroy(); buffer.destroy();
  }
}

/** MuPDF's PDF writer builds a font's ToUnicode from the font's own character
 * map, which in an embedded subset can name a glyph wrongly (Segoe UI's «(» as
 * an ornate parenthesis): copying and searching the moved text would read it
 * wrong. The moved glyphs carry the characters they stood for; those replace
 * the writer's entries. Only fonts addressed by glyph id (Identity-H) are mapped. */
function mapCharacters(doc, form, glyphs) {
  const hex = n => n.toString(16).padStart(4, '0');
  const utf16 = code => [...String.fromCodePoint(code)].flatMap(c => [...c].map(unit => unit.charCodeAt(0))).map(hex).join('');
  form.get('Resources', 'Font').forEach(font => {
    const descendant = font.get('DescendantFonts').get(0), map = descendant.get('CIDToGIDMap');
    if (font.get('Subtype').asName() !== 'Type0' || font.get('Encoding').asName() !== 'Identity-H' || !(map.isNull() || map.asName() === 'Identity')) return;
    const name = font.get('BaseFont').asName(), chars = new Map();
    // What the writer already maps, then the moved glyphs' own characters over it.
    const old = font.get('ToUnicode'); let text = '';
    if (old.isStream()) { const buffer = old.readStream(); try { text = buffer.asString(); } finally { buffer.destroy(); } }
    for (const [, body] of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const [, code, value] of body.matchAll(/<([\da-f]+)>\s*<([\da-f]*)>/gi)) chars.set(parseInt(code, 16), value);
    for (const [, body] of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const [, low, high, value] of body.matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
      for (let code = parseInt(low, 16), at = parseInt(value, 16); code <= parseInt(high, 16) && code - parseInt(low, 16) < 65536; code++, at++) chars.set(code, hex(at));
    }
    // Subsetting may prefix the name of a font that had no prefix (Helvetica → ABCDEF+Helvetica).
    for (const glyph of glyphs) if ((glyph.fontName === name || glyph.fontName === name.replace(/^[A-Z]{6}\+/, '')) && glyph.unicode > 0) chars.set(glyph.gid, utf16(glyph.unicode));
    if (!chars.size) return;
    const entries = [...chars].sort((a, b) => a[0] - b[0]), blocks = [];
    for (let i = 0; i < entries.length; i += 100) blocks.push(`${entries.slice(i, i + 100).length} beginbfchar\n${entries.slice(i, i + 100).map(([code, value]) => `<${hex(code)}> <${value}>`).join('\n')}\nendbfchar`);
    font.put('ToUnicode', doc.addStream(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`, {}));
  });
}

// Edits made in Editar skip deduplication (garbage=3 and up), which takes
// seconds on a PDF with thousands of objects; each edit adds only its own subset font.
const QUICK = 'garbage=2,compress=yes,encrypt=keep';

function saveDrawnDocument(doc, password) {
  // MuPDF 1.28.1 can lose a newly grafted Form's stream when deduplicating
  // an embedded font already present in the document. Persist the new streams
  // before the deduplication pass; reopening preserves their data when renumbered.
  const serialized = save(doc, 'garbage=2,compress=yes,encrypt=keep');
  const normalized = open(serialized, password);
  try { return save(normalized); }
  finally { normalized.destroy(); }
}

function textDrawing(device, box, options) {
  if (typeof options.text !== 'string' || options.text.length > 50000) fail('Texto inválido o demasiado largo.');
  const size = Number(options.size ?? 12);
  if (!Number.isFinite(size) || size < 4 || size > 200) fail('Tamaño de letra inválido.');
  const align = options.align ?? 'left', lineHeight = options.lineHeight ?? 1.25, wrap = options.wrap ?? false;
  if (!['left', 'center', 'right'].includes(align)) fail('Alineación de texto inválida.');
  if (!Number.isFinite(lineHeight) || lineHeight < .8 || lineHeight > 3) fail('Interlineado inválido.');
  if (typeof wrap !== 'boolean') fail('Ajuste de líneas inválido.');
  if (options.baselineOffset !== undefined && (!Number.isFinite(options.baselineOffset) || options.baselineOffset < 0 || options.baselineOffset > 2000)) fail('Posición de la línea de base inválida.');
  if (options.fontFamily !== undefined && (typeof options.fontFamily !== 'string' || !options.fontFamily.trim() || options.fontFamily.length > 100)) fail('Nombre de fuente inválido.');
  if (options.fontIndex !== undefined && (!Number.isInteger(options.fontIndex) || options.fontIndex < 0 || options.fontIndex > 255)) fail('Fuente de texto no disponible.');
  const standardFonts = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'];
  if (options.fontName !== undefined && !standardFonts.includes(options.fontName)) fail('Fuente de texto no disponible.');
  // `glyphFont` is the document's own font with the glyphs it actually painted:
  // a subset font's cmap cannot be trusted for the rest.
  const glyphFont = options.glyphFont;
  if (glyphFont && !(glyphFont.font instanceof mupdf.Font && glyphFont.glyphs instanceof Map)) fail('Fuente de texto no disponible.');
  const font = glyphFont ? glyphFont.font : options.font ? new mupdf.Font(options.fontFamily || postScriptName(options.font, options.fontIndex) || 'Folio Sans', options.font, options.fontIndex ?? 0) : new mupdf.Font(options.fontName ?? 'Helvetica');
  const encode = glyphFont ? c => glyphFont.glyphs.get(c.codePointAt(0)) || (glyphFont.complete ? font.encodeCharacter(c) : 0) : c => font.encodeCharacter(c);
  // Subset fonts often have no space glyph: their gaps advance like a space.
  const spaceGlyph = encode(' '), space = spaceGlyph ? font.advanceGlyph(spaceGlyph) : .25;
  const advance = c => { const gid = encode(c); return gid ? font.advanceGlyph(gid) : /\s/.test(c) ? space : 0; };
  const text = new mupdf.Text();
  try {
    for (const c of options.text) if (!/\s/.test(c) && !encode(c)) fail(glyphFont ? `La fuente original no incluye «${c}».` : `La fuente elegida no incluye el carácter «${c}».`);
    const limit = box[2] - box[0], measure = line => [...line].reduce((n, c) => n + advance(c) * size, 0);
    const lines = [];
    for (const paragraph of options.text.replace(/\r/g, '').split('\n')) {
      if (!wrap || measure(paragraph) <= limit + .5) { lines.push(paragraph); continue; }
      let line = '';
      // Break at whitespace, then at glyph boundaries for a word wider than the box.
      for (const token of paragraph.match(/\S+|\s+/gu) || []) {
        if (measure(line + token) <= limit + .5) { line += token; continue; }
        if (line.trim()) { lines.push(line.trimEnd()); line = ''; }
        if (!token.trim()) continue;
        for (const character of token) {
          if (measure(line + character) > limit + .5) {
            if (!line || measure(character) > limit + .5) fail('El texto no cabe en el área. Amplía el área o reduce la letra.');
            lines.push(line); line = '';
          }
          line += character;
        }
      }
      lines.push(line.trimEnd());
    }
    let y = box[1] + (options.baselineOffset ?? size);
    for (const line of lines) {
      const width = measure(line);
      if (width > limit + .5 || y > box[3] + .5) fail('El texto no cabe en el área. Amplía el área o reduce la letra.');
      let x = box[0] + (align === 'center' ? (limit - width) / 2 : align === 'right' ? limit - width : 0);
      for (const c of line) { const gid = encode(c); if (gid) text.showGlyph(font, [size, 0, 0, -size, x, y], gid, c.codePointAt(0)); x += advance(c) * size; }
      y += size * lineHeight;
    }
    // Wrapped text must fit its actual glyph ink, including descenders below the baseline.
    // Legacy calls retain their original baseline-based fitting behavior.
    // A document's own font may report its whole font box for every glyph, so
    // its text keeps the baseline fitting the original lines had.
    if (wrap && options.text.trim() && !glyphFont) {
      const ink = text.getBounds(null, mupdf.Matrix.identity);
      if (ink[3] > box[3] + .5 || (options.baselineOffset !== undefined && ink[1] < box[1] - .5)) fail('El texto no cabe en el área. Amplía el área o reduce la letra.');
    }
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, rgb(options.color || '#202020'), 1);
  } finally { text.destroy(); if (!glyphFont) font.destroy(); }
}

function imagePlacement(image, box, options, orientation = 1) {
  const fit = options.fit ?? 'stretch', alpha = options.opacity ?? 1, rotation = options.rotation ?? 0;
  if (!['contain', 'cover', 'stretch'].includes(fit)) fail('Ajuste de imagen inválido.');
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) fail('Opacidad de imagen inválida.');
  if (![0, 90, 180, 270].includes(rotation)) fail('Giro de imagen inválido.');
  const width = box[2] - box[0], height = box[3] - box[1], turned = rotation === 90 || rotation === 270;
  let w = turned ? height : width, h = turned ? width : height;
  if (fit !== 'stretch') {
    const iw = orientation >= 5 ? image.getHeight() : image.getWidth(), ih = orientation >= 5 ? image.getWidth() : image.getHeight();
    const scale = (fit === 'contain' ? Math.min : Math.max)(width / (turned ? ih : iw), height / (turned ? iw : ih));
    w = iw * scale; h = ih * scale;
  }
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const matrix = rotation === 90 ? [0, w, -h, 0, cx + h / 2, cy - w / 2]
    : rotation === 180 ? [-w, 0, 0, -h, cx + w / 2, cy + h / 2]
    : rotation === 270 ? [0, -w, h, 0, cx - h / 2, cy + w / 2]
    : [w, 0, 0, h, cx - w / 2, cy - h / 2];
  // Camera photos are placed upright, as galleries show them.
  return { matrix: mupdf.Matrix.concat(orientationMatrix(orientation), matrix), alpha, clip: fit === 'cover' };
}

function imageDrawing(device, box, image, placement) {
  let path;
  if (placement.clip) {
    path = new mupdf.Path(); path.rect(...box);
    try { device.clipPath(path, false, mupdf.Matrix.identity); } finally { path.destroy(); }
  }
  try { device.fillImage(image, placement.matrix, placement.alpha); }
  finally { if (placement.clip) device.popClip(); }
}

function areaContent(page, box) {
  const result = { text: '', size: 12, color: '#202020', fontName: 'Helvetica', mixedStyle: false, rotated: false };
  const styles = new Map(), lines = [];
  let selected = '', direction, structured;
  try {
    structured = page.toStructuredText('preserve-whitespace');
    structured.walk({
      beginLine: (_bounds, mode, vector) => { selected = ''; direction = mode !== 0 || Math.abs(vector[1]) > .01 || vector[0] < .99; },
      onChar: (character, _origin, font, size, quad, color) => {
        try {
          // Same rule as areaRemoval: a glyph belongs to the area by its centre.
          const glyph = quadBounds(quad), x = (glyph[0] + glyph[2]) / 2, y = (glyph[1] + glyph[3]) / 2;
          if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) return;
          selected += character; result.rotated ||= direction;
          if (!character.trim()) return;
          const hex = '#' + color.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('');
          const fontName = font.getName(), key = `${fontName}:${Math.round(size * 100)}:${hex}`;
          const style = styles.get(key) || { size, color: hex, fontName, count: 0 }; style.count++; styles.set(key, style);
        } finally { font.destroy(); }
      },
      endLine: () => { if (selected) lines.push(selected); },
    });
    result.text = lines.join('\n');
    const predominant = [...styles.values()].sort((a, b) => b.count - a.count)[0];
    if (predominant) { result.size = predominant.size; result.color = predominant.color; result.fontName = predominant.fontName; }
    result.mixedStyle = styles.size > 1;
    return result;
  } finally { structured?.destroy(); }
}

// Describe selectable regions, rather than pretending a PDF always has isolated
// editable objects. The device pass also sees faint images and invisible OCR.
function pageContent(doc, page, requestedImage, selectedContent, withDrawings = false) {
  if (requestedImage !== undefined && (typeof requestedImage !== 'string' || !/^image-\d{1,5}$/.test(requestedImage))) fail('La imagen seleccionada ya no es válida.');
  const bounds = page.getBounds(), inverse = mupdf.Matrix.invert(page.getTransform());
  const overlap = (a, b) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > .5 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > .5;
  const intersection = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const usable = b => finite(b) && b.length === 4 && b[2] - b[0] > .1 && b[3] - b[1] > .1;
  const equalBox = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < .5);
  const point = (x, y, m) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  const warnings = new Set(), textPaint = [], images = [], imagePaint = [], glyphs = [], graphics = [], groups = [];
  const clips = [{ box: bounds, complex: false }]; let events = 0, characters = 0, order = 0, overflow = false, deviceError, display, structured, device, selectedImage;
  // Device callbacks run inside MuPDF: an exception unwinding through them skips
  // its cleanup and corrupts the WASM heap. They record the failure and stop
  // collecting; it is raised once runPageContents has returned.
  const reserve = () => { if (++events > 20000) overflow = true; return !overflow && !deviceError; };
  const guard = callback => (...args) => { try { callback(...args); } catch (error) { deviceError ??= error; } };
  const currentClip = () => clips.at(-1);
  const complexGroup = () => groups.some(Boolean);
  const pushClip = (box, complex, maskMatrix) => { if (reserve()) clips.push({ box: intersection(box, currentClip().box), complex: complex || currentClip().complex, maskMatrix }); };
  const isRectangle = (path, matrix) => {
    let count = 0, curve = false, closed = false; const points = [];
    path.walk({ moveTo: (x, y) => { count++; if (count <= 5) points.push(point(x, y, matrix)); }, lineTo: (x, y) => { count++; if (count <= 5) points.push(point(x, y, matrix)); }, curveTo: () => { curve = true; }, closePath: () => { closed = true; } });
    if (curve || !closed || count < 4 || count > 5) return false;
    const box = path.getBounds(null, matrix);
    return points.every(([x, y]) => (Math.abs(x - box[0]) < .1 || Math.abs(x - box[2]) < .1) && (Math.abs(y - box[1]) < .1 || Math.abs(y - box[3]) < .1));
  };
  const paintText = (text, matrix, alpha, hidden, stroke = null) => {
    if (!reserve()) return; const box = text.getBounds(stroke, matrix);
    textPaint.push({ box, hidden: hidden || alpha <= 0, complex: complexGroup() || currentClip().complex || alpha < .999, clip: currentClip().box, order: order++ });
  };
  const paintImage = (image, matrix, alpha, mask = false) => {
    if (!reserve()) return; const box = mupdf.Rect.transform([0, 0, 1, 1], matrix);
    let softMask;
    try {
      softMask = image.getMask();
      // An image's own soft mask (a PNG's alpha) is painted as a mask clip with the
      // image's matrix just before it: that is transparency, not an effect.
      const own = softMask && clips.length > 1 && currentClip().maskMatrix?.every((v, i) => Math.abs(v - matrix[i]) < .01);
      const clip = own ? clips.at(-2) : currentClip(), visible = intersection(box, clip.box);
      // A soft mask is ordinary transparency (a PNG's alpha); stencil masks are effects.
      const info = { box: visible, fullBox: box, alpha, complex: complexGroup() || clip.complex, masked: mask || image.getImageMask(), transparent: !!softMask, clipped: !equalBox(visible, box), matrix, order: order++, width: image.getWidth(), height: image.getHeight() };
      if (selectedContent) imagePaint.push(info);
      if (usable(visible)) {
        if (`image-${images.length}` === (requestedImage ?? (selectedContent?.kind === 'image' ? selectedContent.id : undefined))) selectedImage = new mupdf.Image(image.pointer);
        images.push(info);
      }
    } finally { softMask?.destroy(); }
  };
  const paintPath = (path, matrix, alpha, stroke = null) => { if (reserve() && alpha > 0) graphics.push({ box: path.getBounds(stroke, matrix), order: order++ }); };
  try {
    device = new mupdf.Device(Object.fromEntries(Object.entries({
      fillText: (text, matrix, cs, _color, alpha) => { try { paintText(text, matrix, alpha, false); } finally { text.destroy(); cs.destroy(); } },
      strokeText: (text, stroke, matrix, cs, _color, alpha) => { try { paintText(text, matrix, alpha, false, stroke); } finally { text.destroy(); stroke.destroy(); cs.destroy(); } },
      ignoreText: (text, matrix) => { try { paintText(text, matrix, 0, true); } finally { text.destroy(); } },
      fillImage: (image, matrix, alpha) => { try { paintImage(image, matrix, alpha); } finally { image.destroy(); } },
      fillImageMask: (image, matrix, cs, _color, alpha) => { try { paintImage(image, matrix, alpha, true); } finally { image.destroy(); cs.destroy(); } },
      fillPath: (path, _evenOdd, matrix, cs, _color, alpha) => { try { paintPath(path, matrix, alpha); } finally { path.destroy(); cs.destroy(); } },
      strokePath: (path, stroke, matrix, cs, _color, alpha) => { try { paintPath(path, matrix, alpha, stroke); } finally { path.destroy(); stroke.destroy(); cs.destroy(); } },
      clipPath: (path, _evenOdd, matrix) => { try { pushClip(path.getBounds(null, matrix), !isRectangle(path, matrix)); } finally { path.destroy(); } },
      clipStrokePath: (path, stroke, matrix) => { try { pushClip(path.getBounds(stroke, matrix), true); } finally { path.destroy(); stroke.destroy(); } },
      clipText: (text, matrix) => { try { pushClip(text.getBounds(null, matrix), true); } finally { text.destroy(); } },
      clipStrokeText: (text, stroke, matrix) => { try { pushClip(text.getBounds(stroke, matrix), true); } finally { text.destroy(); stroke.destroy(); } },
      clipImageMask: (image, matrix) => { try { pushClip(mupdf.Rect.transform([0, 0, 1, 1], matrix), true, [...matrix]); } finally { image.destroy(); } },
      popClip: () => { if (clips.length > 1) clips.pop(); },
      beginGroup: (_box, cs, _isolated, knockout, blend, alpha) => { try { if (reserve()) groups.push(knockout || blend !== 'Normal' || alpha < .999); } finally { cs.destroy(); } },
      endGroup: () => { groups.pop(); },
      beginMask: (box, _luminosity, cs) => { try { pushClip(box, true); } finally { cs.destroy(); } },
      endMask: () => {},
    }).map(([name, callback]) => [name, guard(callback)])));
    page.runPageContents(device, mupdf.Matrix.identity); device.close(); device.destroy(); device = undefined;
    if (deviceError) throw deviceError;
    if (overflow) fail('La página contiene demasiados elementos para detectarlos automáticamente.');
    display = page.toDisplayList(false); structured = display.toStructuredText('preserve-whitespace');
    // The installed walker truncates non-BMP runes with fromCharCode. JSON's
    // Unicode strings preserve them; only strings are used, not its rounded boxes.
    const jsonLines = JSON.parse(structured.asJSON()).blocks.filter(block => block.type === 'text').flatMap(block => block.lines.map(line => line.text));
    if (jsonLines.reduce((n, line) => n + line.length, 0) > 200000) fail('La página tiene demasiado texto para detectarlo automáticamente.');
    const blocks = [], fontChars = new Map(); let block, line, index = 0, rune = 0, jsonRunes;
    structured.walk({
      beginTextBlock: box => { block = { box, lines: [] }; blocks.push(block); if (blocks.length > 5000) fail('Hay demasiados bloques para la selección automática.'); },
      beginLine: (box, mode, direction) => { line = { box, mode, direction, text: '', styles: new Map(), glyphs: [] }; block.lines.push(line); jsonRunes = [...(jsonLines[index++] || '')]; rune = 0; },
      onChar: (character, origin, font, size, _quad, color) => {
        try {
          if (++characters > 100000) fail('Hay demasiado texto para la selección automática.');
          const c = jsonRunes[rune++] ?? character; line.text += c; line.origin ??= origin;
          const fontName = font.getName();
          if (c.trim()) { const chars = fontChars.get(fontName) || new Set(); if (chars.size < 4000) chars.add(c); fontChars.set(fontName, chars); }
          if (selectedContent) { const glyph = { c, origin: [...origin], quad: [..._quad], fontName, size, color: [...color] }; line.glyphs.push(glyph); glyphs.push(glyph); }
          if (!c.trim()) return;
          const hex = '#' + color.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('');
          const key = `${fontName}:${Math.round(size * 100)}:${hex}`, style = line.styles.get(key) || { size, color: hex, fontName, count: 0 };
          style.count++; line.styles.set(key, style);
        } finally { font.destroy(); }
      },
    });
    const candidates = [];
    const addText = (id, level, box, rows, bi) => {
        const styles = new Map(); rows.forEach(row => row.styles.forEach((style, key) => { const entry = styles.get(key) || { ...style, count: 0 }; entry.count += style.count; styles.set(key, entry); }));
        const style = [...styles.values()].sort((a, b) => b.count - a.count)[0] || { size: 12, color: '#202020', fontName: 'Helvetica' };
        const related = textPaint.filter(event => overlap(event.box, box)), hidden = related.some(event => event.hidden), visible = related.some(event => !event.hidden);
        const rotated = rows.some(row => row.mode !== 0 || Math.abs(row.direction[1]) > .01 || row.direction[0] < .99);
        const clipped = !equalBox(intersection(box, bounds), box) || related.some(event => !equalBox(intersection(box, event.clip), box));
        const complex = related.some(event => event.complex && !event.hidden);
        let reason = !visible ? 'Texto OCR invisible: no representa letras visibles que puedan reemplazarse.' : hidden ? 'Hay capas de texto visibles e invisibles superpuestas.' : rotated ? 'Texto girado o vertical.' : clipped || complex ? 'Texto recortado o con efectos.' : undefined;
        const baselineOffset = rows[0].origin?.[1] - box[1];
        const advances = !rotated ? rows.slice(1).map((row, i) => (row.origin?.[1] - rows[i].origin?.[1]) / style.size).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b) : [];
        const lineHeight = advances.length ? advances[Math.floor(advances.length / 2)] : undefined;
        if (lineHeight !== undefined && (lineHeight < .8 || lineHeight > 3)) reason ??= 'Interlineado fuera del rango del editor.';
        const item = { id, kind: 'text', level, rect: mupdf.Rect.transform(intersection(box, bounds), inverse), text: rows.map(row => row.text).join('\n'), size: style.size, color: style.color, fontName: style.fontName, mixedStyle: styles.size > 1, rotated, editable: !reason, ...(reason ? { reason } : {}), ...(reason && visible && !hidden ? { areaReplaceable: true } : {}), ...(Number.isFinite(baselineOffset) && baselineOffset >= 0 ? { baselineOffset } : {}), ...(lineHeight >= .8 && lineHeight <= 3 ? { lineHeight } : {}), fontGlyphs: /^[A-Z]{6}\+/.test(style.fontName) ? [...(fontChars.get(style.fontName) || [])].join('') : '*' };
        candidates.push({ item, box, block: bi, rows });
    };
    const around = rows => rows.reduce((box, row) => [Math.min(box[0], row.box[0]), Math.min(box[1], row.box[1]), Math.max(box[2], row.box[2]), Math.max(box[3], row.box[3])], [...rows[0].box]);
    for (const [bi, block] of blocks.entries()) {
      const rows = block.lines.filter(row => row.text.trim() && usable(intersection(row.box, bounds)));
      if (!rows.length) continue;
      rows.forEach((row, li) => addText(`text-line-b${bi}-l${li}`, 'line', row.box, [row], bi));
      addText(`text-paragraph-b${bi}`, 'paragraph', around(rows), rows, bi);
    }
    // Text Folio wrote that the page reads as part of a neighbour's paragraph (it
    // was dropped next to it) is still offered alone, as the block Folio drew.
    const written = folioTexts(page);
    written.forEach((own, n) => {
      if (candidates.some(candidate => candidate.item.level === 'paragraph' && folioText([own], candidate.item.rect, candidate.item.text))) return;
      const [x0, y0, x1, y1] = mupdf.Rect.transform(own.box, page.getTransform());
      const rows = candidates.filter(candidate => candidate.item.level === 'line').flatMap(candidate => candidate.rows)
        .filter(row => { const x = (row.box[0] + row.box[2]) / 2, y = (row.box[1] + row.box[3]) / 2; return x >= x0 && x <= x1 && y >= y0 && y <= y1; });
      if (!rows.length) return;
      addText(`text-folio-${n}`, 'paragraph', mupdf.Rect.transform(own.box, page.getTransform()), rows, -1 - n);
      candidates.at(-1).item.text = own.text.trim();
    });
    for (const candidate of candidates) {
      if (candidate.item.editable && candidates.some(other => other.block !== candidate.block && other.item.level === 'line' && overlap(candidate.box, other.box))) {
        Object.assign(candidate.item, { editable: false, reason: 'Hay otro bloque de texto superpuesto.', areaReplaceable: true });
      }
      if (candidate.item.editable && images.some(image => image.alpha >= .999 && !image.masked && overlap(candidate.box, image.box) && textPaint.some(event => !event.hidden && overlap(event.box, candidate.box) && image.order > event.order))) {
        Object.assign(candidate.item, { editable: false, reason: 'El texto está cubierto por una imagen.', areaReplaceable: true });
      }
      if (candidate.item.reason) warnings.add(candidate.item.reason);
    }
    for (const candidate of candidates) if (candidate.item.level === 'paragraph' && !candidate.item.rotated && folioText(written, candidate.item.rect, candidate.item.text)) {
      candidate.item.editable = true; delete candidate.item.reason; delete candidate.item.areaReplaceable;
    }
    const placed = folioImages(page);
    const imageItems = images.map((image, i) => {
      const [a, b, c, d] = image.matrix, orthogonal = (Math.abs(b) < .01 && Math.abs(c) < .01) || (Math.abs(a) < .01 && Math.abs(d) < .01);
      // Moving an image draws it again on top: anything above it would end up below.
      // What lies below is kept. An image Folio placed is edited where it is.
      const own = !!folioImage(placed, mupdf.Rect.transform(image.box, inverse));
      const overlaps = !own && (images.some(other => other.order > image.order && other.alpha > 0 && overlap(image.box, other.box)) || candidates.some(candidate => candidate.item.level === 'line' && overlap(image.box, candidate.box) && textPaint.some(event => !event.hidden && event.order > image.order && overlap(event.box, candidate.box))) || graphics.some(graphic => graphic.order > image.order && overlap(graphic.box, image.box)));
      const reason = image.alpha <= 0 ? 'Imagen invisible.' : image.clipped || image.complex || image.masked ? 'Imagen recortada, con máscara o efectos.' : a * d - b * c <= 0 ? 'Imagen reflejada.' : !orthogonal ? 'Imagen inclinada.' : overlaps ? 'Imagen con contenido superpuesto.' : image.width * image.height > 16000000 ? 'La imagen supera el límite de 16 megapíxeles para editarla automáticamente.' : undefined;
      if (reason) warnings.add(reason);
      const rotation = ((Math.round(Math.atan2(b, a) / (Math.PI / 2)) * 90) % 360 + 360) % 360;
      return { id: `image-${i}`, kind: 'image', rect: mupdf.Rect.transform(image.box, inverse), editable: !reason, opacity: image.alpha, rotation, ...(image.transparent ? { transparent: true } : {}), ...(reason ? { reason } : {}), ...(reason && image.alpha > 0 ? { areaReplaceable: true } : {}) };
    });
    const items = [...candidates.map(candidate => candidate.item), ...imageItems];
    if (withDrawings) {
      const drawn = drawingItems(page);
      if (drawn.tooMany) warnings.add('La página tiene demasiados dibujos para seleccionarlos.');
      items.push(...drawn.items);
    }
    if (hasSignature(doc) || !doc.hasPermission('edit')) {
      const reason = 'El documento firmado o sus permisos no permiten editar el contenido.';
      items.forEach(item => { item.editable = false; item.reason = reason; delete item.areaReplaceable; }); warnings.add(reason);
    }
    if (selectedContent) {
      const { id, kind } = selectedContent, item = items.find(item => item.id === id);
      if (!item || item.kind !== kind || !item.rect.every((value, i) => Math.abs(value - selectedContent.rect[i]) <= .02)) fail('La selección cambió o ya no existe. Selecciona de nuevo el contenido.');
      if (!item.editable) fail(item.reason || 'No se puede eliminar esta selección automáticamente.');
      if (kind === 'image') {
        const image = images[Number(id.slice(6))];
        if (!finite(image.fullBox) || !image.fullBox.every((n, i) => Math.abs(n - image.box[i]) <= .02)) fail('La imagen está recortada; no se puede eliminar esta instancia automáticamente.');
        // IMAGE_REMOVE tests the complete painted image, even when it is hidden
        // by alpha or clipping. The picker deliberately tolerates tiny overlaps;
        // deletion must not use that tolerance or remove a second instance.
        // Removal takes every image the mark touches: mark a spot of this one that no other image covers.
        const [x0, y0, x1, y1] = image.fullBox, spots = [];
        for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) spots.push([x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * j / 8]);
        const spot = spots.map(([x, y]) => [x - .2, y - .2, x + .2, y + .2]).find(box => !imagePaint.some(other => other !== image && intersects(box, other.fullBox)));
        if (!spot) fail('Otra imagen cubre por completo esta; no se puede eliminar solo esta instancia con seguridad.');
        return { boxes: [spot], retainedGlyphs: glyphs.filter(glyph => glyph.c.trim()), info: image, image: selectedImage && new mupdf.Image(selectedImage.pointer) };
      }
      const candidate = candidates.find(candidate => candidate.item === item), selected = new Set(candidate.rows.flatMap(row => row.glyphs));
      if (selected.size > 5000) fail('Hay demasiados caracteres para modificar esta selección automáticamente. Selecciona menos líneas.');
      return textRemoval([...selected], glyphs.filter(glyph => !selected.has(glyph) && glyph.c.trim()), item.level === 'line'
        ? 'Esta línea está demasiado cerca de otro texto para modificarla sola. Selecciona el párrafo completo.' : 'Este párrafo está demasiado cerca de otro texto para modificarlo solo.');
    }
    if (requestedImage !== undefined) {
      const item = imageItems.find(item => item.id === requestedImage);
      if (!item || !selectedImage) fail('La imagen seleccionada ya no existe en esta página.');
      if (!item.editable) fail(item.reason);
      if (images[Number(requestedImage.slice(6))].transparent) fail('Esta imagen tiene transparencia: muévela o sustitúyela desde el editor de escritorio.');
      return pageImagePixels(selectedImage, images[Number(requestedImage.slice(6))], jpegSource(doc, page, selectedImage));
    }
    return { items, warnings: [...warnings] };
  } finally { selectedImage?.destroy(); device?.destroy(); structured?.destroy(); display?.destroy(); }
}

// Drawings the PDF paints itself (boxes, bands, rules) are read from the page's
// own content streams: a drawing is the outermost q…Q group that only paints
// paths, or a lone painted path. Editing rewrites those operators where they
// are, so whatever lies above or below a drawing stays there. Paths inside Form
// XObjects, Folio's own additions among them, are not listed.
const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const FILL_COLOR = new Set(['rg', 'g', 'k', 'sc', 'scn', 'cs']), STROKE_COLOR = new Set(['RG', 'G', 'K', 'SC', 'SCN', 'CS']);
// What may stand between the parts of one drawing: state changes, none of them painting.
const BETWEEN = new Set(['gs', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'cm', 'BDC', 'BMC', 'EMC', 'MP', 'DP', ...FILL_COLOR, ...STROKE_COLOR]);
const latin1 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768)); return text; };
const number = value => String(Math.round(value * 10000) / 10000);

/** A content stream's operators, each with its operands and the offsets they span. */
function contentOperators(text) {
  const ops = [], args = [], n = text.length, white = c => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  let i = 0, start = -1, depth = 0;
  while (i < n) {
    const c = text[i];
    if (white(c)) { i++; continue; }
    if (c === '%') { while (i < n && text[i] !== '\n' && text[i] !== '\r') i++; continue; }
    const from = i;
    if (c === '(') { for (let level = 0; i < n; i++) { if (text[i] === '\\') i++; else if (text[i] === '(') level++; else if (text[i] === ')' && --level === 0) { i++; break; } } }
    else if (c === '<' && text[i + 1] === '<') { i += 2; depth++; }
    else if (c === '>' && text[i + 1] === '>') { i += 2; depth = Math.max(0, depth - 1); }
    else if (c === '<') { const close = text.indexOf('>', i); i = close < 0 ? n : close + 1; }
    else if (c === '[') { i++; depth++; }
    else if (c === ']') { i++; depth = Math.max(0, depth - 1); }
    else { i++; while (i < n && !white(text[i]) && !'()<>[]{}/%'.includes(text[i])) i++; }
    if (start < 0) start = from;
    const token = text.slice(from, i);
    if (depth > 0 || '(<>[]{}/'.includes(c) || /^[+-]?(\d+\.?\d*|\.\d+)$/.test(token) || token === 'true' || token === 'false' || token === 'null') {
      if (depth === 0 && c !== ']' && c !== '>') args.push(token);
      continue;
    }
    ops.push({ op: token, start, end: i, args: args.splice(0) }); start = -1;
    // Inline image data runs, unparsed, to EI.
    if (token === 'ID') { const end = /\sEI(?=\s|$)/g; end.lastIndex = i + 1; const found = end.exec(text); i = ops.at(-1).end = found ? found.index + 3 : n; }
  }
  return ops;
}

// Gray, RGB or CMYK operands as #rrggbb; a pattern or other space gives null.
function colorHex(args) {
  if (!args.length || args.some(arg => arg.startsWith('/'))) return null;
  const v = args.map(Number), hex = values => '#' + values.map(x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
  return v.length === 4 ? hex(v.slice(0, 3).map(x => (1 - x) * (1 - v[3]))) : v.length === 3 ? hex(v) : v.length === 1 ? hex([v[0], v[0], v[0]]) : null;
}

/** The page's drawings in PDF coordinates, with where each sits in its content stream. */
function pageDrawings(page) {
  const contents = page.getObject().get('Contents');
  const streams = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : contents.isStream() ? [contents] : [];
  const pageBox = mupdf.Rect.transform(page.getBounds(), mupdf.Matrix.invert(page.getTransform()));
  const union = (a, b) => a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
  const meet = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const texts = [], drawings = [], saved = [];
  let state = { ctm: [1, 0, 0, 1, 0, 0], width: 1, clip: pageBox, fill: '#000000', stroke: '#000000' }, path = null;
  const point = (x, y) => { const [a, b, c, d, e, f] = state.ctm, px = x * a + y * c + e, py = x * b + y * d + f; path.box = union(path.box, [px, py, px, py]); };
  // Open q…Q groups; the first stands for the page itself.
  const fresh = (si, start) => ({ si, start, ctm: state.ctm, pure: true, children: [], loose: [], paints: [], fills: [], strokes: [] });
  const groups = [{ ...fresh(-1, 0), pure: false }];
  // A group that only drew paths waits inside its parent, which may take it in;
  // a group with anything else gives its own drawings and lone paths.
  const close = (group, si, end) => {
    if (group.pure && group.si === si && group.box) { group.parts = [{ start: group.start, end, ctm: group.ctm }]; groups.at(-1).children.push(group); return; }
    drawings.push(...group.children, ...group.loose);
  };
  for (const [si, stream] of streams.entries()) {
    const buffer = stream.readStream();
    try { texts.push(latin1(buffer.asUint8Array())); } finally { buffer.destroy(); }
    for (const { op, start, end, args } of contentOperators(texts[si])) {
      const v = args.map(Number);
      if (op === 'q') { saved.push(state); state = { ...state }; groups.push(fresh(si, start)); }
      else if (op === 'Q') { if (saved.length) state = saved.pop(); if (groups.length > 1) close(groups.pop(), si, end); }
      else if (op === 'cm' && v.length === 6 && v.every(Number.isFinite)) state.ctm = mupdf.Matrix.concat(v, state.ctm);
      else if (op === 'w' && Number.isFinite(v[0])) state.width = v[0];
      else if (['m', 'l', 'c', 'v', 'y', 're', 'h'].includes(op)) {
        path ??= { si, start, box: null, clip: false };
        if (op === 're') { point(v[0], v[1]); point(v[0] + v[2], v[1]); point(v[0], v[1] + v[3]); point(v[0] + v[2], v[1] + v[3]); }
        else for (let p = 0; p + 1 < v.length; p += 2) point(v[p], v[p + 1]);
      }
      else if (op === 'W' || op === 'W*') { if (path) path.clip = true; }
      else if (op === 'n') { if (path?.clip && path.box) state.clip = meet(state.clip, path.box); path = null; }
      else if (PAINT.has(op)) {
        if (!path?.box || path.box.some(value => !Number.isFinite(value))) { path = null; continue; }
        const stroked = op !== 'f' && op !== 'F' && op !== 'f*', filled = op !== 'S' && op !== 's';
        const grow = stroked ? state.width * Math.hypot(state.ctm[0], state.ctm[1]) / 2 : 0;
        const box = meet([path.box[0] - grow, path.box[1] - grow, path.box[2] + grow, path.box[3] + grow], state.clip), visible = box[2] > box[0] && box[3] > box[1];
        if (path.clip) state.clip = meet(state.clip, path.box);
        const paint = { start, end };
        for (const group of groups) {
          group.paints.push(paint);
          if (visible) group.box = union(group.box, box);
          if (filled && group.fill === undefined) group.fill = state.fill;
          if (stroked && group.stroke === undefined) group.stroke = state.stroke;
        }
        if (visible && path.si === si) groups.at(-1).loose.push({ si, start: path.start, parts: [{ start: path.start, end, ctm: state.ctm, lone: true }], box, paints: [paint], fills: [], strokes: [], clip: path.clip, ...(filled ? { fill: state.fill } : {}), ...(stroked ? { stroke: state.stroke } : {}) });
        path = null;
      }
      else if (FILL_COLOR.has(op) || STROKE_COLOR.has(op)) {
        const fill = FILL_COLOR.has(op), lower = op.toLowerCase(), key = fill ? 'fill' : 'stroke';
        if (lower !== 'cs') state[key] = colorHex(args);
        else if (args[0] === '/Pattern') state[key] = null;
        for (const group of groups) group[fill ? 'fills' : 'strokes'].push({ start, end });
      }
      // Text, images and shadings make a group more than a drawing.
      else if (op === 'BT' || op === 'Do' || op === 'BI' || op === 'sh') for (const group of groups) group.pure = false;
    }
  }
  while (groups.length > 1) close(groups.pop(), -1, 0);
  close(groups[0], -1, 0);
  // A shape's fill and its border are often painted one after the other, with at
  // most a change of state between them: they make one drawing, in parts.
  const same = (a, b) => { const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]); return w > 0 && h > 0 && w * h > .8 * Math.max((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])); };
  const merged = [];
  for (const drawing of drawings.sort((a, b) => a.si - b.si || a.start - b.start)) {
    const last = merged.at(-1);
    if (last && last.si === drawing.si && !last.clip && !drawing.clip && same(last.box, drawing.box)
      && contentOperators(texts[drawing.si].slice(last.parts.at(-1).end, drawing.start)).every(({ op }) => BETWEEN.has(op))) {
      Object.assign(last, { box: union(last.box, drawing.box), parts: [...last.parts, ...drawing.parts], paints: [...last.paints, ...drawing.paints], fills: [...last.fills, ...drawing.fills], strokes: [...last.strokes, ...drawing.strokes] });
      if (last.fill === undefined && drawing.fill !== undefined) last.fill = drawing.fill;
      if (last.stroke === undefined && drawing.stroke !== undefined) last.stroke = drawing.stroke;
    } else merged.push(drawing);
  }
  // The page's own background is not something to pick.
  const area = box => (box[2] - box[0]) * (box[3] - box[1]), pageArea = area(pageBox);
  const listed = merged.filter(drawing => area(drawing.box) < pageArea * .85);
  return { streams, texts, drawings: listed.length > 3000 ? [] : listed, tooMany: listed.length > 3000 };
}

function drawingItems(page) {
  const { drawings, tooMany } = pageDrawings(page);
  return { tooMany, items: drawings.map((drawing, i) => ({ id: `graphic-${i}`, kind: 'graphic', rect: drawing.box, editable: true, ...(drawing.fill !== undefined ? { fill: drawing.fill } : {}), ...(drawing.stroke !== undefined ? { stroke: drawing.stroke } : {}), ...(drawing.clip ? { clip: true } : {}) })) };
}

/** The drawing `sourceId` names, checked against where it was selected. */
function drawingAt(page, options) {
  if (typeof options.sourceId !== 'string' || !/^graphic-\d{1,5}$/.test(options.sourceId)) fail('La selección de contenido no es válida.');
  const found = pageDrawings(page), drawing = found.drawings[Number(options.sourceId.slice(8))], source = rect(options.sourceRect);
  if (!drawing || !drawing.box.every((value, i) => Math.abs(value - source[i]) <= .02)) fail('La selección cambió o ya no existe. Selecciona de nuevo el contenido.');
  return { found, drawing, source };
}

const pdfColor = hex => rgb(hex).map(number).join(' ');
/** Edits to a drawing's own stream that paint it in new colours. */
function recolorEdits(drawing, { fill, stroke }) {
  if (!fill && !stroke) fail('Elige un color.');
  if (drawing.clip) fail('Este trazo también recorta otros elementos: no se puede cambiar su color.');
  const set = `${fill ? `${pdfColor(fill)} rg ` : ''}${stroke ? `${pdfColor(stroke)} RG ` : ''}`, edits = [];
  // A lone path is wrapped with its new colours; a group gets them after its
  // own q, and each colour it sets is replaced.
  for (const part of drawing.parts) {
    if (part.lone) edits.push([part.start, part.start, `q ${set}\n`], [part.end, part.end, '\nQ']);
    else edits.push([part.start + 1, part.start + 1, ` ${set}`]);
  }
  if (fill) for (const op of drawing.fills) edits.push([op.start, op.end, `${pdfColor(fill)} rg`]);
  if (stroke) for (const op of drawing.strokes) edits.push([op.start, op.end, `${pdfColor(stroke)} RG`]);
  return edits;
}
const applyEdits = (text, edits) => { let next = text; for (const [from, to, value] of [...edits].sort((a, b) => b[0] - a[0])) next = next.slice(0, from) + value + next.slice(to); return next; };

/** Move, duplicate, recolour or remove one drawing by rewriting its operators. */
function editDrawing(doc, page, index, options) {
  if (!doc.hasPermission('copy')) fail('El PDF no permite extraer contenido para verificar la selección.');
  const { found, drawing, source } = drawingAt(page, options);
  const text = found.texts[drawing.si], edits = [], operation = options.operation;
  let expected;
  if (operation === 'move-graphic') {
    if (drawing.clip) fail('Este trazo también recorta otros elementos: no se puede mover.');
    if (options.copy !== undefined && typeof options.copy !== 'boolean') fail('Opción de copia inválida.');
    const target = rect(options.rect), dx = target[0] - source[0], dy = target[1] - source[1];
    // The shift in a part's own coordinates that moves it by (dx, dy) on the page.
    const shift = ([a, b, c, d]) => { const det = a * d - b * c; if (!(Math.abs(det) > 1e-9)) fail('Este dibujo no se puede mover.'); return `q 1 0 0 1 ${number((d * dx - c * dy) / det)} ${number((a * dy - b * dx) / det)} cm\n`; };
    // A copy goes whole just before the drawing, where the state is the drawing's
    // own; a move shifts each part where it is, leaving the state between them as it was.
    if (options.copy) edits.push([drawing.parts[0].start, drawing.parts[0].start, `${shift(drawing.parts[0].ctm)}${text.slice(drawing.parts[0].start, drawing.parts.at(-1).end)}\nQ\n`]);
    else for (const part of drawing.parts) edits.push([part.start, part.end, `${shift(part.ctm)}${text.slice(part.start, part.end)}\nQ`]);
    expected = [source[0] + dx, source[1] + dy, source[2] + dx, source[3] + dy];
  } else if (operation === 'remove-graphic') {
    for (const paint of drawing.paints) edits.push([paint.start, paint.end, 'n']);
  } else edits.push(...recolorEdits(drawing, options));
  const next = applyEdits(text, edits);
  const glyphs = contentGlyphs(page), object = page.getObject(), stream = doc.addStream(Uint8Array.from(next, c => c.charCodeAt(0)), {});
  // A new stream rather than the old one rewritten: another page may share it.
  if (!object.get('Contents').isArray()) object.put('Contents', stream);
  else { const list = doc.newArray(); found.streams.forEach((value, i) => list.push(i === drawing.si ? stream : value)); object.put('Contents', list); }
  verifyRetainedGlyphs(doc, index, glyphs, 'No se pudo cambiar este dibujo sin afectar al texto. El original permanece intacto.');
  if (expected) {
    const moved = doc.loadPage(index); let after;
    try { after = pageDrawings(moved).drawings; } finally { moved.destroy(); }
    if (!after.some(other => other.box.every((value, i) => Math.abs(value - expected[i]) < .5))) fail('El dibujo quedaría recortado en esa posición. El original permanece intacto.');
  }
}

function contentGlyphs(page, whitespace = false) {
  let display, structured, rune = 0, line = 0, chars; const result = [];
  try {
    display = page.toDisplayList(false); structured = display.toStructuredText('preserve-whitespace');
    const lines = JSON.parse(structured.asJSON()).blocks.filter(block => block.type === 'text').flatMap(block => block.lines.map(line => line.text));
    if (lines.reduce((n, text) => n + text.length, 0) > 200000) fail('No se pudo verificar la eliminación sin afectar texto vecino.');
    structured.walk({
      beginLine: () => { chars = [...(lines[line++] || '')]; rune = 0; },
      onChar: (c, origin, font, size, quad, color) => {
        try { const value = chars[rune++] ?? c; if (whitespace || value.trim()) result.push({ c: value, origin: [...origin], quad: [...quad], fontName: font.getName(), size, color: [...color] }); }
        finally { font.destroy(); }
      },
    });
    return result;
  } finally { structured?.destroy(); display?.destroy(); }
}

// Every filled glyph on the page in device space, with the font that painted it
// kept alive, so text can be drawn again with its own fonts and colours.
function captureGlyphs(page) {
  const glyphs = [], fonts = new Map(); let device, failure;
  const release = () => { for (const font of fonts.values()) font.destroy(); fonts.clear(); };
  try {
    device = new mupdf.Device({
      fillText: (text, matrix, cs, color, alpha) => {
        try {
          if (failure) return;
          const space = cs.isGray() ? 'gray' : cs.isRGB() ? 'rgb' : cs.isCMYK() ? 'cmyk' : null;
          text.walk({ showGlyph: (font, trm, gid, unicode, wmode) => {
            if (failure) return;
            if (glyphs.length >= 100000) { failure = new Error('Hay demasiado texto en la página para moverlo automáticamente.'); return; }
            if (!fonts.has(font.pointer)) fonts.set(font.pointer, new mupdf.Font(font.pointer));
            const m = mupdf.Matrix.concat(trm, matrix);
            glyphs.push({ font: fonts.get(font.pointer), fontName: font.getName(), matrix: m, origin: [m[4], m[5]], gid, unicode, wmode, space, color: [...color], alpha });
          } });
        } catch (error) { failure ??= error; } finally { text.destroy(); cs.destroy(); }
      },
    });
    page.runPageContents(device, mupdf.Matrix.identity); device.close();
  } catch (error) { failure ??= error; } finally { device?.destroy(); }
  if (failure) { release(); throw failure; }
  return { glyphs, release };
}

// The characters a font has actually painted on this page and their glyphs.
function fontCensus(glyphs, fontName) {
  const map = new Map();
  for (const glyph of glyphs) if (glyph.fontName === fontName && glyph.gid && glyph.unicode > 0 && !map.has(glyph.unicode)) map.set(glyph.unicode, glyph.gid);
  return map;
}

// Draw captured glyphs again, moved by (dx, dy) in device space.
// Spot and indexed colours are drawn with their RGB equivalent.
// Each glyph is its own text: written as one run, the PDF writer turns their
// places into whole thousandths of an em between glyphs, and along a long line
// that rounding drifts the letters by a third of a point.
function glyphDrawing(device, glyphs, dx, dy) {
  const paint = glyph => glyph.space ? [glyph.space, ...glyph.color, glyph.alpha] : ['rgb', ...glyph.rgb, glyph.alpha];
  for (let start = 0; start < glyphs.length;) {
    let end = start;
    const text = new mupdf.Text();
    try {
      {
        const { font, matrix: m, gid, unicode, wmode } = glyphs[end++];
        text.showGlyph(font, [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy], gid, unicode, wmode);
      }
      const [space, ...rest] = paint(glyphs[start]), alpha = rest.pop();
      const cs = space === 'gray' ? mupdf.ColorSpace.DeviceGray : space === 'cmyk' ? mupdf.ColorSpace.DeviceCMYK : mupdf.ColorSpace.DeviceRGB;
      device.fillText(text, mupdf.Matrix.identity, cs, rest, alpha);
    } finally { text.destroy(); }
    start = end;
  }
}

// Redaction removes every glyph whose font box touches a mark, and with ordinary
// leading those boxes overlap the adjacent lines. Mark only the middle band of
// each selected glyph; verifyRetainedGlyphs then checks the edited page.
function textRemoval(selected, retainedGlyphs, conflict) {
  const marks = selected.map(({ quad, origin }) => {
    if (!finite(quad) || !finite(origin)) fail('Los límites del texto no permiten una eliminación segura.');
    const at = (t, i) => quad[i] + t * (quad[i + 4] - quad[i]);
    const box = quadBounds([.4, .6].flatMap(t => [at(t, 0), at(t, 1), at(t, 2), at(t, 3)]));
    // Inset normal boxes to avoid deleting a neighbouring glyph that only
    // shares an edge. Zero-width accents still need a small removal area.
    const insetX = Math.min(.02, (box[2] - box[0]) / 10), insetY = Math.min(.02, (box[3] - box[1]) / 10);
    return [box[0] + insetX - (insetX === 0 ? .01 : 0), box[1] + insetY - (insetY === 0 ? .01 : 0), box[2] - insetX + (insetX === 0 ? .01 : 0), box[3] - insetY + (insetY === 0 ? .01 : 0)];
  });
  // Merge touching marks with the same vertical extent, but never bridge
  // lines or differently sized spans. This avoids thousands of annotations
  // for an ordinary paragraph while retaining its actual glyph geometry.
  const boxes = [];
  marks.sort((a, b) => a[1] - b[1] || a[3] - b[3] || a[0] - b[0]);
  for (const box of marks) {
    const last = boxes.at(-1);
    if (last && Math.abs(last[1] - box[1]) < .02 && Math.abs(last[3] - box[3]) < .02 && box[0] <= last[2] + .041) last[2] = Math.max(last[2], box[2]);
    else boxes.push(box);
  }
  if (boxes.length > 500) fail('La selección tiene demasiados fragmentos para modificarla con seguridad. Selecciona menos texto.');
  if (retainedGlyphs.some(glyph => boxes.some(box => intersects(quadBounds(glyph.quad), box)))) fail(conflict);
  return { boxes, retainedGlyphs, selected };
}

// A drawn area takes the glyphs whose centre lies inside it, so a generous
// rectangle never clips letters of neighbouring words or lines.
function areaRemoval(page, box) {
  const glyphs = contentGlyphs(page, true), inside = ({ quad }) => {
    const b = quadBounds(quad), x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
    return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
  };
  return textRemoval(glyphs.filter(inside), glyphs.filter(glyph => !inside(glyph) && glyph.c.trim()), 'El área corta letras de otro texto. Ajústala para incluirlas completas o dejarlas fuera.');
}

// Checks the edited document itself: a failed check is undone by the caller, never written.
function verifyRetainedGlyphs(doc, index, expected, message = 'La eliminación afectaría otros caracteres o no quitaría toda la selección. El original permanece intacto.') {
  const page = doc.loadPage(index); let actual;
  try { actual = contentGlyphs(page); } finally { page.destroy(); }
  const key = glyph => JSON.stringify([glyph.c, glyph.fontName, glyph.color.map(n => Math.round(n * 255))]);
  const sort = (a, b) => key(a).localeCompare(key(b)) || a.origin[1] - b.origin[1] || a.origin[0] - b.origin[0] || a.size - b.size;
  expected.sort(sort); actual.sort(sort);
  if (expected.length !== actual.length || expected.some((glyph, i) => {
    const next = actual[i];
    return key(glyph) !== key(next) || Math.abs(glyph.size - next.size) > .025 || [...glyph.origin, ...glyph.quad].some((n, j) => Math.abs(n - [...next.origin, ...next.quad][j]) > .025);
  })) fail(message);
}

// Keep a JPEG compressed when it is moved or duplicated. Only one unambiguous
// DCT XObject with this size and plain RGB or gray samples qualifies, and only
// when it is the painted image itself, not an inline image of the same size;
// every other image is decoded to PNG.
function jpegSource(doc, page, image) {
  const found = new Map(), visited = new Set();
  (function walk(resources, depth) {
    if (depth > 8 || !resources.isDictionary()) return;
    const xobjects = resources.get('XObject'); if (!xobjects.isDictionary()) return;
    xobjects.forEach(value => {
      const ref = value.asIndirect(); if (!ref || visited.has(ref)) return; visited.add(ref);
      const subtype = value.get('Subtype').asName();
      if (subtype === 'Form') walk(value.get('Resources'), depth + 1);
      else if (subtype === 'Image' && value.get('Width').asNumber() === image.getWidth() && value.get('Height').asNumber() === image.getHeight()) found.set(ref, value);
    });
  })(page.getObject().getInheritable('Resources'), 0);
  if (found.size !== 1) return null;
  const [object] = found.values(), filter = object.get('Filter');
  if ((filter.isArray() ? filter.length === 1 && filter.get(0).asName() : filter.asName()) !== 'DCTDecode' || !['DeviceRGB', 'DeviceGray'].includes(object.get('ColorSpace').asName())
    || ['Decode', 'SMask', 'Mask', 'DecodeParms'].some(key => !object.get(key).isNull()) || object.get('ImageMask').asBoolean()) return null;
  // MuPDF's store hands out the image it already loaded for this XObject, so a
  // different pointer means another image was painted, e.g. an inline one.
  let loaded;
  try { loaded = doc.loadImage(object); if (loaded.pointer !== image.pointer) return null; } catch { return null; } finally { loaded?.destroy(); }
  const buffer = object.readRawStream();
  try { const bytes = new Uint8Array(buffer.asUint8Array()); return jpegOrientation(bytes) === 1 ? bytes : null; }
  finally { buffer.destroy(); }
}

function pageImagePixels(image, info, jpeg) {
  const width = image.getWidth(), height = image.getHeight();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16000000) fail('La imagen supera el límite de 16 megapíxeles para editarla automáticamente.');
  const rotation = ((Math.round(Math.atan2(info.matrix[1], info.matrix[0]) / (Math.PI / 2)) * 90) % 360 + 360) % 360;
  if (jpeg) return { bytes: jpeg, type: 'image/jpeg', width, height, opacity: info.alpha, rotation };
  let decoded, rgb;
  try {
    decoded = image.toPixmap(); rgb = decoded.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
    return { bytes: new Uint8Array(rgb.asPNG()), type: 'image/png', width, height, opacity: info.alpha, rotation };
  } finally { rgb?.destroy(); decoded?.destroy(); }
}

function redactPage(doc, page, boxes, { black = true, images = true, imageMethod = mupdf.PDFPage.REDACT_IMAGE_PIXELS, graphics = true, text = true, preserveAnnotations = false } = {}) {
  // Editing content must retain comments, links, widgets and pending redaction marks.
  const object = page.getObject(), originals = preserveAnnotations ? object.get('Annots') : null;
  let restored;
  if (originals && !originals.isNull()) {
    restored = doc.newArray();
    for (let i = 0; i < originals.length; i++) restored.push(originals.get(i));
    for (const annotation of [...page.getAnnotations()]) page.deleteAnnotation(annotation);
  }
  try {
    for (const box of boxes) {
      if (!preserveAnnotations) for (const a of [...page.getAnnotations()]) if (intersects(a.getBounds(), box)) page.deleteAnnotation(a);
      const mark = page.createAnnotation('Redact'); mark.setRect(box); mark.update();
    }
    page.applyRedactions(black, images ? imageMethod : mupdf.PDFPage.REDACT_IMAGE_NONE,
      graphics ? mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED : mupdf.PDFPage.REDACT_LINE_ART_NONE, text ? mupdf.PDFPage.REDACT_TEXT_REMOVE : mupdf.PDFPage.REDACT_TEXT_NONE);
  } finally {
    if (preserveAnnotations) { if (restored) object.put('Annots', restored); else object.delete('Annots'); }
  }
}

// An image Folio placed is a Form holding only that image, drawn by its own
// `q <matrix> cm /FolioN Do Q` stream. Moving, resizing, turning, copying or
// removing it rewrites that one stream: nothing is redacted and stacking stays.
function folioImages(page) {
  const object = page.getObject(), contents = object.get('Contents'), xobjects = object.getInheritable('Resources').get('XObject'), found = [];
  if (!contents.isArray() || !xobjects.isDictionary()) return found;
  const read = stream => { const buffer = stream.readStream(); try { return buffer.asString(); } finally { buffer.destroy(); } };
  for (let index = 0; index < contents.length; index++) {
    const match = /^q ((?:[-\d.e]+ ){6})cm \/(Folio\d+) Do Q\n$/.exec(read(contents.get(index)));
    const form = match && xobjects.get(match[2]);
    if (!form?.isStream() || form.get('Subtype').asName() !== 'Form' || !form.get('Matrix').isNull()) continue;
    const wrapper = match[1].trim().split(' ').map(Number);
    let matrix = wrapper, images = 0, plain = true;
    for (const { op, args } of contentOperators(read(form))) {
      if (op === 'cm' && args.length === 6) matrix = mupdf.Matrix.concat(args.map(Number), matrix);
      else if (op === 'Do' && form.get('Resources').get('XObject').get(args[0]?.slice(1) ?? '').get('Subtype').asName() === 'Image') images++;
      else plain = false;
    }
    if (plain && images === 1) found.push({ index, name: match[2], wrapper, box: mupdf.Rect.transform([0, 0, 1, 1], matrix) });
  }
  return found;
}
// Only an unambiguous match: two placed images on exactly the same spot take the general path.
const folioImage = (placed, box) => { const matches = placed.filter(image => image.box.every((value, i) => Math.abs(value - box[i]) < .05)); return matches.length === 1 ? matches[0] : null; };

/** Draws a placed Form with another matrix (null removes it); a copy keeps the original. */
function rewrap(doc, page, placed, matrix, copy = false) {
  const object = page.getObject(), contents = object.get('Contents'), list = doc.newArray();
  const replacement = matrix && doc.addStream(`q ${matrix.map(number).join(' ')} cm /${placed.name} Do Q\n`, {});
  for (let i = 0; i < contents.length; i++) {
    if (i !== placed.index || copy) list.push(contents.get(i));
    if (i === placed.index && replacement) list.push(replacement);
  }
  object.put('Contents', list);
}

// Text Folio wrote (moved, added or retyped) is a Form drawn by its own wrapper,
// like a placed image, and carries the box it covers (FolioBox). Moving, copying,
// removing or retyping it rewrites that wrapper, so text overlapping it does not
// matter: nothing is redacted.
function folioTexts(page) {
  const object = page.getObject(), contents = object.get('Contents'), xobjects = object.getInheritable('Resources').get('XObject'), found = [];
  if (!contents.isArray() || !xobjects.isDictionary()) return found;
  for (let index = 0; index < contents.length; index++) {
    let buffer, text = '';
    try { buffer = contents.get(index).readStream(); text = buffer.asString(); } catch { continue; } finally { buffer?.destroy(); }
    const match = /^q ((?:[-\d.e]+ ){6})cm \/(Folio\d+) Do Q\n$/.exec(text), form = match && xobjects.get(match[2]), box = form?.get('FolioBox');
    if (!box?.isArray() || box.length !== 4) continue;
    const wrapper = match[1].trim().split(' ').map(Number);
    found.push({ index, name: match[2], wrapper, box: mupdf.Rect.transform(box.asJS(), wrapper), text: form.get('FolioText').asString() });
  }
  return found;
}
// Compared without spaces or line breaks: lines wrap and join differently.
const letters = text => text.replace(/\s+/g, '');
// The paragraph that is one of them: mostly the same box (and, given, the same text), and only one such.
const folioText = (placed, box, text) => {
  const iou = (a, b) => { const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]); return w > 0 && h > 0 ? w * h / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - w * h) : 0; };
  const matches = placed.filter(own => iou(own.box, box) > .75 && (text === undefined || letters(own.text) === letters(text)));
  return matches.length === 1 ? matches[0] : null;
};

function editFolioImage(doc, page, image, options) {
  let replacement = null;
  if (options.operation === 'move-image') {
    const turn = options.rotation ?? 0;
    if (![0, 90, 180, 270].includes(turn)) fail('Giro de imagen inválido.');
    // Fit the image's box to the target, then turn it clockwise about the target's centre.
    const from = image.box, target = rect(options.rect), turned = turn === 90 || turn === 270, cx = (target[0] + target[2]) / 2, cy = (target[1] + target[3]) / 2;
    const w = turned ? target[3] - target[1] : target[2] - target[0], h = turned ? target[2] - target[0] : target[3] - target[1];
    const sx = w / (from[2] - from[0]), sy = h / (from[3] - from[1]);
    const fit = [sx, 0, 0, sy, cx - w / 2 - from[0] * sx, cy - h / 2 - from[1] * sy];
    const spin = mupdf.Matrix.concat(mupdf.Matrix.concat(mupdf.Matrix.translate(-cx, -cy), mupdf.Matrix.rotate(-turn)), mupdf.Matrix.translate(cx, cy));
    replacement = mupdf.Matrix.concat(mupdf.Matrix.concat(image.wrapper, fit), spin);
  }
  rewrap(doc, page, image, replacement, options.copy);
}

// Move, resize, turn or duplicate a text block or an image without rewriting it:
// text keeps its own glyphs, fonts and mixed styles, and an image keeps its
// compressed data and transparency. The original is removed like remove-content.
function moveContent(doc, page, index, target, options) {
  if (!doc.hasPermission('copy')) fail('El PDF no permite extraer contenido para verificar la selección.');
  if (options.copy !== undefined && typeof options.copy !== 'boolean') fail('Opción de copia inválida.');
  const source = rect(options.sourceRect), sourceBox = mupdf.Rect.transform(source, page.getTransform());
  const text = options.operation === 'move-text';
  if (typeof options.sourceId !== 'string' || !(text ? /^(?:text-line-b\d{1,4}-l\d{1,5}|text-paragraph-b\d{1,4}|text-folio-\d{1,4})$/ : /^image-\d{1,5}$/).test(options.sourceId)) fail('La selección de contenido no es válida.');
  const placed = !text && options.opacity === undefined && folioImage(folioImages(page), source);
  if (placed) return editFolioImage(doc, page, placed, options);
  const written = text && folioText(folioTexts(page), source);
  if (written) {
    const to = rect(options.rect);
    if (Math.abs((to[2] - to[0]) - (source[2] - source[0])) > .5 || Math.abs((to[3] - to[1]) - (source[3] - source[1])) > .5) fail('Para cambiar el tamaño del texto, edítalo.');
    return rewrap(doc, page, written, mupdf.Matrix.concat(written.wrapper, mupdf.Matrix.translate(to[0] - source[0], to[1] - source[1])), options.copy);
  }
  const selection = pageContent(doc, page, undefined, { id: options.sourceId, kind: text ? 'text' : 'image', rect: source });
  const { draw, expected, glyphs, release } = movedDrawing(page, selection, text, sourceBox, target, options);
  try {
    if (!options.copy) {
      redactPage(doc, page, selection.boxes, { black: false, images: !text, imageMethod: mupdf.PDFPage.REDACT_IMAGE_REMOVE, graphics: false, text, preserveAnnotations: true });
      verifyRetainedGlyphs(doc, index, selection.retainedGlyphs, text ? 'No se pudo mover el texto sin afectar al texto cercano. El original permanece intacto.' : undefined);
    }
    let form;
    // The moved text as it reads, a line break wherever the baseline changes.
    const reading = text && selection.selected.map((glyph, i, all) => (i && Math.abs(glyph.origin[1] - all[i - 1].origin[1]) > glyph.size / 2 ? '\n' : '') + glyph.c).join('');
    try { form = appendDrawing(doc, page, draw, reading); }
    catch (error) { throw /type 3/i.test(error?.message) ? new Error('Este texto usa una fuente dibujada (Type 3) que no se puede volver a escribir. Edítalo para reescribirlo.') : error; }
    if (glyphs) mapCharacters(doc, form, glyphs);
    if (expected.length) {
      // Every glyph must appear where it was moved. A rewritten font may name an
      // odd glyph differently (a bullet as a middle dot, a TeX brace as a letter), so almost all must read the same.
      const moved = doc.loadPage(index); let found;
      try { found = contentGlyphs(moved); } finally { moved.destroy(); }
      // Positions are written rounded: a glyph may land some hundredths of a point off (well inside the gap to the next one).
      const at = glyph => found.filter(other => Math.abs(other.origin[0] - glyph.origin[0]) < .25 && Math.abs(other.origin[1] - glyph.origin[1]) < .25);
      if (expected.some(glyph => !at(glyph).length) || expected.filter(glyph => !at(glyph).some(other => other.c === glyph.c)).length > Math.max(3, expected.length * .05))
        fail('Este texto no se puede mover sin cambiar su aspecto. Edítalo para reescribirlo.');
    }
  } finally { release(); }
}

/** What moving a selected text or image to `target` (device space) draws: the
 * text's own glyphs, or the image fitted and turned there, with where each moved
 * character must end up. `release` frees the fonts or image it holds. */
function movedDrawing(page, selection, text, sourceBox, target, options) {
  if (text) {
    // Text is moved, not scaled: a new size means retyping it.
    if (Math.abs((target[2] - target[0]) - (sourceBox[2] - sourceBox[0])) > .5 || Math.abs((target[3] - target[1]) - (sourceBox[3] - sourceBox[1])) > .5) fail('Para cambiar el tamaño del texto, edítalo.');
    const captured = captureGlyphs(page);
    try {
      const dx = target[0] - sourceBox[0], dy = target[1] - sourceBox[1], used = new Set(), moved = [], expected = [];
      const near = (a, b) => Math.abs(a[0] - b[0]) < .02 && Math.abs(a[1] - b[1]) < .02;
      for (const glyph of selection.selected) {
        const matches = captured.glyphs.filter(g => !used.has(g) && near(g.origin, glyph.origin));
        // Re-emitted glyphs carry the character text extraction reported, so copying and searching stay the same.
        const unicode = [...glyph.c].length === 1 ? glyph.c.codePointAt(0) : undefined;
        for (const match of matches) { used.add(match); match.rgb = glyph.color; if (unicode && glyph.c.trim()) match.unicode = unicode; moved.push(match); }
        // A ligature paints one glyph for several characters, placed within its advance.
        const ligature = !matches.length && moved.some(g => Math.abs(g.origin[1] - glyph.origin[1]) < .5 && g.origin[0] < glyph.origin[0] && glyph.origin[0] - g.origin[0] < 2 * glyph.size);
        if (!matches.length && glyph.c.trim() && !ligature) fail('Este texto no se puede mover sin cambiar su aspecto. Edítalo para reescribirlo.');
        if (matches.length && glyph.c.trim()) expected.push({ c: glyph.c, origin: [glyph.origin[0] + dx, glyph.origin[1] + dy] });
      }
      return { draw: device => glyphDrawing(device, moved, dx, dy), expected, glyphs: moved, release: captured.release };
    } catch (error) { captured.release(); throw error; }
  }
  const { image, info } = selection;
  if (!image) fail('La imagen seleccionada ya no existe en esta página.');
  try {
    const turn = options.rotation ?? 0, alpha = options.opacity ?? info.alpha;
    if (![0, 90, 180, 270].includes(turn)) fail('Giro de imagen inválido.');
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) fail('Opacidad de imagen inválida.');
    // Fit the painted box to the target, then turn it clockwise about the target's centre.
    const from = info.fullBox, turned = turn === 90 || turn === 270, cx = (target[0] + target[2]) / 2, cy = (target[1] + target[3]) / 2;
    const w = turned ? target[3] - target[1] : target[2] - target[0], h = turned ? target[2] - target[0] : target[3] - target[1];
    const sx = w / (from[2] - from[0]), sy = h / (from[3] - from[1]);
    const fit = [sx, 0, 0, sy, cx - w / 2 - from[0] * sx, cy - h / 2 - from[1] * sy];
    const spin = mupdf.Matrix.concat(mupdf.Matrix.concat(mupdf.Matrix.translate(-cx, -cy), mupdf.Matrix.rotate(turn)), mupdf.Matrix.translate(cx, cy));
    const matrix = mupdf.Matrix.concat(mupdf.Matrix.concat(info.matrix, fit), spin);
    // On screen an image's own soft mask is a clip, as the PDF interpreter draws it; a PDF writer keeps it with the image.
    const draw = (device, screen = false) => {
      const mask = screen ? image.getMask() : null;
      try { if (mask) device.clipImageMask(mask, matrix); device.fillImage(image, matrix, alpha); if (mask) device.popClip(); } finally { mask?.destroy(); }
    };
    return { draw, expected: [], release: () => image.destroy() };
  } catch (error) { image.destroy(); throw error; }
}

// What the page paints besides drawings: text, XObjects (images, forms), shadings, inline images.
const SHOWN = new Set(['Tj', 'TJ', "'", '"', 'Do', 'sh', 'BI', 'ID']);

/** One editable item drawn alone, on transparent pixels, as moving it would draw
 * it: a text's own glyphs, an image, or a drawing's own operators with the state
 * around them. `fill`/`stroke` show a drawing in other colours. The document is
 * not changed. Returns a PNG and the area it covers, in PDF coordinates. */
export function itemSprite(doc, options) {
  if (!doc.hasPermission('copy')) fail('El PDF no permite extraer su contenido.');
  const index = pageIndex(doc, options.page), area = rect(options.rect), scale = Number(options.scale);
  if (!(scale > 0 && scale <= 8)) fail('Escala inválida.');
  if (!['text', 'image', 'graphic'].includes(options.kind)) fail('La selección de contenido no es válida.');
  const page = doc.loadPage(index); let pixmap, device, scratch, release = () => {};
  try {
    const zoom = mupdf.Matrix.scale(scale, scale), toDevice = mupdf.Matrix.concat(page.getTransform(), zoom), sourceBox = mupdf.Rect.transform(area, page.getTransform());
    const box = mupdf.Rect.transform([area[0] - 4, area[1] - 4, area[2] + 4, area[3] + 4], toDevice).map((v, i) => i < 2 ? Math.floor(v) : Math.ceil(v));
    if ((box[2] - box[0]) * (box[3] - box[1]) > 16000000) fail('El área es demasiado grande.');
    pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, true); pixmap.clear();
    device = new mupdf.DrawDevice(zoom, pixmap);
    if (options.kind === 'graphic') {
      // The page's streams with every other paint left out, on a page of its own
      // in a scratch document that shares the page's geometry and graphics resources.
      const { found, drawing } = drawingAt(page, { sourceId: options.id, sourceRect: area });
      const keep = new Set(drawing.paints.map(paint => paint.start)), colors = options.fill || options.stroke ? recolorEdits(drawing, options) : [];
      const content = found.texts.map((text, si) => applyEdits(text, [...contentOperators(text).flatMap(({ op, start, end }) =>
        PAINT.has(op) && !(si === drawing.si && keep.has(start)) ? [[start, end, 'n']] : SHOWN.has(op) ? [[start, end, '']] : []), ...(si === drawing.si ? colors : [])])).join('\n');
      scratch = new mupdf.PDFDocument();
      const object = page.getObject(), resources = scratch.newDictionary();
      object.getInheritable('Resources').forEach((value, key) => { if (key !== 'XObject' && key !== 'Font') resources.put(key, scratch.graftObject(value)); });
      const copy = scratch.addPage(object.getInheritable('MediaBox').asJS(), object.getInheritable('Rotate').asNumber(), resources, Uint8Array.from(content, c => c.charCodeAt(0)));
      const crop = object.getInheritable('CropBox'); if (!crop.isNull()) copy.put('CropBox', crop.asJS());
      scratch.insertPage(-1, copy);
      const alone = scratch.loadPage(0);
      try { alone.runPageContents(device, mupdf.Matrix.identity); } finally { alone.destroy(); }
    } else {
      const selection = pageContent(doc, page, undefined, { id: options.id, kind: options.kind, rect: area });
      const drawn = movedDrawing(page, selection, options.kind === 'text', sourceBox, sourceBox, {});
      release = drawn.release; drawn.draw(device, true);
    }
    device.close();
    return { png: new Uint8Array(pixmap.asPNG()), rect: mupdf.Rect.transform(box, mupdf.Matrix.invert(toDevice)) };
  } finally { release(); device?.destroy(); pixmap?.destroy(); scratch?.destroy(); page.destroy(); }
}

// The changes Editar makes. Each one edits an open document and checks it there:
// operateDocument saves the result, a live session (session.worker.ts) keeps it.
export const EDITS = new Set(['add-text', 'replace-text', 'add-image', 'replace-image', 'move-text', 'move-image', 'remove-content', 'move-graphic', 'remove-graphic', 'recolor-graphic']);

/** Applies one change in place. A failure can leave `doc` half changed: the caller discards or undoes it. */
export function editDocument(doc, options) {
  const operation = options.operation;
  if (!EDITS.has(operation)) fail('Operación desconocida.');
  allowed(doc, 'edit');
  const index = pageIndex(doc, options.page), page = doc.loadPage(index);
  try {
    if (['move-graphic', 'remove-graphic', 'recolor-graphic'].includes(operation)) return editDrawing(doc, page, index, options);
    if (operation === 'remove-content') {
      if (!doc.hasPermission('copy')) fail('El PDF no permite extraer contenido para verificar la selección.');
      if (!['text', 'image'].includes(options.kind) || typeof options.id !== 'string' || !/^(?:image-\d{1,5}|text-line-b\d{1,4}-l\d{1,5}|text-paragraph-b\d{1,4}|text-folio-\d{1,4})$/.test(options.id)) fail('La selección de contenido no es válida.');
      const placed = options.kind === 'image' && folioImage(folioImages(page), rect(options.rect));
      if (placed) return editFolioImage(doc, page, placed, options);
      const written = options.kind === 'text' && folioText(folioTexts(page), rect(options.rect));
      if (written) return rewrap(doc, page, written, null);
      const selection = pageContent(doc, page, undefined, { id: options.id, kind: options.kind, rect: rect(options.rect) });
      redactPage(doc, page, selection.boxes, { black: false, images: options.kind === 'image', imageMethod: mupdf.PDFPage.REDACT_IMAGE_REMOVE, graphics: false, text: options.kind === 'text', preserveAnnotations: true });
      // Redaction uses font character bounds rather than the picker's quads:
      // nearby text must survive with its original glyphs and positions, including other lines in the block.
      return verifyRetainedGlyphs(doc, index, selection.retainedGlyphs);
    }
    const box = mupdf.Rect.transform(rect(options.rect), page.getTransform());
    if (operation === 'move-text' || operation === 'move-image') return moveContent(doc, page, index, box, options);
    if (operation === 'add-image' || operation === 'replace-image') {
      const image = new mupdf.Image(options.image);
      try {
        const placement = imagePlacement(image, box, options, options.image instanceof Uint8Array ? jpegOrientation(options.image) : 1);
        // Image editing removes pixels in the source area; text and annotations remain.
        if (operation === 'replace-image') redactPage(doc, page, [mupdf.Rect.transform(rect(options.sourceRect ?? options.rect), page.getTransform())], { black: false, images: true, graphics: false, text: false, preserveAnnotations: true });
        return appendDrawing(doc, page, device => imageDrawing(device, box, image, placement));
      } finally { image.destroy(); }
    }
    if (operation === 'add-text') return appendDrawing(doc, page, device => textDrawing(device, box, options), options.text);
    // replace-text. Fit validation happens before redaction.
    if (options.originalFont !== undefined && typeof options.originalFont !== 'boolean') fail('Opción de fuente inválida.');
    if (!options.originalFont) textDrawing({ fillText() {} }, box, options);
    const source = rect(options.sourceRect ?? options.rect);
    // A selected line or paragraph removes exactly its glyphs, like remove-content.
    let selection, glyphFont;
    // Text Folio wrote is retyped by replacing its wrapper: what overlaps it stays untouched.
    const written = options.sourceId !== undefined && folioText(folioTexts(page), source);
    if (written) {
      const area = mupdf.Rect.transform(written.box, page.getTransform()), inside = ({ origin: [x, y] }) => x >= area[0] && x <= area[2] && y >= area[1] && y <= area[3];
      selection = { boxes: [], retainedGlyphs: [], selected: contentGlyphs(page).filter(inside) };
    } else if (options.sourceId !== undefined) {
      if (!doc.hasPermission('copy')) fail('El PDF no permite extraer contenido para verificar la selección.');
      if (typeof options.sourceId !== 'string' || !/^(?:text-line-b\d{1,4}-l\d{1,5}|text-paragraph-b\d{1,4}|text-folio-\d{1,4})$/.test(options.sourceId)) fail('La selección de contenido no es válida.');
      selection = pageContent(doc, page, undefined, { id: options.sourceId, kind: 'text', rect: source });
    } else if (options.originalFont) fail('La fuente original necesita un texto seleccionado.');
    else selection = areaRemoval(page, mupdf.Rect.transform(source, page.getTransform()));
    try {
      if (options.originalFont) {
        // The predominant font of the selection, with every glyph it painted on this page.
        const counts = new Map();
        for (const glyph of selection.selected) if (glyph.c.trim()) counts.set(glyph.fontName, (counts.get(glyph.fontName) || 0) + 1);
        const fontName = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0], captured = captureGlyphs(page);
        try {
          const painted = captured.glyphs.find(glyph => glyph.fontName === fontName);
          if (!painted) fail('La fuente original no está disponible.');
          // A subset font has only what it painted; a whole or standard font has its full map.
          glyphFont = { font: new mupdf.Font(painted.font.pointer), glyphs: fontCensus(captured.glyphs, fontName), complete: !/^[A-Z]{6}\+/.test(fontName) };
        } finally { captured.release(); }
        textDrawing({ fillText() {} }, box, { ...options, glyphFont });
      }
      if (selection.boxes.length) {
        redactPage(doc, page, selection.boxes, { black: false, images: false, graphics: false, preserveAnnotations: true });
        verifyRetainedGlyphs(doc, index, selection.retainedGlyphs, 'No se pudo reemplazar el texto sin afectar al texto cercano. El original permanece intacto.');
      }
      if (written) rewrap(doc, page, written, null);
      try { appendDrawing(doc, page, device => textDrawing(device, box, { ...options, glyphFont }), options.text); }
      catch (error) { throw glyphFont && !/no incluye|no cabe/.test(error?.message) ? new Error('La fuente original no se puede volver a usar en este PDF.') : error; }
    } finally { glyphFont?.font.destroy(); }
  } finally { page.destroy(); }
}

/** A page's editable items (page-content) or one image's pixels (page-image). */
export function readPage(doc, options) {
  if (!doc.hasPermission('copy')) fail('El PDF no permite extraer su contenido.');
  const image = options.operation === 'page-image';
  if (image && typeof options.id !== 'string') fail('La imagen seleccionada ya no es válida.');
  const page = doc.loadPage(pageIndex(doc, options.page));
  try { return pageContent(doc, page, image ? options.id : undefined, undefined, options.graphics === true); }
  finally { page.destroy(); }
}

/** Several changes to one page as one (a selection of several items). An
 * earlier change can renumber the page's items, so each later one finds its
 * item again by kind and place. Moves and copies go front first, along their
 * shift, so nothing lands where an item still to be changed is. */
export function editDocumentAll(doc, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 500) fail('La selección no es válida.');
  if (operations.some(options => options?.page !== operations[0].page)) fail('Los elementos deben estar en la misma página.');
  const source = options => options.operation === 'remove-content' ? ['id', 'rect'] : ['sourceId', 'sourceRect'];
  const ahead = options => {
    if (!/^move-/.test(options.operation)) return 0;
    const from = options.sourceRect, to = options.rect, dx = to[0] - from[0], dy = to[1] - from[1];
    return (from[0] + from[2]) / 2 * dx + (from[1] + from[3]) / 2 * dy;
  };
  [...operations].sort((a, b) => ahead(b) - ahead(a)).forEach((options, index) => {
    if (index) {
      const [idKey, rectKey] = source(options), id = options[idKey], place = rect(options[rectKey]);
      const kind = /^text-/.test(id) ? 'text' : /^image-/.test(id) ? 'image' : 'graphic', level = id.startsWith('text-line-') ? 'line' : kind === 'text' ? 'paragraph' : undefined;
      const found = readPage(doc, { operation: 'page-content', page: options.page, graphics: kind === 'graphic' }).items
        .find(item => item.kind === kind && item.level === level && item.rect.every((value, i) => Math.abs(value - place[i]) <= .02));
      if (!found) fail('La selección cambió o ya no existe. Selecciona de nuevo el contenido.');
      options = { ...options, [idKey]: found.id };
    }
    editDocument(doc, options);
  });
}

/** Paints a page as the reader shows it, on white: contents, then annotations
 * and fields, leaving out the annotations Folio draws itself. `box` is in device
 * space; with `alpha` the pixels are RGBA, still opaque. */
export function renderPage(page, matrix, box, alpha = false) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, alpha); let device;
  try {
    pixmap.clear(255); device = new mupdf.DrawDevice(matrix, pixmap);
    page.runPageContents(device, mupdf.Matrix.identity);
    for (const annotation of page.getAnnotations()) if (!folioAnnotation(annotation)) annotation.run(device, mupdf.Matrix.identity);
    page.runPageWidgets(device, mupdf.Matrix.identity);
    device.close();
    return pixmap;
  } catch (error) { pixmap.destroy(); throw error; } finally { device?.destroy(); }
}

/** The page around one item as it looks without it: shown where the item was
 * while it is dragged, moved, or removed, until the page shows the result.
 * Removes the item from `doc`, which the caller discards or undoes. */
export function pagePlate(doc, options) {
  const area = rect(options.rect), scale = Number(options.scale);
  if (!(scale > 0 && scale <= 8)) fail('Escala inválida.');
  editDocument(doc, options.kind === 'graphic' ? { operation: 'remove-graphic', page: options.page, sourceId: options.id, sourceRect: area, rect: area } : { operation: 'remove-content', page: options.page, id: options.id, kind: options.kind, rect: area });
  const page = doc.loadPage(pageIndex(doc, options.page)); let pixmap;
  try {
    const zoom = mupdf.Matrix.scale(scale, scale), toDevice = mupdf.Matrix.concat(page.getTransform(), zoom);
    const box = mupdf.Rect.transform([area[0] - 4, area[1] - 4, area[2] + 4, area[3] + 4], toDevice).map((v, i) => i < 2 ? Math.floor(v) : Math.ceil(v));
    if ((box[2] - box[0]) * (box[3] - box[1]) > 16000000) fail('El área es demasiado grande.');
    pixmap = renderPage(page, zoom, box);
    return { png: new Uint8Array(pixmap.asPNG()), rect: mupdf.Rect.transform(box, mupdf.Matrix.invert(toDevice)) };
  } finally { pixmap?.destroy(); page.destroy(); }
}

export function operateDocument(bytes, options, password = '', onPart) {
  // Each part reopens the same bytes (streamed above 32 MB, so a large book is not
  // copied per part) and reuses the page plan, which keeps outlines, links and forms.
  // Parts go to `onPart` as soon as they are ready instead of piling up next to the book.
  if (options.operation === 'split') {
    if (!Array.isArray(options.parts) || !options.parts.length || options.parts.length > 5000) fail('La división no tiene partes o tiene demasiadas.');
    if (typeof onPart !== 'function') fail('Falta el destino de las partes.');
    options.parts.forEach((plan, index) => onPart(index, operateDocument(bytes, { operation: 'pages', plan }, password)));
    return options.parts.length;
  }
  const doc = open(bytes, password);
  try {
    const operation = options.operation;
    if (operation === 'fields') return fields(doc);
    if (operation === 'page-content' || operation === 'page-image') return readPage(doc, options);
    if (operation === 'page-plate') return pagePlate(doc, options);
    if (operation === 'text-layers') {
      // How much of each page's text is painted and how much is invisible (an OCR layer, 3 Tr),
      // and whether the page is a scan: an image over nearly all of it, with at most a little
      // text drawn on top (a watermark, a stamp). Text drawn under the scan is covered by it.
      if (!Array.isArray(options.pages) || options.pages.length > 100000) fail('Páginas inválidas.');
      return options.pages.map(number => {
        const page = doc.loadPage(pageIndex(doc, number)), bounds = page.getBounds(), area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
        let visible = 0, hidden = 0, covered = false, above = 0;
        const letters = text => { let n = 0; text.walk({ showGlyph: () => { n++; } }); return n; };
        const painted = text => { visible++; if (covered) above += letters(text); };
        const device = new mupdf.Device({
          fillText: painted, strokeText: painted, ignoreText: () => { hidden++; },
          fillImage: (image, ctm) => { const box = mupdf.Rect.transform([0, 0, 1, 1], ctm); if ((box[2] - box[0]) * (box[3] - box[1]) >= area * .8) { covered = true; above = 0; } },
        });
        try { page.run(device, mupdf.Matrix.identity); device.close(); } finally { device.destroy(); page.destroy(); }
        return { page: number, visible, hidden, scan: covered && above < 120 };
      });
    }
    if (operation === 'area-info') {
      if (!doc.hasPermission('copy')) fail('El PDF no permite extraer texto.');
      const page = doc.loadPage(pageIndex(doc, options.page));
      try { return areaContent(page, mupdf.Rect.transform(rect(options.rect), page.getTransform())); }
      finally { page.destroy(); }
    }
    if (EDITS.has(operation)) { editDocument(doc, options); return save(doc, QUICK); }
    if (operation === 'text') {
      if (!doc.hasPermission('copy')) fail('El PDF no permite extraer texto.');
      return Array.from({ length: doc.countPages() }, (_, i) => {
        const page = doc.loadPage(i); let text;
        try { text = page.toStructuredText(); return text.asText(); } finally { text?.destroy(); page.destroy(); }
      });
    }
    if (operation === 'pages') {
      allowed(doc, 'assemble');
      if (!Array.isArray(options.plan) || !options.plan.length || options.plan.length > 10000) fail('La lista de páginas está vacía o es demasiado larga.');
      // Preserve the original document dictionaries and use MuPDF to remap destinations.
      const sources = [];
      try {
        for (const source of options.sources || []) { const other = open(source.bytes, source.password); sources.push(other); allowed(other, 'assemble'); }
        const order = [], used = new Set(), importedPages = new Map(), pendingLinks = [];
        for (const entry of options.plan) {
          let index;
          if (entry.blank) {
            if (!finite(entry.blank) || entry.blank.length !== 2 || entry.blank.some(n => n < 10 || n > 14400)) fail('Tamaño de página inválido.');
            const object = doc.addPage([0, 0, ...entry.blank], 0, {}, ''); index = doc.countPages(); doc.insertPage(-1, object);
          } else if (entry.source != null) {
            const source = sources[entry.source]; if (!source) fail('Documento de origen inválido.');
            const sourceIndex = pageIndex(source, entry.page);
            index = doc.countPages(); const map = doc.newGraftMap();
            try {
              map.graftPage(-1, source, sourceIndex);
              const key = `${entry.source}:${source.findPage(sourceIndex).asIndirect()}`;
              if (!importedPages.has(key)) importedPages.set(key, doc.findPage(index));
              importAnnotations(doc, source, sourceIndex, index, map, pendingLinks, entry.source);
            }
            finally { map.destroy(); }
          } else {
            index = pageIndex(doc, entry.page);
            if (used.has(index)) {
              const original = doc.findPage(index), copy = doc.newDictionary();
              original.forEach((value, key) => { if (key !== 'Parent' && key !== 'Annots') copy.put(key, value); });
              for (const key of ['MediaBox', 'CropBox', 'Rotate', 'Resources']) if (copy.get(key).isNull()) {
                const value = original.getInheritable(key); if (!value.isNull()) copy.put(key, value);
              }
              const object = doc.addObject(copy), annots = original.get('Annots'), copies = doc.newArray();
              for (let n = 0; n < annots.length; n++) {
                const annotation = annots.get(n), clone = doc.newDictionary();
                annotation.forEach((value, key) => { if (!['P', 'Popup'].includes(key)) clone.put(key, value); });
                clone.put('P', object);
                const name = annotation.get('NM').asString(); if (name) clone.put('NM', doc.newString(`${name}-copy-${object.asIndirect()}`));
                const ref = doc.addObject(clone); copies.push(ref);
                if (clone.get('Subtype').asName() === 'Widget') {
                  const parent = clone.get('Parent');
                  if (!parent.isNull()) parent.get('Kids').push(ref);
                  else { clone.put('T', doc.newString(`${clone.get('T').asString()}_copy_${object.asIndirect()}`)); doc.getTrailer().get('Root', 'AcroForm', 'Fields').push(ref); }
                }
              }
              if (copies.length) copy.put('Annots', copies);
              index = doc.countPages(); doc.insertPage(-1, object);
            }
            used.add(pageIndex(doc, entry.page));
          }
          if (entry.rotation != null && (!Number.isInteger(entry.rotation) || entry.rotation % 90)) fail('Giro de página inválido.');
          order.push(index);
        }
        for (const { ref, page, sourceNumber, source, dest } of pendingLinks) {
          const first = dest.get(0), pageRef = first.isNumber() ? source.findPage(first.asNumber()).asIndirect() : first.asIndirect();
          const target = importedPages.get(`${sourceNumber}:${pageRef}`);
          if (!target) {
            const kept = doc.newArray(), annots = page.get('Annots');
            for (let i = 0; i < annots.length; i++) if (annots.get(i).asIndirect() !== ref.asIndirect()) kept.push(annots.get(i));
            page.put('Annots', kept); continue;
          }
          const rewritten = doc.newArray(); rewritten.push(target);
          for (let i = 1; i < dest.length; i++) rewritten.push(doc.graftObject(dest.get(i)));
          ref.put('Dest', rewritten);
        }
        // MuPDF drops AcroForm when all original form pages are removed, even if
        // imported pages contain widgets. Preserve its new fields/resources too.
        const root = doc.getTrailer().get('Root'), acro = root.get('AcroForm'), keptForm = doc.newDictionary();
        if (!acro.isNull()) {
          acro.forEach((value, key) => keptForm.put(key, value));
          const keptFields = doc.newArray(), currentFields = acro.get('Fields');
          for (let i = 0; i < currentFields.length; i++) keptFields.push(currentFields.get(i));
          keptForm.put('Fields', keptFields);
        }
        doc.rearrangePages(order);
        if (!acro.isNull()) root.put('AcroForm', keptForm);
        pruneFields(doc);
        for (let i = 0; i < options.plan.length; i++) if (options.plan[i].rotation) {
          const object = doc.findPage(i), angle = object.getInheritable('Rotate').asNumber();
          object.put('Rotate', ((angle + options.plan[i].rotation) % 360 + 360) % 360);
        }
      } finally { sources.forEach(source => source.destroy()); }
    } else if (operation === 'fill') {
      allowed(doc, 'form');
      const pending = new Map(Object.entries(options.values || {})), seen = new Set(), groups = new Map();
      for (let i = 0; i < doc.countPages(); i++) {
        const page = doc.loadPage(i);
        try {
          for (const [position, widget] of page.getWidgets().entries()) {
            const id = `${i + 1}:${position}:${widget.getName()}`, key = fieldKey(widget, id);
            if (!groups.has(key)) groups.set(key, id);
            const field = groups.get(key); if (!pending.has(field)) continue;
            if (widget.isReadOnly()) fail(`El campo «${widget.getName()}» es de solo lectura.`);
            // Later widgets of a field usually share the value already and only
            // need their appearance updated; same-named separate fields still get it.
            const value = pending.get(field), repeated = field !== id; seen.add(field);
            if (widget.isText()) {
              if (typeof value !== 'string' || value.length > 100000 || (widget.getMaxLen() > 0 && value.length > widget.getMaxLen())) fail('El valor excede el límite del campo.');
              if ((!repeated || widget.getValue() !== value) && !widget.setTextValue(value)) fail(`No se pudo actualizar «${widget.getName()}».`);
            } else if (widget.isChoice()) {
              if (typeof value !== 'string' || !widget.getOptions(true).includes(value)) fail('Opción de formulario inválida.');
              if ((!repeated || widget.getValue() !== value) && !widget.setChoiceValue(value)) fail('No se pudo actualizar la opción.');
            } else if (widget.isCheckbox() || widget.isRadioButton()) {
              const checked = widget.getObject().get('AS').asName() !== 'Off';
              if (typeof value !== 'boolean') fail('Valor de casilla inválido.');
              if (checked !== value) widget.toggle();
            } else fail('Este tipo de campo no admite valores.');
            widget.update();
          }
          page.update();
        } finally { page.destroy(); }
      }
      if ([...pending.keys()].some(key => !seen.has(key))) fail('Un campo ya no existe en el documento.');
      if (options.flatten) { allowed(doc, 'edit'); doc.bake(false, true); }
    } else if (operation === 'create-field') {
      allowed(doc, 'edit');
      if (typeof options.name !== 'string' || !options.name.trim() || options.name.length > 200 || fields(doc).some(field => field.name === options.name)) fail('El nombre del campo está vacío o ya existe.');
      const index = pageIndex(doc, options.page), box = rect(options.rect), page = doc.loadPage(index);
      try {
        const root = doc.getTrailer().get('Root');
        let acro = root.get('AcroForm');
        if (acro.isNull()) { acro = doc.newDictionary(); acro.put('Fields', doc.newArray()); root.put('AcroForm', acro); }
        if (acro.get('Fields').isNull()) acro.put('Fields', doc.newArray());
        const font = new mupdf.Font('Helvetica');
        try {
          let resources = acro.get('DR'); if (resources.isNull()) { resources = doc.newDictionary(); acro.put('DR', resources); }
          let fonts = resources.get('Font'); if (fonts.isNull()) { fonts = doc.newDictionary(); resources.put('Font', fonts); }
          fonts.put('FolioForm', doc.addSimpleFont(font));
        } finally { font.destroy(); }
        const object = doc.newDictionary();
        object.put('Type', 'Annot'); object.put('Subtype', 'Widget'); object.put('P', page.getObject()); object.put('F', 4);
        object.put('T', doc.newString(options.name.trim())); object.put('Rect', box); object.put('DA', doc.newString('/FolioForm 12 Tf 0 g'));
        if (options.fieldType === 'text') { object.put('FT', 'Tx'); object.put('Ff', options.multiline ? 4096 : 0); object.put('V', doc.newString('')); }
        else if (options.fieldType === 'combobox') {
          if (!Array.isArray(options.options) || !options.options.length || options.options.some(value => typeof value !== 'string' || value.length > 500)) fail('Añade opciones válidas para la lista.');
          object.put('FT', 'Ch'); object.put('Ff', 131072); object.put('Opt', options.options.map(value => doc.newString(value))); object.put('V', doc.newString(options.options[0]));
        } else if (options.fieldType === 'checkbox') {
          object.put('FT', 'Btn'); object.put('V', 'Off'); object.put('AS', 'Off');
          const w = box[2] - box[0], h = box[3] - box[1], base = `.5 w 0 0 0 RG 1 1 ${w - 2} ${h - 2} re S\n`;
          const appearance = content => doc.addStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: {} });
          object.put('AP', { N: { Off: appearance(base), Yes: appearance(base + `2 w 3 3 m ${w - 3} ${h - 3} l 3 ${h - 3} m ${w - 3} 3 l S`) } });
        } else fail('Tipo de campo desconocido.');
        object.put('BS', { W: 1, S: 'S' }); object.put('MK', { BC: [0.6, 0.6, 0.6], BG: [1, 1, 1] });
        const ref = doc.addObject(object); acro.get('Fields').push(ref);
        let annots = page.getObject().get('Annots'); if (annots.isNull()) { annots = doc.newArray(); page.getObject().put('Annots', annots); } annots.push(ref);
        const reloaded = doc.loadPage(index);
        try { for (const widget of reloaded.getWidgets()) if (widget.getObject().asIndirect() === ref.asIndirect()) widget.update(); reloaded.update(); }
        finally { reloaded.destroy(); }
      } finally { page.destroy(); }
    } else if (operation === 'ocr') {
      allowed(doc, 'edit');
      const font = options.font ? new mupdf.Font('Folio Sans', options.font) : new mupdf.Font('Helvetica');
      let faces = null;
      try {
        for (const result of options.pages) {
          const index = pageIndex(doc, result.page);
          // Straightened before OCR: a flattened image replaces the scan, or a tilt turns the content.
          if (result.image) replaceWithImage(doc, index, result.image, result.size);
          else if (result.angle) { const page = doc.loadPage(index); try { turnContent(doc, page, result.angle); } finally { page.destroy(); } }
          const page = doc.loadPage(index);
          try {
            // A rebuilt page: its letters were erased from the image and are written again as
            // real text, one Folio text per line, so Editar can change each line.
            const scan = result.lines?.length && result.original ? scanOf(result.original, page.getBounds()[2] - page.getBounds()[0]) : null;
            const lines = (result.lines ?? []).map(checkLine);
            if (lines.length) {
              faces ??= loadFaces(options.faces);
              const chosen = pageFaces(scan, lines, faces);
              lines.forEach((line, i) => writeLine(doc, page, line, chosen[i]));
            }
            if (result.words.length) appendDrawing(doc, page, device => {
              const text = new mupdf.Text();
              try {
                for (const word of result.words) {
                  if (typeof word.text !== 'string' || word.text.length > 1000) fail('Palabra OCR inválida.');
                  const box = mupdf.Rect.transform(rect(word.rect), page.getTransform());
                  const width = [...word.text].reduce((n, c) => n + font.advanceGlyph(font.encodeCharacter(c)), 0);
                  if (!width || !word.text.trim()) continue;
                  const height = (box[3] - box[1]) * .85;
                  text.showString(font, [(box[2] - box[0]) / width, 0, 0, -height, box[0], box[3]], word.text + ' ');
                }
                device.ignoreText(text, mupdf.Matrix.identity);
              } finally { text.destroy(); }
            });
          } finally { page.destroy(); }
        }
      } finally { font.destroy(); for (const face of faces ?? []) face.font.destroy(); }
    } else if (['remove-image', 'redact', 'crop'].includes(operation)) {
      allowed(doc, 'edit');
      if (operation === 'redact') {
        if (!Array.isArray(options.areas) || !options.areas.length) fail('Selecciona al menos un área.');
        // Forms can retain sensitive values outside their appearance streams.
        doc.bake(false, true);
        const grouped = new Map();
        for (const area of options.areas) {
          const index = pageIndex(doc, area.page), boxes = grouped.get(index) || []; boxes.push(rect(area.rect)); grouped.set(index, boxes);
        }
        for (const [index, boxes] of grouped) {
          const page = doc.loadPage(index);
          try { redactPage(doc, page, boxes.map(box => mupdf.Rect.transform(box, page.getTransform()))); } finally { page.destroy(); }
        }
        if (options.sanitize !== false) clearPrivateData(doc, true);
      } else {
        const page = doc.loadPage(pageIndex(doc, options.page));
        try {
          const box = mupdf.Rect.transform(rect(options.rect), page.getTransform());
          if (operation === 'crop') page.setPageBox('CropBox', box);
          else redactPage(doc, page, [box], { black: false, images: true, graphics: false, text: false, preserveAnnotations: true });
        } finally { page.destroy(); }
      }
    } else if (operation === 'sanitize') { allowed(doc, 'edit'); clearPrivateData(doc); }
    else if (operation === 'compress') { allowed(doc, 'edit'); }
    else if (operation === 'protect') {
      allowed(doc, 'edit');
      const user = options.userPassword, owner = options.ownerPassword;
      if (typeof user !== 'string' || typeof owner !== 'string' || !owner || [user, owner].some(p => p.length > 100 || /[,\x00-\x1f]/.test(p))) fail('Usa contraseñas de hasta 100 caracteres, sin comas ni caracteres de control.');
      const permissions = Number(options.permissions ?? 4095);
      if (!Number.isInteger(permissions) || permissions < 0 || permissions > 4095) fail('Permisos inválidos.');
      return save(doc, `garbage=4,compress=yes,encrypt=aes-256,user-password=${user},owner-password=${owner},permissions=${permissions}`);
    } else if (operation === 'unprotect') {
      // An owner password is required even when user permissions are permissive,
      // also in PDFs that open without a password.
      if (!doc.getTrailer().get('Encrypt').isNull() && !(doc.authenticatePassword(password) & 4)) fail('Necesitas la contraseña de propietario para quitar la protección.');
      allowed(doc, 'edit');
      return save(doc, 'garbage=4,compress=yes,encrypt=no');
    } else fail('Operación desconocida.');
    // OCR draws the same font on every page: deduplication merges those copies.
    const output = operation === 'ocr' ? saveDrawnDocument(doc, password) : save(doc, operation === 'remove-image' ? QUICK : undefined);
    return operation === 'compress' && output.length >= bytes.length ? new Uint8Array(bytes) : output;
  } finally { doc.destroy(); mupdf.emptyStore(); }
}
