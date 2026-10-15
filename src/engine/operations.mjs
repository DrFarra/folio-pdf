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
      try {
        for (const result of options.pages) {
          const index = pageIndex(doc, result.page);
          // Straightened before OCR: a flattened image replaces the scan, or a tilt turns the content.
          if (result.image) replaceWithImage(doc, index, result.image, result.size);
          else if (result.angle) { const page = doc.loadPage(index); try { turnContent(doc, page, result.angle); } finally { page.destroy(); } }
          const page = doc.loadPage(index);
          try {
            appendDrawing(doc, page, device => {
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
      } finally { font.destroy(); }
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
