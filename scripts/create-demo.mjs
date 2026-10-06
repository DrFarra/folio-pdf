// Builds public/sample.pdf, the «Guía de Folio» opened by «Abrir PDF de ejemplo»:
// one short exercise per page, with a note, a form field and internal links.
// Tests also use it as a six-page fixture, so keep six A4 pages.
import { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

const pdf = await PDFDocument.create();
const sans = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const c = hex => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
const ink = c('#1f2430'), muted = c('#5f6878'), accent = c('#b0473a'), line = c('#d9dce3'), soft = c('#f6ece9');
const ctx = pdf.context, left = 56, width = 483;
const text = (page, value, x, y, size = 12, font = sans, color = ink) => page.drawText(value, { x, y, size, font, color });
function paragraph(page, value, y, { x = left, size = 12, font = sans, color = ink, max = width, leading = size * 1.55 } = {}) {
  let current = '';
  for (const word of value.split(' ')) {
    const next = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(next, size) > max) { text(page, current, x, y, size, font, color); y -= leading; current = word; }
    else current = next;
  }
  if (current) { text(page, current, x, y, size, font, color); y -= leading; }
  return y - size * .6;
}
const annotation = (page, entries) => page.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', F: 4, ...entries })));
const link = (page, rect, target) => annotation(page, { Subtype: 'Link', Rect: rect, Border: [0, 0, 0], Dest: [target.ref, 'XYZ', null, 842, null] });
const pages = [];
function section(number, title) {
  const page = pdf.addPage([595, 842]);
  text(page, 'Guía de Folio', left, 800, 9, bold, muted);
  text(page, `${number} / 6`, 539 - sans.widthOfTextAtSize(`${number} / 6`, 9), 800, 9, sans, muted);
  page.drawLine({ start: { x: left, y: 790 }, end: { x: 539, y: 790 }, thickness: .6, color: line });
  text(page, title, left, 735, 26, bold);
  pages.push(page);
  return page;
}
const topics = [
  ['Resaltar texto', 'Selecciona una frase y resáltala.'],
  ['Notas', 'Lee la nota de esta guía y añade otra.'],
  ['Dibujar', 'Usa el lápiz y la goma.'],
  ['Formularios', 'Rellena un campo de formulario.'],
  ['Buscar, marcar y guardar', 'Encuentra una palabra y guarda tus cambios.'],
];

const cover = section(1, 'Guía de Folio');
let y = paragraph(cover, 'Este PDF sirve para probar Folio. Cada página propone un ejercicio corto.', 690);
text(cover, 'Contenido', left, y - 8, 15, bold); y -= 44;
const contents = topics.map(([title, summary], index) => {
  text(cover, String(index + 2), left, y, 13, bold, accent);
  text(cover, title, left + 28, y, 13, bold);
  text(cover, summary, left + 28, y - 18, 11, sans, muted);
  const rect = [left - 4, y - 26, 539, y + 16];
  y -= 58;
  return rect;
});
y = paragraph(cover, 'Haz clic o toca un título para ir a su página. El mismo contenido está en el Índice del documento.', y - 6, { size: 11, color: muted });

const highlight = section(2, 'Resaltar texto');
y = paragraph(highlight, 'Selecciona la frase del recuadro y elige Resaltar en el menú que aparece. En un teléfono o una tablet, mantén pulsado el texto para seleccionarlo.', 690);
highlight.drawRectangle({ x: left, y: y - 62, width, height: 74, color: soft });
y = paragraph(highlight, 'Al guardar el PDF, Folio escribe los resaltados, las notas y los dibujos dentro del archivo, así que también se ven en otros lectores de PDF.', y - 14, { x: left + 16, max: width - 32, size: 13, font: bold });
paragraph(highlight, 'Para cambiar el color de un resaltado, comentarlo o borrarlo, haz clic o toca sobre él.', y - 26);

const notes = section(3, 'Notas');
y = paragraph(notes, 'Esta página ya tiene una nota en el margen derecho. Ábrela para leerla o editarla; también aparece en Anotaciones.', 690, { max: width - 40 });
paragraph(notes, 'Para añadir otra, elige Anotar y después Nota, y haz clic o toca donde quieras dejarla.', y, { max: width - 40 });
annotation(notes, { Subtype: 'Text', Rect: [551, 678, 571, 698], Name: 'Comment', C: [.96, .82, .39], T: PDFHexString.fromText('Folio'), NM: PDFHexString.fromText('guia-de-folio-nota'),
  Contents: PDFHexString.fromText('Esta es una nota de ejemplo. Puedes editarla o borrarla.') });

const drawing = section(4, 'Dibujar');
y = paragraph(drawing, 'Elige Anotar y después Lápiz, y dibuja dentro del recuadro. La Goma borra un trazo entero.', 690);
y = paragraph(drawing, 'Si dibujas con un lápiz digital, el dedo pasa a desplazar la página. Puedes cambiarlo con «Usar el dedo» en las opciones del Lápiz.', y);
drawing.drawRectangle({ x: left, y: y - 300, width, height: 290, borderColor: line, borderWidth: 1.2, borderDashArray: [6, 4] });
text(drawing, 'Dibuja aquí', left + 16, y - 34, 11, sans, muted);

const forms = section(5, 'Formularios');
y = paragraph(forms, 'Este PDF tiene un campo de formulario. Abre Herramientas, elige Rellenar formulario, escribe tu nombre y pulsa Aplicar valores.', 690);
text(forms, 'Nombre', left, y - 4, 11, bold, muted);
const field = pdf.getForm().createTextField('Nombre');
field.addToPage(forms, { x: left, y: y - 46, width: 300, height: 30, borderColor: muted, borderWidth: 1, backgroundColor: rgb(1, 1, 1), font: sans });
paragraph(forms, 'En Herramientas también puedes organizar páginas, reconocer texto (OCR), comparar documentos y firmar.', y - 82);

const finish = section(6, 'Buscar, marcar y guardar');
y = paragraph(finish, 'Buscar: escribe «marcador» en Buscar para encontrar esta palabra en todo el documento.', 690);
y = paragraph(finish, 'Marcadores: guarda esta página con el botón de marcador y vuelve a ella desde Marcadores.', y);
y = paragraph(finish, 'Guardar: mientras trabajas, Folio conserva tus cambios. Para tener un PDF con ellos, guárdalo o descárgalo.', y);
text(finish, 'Volver al contenido', left, y - 10, 12, bold, accent);
link(finish, [left - 4, y - 18, left + bold.widthOfTextAtSize('Volver al contenido', 12) + 4, y + 6], cover);
contents.forEach((rect, index) => link(cover, rect, pages[index + 1]));

const titles = ['Guía de Folio', ...topics.map(([title]) => title)];
const root = ctx.obj({ Type: 'Outlines', Count: titles.length }), rootRef = ctx.register(root);
const items = titles.map((title, index) => ctx.obj({ Title: PDFHexString.fromText(title), Parent: rootRef, Dest: [pages[index].ref, 'XYZ', null, 842, null] }));
const refs = items.map(item => ctx.register(item));
items.forEach((item, index) => { if (index) item.set(PDFName.of('Prev'), refs[index - 1]); if (index < items.length - 1) item.set(PDFName.of('Next'), refs[index + 1]); });
root.set(PDFName.of('First'), refs[0]); root.set(PDFName.of('Last'), refs.at(-1)); pdf.catalog.set(PDFName.of('Outlines'), rootRef);
pdf.setTitle('Guía de Folio'); pdf.setAuthor('Folio'); pdf.setSubject('PDF de ejemplo para probar Folio'); pdf.setLanguage('es');
await mkdir('public', { recursive: true }); await writeFile('public/sample.pdf', await pdf.save());
console.log('Guía de Folio generada en public/sample.pdf: 6 páginas, una nota, un campo de formulario y enlaces internos.');
