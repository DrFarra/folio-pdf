import * as mupdf from 'mupdf';
import { open, hasSignature, save } from './mupdf-engine.mjs';

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

function clearPrivateData(doc, removeOutlines = false) {
  const trailer = doc.getTrailer(), root = trailer.get('Root');
  trailer.delete('Info'); root.delete('Metadata'); root.delete('OpenAction'); root.delete('AA');
  const names = root.get('Names');
  if (!names.isNull()) { names.delete('EmbeddedFiles'); names.delete('JavaScript'); }
  root.delete('AF'); root.delete('Collection');
  if (removeOutlines) { root.delete('Outlines'); root.delete('Dests'); if (!names.isNull()) names.delete('Dests'); }
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      page.getObject().delete('Metadata'); page.getObject().delete('PieceInfo'); page.getObject().delete('AA');
      for (const a of [...page.getAnnotations()]) if (['FileAttachment', 'Sound', 'Movie', 'RichMedia'].includes(a.getType())) page.deleteAnnotation(a);
    } finally { page.destroy(); }
  }
}

function fields(doc) {
  const result = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      for (const [position, widget] of page.getWidgets().entries()) {
        let buttonValue = '';
        if (widget.isRadioButton()) widget.getObject().get('AP', 'N').forEach((_, key) => { if (key !== 'Off') buttonValue = key; });
        result.push({
        id: `${i + 1}:${position}:${widget.getName()}`, name: widget.getName(), label: widget.getLabel() || widget.getName(),
        page: i + 1, type: widget.getFieldType(), value: widget.getValue(), readOnly: widget.isReadOnly(),
        multiline: widget.isText() && widget.isMultiline(), maxLength: widget.isText() ? widget.getMaxLen() : 0,
        options: widget.isChoice() ? widget.getOptions(false) : [],
        exportOptions: widget.isChoice() ? widget.getOptions(true) : [],
        checked: (widget.isCheckbox() || widget.isRadioButton()) && widget.getObject().get('AS').asName() !== 'Off',
        buttonValue,
        rect: mupdf.Rect.transform(widget.getBounds(), mupdf.Matrix.invert(page.getTransform())),
      }); }
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

// Write a drawing as a Form XObject, keeping the rest of the page streams intact.
function appendDrawing(doc, page, draw) {
  const bounds = page.getBounds();
  const buffer = new mupdf.Buffer(), writer = new mupdf.DocumentWriter(buffer, 'pdf', 'compress=yes');
  let generated, closed = false;
  try {
    const device = writer.beginPage(bounds);
    try { draw(device); } finally { try { writer.endPage(); } finally { device.destroy(); } }
    writer.close(); closed = true; generated = new mupdf.PDFDocument(buffer);
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
    const transform = mupdf.Matrix.concat(generatedPage.getTransform(), mupdf.Matrix.invert(page.getTransform())); generatedPage.destroy();
    const stream = doc.addStream(`q ${transform.join(' ')} cm /${name} Do Q\n`, {});
    const contents = target.get('Contents'), list = doc.newArray();
    if (!contents.isNull()) {
      // Contents streams share graphics and text state. Restore the page defaults
      // after the original content, which may leave invisible OCR text (3 Tr),
      // transforms, clipping or transparency active for a subsequently added Form.
      list.push(doc.addStream('q\n', {}));
      if (contents.isArray()) for (let i = 0; i < contents.length; i++) list.push(contents.get(i));
      else list.push(contents);
      list.push(doc.addStream('Q\n', {}));
    }
    list.push(stream); target.put('Contents', list);
  } finally {
    if (!closed) { try { writer.close(); } catch {} }
    generated?.destroy(); writer.destroy(); buffer.destroy();
  }
}

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
  const standardFonts = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'];
  if (options.fontName !== undefined && !standardFonts.includes(options.fontName)) fail('Fuente de texto no disponible.');
  const font = options.font ? new mupdf.Font('Folio Sans', options.font) : new mupdf.Font(options.fontName ?? 'Helvetica');
  const text = new mupdf.Text();
  try {
    for (const c of options.text) if (c !== '\n' && c !== '\r' && c !== '\t' && !font.encodeCharacter(c)) fail(`La fuente elegida no incluye el carácter «${c}».`);
    const limit = box[2] - box[0], measure = line => [...line].reduce((n, c) => n + font.advanceGlyph(font.encodeCharacter(c)) * size, 0);
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
      const x = box[0] + (align === 'center' ? (limit - width) / 2 : align === 'right' ? limit - width : 0);
      text.showString(font, [size, 0, 0, -size, x, y], line);
      y += size * lineHeight;
    }
    // Wrapped text must fit its actual glyph ink, including descenders below the baseline.
    // Legacy calls retain their original baseline-based fitting behavior.
    if (wrap && options.text.trim()) {
      const ink = text.getBounds(null, mupdf.Matrix.identity);
      if (ink[3] > box[3] + .5 || (options.baselineOffset !== undefined && ink[1] < box[1] - .5)) fail('El texto no cabe en el área. Amplía el área o reduce la letra.');
    }
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, rgb(options.color || '#202020'), 1);
  } finally { text.destroy(); font.destroy(); }
}

function imagePlacement(image, box, options) {
  const fit = options.fit ?? 'stretch', alpha = options.opacity ?? 1, rotation = options.rotation ?? 0;
  if (!['contain', 'cover', 'stretch'].includes(fit)) fail('Ajuste de imagen inválido.');
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) fail('Opacidad de imagen inválida.');
  if (![0, 90, 180, 270].includes(rotation)) fail('Giro de imagen inválido.');
  const width = box[2] - box[0], height = box[3] - box[1], turned = rotation === 90 || rotation === 270;
  let w = turned ? height : width, h = turned ? width : height;
  if (fit !== 'stretch') {
    const iw = image.getWidth(), ih = image.getHeight();
    const scale = (fit === 'contain' ? Math.min : Math.max)(width / (turned ? ih : iw), height / (turned ? iw : ih));
    w = iw * scale; h = ih * scale;
  }
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const matrix = rotation === 90 ? [0, w, -h, 0, cx + h / 2, cy - w / 2]
    : rotation === 180 ? [-w, 0, 0, -h, cx + w / 2, cy + h / 2]
    : rotation === 270 ? [0, -w, h, 0, cx - h / 2, cy + w / 2]
    : [w, 0, 0, h, cx - w / 2, cy - h / 2];
  return { matrix, alpha, clip: fit === 'cover' };
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
          const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
          if (!intersects(box, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])) return;
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
function pageContent(doc, page, requestedImage) {
  if (requestedImage !== undefined && (typeof requestedImage !== 'string' || !/^image-\d{1,5}$/.test(requestedImage))) fail('La imagen seleccionada ya no es válida.');
  const bounds = page.getBounds(), inverse = mupdf.Matrix.invert(page.getTransform());
  const overlap = (a, b) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > .5 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > .5;
  const intersection = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const usable = b => finite(b) && b.length === 4 && b[2] - b[0] > .1 && b[3] - b[1] > .1;
  const equalBox = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < .5);
  const point = (x, y, m) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  const warnings = new Set(), textPaint = [], images = [], graphics = [], groups = [];
  const clips = [{ box: bounds, complex: false }]; let events = 0, characters = 0, order = 0, display, structured, device, selectedImage;
  const reserve = () => { if (++events > 20000) fail('La página contiene demasiados elementos para la selección automática. Usa una selección manual.'); };
  const currentClip = () => clips.at(-1);
  const complexGroup = () => groups.some(Boolean);
  const pushClip = (box, complex) => { reserve(); clips.push({ box: intersection(box, currentClip().box), complex: complex || currentClip().complex }); };
  const isRectangle = (path, matrix) => {
    let count = 0, curve = false, closed = false; const points = [];
    path.walk({ moveTo: (x, y) => { count++; if (count <= 5) points.push(point(x, y, matrix)); }, lineTo: (x, y) => { count++; if (count <= 5) points.push(point(x, y, matrix)); }, curveTo: () => { curve = true; }, closePath: () => { closed = true; } });
    if (curve || !closed || count < 4 || count > 5) return false;
    const box = path.getBounds(null, matrix);
    return points.every(([x, y]) => (Math.abs(x - box[0]) < .1 || Math.abs(x - box[2]) < .1) && (Math.abs(y - box[1]) < .1 || Math.abs(y - box[3]) < .1));
  };
  const paintText = (text, matrix, alpha, hidden, stroke = null) => {
    reserve(); const box = text.getBounds(stroke, matrix);
    textPaint.push({ box, hidden: hidden || alpha <= 0, complex: complexGroup() || currentClip().complex || alpha < .999, clip: currentClip().box, order: order++ });
  };
  const paintImage = (image, matrix, alpha, mask = false) => {
    reserve(); const box = mupdf.Rect.transform([0, 0, 1, 1], matrix), clip = currentClip(), visible = intersection(box, clip.box);
    let softMask;
    try {
      softMask = image.getMask();
      if (usable(visible)) {
        if (`image-${images.length}` === requestedImage) selectedImage = new mupdf.Image(image.pointer);
        images.push({ box: visible, fullBox: box, alpha, complex: complexGroup() || clip.complex, masked: mask || image.getImageMask() || !!softMask, clipped: !equalBox(visible, box), matrix, order: order++, width: image.getWidth(), height: image.getHeight() });
      }
    } finally { softMask?.destroy(); }
  };
  const paintPath = (path, matrix, alpha, stroke = null) => { reserve(); if (alpha > 0) graphics.push({ box: path.getBounds(stroke, matrix), order: order++ }); };
  try {
    device = new mupdf.Device({
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
      clipImageMask: (image, matrix) => { try { pushClip(mupdf.Rect.transform([0, 0, 1, 1], matrix), true); } finally { image.destroy(); } },
      popClip: () => { if (clips.length > 1) clips.pop(); },
      beginGroup: (_box, cs, _isolated, knockout, blend, alpha) => { reserve(); groups.push(knockout || blend !== 'Normal' || alpha < .999); cs.destroy(); },
      endGroup: () => { groups.pop(); },
      beginMask: (box, _luminosity, cs) => { pushClip(box, true); cs.destroy(); },
      endMask: () => {},
    });
    page.runPageContents(device, mupdf.Matrix.identity); device.close(); device.destroy(); device = undefined;
    display = page.toDisplayList(false); structured = display.toStructuredText('preserve-whitespace');
    // The installed walker truncates non-BMP runes with fromCharCode. JSON's
    // Unicode strings preserve them; only strings are used, not its rounded boxes.
    const jsonLines = JSON.parse(structured.asJSON()).blocks.filter(block => block.type === 'text').flatMap(block => block.lines.map(line => line.text));
    if (jsonLines.reduce((n, line) => n + line.length, 0) > 200000) fail('Hay demasiado texto para la selección automática. Usa una selección manual.');
    const blocks = []; let block, line, index = 0, rune = 0, jsonRunes;
    structured.walk({
      beginTextBlock: box => { block = { box, lines: [] }; blocks.push(block); if (blocks.length > 5000) fail('Hay demasiados bloques para la selección automática.'); },
      beginLine: (box, mode, direction) => { line = { box, mode, direction, text: '', styles: new Map() }; block.lines.push(line); jsonRunes = [...(jsonLines[index++] || '')]; rune = 0; },
      onChar: (character, origin, font, size, _quad, color) => {
        try {
          if (++characters > 100000) fail('Hay demasiado texto para la selección automática.');
          const c = jsonRunes[rune++] ?? character; line.text += c; line.origin ??= origin;
          if (!c.trim()) return;
          const hex = '#' + color.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('');
          const fontName = font.getName(), key = `${fontName}:${Math.round(size * 100)}:${hex}`, style = line.styles.get(key) || { size, color: hex, fontName, count: 0 };
          style.count++; line.styles.set(key, style);
        } finally { font.destroy(); }
      },
    });
    const candidates = [];
    for (const [bi, block] of blocks.entries()) {
      const rows = block.lines.filter(row => row.text.trim() && usable(intersection(row.box, bounds)));
      if (!rows.length) continue;
      const addText = (id, level, box, rows) => {
        const styles = new Map(); rows.forEach(row => row.styles.forEach((style, key) => { const entry = styles.get(key) || { ...style, count: 0 }; entry.count += style.count; styles.set(key, entry); }));
        const style = [...styles.values()].sort((a, b) => b.count - a.count)[0] || { size: 12, color: '#202020', fontName: 'Helvetica' };
        const related = textPaint.filter(event => overlap(event.box, box)), hidden = related.some(event => event.hidden), visible = related.some(event => !event.hidden);
        const rotated = rows.some(row => row.mode !== 0 || Math.abs(row.direction[1]) > .01 || row.direction[0] < .99);
        const clipped = !equalBox(intersection(box, bounds), box) || related.some(event => !equalBox(intersection(box, event.clip), box));
        const complex = related.some(event => event.complex && !event.hidden);
        let reason = !visible ? 'Texto OCR invisible: no representa letras visibles que puedan reemplazarse.' : hidden ? 'Hay capas de texto visibles e invisibles superpuestas.' : rotated ? 'Texto girado o vertical: usa una selección manual.' : clipped || complex ? 'Texto recortado o con efectos: usa una selección manual.' : undefined;
        const baselineOffset = rows[0].origin?.[1] - box[1];
        const advances = !rotated ? rows.slice(1).map((row, i) => (row.origin?.[1] - rows[i].origin?.[1]) / style.size).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b) : [];
        const lineHeight = advances.length ? advances[Math.floor(advances.length / 2)] : undefined;
        if (lineHeight !== undefined && (lineHeight < .8 || lineHeight > 3)) reason ??= 'Interlineado fuera del rango del editor: usa una selección manual.';
        const item = { id, kind: 'text', level, rect: mupdf.Rect.transform(intersection(box, bounds), inverse), text: rows.map(row => row.text).join('\n'), size: style.size, color: style.color, fontName: style.fontName, mixedStyle: styles.size > 1, rotated, editable: !reason, ...(reason ? { reason } : {}), ...(Number.isFinite(baselineOffset) && baselineOffset >= 0 ? { baselineOffset } : {}), ...(lineHeight >= .8 && lineHeight <= 3 ? { lineHeight } : {}) };
        candidates.push({ item, box, block: bi, rows });
      };
      rows.forEach((row, li) => addText(`text-line-b${bi}-l${li}`, 'line', row.box, [row]));
      addText(`text-paragraph-b${bi}`, 'paragraph', rows.reduce((box, row) => [Math.min(box[0], row.box[0]), Math.min(box[1], row.box[1]), Math.max(box[2], row.box[2]), Math.max(box[3], row.box[3])], [...rows[0].box]), rows);
    }
    for (const candidate of candidates) {
      if (candidate.item.editable && candidates.some(other => other.block !== candidate.block && other.item.level === 'line' && overlap(candidate.box, other.box))) {
        candidate.item.editable = false; candidate.item.reason = 'Hay otro bloque de texto superpuesto: usa una selección manual.';
      }
      if (candidate.item.editable && images.some(image => image.alpha >= .999 && !image.masked && overlap(candidate.box, image.box) && textPaint.some(event => !event.hidden && overlap(event.box, candidate.box) && image.order > event.order))) {
        candidate.item.editable = false; candidate.item.reason = 'El texto está cubierto por una imagen: usa una selección manual.';
      }
      if (candidate.item.reason) warnings.add(candidate.item.reason);
    }
    const imageItems = images.map((image, i) => {
      const [a, b, c, d] = image.matrix, orthogonal = (Math.abs(b) < .01 && Math.abs(c) < .01) || (Math.abs(a) < .01 && Math.abs(d) < .01);
      const overlaps = images.some(other => other !== image && other.alpha > 0 && overlap(image.box, other.box)) || candidates.some(candidate => candidate.item.level === 'line' && textPaint.some(event => !event.hidden && overlap(event.box, candidate.box)) && overlap(image.box, candidate.box)) || graphics.some(graphic => graphic.order > image.order && overlap(graphic.box, image.box));
      const reason = image.alpha <= 0 ? 'Imagen invisible.' : image.clipped || image.complex || image.masked ? 'Imagen recortada, con máscara o efectos: usa una selección manual.' : a * d - b * c <= 0 ? 'Imagen reflejada: usa una selección manual.' : !orthogonal ? 'Imagen inclinada: usa una selección manual.' : overlaps ? 'Imagen con contenido superpuesto: usa una selección manual.' : image.width * image.height > 16000000 ? 'La imagen supera el límite de 16 megapíxeles para editarla automáticamente.' : undefined;
      if (reason) warnings.add(reason);
      return { id: `image-${i}`, kind: 'image', rect: mupdf.Rect.transform(image.box, inverse), editable: !reason, ...(reason ? { reason } : {}) };
    });
    const items = [...candidates.map(candidate => candidate.item), ...imageItems];
    if (hasSignature(doc) || !doc.hasPermission('edit')) {
      const reason = 'El documento firmado o sus permisos no permiten editar el contenido.';
      items.forEach(item => { item.editable = false; item.reason = reason; }); warnings.add(reason);
    }
    if (requestedImage !== undefined) {
      const item = imageItems.find(item => item.id === requestedImage);
      if (!item || !selectedImage) fail('La imagen seleccionada ya no existe en esta página.');
      if (!item.editable) fail(item.reason);
      return pageImagePixels(selectedImage, images[Number(requestedImage.slice(6))]);
    }
    return { items, warnings: [...warnings] };
  } finally { selectedImage?.destroy(); device?.destroy(); structured?.destroy(); display?.destroy(); }
}

function pageImagePixels(image, info) {
  const width = image.getWidth(), height = image.getHeight();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16000000) fail('La imagen supera el límite de 16 megapíxeles para editarla automáticamente.');
  let decoded, rgb;
  try {
    decoded = image.toPixmap(); rgb = decoded.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
    const rotation = ((Math.round(Math.atan2(info.matrix[1], info.matrix[0]) / (Math.PI / 2)) * 90) % 360 + 360) % 360;
    return { bytes: new Uint8Array(rgb.asPNG()), width, height, opacity: info.alpha, rotation };
  } finally { rgb?.destroy(); decoded?.destroy(); }
}

function redactPage(doc, page, boxes, { black = true, images = true, graphics = true, text = true, preserveAnnotations = false } = {}) {
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
    page.applyRedactions(black, images ? mupdf.PDFPage.REDACT_IMAGE_PIXELS : mupdf.PDFPage.REDACT_IMAGE_NONE,
      graphics ? mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED : mupdf.PDFPage.REDACT_LINE_ART_NONE, text ? mupdf.PDFPage.REDACT_TEXT_REMOVE : mupdf.PDFPage.REDACT_TEXT_NONE);
  } finally {
    if (preserveAnnotations) { if (restored) object.put('Annots', restored); else object.delete('Annots'); }
  }
}

export function operateDocument(bytes, options, password = '') {
  const doc = open(bytes, password);
  try {
    const operation = options.operation;
    if (operation === 'fields') return fields(doc);
    if (operation === 'page-content' || operation === 'page-image') {
      if (!doc.hasPermission('copy')) fail('El PDF no permite extraer su contenido.');
      if (operation === 'page-image' && typeof options.id !== 'string') fail('La imagen seleccionada ya no es válida.');
      const page = doc.loadPage(pageIndex(doc, options.page));
      try { return pageContent(doc, page, operation === 'page-image' ? options.id : undefined); }
      finally { page.destroy(); }
    }
    if (operation === 'area-info') {
      if (!doc.hasPermission('copy')) fail('El PDF no permite extraer texto.');
      const page = doc.loadPage(pageIndex(doc, options.page));
      try { return areaContent(page, mupdf.Rect.transform(rect(options.rect), page.getTransform())); }
      finally { page.destroy(); }
    }
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
      const sources = (options.sources || []).map(source => {
        const other = open(source.bytes, source.password); allowed(other, 'assemble'); return other;
      });
      try {
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
      const pending = new Map(Object.entries(options.values || {})), seen = new Set();
      for (let i = 0; i < doc.countPages(); i++) {
        const page = doc.loadPage(i);
        try {
          for (const [position, widget] of page.getWidgets().entries()) {
            const id = `${i + 1}:${position}:${widget.getName()}`; if (!pending.has(id)) continue;
            if (widget.isReadOnly()) fail(`El campo «${widget.getName()}» es de solo lectura.`);
            const value = pending.get(id); seen.add(id);
            if (widget.isText()) {
              if (typeof value !== 'string' || value.length > 100000 || (widget.getMaxLen() > 0 && value.length > widget.getMaxLen())) fail('El valor excede el límite del campo.');
              if (!widget.setTextValue(value)) fail(`No se pudo actualizar «${widget.getName()}».`);
            } else if (widget.isChoice()) {
              if (typeof value !== 'string' || !widget.getOptions(true).includes(value)) fail('Opción de formulario inválida.');
              if (!widget.setChoiceValue(value)) fail('No se pudo actualizar la opción.');
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
      const page = doc.loadPage(pageIndex(doc, options.page)), box = rect(options.rect);
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
        const reloaded = doc.loadPage(pageIndex(doc, options.page));
        try { for (const widget of reloaded.getWidgets()) if (widget.getObject().asIndirect() === ref.asIndirect()) widget.update(); reloaded.update(); }
        finally { reloaded.destroy(); }
      } finally { page.destroy(); }
    } else if (operation === 'ocr') {
      allowed(doc, 'edit');
      const font = options.font ? new mupdf.Font('Folio Sans', options.font) : new mupdf.Font('Helvetica');
      try {
        for (const result of options.pages) {
          const page = doc.loadPage(pageIndex(doc, result.page));
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
    } else if (['add-text', 'replace-text', 'add-image', 'replace-image', 'remove-image', 'redact', 'crop'].includes(operation)) {
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
          else if (operation === 'add-image' || operation === 'replace-image') {
            const image = new mupdf.Image(options.image);
            let replacement;
            try {
              const placement = imagePlacement(image, box, options);
              if (operation === 'replace-image') {
                const source = mupdf.Rect.transform(rect(options.sourceRect ?? options.rect), page.getTransform());
                // Image editing removes pixels in the source area; text and annotations remain.
                redactPage(doc, page, [source], { black: false, images: true, graphics: false, text: false, preserveAnnotations: true });
                replacement = save(doc);
              } else appendDrawing(doc, page, device => imageDrawing(device, box, image, placement));
            } finally { image.destroy(); }
            if (replacement) return operateDocument(replacement, { ...options, operation: 'add-image' }, password);
          } else if (operation === 'remove-image') {
            const a = page.createAnnotation('Redact'); a.setRect(box); a.update();
            page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_NONE);
          } else {
            // Fit validation happens before redaction; errors never return a modified PDF.
            if (operation === 'replace-text') {
              textDrawing({ fillText() {} }, box, options);
              const source = mupdf.Rect.transform(rect(options.sourceRect ?? options.rect), page.getTransform());
              redactPage(doc, page, [source], { black: false, images: false, graphics: false, preserveAnnotations: true });
              // MuPDF's redaction save pass rewrites Form streams; commit it before adding a new one.
              return operateDocument(save(doc), { ...options, operation: 'add-text' }, password);
            }
            appendDrawing(doc, page, device => textDrawing(device, box, options));
          }
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
      allowed(doc, 'edit');
      // An owner password is required even when user permissions are permissive.
      if (doc.needsPassword() && !(doc.authenticatePassword(password) & 4)) fail('Necesitas la contraseña de propietario para quitar la protección.');
      return save(doc, 'garbage=4,compress=yes,encrypt=no');
    } else fail('Operación desconocida.');
    const output = ['add-text', 'add-image', 'ocr'].includes(operation) ? saveDrawnDocument(doc, password) : save(doc);
    return operation === 'compress' && output.length >= bytes.length ? new Uint8Array(bytes) : output;
  } finally { doc.destroy(); mupdf.emptyStore(); }
}
