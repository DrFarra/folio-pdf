import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

const pdf = await PDFDocument.create();
const sans = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const serif = await pdf.embedFont(StandardFonts.TimesRoman);
const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
const c = hex => rgb(parseInt(hex.slice(1,3),16)/255,parseInt(hex.slice(3,5),16)/255,parseInt(hex.slice(5,7),16)/255);
const ink = c('#30382e'), muted = c('#929580'), cream = c('#f8f5ec'), red = c('#b95e45'), sage = c('#7c8d72');
const text = (page, value, x, y, size = 11, font = sans, color = ink) => page.drawText(value, { x, y, size, font, color });
function paragraph(page, value, x, y, width = 450, size = 11, font = sans, color = ink, leading = 19) {
  let line = '';
  for (const word of value.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next,size) > width && line) { text(page,line,x,y,size,font,color); y -= leading; line = word; }
    else line = next;
  }
  if (line) { text(page,line,x,y,size,font,color); y -= leading; }
  return y;
}
function base(number, section) {
  const page = pdf.addPage([595,842]);
  page.drawRectangle({ x:0,y:0,width:595,height:842,color:cream });
  text(page,'FOLIO JOURNAL',48,793,8,bold,muted);
  text(page,section.toUpperCase(),390,793,7,sans,muted);
  page.drawLine({ start:{x:48,y:775},end:{x:547,y:775},thickness:.5,color:c('#d4d5c6') });
  page.drawLine({ start:{x:48,y:57},end:{x:547,y:57},thickness:.5,color:c('#d4d5c6') });
  text(page,'EL ARTE DE OBSERVAR  /  UNA GUÍA DE LECTURA',48,37,6.5,sans,muted);
  text(page,number.toString().padStart(2,'0'),531,36,8,bold,muted);
  return page;
}
function arch(page,x,y,width,height,color) {
  page.drawRectangle({ x,y,width,height:height-width/2,color });
  page.drawCircle({ x:x+width/2,y:y+height-width/2,size:width/2,color });
}
function artwork(page,x,y,width,height) {
  page.drawRectangle({ x,y,width,height,color:c('#e9eadb') });
  page.drawRectangle({ x:x+width*.55,y,width:width*.45,height:height*.87,color:c('#84927b') });
  page.drawRectangle({ x:x+width*.88,y,width:width*.12,height,color:c('#64785f') });
  arch(page,x+width*.65,y,width*.18,height*.64,c('#52674c'));
  page.drawRectangle({ x,y,width:width*.56,height:height*.55,color:red });
  arch(page,x+width*.28,y,width*.16,height*.46,c('#7d4434'));
  page.drawCircle({ x:x+width*.27,y:y+height*.83,size:height*.12,color:c('#cd785b') });
  for(let i=0;i<6;i++) page.drawRectangle({x:x+width*(.44+i*.042),y,width:width*.043,height:height*(.12+i*.073),color:c('#d3c6aa')});
  page.drawLine({ start:{x,y},end:{x:x+width,y},thickness:1,color:c('#cbc9b3') });
}
const cover = base(1,'Perspectivas / 2026');
text(cover,'UNA GUÍA PARA MIRAR CON MÁS INTENCIÓN',48,739,7,bold,muted);
text(cover,'El arte',45,666,55,serif);
text(cover,'de observar',45,608,55,serif);
paragraph(cover,'Ideas, principios y pequeñas pausas para descubrir lo extraordinario en lo cotidiano.',48,567,345,11,sans,c('#808575'),18);
artwork(cover,48,222,499,283);
text(cover,'MENOS PRISA. MÁS PERSPECTIVA.',48,170,7.5,bold,red);
paragraph(cover,'Una invitación a detenerte, prestar atención y volver a mirar. Porque una buena idea empieza con una mirada curiosa.',48,143,430,10,sans,muted,17);

const second = base(2,'Una mirada atenta');
text(second,'01  /  ATENCIÓN',48,738,8,bold,red);
text(second,'Una mirada',46,676,41,serif);text(second,'más atenta.',46,631,41,serif);
let y = paragraph(second,'Observar no es solo mirar. Es una forma de estar en el mundo: detenerse, descubrir la belleza en lo cotidiano y aprender a habitar con más conciencia nuestro entorno.',48,584,482,12,serif,ink,20);
y=paragraph(second,'El diseño nace de una forma más lenta y consciente de mirar. Antes de trazar una línea, elegir un material o definir un espacio, es necesario detenerse, observar y comprender.',48,y-21,482,11,sans,ink,20);
artwork(second,48,206,499,211);
text(second,'La atención transforma lo que vemos.',48,157,19,italic,c('#738367'));
text(second,'Haz una pausa. Mira de nuevo. Encuentra un detalle que no habías visto.',48,128,9,sans,muted);

const third = base(3,'Principios de la observación');
text(third,'02  /  PRINCIPIOS',48,738,8,bold,red);
text(third,'Mirar de otra manera.',46,677,37,serif);
const principles = [
  ['01','Busca relaciones','El diseño conecta proporciones, ritmos y materiales. Mira cómo se relacionan las partes antes de estudiar cada elemento por separado.'],
  ['02','Acepta la pausa','Una pausa abre espacio para preguntas nuevas. Cambiar la velocidad de tu mirada puede cambiar el resultado de una decisión.'],
  ['03','Conserva la curiosidad','La vida cotidiana está llena de pequeñas lecciones de diseño. Pregunta por qué una forma te atrae o un lugar te transmite calma.'],
];
let py=607;
for(const [number,title,body] of principles){text(third,number,48,py,27,serif,red);text(third,title,105,py+3,15,bold);paragraph(third,body,105,py-25,414,10,sans,muted,18);third.drawLine({start:{x:48,y:py-100},end:{x:547,y:py-100},thickness:.5,color:c('#d4d5c6')});py-=160;}
text(third,'Lo simple también merece ser observado.',48,113,17,italic,c('#738367'));

const fourth = base(4,'Espacio y proporción');
text(fourth,'03  /  PERSPECTIVA',48,738,8,bold,red);
text(fourth,'Espacio',46,679,43,serif);text(fourth,'y proporción.',46,631,43,serif);
paragraph(fourth,'La percepción de un espacio cambia según la luz, la escala y los materiales. Un mismo lugar puede transmitir calma, energía o intimidad, dependiendo de cómo se combinan sus elementos.',48,582,482,11,sans,ink,20);
artwork(fourth,48,248,499,208);
paragraph(fourth,'El diseño de interiores no solo organiza objetos: también moldea experiencias. La proporción, la luz y el vacío son herramientas esenciales para dar forma a espacios que nos hacen sentir bien.',48,214,482,11,sans,ink,19);
text(fourth,'Observar cómo habita la gente un lugar',48,115,16,italic,sage);
text(fourth,'nos ayuda a tomar mejores decisiones.',48,94,16,italic,sage);

const fifth = base(5,'Un ejercicio cotidiano');
text(fifth,'04  /  UNA PEQUEÑA PRÁCTICA',48,738,8,bold,red);
text(fifth,'Cinco minutos.',46,677,39,serif);
paragraph(fifth,'Elige un lugar que conozcas bien. Una mesa, una ventana, una calle de tu barrio. Durante cinco minutos, míralo como si fuera la primera vez.',48,625,470,12,serif,ink,21);
const tasks = [['1','Descubre una forma','Busca una línea, una curva o una proporción que antes pasabas por alto.'],['2','Sigue la luz','Observa una sombra. ¿Qué cambia cuando la luz se mueve?'],['3','Escucha el espacio','Piensa en cómo los materiales afectan a los sonidos que te rodean.'],['4','Escribe una idea','Guarda una observación que quieras llevar a tu próximo proyecto.']];
let ty=520;
for(const [n,title,body] of tasks){fifth.drawCircle({x:63,y:ty+4,size:15,color:c('#e7eada')});text(fifth,n,60,ty,10,bold,sage);text(fifth,title,94,ty+6,12,bold);paragraph(fifth,body,94,ty-18,421,10,sans,muted,18);ty-=92;}
fifth.drawRectangle({x:48,y:84,width:499,height:74,color:c('#ece8d7')});text(fifth,'Una idea para recordar',66,129,12,bold,c('#8c835c'));text(fifth,'Usa una nota de Folio para conservar lo que acabas de descubrir.',66,107,9,sans,c('#a09979'));

const sixth=base(6,'Ideas para llevar');
text(sixth,'05  /  PARA LLEVAR',48,738,8,bold,red);
text(sixth,'Leer es otra',46,674,43,serif);text(sixth,'forma de crear.',46,627,43,serif);
paragraph(sixth,'Cada documento es una oportunidad para hacer una conexión nueva. Resalta una frase, deja una nota, guarda una página. No hace falta recordarlo todo: basta con conservar una buena idea.',48,576,475,11,sans,ink,20);
artwork(sixth,48,207,499,255);
text(sixth,'¿Qué idea te llevas de esta lectura?',48,154,21,italic,sage);
text(sixth,'Folio · Un espacio gratuito para tus documentos y tus ideas.',48,122,9,sans,muted);
text(sixth,'Documento de ejemplo. Contenido e ilustraciones creados para este visor.',48,101,7,sans,muted);

const titles=['Portada','Una mirada atenta','Principios de la observación','Espacio y proporción','Un ejercicio cotidiano','Ideas para llevar'];
const ctx=pdf.context;
const root=ctx.obj({Type:'Outlines',Count:titles.length});
const rootRef=ctx.register(root);
const items=titles.map((title,i)=>ctx.obj({Title:PDFString.of(title),Parent:rootRef,Dest:[pdf.getPages()[i].ref,'Fit']}));
const refs=items.map(item=>ctx.register(item));
items.forEach((item,i)=>{if(i)item.set(PDFName.of('Prev'),refs[i-1]);if(i<items.length-1)item.set(PDFName.of('Next'),refs[i+1]);});
root.set(PDFName.of('First'),refs[0]);root.set(PDFName.of('Last'),refs.at(-1));pdf.catalog.set(PDFName.of('Outlines'),rootRef);
pdf.setTitle('El arte de observar');pdf.setAuthor('Folio');pdf.setSubject('Documento de ejemplo para el visor de PDF Folio');pdf.setLanguage('es');
await mkdir('public',{recursive:true});await writeFile('public/sample.pdf',await pdf.save());
console.log('Documento de ejemplo generado: 6 páginas con índice y texto seleccionable.');
