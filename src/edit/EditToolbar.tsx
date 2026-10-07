import { useEffect, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowUpRight, Bold, Check, Circle, Copy, ImagePlus, Italic, LoaderCircle, Minus, MousePointer2, RotateCw, Square, Trash2, Type } from 'lucide-react';
import type { LoadedDocument } from '../types';
import { useEdit, type EditStore, type EditTool, type TextStyle } from './store';
import { deleteSelection, duplicateSelection, editText, fadeSelection, replaceImage, rotateSelection, styleFrom } from './actions';
import { parseFontName, systemFamilies } from './fonts';
import { isMac } from '../platform';

// The row under the reader toolbar while editing: tools on the left, the
// selection's properties next to them, what is happening on the right.

const TOOLS: [EditTool, string, string, typeof Type][] = [
  ['select', 'Seleccionar', 'V', MousePointer2], ['text', 'Texto', 'T', Type], ['image', 'Imagen', 'I', ImagePlus],
  ['rect', 'Rectángulo', 'R', Square], ['ellipse', 'Elipse', 'O', Circle], ['line', 'Línea', 'L', Minus], ['arrow', 'Flecha', 'A', ArrowUpRight],
];
const HINTS: Record<EditTool, string> = {
  select: 'Haz clic en un texto, imagen o forma para editarlo. Doble clic en un texto para escribir.',
  text: 'Haz clic en un texto para modificarlo, o en un espacio libre para escribir uno nuevo.',
  image: 'Haz clic o arrastra en la página para colocar la imagen.',
  rect: 'Arrastra en la página para dibujar un rectángulo.', ellipse: 'Arrastra en la página para dibujar una elipse.',
  line: 'Arrastra en la página para dibujar una línea.', arrow: 'Arrastra en la página para dibujar una flecha.',
};
const keep = (event: React.MouseEvent) => event.preventDefault();

export async function readImage(file: File): Promise<{ bytes: Uint8Array; width: number; height: number; name: string }> {
  if (!/^image\/(png|jpeg)$/.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) throw new Error('Elige una imagen PNG o JPEG.');
  if (file.size > 50 * 1024 * 1024) throw new Error('La imagen supera 50 MB.');
  const bitmap = await createImageBitmap(file);
  try { return { bytes: new Uint8Array(await file.arrayBuffer()), width: bitmap.width, height: bitmap.height, name: file.name }; }
  finally { bitmap.close(); }
}

function ColorField({ label, value, onChange, empty }: { label: string; value: string | null; onChange: (value: string) => void; empty?: boolean }) {
  return <label className="edit-color" title={label} onMouseDown={event => event.stopPropagation()}>
    <span className={value ? '' : 'empty'} style={value ? { background: value } : undefined} />
    <input type="color" aria-label={label} value={value || '#ffffff'} onChange={event => onChange(event.target.value)} />
    {empty && null}
  </label>;
}
function Toggle({ label, pressed, onClick, children, disabled }: { label: string; pressed?: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return <button type="button" className="edit-toggle" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onMouseDown={keep} onClick={onClick}>{children}</button>;
}

export default function EditToolbar({ store, doc, onDone }: { store: EditStore; doc: LoadedDocument; onDone: () => void }) {
  const tool = useEdit(store, state => state.tool);
  const selection = useEdit(store, state => state.selection);
  const draft = useEdit(store, state => state.draft);
  const committing = useEdit(store, state => state.committing);
  const notice = useEdit(store, state => state.notice);
  const pendingImage = useEdit(store, state => state.image);
  const shapeStyle = useEdit(store, state => state.shapeStyle);
  const [families, setFamilies] = useState<string[]>([]);
  const [opacity, setOpacity] = useState<number | null>(null);
  const imageInput = useRef<HTMLInputElement>(null), replaceInput = useRef<HTMLInputElement>(null);
  useEffect(() => { void systemFamilies().then(setFamilies); }, []);
  useEffect(() => { setOpacity(null); }, [selection]);

  const chooseTool = (next: EditTool) => {
    if (next === 'image') { imageInput.current?.click(); return; }
    store.set({ tool: next, image: null, notice: '', ...(next !== 'select' ? { selection: null } : {}) });
  };
  const pickImage = async (file?: File) => {
    if (!file) return;
    try { store.set({ image: await readImage(file), tool: 'image', selection: null, notice: '' }); }
    catch (error) { store.actions?.notify((error as Error).message, 'error'); }
  };

  // Text: the draft being typed, or the selected paragraph (a change starts typing in it).
  const textItem = selection?.kind === 'text' ? selection.item : null;
  const style: TextStyle | null = draft?.style ?? (textItem ? styleFrom(textItem) : null);
  const sourceName = draft?.source?.fontName ?? textItem?.fontName;
  const setStyle = async (patch: Partial<TextStyle>) => {
    const current = store.state.draft;
    if (current) { store.set({ draft: { ...current, style: { ...current.style, ...patch } } }); return; }
    const chosen = store.state.selection;
    if (chosen?.kind !== 'text') return;
    const info = await store.items(doc, chosen.page).catch(() => null);
    editText(store, chosen.page, chosen.item, info?.items ?? [chosen.item], patch);
  };
  const shapeSelected = selection?.kind === 'shape' ? store.actions?.shapes().find(shape => shape.id === selection.id) ?? null : null;
  const shapeTool = ['rect', 'ellipse', 'line', 'arrow'].includes(tool);
  const shapeValues = shapeSelected ? { color: shapeSelected.color, fill: shapeSelected.fill ?? null, strokeWidth: shapeSelected.strokeWidth ?? 1, opacity: shapeSelected.opacity ?? 1 } : shapeStyle;
  const setShape = (patch: Partial<typeof shapeStyle>) => {
    store.set({ shapeStyle: { ...store.state.shapeStyle, ...patch } });
    if (shapeSelected) store.actions?.updateShape(shapeSelected.id, patch);
  };
  const lineShape = shapeSelected ? !!shapeSelected.line : tool === 'line' || tool === 'arrow';
  const modifier = isMac ? '⌘' : 'Ctrl+';

  return <div className="edit-toolbar" role="toolbar" aria-label="Herramientas de edición">
    <div className="tool-group">
      {TOOLS.map(([key, label, shortcut, Icon], index) => <span key={key} style={{ display: 'contents' }}>
        {index === 3 && <span className="edit-divider" />}
        <button type="button" className={`icon-button ${tool === key ? 'active' : ''}`} aria-label={`${label} (${shortcut})`} title={`${label} (${shortcut})`} aria-pressed={tool === key} disabled={committing} onMouseDown={keep} onClick={() => chooseTool(key)}><Icon size={18} /></button>
      </span>)}
      <input ref={imageInput} type="file" accept="image/png,image/jpeg" className="sr-only" tabIndex={-1} onChange={event => { void pickImage(event.target.files?.[0]); event.target.value = ''; }} />
    </div>
    {(style || selection?.kind === 'image' || shapeSelected || shapeTool) && <span className="edit-divider" />}
    {style && <div className="edit-properties" aria-label="Formato del texto">
      <select aria-label="Fuente" value={style.family} disabled={committing} onChange={event => void setStyle({ family: event.target.value })}>
        {sourceName && <option value="original">Original · {parseFontName(sourceName).family}</option>}
        <option value="helvetica">Helvetica / Arial</option><option value="times">Times</option><option value="courier">Courier</option><option value="dm-sans">DM Sans</option>
        {!!families.length && <optgroup label="En este equipo">{families.map(family => <option key={family} value={`system:${family}`}>{family}</option>)}</optgroup>}
      </select>
      <input type="number" aria-label="Tamaño de letra" title="Tamaño de letra" min={4} max={200} step={.5} value={style.size} disabled={committing} onChange={event => { const size = Number(event.target.value); if (size >= 4 && size <= 200) void setStyle({ size }); }} />
      <Toggle label={`Negrita (${modifier}B)`} pressed={style.bold} disabled={committing} onClick={() => void setStyle({ bold: !style.bold })}><Bold size={16} /></Toggle>
      <Toggle label={`Cursiva (${modifier}I)`} pressed={style.italic} disabled={committing} onClick={() => void setStyle({ italic: !style.italic })}><Italic size={16} /></Toggle>
      <ColorField label="Color del texto" value={style.color} onChange={color => void setStyle({ color })} />
      <Toggle label="Alinear a la izquierda" pressed={style.align === 'left'} onClick={() => void setStyle({ align: 'left' })}><AlignLeft size={16} /></Toggle>
      <Toggle label="Centrar" pressed={style.align === 'center'} onClick={() => void setStyle({ align: 'center' })}><AlignCenter size={16} /></Toggle>
      <Toggle label="Alinear a la derecha" pressed={style.align === 'right'} onClick={() => void setStyle({ align: 'right' })}><AlignRight size={16} /></Toggle>
      <select aria-label="Interlineado" title="Interlineado" value={String(style.lineHeight)} onChange={event => void setStyle({ lineHeight: Number(event.target.value) })}>
        {[...new Set([1, 1.15, 1.25, 1.5, 2, style.lineHeight])].sort((a, b) => a - b).map(value => <option key={value} value={String(value)}>{value.toLocaleString('es')}</option>)}
      </select>
      {textItem && <Toggle label="Eliminar texto (Supr)" onClick={() => void deleteSelection(store)} disabled={committing}><Trash2 size={16} /></Toggle>}
    </div>}
    {selection?.kind === 'image' && <div className="edit-properties" aria-label="Imagen">
      <button type="button" className="edit-toggle" disabled={committing} onMouseDown={keep} onClick={() => replaceInput.current?.click()}>Reemplazar…</button>
      <input ref={replaceInput} type="file" accept="image/png,image/jpeg" className="sr-only" tabIndex={-1} onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { void replaceImage(store, (await readImage(file)).bytes); } catch (error) { store.actions?.notify((error as Error).message, 'error'); } }} />
      <Toggle label="Girar 90°" onClick={() => rotateSelection(store)} disabled={committing}><RotateCw size={16} /></Toggle>
      <label>Opacidad<input type="range" aria-label="Opacidad de la imagen" min={0} max={100} value={Math.round((opacity ?? selection.item.opacity ?? 1) * 100)} disabled={committing}
        onChange={event => setOpacity(Number(event.target.value) / 100)} onPointerUp={() => { if (opacity !== null) fadeSelection(store, opacity); }} onKeyUp={() => { if (opacity !== null) fadeSelection(store, opacity); }} /></label>
      <Toggle label={`Duplicar (${modifier}D)`} onClick={() => duplicateSelection(store)} disabled={committing}><Copy size={16} /></Toggle>
      <Toggle label="Eliminar imagen (Supr)" onClick={() => void deleteSelection(store)} disabled={committing}><Trash2 size={16} /></Toggle>
    </div>}
    {(shapeSelected || shapeTool) && <div className="edit-properties" aria-label="Forma">
      <ColorField label="Color del borde" value={shapeValues.color} onChange={color => setShape({ color })} />
      {!lineShape && <><ColorField label="Color de relleno" value={shapeValues.fill} onChange={fill => setShape({ fill })} />
        <Toggle label="Sin relleno" pressed={!shapeValues.fill} onClick={() => setShape({ fill: shapeValues.fill ? null : '#ffe08a' })}><span style={{ fontSize: 11 }}>Sin relleno</span></Toggle></>}
      <select aria-label="Grosor del borde" title="Grosor" value={String(shapeValues.strokeWidth)} onChange={event => setShape({ strokeWidth: Number(event.target.value) })}>
        {[...new Set([...(lineShape ? [] : [0]), .5, 1, 2, 3, 5, 8, shapeValues.strokeWidth])].sort((a, b) => a - b).map(value => <option key={value} value={String(value)}>{value ? `${value.toLocaleString('es')} pt` : 'Sin borde'}</option>)}
      </select>
      <select aria-label="Opacidad de la forma" title="Opacidad" value={String(shapeValues.opacity)} onChange={event => setShape({ opacity: Number(event.target.value) })}>
        {[...new Set([.25, .5, .75, 1, shapeValues.opacity])].sort((a, b) => a - b).map(value => <option key={value} value={String(value)}>{Math.round(value * 100)} %</option>)}
      </select>
      {shapeSelected && <><Toggle label={`Duplicar (${modifier}D)`} onClick={() => duplicateSelection(store)}><Copy size={16} /></Toggle><Toggle label="Eliminar forma (Supr)" onClick={() => void deleteSelection(store)}><Trash2 size={16} /></Toggle></>}
    </div>}
    <span className={`edit-status${notice ? ' notice' : ''}`} role="status" aria-live="polite">
      {committing ? <><LoaderCircle size={14} className="spin" />Guardando el cambio…</> : notice || (tool === 'image' && pendingImage ? `Haz clic o arrastra en la página para colocar «${pendingImage.name}».`
        : draft ? `Haz clic fuera o ${modifier}Intro para terminar · Esc cancela`
        : selection?.kind === 'text' ? 'Arrastra para moverlo · clic otra vez para escribir · Supr lo elimina'
        : selection?.kind === 'image' ? 'Arrastra para moverla · las esquinas cambian el tamaño (Mayús: libre)'
        : selection?.kind === 'shape' ? 'Arrastra para moverla · los tiradores cambian el tamaño'
        : HINTS[tool])}
    </span>
    <button className="text-button" disabled={committing} onMouseDown={keep} onClick={onDone}><Check size={16} />Listo</button>
  </div>;
}
