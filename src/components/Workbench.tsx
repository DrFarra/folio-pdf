import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Copy, Crop, EyeOff, FileArchive, FilePenLine, FileText, Files, FormInput, GripVertical, ImageMinus, LoaderCircle, LockKeyhole, Plus, RotateCw, ScanText, ShieldCheck, TextCursorInput, Trash2, FileOutput, Signature, GitCompareArrows, Undo2, Redo2, Save, Scissors } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import Modal from './Modal';
import FilePicker from './FilePicker';
import { Thumbnail } from './PDFPage';
import { inspectPdf, processPdf, readFields, splitPdf } from '../engine/client';
import type { Area, Field, Operation, PageEntry, PageContentItem } from '../engine/operations.mjs';
import type { LoadedDocument, Tool } from '../types';
import { formatSize, getDocument, plural } from '../pdf';
import { errorMessage } from '../errors';
import { pdfAssetSettings } from '../assets';
import { recognizePdf } from '../ocr';
import { convertPdf } from '../conversion';
import { saveExport, choosePartsFolder, savePartsZip, isNative, isAndroid, isDesktop, isMac } from '../platform';
import { signPdf, checkSignatures } from '../engine/crypto-client';
import type { SignatureResult } from '../engine/signatures.mjs';
import CompareDocuments from './CompareDocuments';
import ContentEditor, { NumberField, type ContentEditorKind } from './ContentEditor';
import PdfContentPicker from './PdfContentPicker';
import ConversionOptions from './ConversionOptions';
import SplitPdf from './SplitPdf';
import type { Part } from '../split';
import { usePagePlanDrag } from './usePagePlanDrag';
import './Workbench.css';

type Props = { doc: LoadedDocument; section: string; page: number; inline?: boolean; documentBusy?: boolean; area: Area | null; onAreaChange?: (area: Area) => void; redactions: Area[]; onClose: () => void; onSelectTool: (tool: Tool) => void; onOpenEditor?: () => void; onOpenSection?: (section: string) => void; onDraftChange?: (active: boolean) => void; onEditPageChange?: (page: number) => void; onApply: (operation: Operation, signal?: AbortSignal, context?: { keepEditing: boolean; page: number }) => Promise<void>; getBytes: () => Promise<Uint8Array>; onHistory?: (direction: 'undo' | 'redo') => void; canUndo?: boolean; canRedo?: boolean; onSave?: () => void; canSave?: boolean; onReplace: (bytes: Uint8Array, context?: { extraction?: { name: string; plan: PageEntry[] } }) => Promise<void>; onNotify?: (message: string) => void };
type PlannedPage = PageEntry & { key: string; label: string };
type EditSelection = { kind: ContentEditorKind; area: Area; item?: PageContentItem; reset?: number };
const entry = (page: number): PlannedPage => ({ key: crypto.randomUUID(), page, label: `Página ${page}` });
const initialValue = (field: Field) => ['checkbox', 'radiobutton'].includes(field.type) ? field.checked : field.value;
const fieldContext: [number, number] = [150, 24];
const fieldKinds: Record<string, string> = { text: 'Campo de texto', checkbox: 'Casilla', radiobutton: 'Grupo de opciones', combobox: 'Lista desplegable', listbox: 'Lista' };
// Fields without a tooltip expose internal names such as "f1_01[0]"; number
// them by kind instead. Fields of inserted PDFs carry a prefix before their name.
function fieldLabels(fields: Field[]) {
  const counts = new Map<string, number>(), groups = new Map<string, number>();
  return new Map(fields.map(field => {
    const kind = fieldKinds[field.type] || 'Campo', label = field.label.replace(/^Imported\d+_\d+_/, '');
    let number = field.type === 'radiobutton' ? groups.get(field.name) : undefined;
    if (number === undefined) { number = (counts.get(kind) || 0) + 1; counts.set(kind, number); if (field.type === 'radiobutton') groups.set(field.name, number); }
    return [field.id, /\[\d+\]$/.test(label) ? `${kind} ${number}` : label];
  }));
}

/** Renders the page around an area, outlined: the whole page, or a strip of `around` points. */
function AreaPreview({ pdf, area, around, measure }: { pdf: PDFDocumentProxy; area: Area; around?: [number, number]; measure?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  useEffect(() => {
    let alive = true, task: RenderTask | undefined;
    void pdf.getPage(area.page).then(async page => {
      const node = canvas.current; if (!alive || !node) return;
      const base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: around ? 1.5 : 240 / Math.max(base.width, base.height) });
      const [x0, y0] = viewport.convertToViewportPoint(area.rect[0], area.rect[1]), [x1, y1] = viewport.convertToViewportPoint(area.rect[2], area.rect[3]);
      const box = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      const [padX, padY] = (around || [Infinity, Infinity]).map(value => value * viewport.scale), left = Math.max(0, box[0] - padX), top = Math.max(0, box[1] - padY);
      const width = Math.min(viewport.width, box[2] + padX) - left, height = Math.min(viewport.height, box[3] + padY) - top, dpr = Math.min(window.devicePixelRatio || 1, 2);
      node.width = Math.ceil(width * dpr); node.height = Math.ceil(height * dpr); if (!around) node.style.width = `${width}px`;
      if (measure) setSize([(box[2] - box[0]) / viewport.scale, (box[3] - box[1]) / viewport.scale]);
      task = page.render({ canvas: node, viewport, transform: [dpr, 0, 0, dpr, -left * dpr, -top * dpr] }); await task.promise;
      const context = node.getContext('2d')!, rect = [(box[0] - left) * dpr, (box[1] - top) * dpr, (box[2] - box[0]) * dpr, (box[3] - box[1]) * dpr] as const;
      if (!around) { context.fillStyle = '#0005'; context.beginPath(); context.rect(0, 0, node.width, node.height); context.rect(...rect); context.fill('evenodd'); }
      context.strokeStyle = getComputedStyle(node).getPropertyValue('--accent').trim() || '#b94d37'; context.lineWidth = 2 * dpr; context.strokeRect(...rect);
    }).catch(() => {});
    return () => { alive = false; task?.cancel(); };
  }, [pdf, area, around, measure]);
  const mm = (points: number) => Math.round(points * 25.4 / 72);
  return <>
    <canvas ref={canvas} aria-hidden="true" style={around ? { display: 'block', maxWidth: '100%', maxHeight: '100%' } : { display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto 8px', background: '#fff', border: '1px solid var(--line)', borderRadius: 4 }} />
    {size && <p className="area-label">Tamaño resultante: {mm(size[0])} × {mm(size[1])} mm</p>}
  </>;
}

/** The area's position and size in points from the page's top-left corner, so it can also be set from the keyboard. */
function AreaFields({ pdf, area, disabled, onChange }: { pdf: PDFDocumentProxy; area: Area; disabled: boolean; onChange: (area: Area) => void }) {
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  useEffect(() => {
    let alive = true; void pdf.getPage(area.page).then(page => { if (alive) setViewport(page.getViewport({ scale: 1 })); }).catch(() => {});
    return () => { alive = false; };
  }, [pdf, area.page]);
  if (!viewport) return null;
  const [x0, y0] = viewport.convertToViewportPoint(area.rect[0], area.rect[1]), [x1, y1] = viewport.convertToViewportPoint(area.rect[2], area.rect[3]);
  const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  const update = (key: keyof typeof box, value: number) => {
    if (!Number.isFinite(value)) return;
    const next = { ...box, [key]: value }, width = Math.max(1, Math.min(viewport.width, next.width)), height = Math.max(1, Math.min(viewport.height, next.height));
    const x = Math.max(0, Math.min(viewport.width - width, next.x)), y = Math.max(0, Math.min(viewport.height - height, next.y));
    const a = viewport.convertToPdfPoint(x, y), b = viewport.convertToPdfPoint(x + width, y + height);
    onChange({ page: area.page, rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
  };
  // Typed values apply as they are completed; clamping shows once the field is left.
  const field = (label: string, name: string, key: keyof typeof box, min: number) => <label>{label}<NumberField aria-label={name} min={min} step={.5} disabled={disabled} value={Math.round(box[key] * 100) / 100} onValue={value => update(key, value)} /></label>;
  return <fieldset className="area-fields"><legend>Posición y tamaño, en puntos desde la esquina superior izquierda</legend>{field('X (pt)', 'Posición X', 'x', 0)}{field('Y (pt)', 'Posición Y', 'y', 0)}{field('Ancho (pt)', 'Ancho', 'width', 1)}{field('Alto (pt)', 'Alto', 'height', 1)}</fieldset>;
}

export default function Workbench(props: Props) {
  const { doc, onApply, onSelectTool } = props;
  const [section, setSection] = useState(props.section);
  const [editPage, setEditPage] = useState(props.page);
  const [editSelection, setEditSelection] = useState<EditSelection | null>(null);
  // Selecting an element is not a draft until the editor reports a change.
  const [editDirty, setEditDirty] = useState(false);
  const editDraft = !!editSelection && editDirty;
  const selectEdit = (next: EditSelection | null) => { setEditDirty(false); setEditSelection(next); };
  useEffect(() => { props.onDraftChange?.(editDraft); }, [editDraft, props.onDraftChange]);
  useEffect(() => () => props.onDraftChange?.(false), [props.onDraftChange]);
  const [compareVisited, setCompareVisited] = useState(props.section === 'compare');
  const [error, setError] = useState('');
  const [taskBusy, setBusy] = useState(false);
  const busy = taskBusy || !!props.documentBusy;
  const [compareBusy, setCompareBusy] = useState(false);
  const [plan, setPlan] = useState<PlannedPage[]>(() => Array.from({ length: doc.pdf.numPages }, (_, i) => entry(i + 1)));
  const initialPlan = useRef(plan);
  const [selected, setSelected] = useState<string[]>([]);
  const selectionAnchor = useRef<string | null>(null);
  const pageDrag = usePagePlanDrag(plan, selected, busy, setPlan);
  const [sources, setSources] = useState<{ bytes: Uint8Array; password?: string }[]>([]);
  // PDF.js copies of inserted PDFs, only for their thumbnails.
  const [sourcePreviews, setSourcePreviews] = useState<(PDFDocumentProxy | null)[]>([]);
  const previewTasks = useRef<PDFDocumentLoadingTask[]>([]);
  const [pendingSource, setPendingSource] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [sourcePassword, setSourcePassword] = useState('');
  const [fields, setFields] = useState<Field[] | null>(null);
  const fieldsSource = useRef<Uint8Array | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [focusedField, setFocusedField] = useState('');
  const [flatten, setFlatten] = useState(false);
  const [encrypted, setEncrypted] = useState(!!doc.password);
  const [userPassword, setUserPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentOwnerPassword, setCurrentOwnerPassword] = useState('');
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowPrint, setAllowPrint] = useState(true);
  const [allowComments, setAllowComments] = useState(true);
  const [allowChanges, setAllowChanges] = useState(false);
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState<'text' | 'checkbox' | 'combobox'>('text');
  const [fieldOptions, setFieldOptions] = useState('');
  const [language, setLanguage] = useState<'spa' | 'eng' | 'spa+eng'>('spa+eng');
  const [ocrScope, setOcrScope] = useState<'current' | 'all' | 'range'>(doc.pdf.numPages > 1 ? 'all' : 'current');
  const [pageRange, setPageRange] = useState(String(props.page));
  const [progress, setProgress] = useState('');
  const [pfx, setPfx] = useState<Uint8Array | null>(null);
  const [pfxName, setPfxName] = useState('');
  const [pfxPassword, setPfxPassword] = useState('');
  const [reason, setReason] = useState('');
  const [signatures, setSignatures] = useState<SignatureResult[] | null>(null);
  const [roots, setRoots] = useState<Uint8Array[]>([]);
  const [rootName, setRootName] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); previewTasks.current.forEach(task => { void task.destroy(); }); }, []);
  useEffect(() => () => { pfx?.fill(0); }, [pfx]);
  useEffect(() => {
    if (selectionAnchor.current && !plan.some(page => page.key === selectionAnchor.current)) selectionAnchor.current = null;
  }, [plan]);
  // Owner-password-only PDFs open without a password but are still encrypted.
  useEffect(() => {
    let alive = true;
    void doc.pdf.getMetadata().then(({ info }) => { if (alive) setEncrypted(!!(info as { EncryptFilterName?: string }).EncryptFilterName); }).catch(() => {});
    return () => { alive = false; };
  }, [doc.pdf]);

  useEffect(() => {
    if (section !== 'forms' || fieldsSource.current === doc.bytes) return;
    const controller = new AbortController(); setError('');
    void readFields(doc.bytes, doc.password, controller.signal).then(items => {
      if (controller.signal.aborted) return;
      fieldsSource.current = doc.bytes;
      setFields(items); setValues(Object.fromEntries(items.map(f => [f.id, initialValue(f)])));
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    return () => controller.abort();
  }, [section, doc.bytes, doc.password]);

  async function apply(operation: Operation) {
    await task(signal => onApply(operation, signal, section === 'edit-pdf' ? { keepEditing: true, page: editPage } : undefined));
  }
  function selectedPages(): number[] {
    if (ocrScope === 'current') return [props.page];
    if (ocrScope === 'all') return Array.from({ length: doc.pdf.numPages }, (_, i) => i + 1);
    const result = new Set<number>();
    for (const token of pageRange.split(',')) {
      const match = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/); if (!match) throw new Error('Intervalo inválido. Usa por ejemplo 1-3, 6.');
      const a = Number(match[1]), b = Number(match[2] || match[1]);
      if (a < 1 || b < a || b > doc.pdf.numPages) throw new Error('El intervalo contiene páginas que no existen.');
      for (let n = a; n <= b; n++) result.add(n);
    }
    return [...result];
  }
  async function task(action: (signal: AbortSignal) => Promise<void>) {
    setBusy(true); setError(''); setProgress('Preparando…'); controller.current = new AbortController();
    try { await action(controller.current.signal); }
    catch (err) { if (!controller.current.signal.aborted) setError(errorMessage(err)); }
    finally { setBusy(false); setProgress(''); }
  }
  function tool(tool: Tool) { onSelectTool(tool); }
  function move(index: number, delta: number) {
    const next = [...plan], target = index + delta; if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; setPlan(next);
  }
  function moveSelection(index: number) {
    const rest = plan.filter(page => !selected.includes(page.key));
    setPlan([...rest.slice(0, index), ...plan.filter(page => selected.includes(page.key)), ...rest.slice(index)]);
  }
  // New pages follow the last selected page, or go at the end.
  function insertPages(pages: PlannedPage[]) {
    setPlan(current => {
      const last = Math.max(-1, ...selected.map(key => current.findIndex(page => page.key === key))), at = last < 0 ? current.length : last + 1;
      return [...current.slice(0, at), ...pages, ...current.slice(at)];
    });
  }
  async function insertBlank() {
    // Match the page it follows; A4 when that size is unknown.
    const previous = selected.length ? plan.filter(page => selected.includes(page.key)).at(-1) : plan.at(-1);
    const pdf = previous?.source == null ? doc.pdf : sourcePreviews[previous.source];
    let size: [number, number] = previous?.blank || [595, 842];
    if (previous?.page && pdf) { const view = await pdf.getPage(previous.page).then(page => page.getViewport({ scale: 1 }), () => null); if (view) size = [view.width, view.height]; }
    insertPages([{ key: crypto.randomUUID(), blank: size, label: 'Página en blanco' }]);
  }
  function selectPage(key: string, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }, checked?: boolean) {
    if (busy) return;
    const index = plan.findIndex(page => page.key === key);
    if (index < 0) return;
    if (modifiers.shiftKey) {
      let anchor = plan.findIndex(page => page.key === selectionAnchor.current);
      if (anchor < 0) { selectionAnchor.current = key; anchor = index; }
      const range = new Set(plan.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map(page => page.key));
      setSelected(previous => plan.filter(page => range.has(page.key) || (modifiers.ctrlKey || modifiers.metaKey) && previous.includes(page.key)).map(page => page.key));
    } else {
      selectionAnchor.current = key;
      setSelected(previous => {
        const include = checked ?? !previous.includes(key);
        return plan.filter(page => page.key === key ? include : previous.includes(page.key)).map(page => page.key);
      });
    }
  }
  async function extractSelection() {
    const selectedPlan = plan.filter(page => selected.includes(page.key));
    if (!selectedPlan.length || busy) return;
    await task(async signal => {
      const bytes = await processPdf(await props.getBytes(), { operation: 'pages', plan: selectedPlan, sources }, doc.password, signal);
      if (!signal.aborted) await props.onReplace(bytes, { extraction: { name: `${doc.name.replace(/\.pdf$/i, '')} — páginas extraídas.pdf`, plan: selectedPlan } });
    });
  }
  async function splitDocument(parts: Part[], names: string[], signal: AbortSignal) {
    // Annotations are baked in first; a book too large for that is split without them.
    let bytes: Uint8Array, withoutAnnotations = false;
    try { bytes = await props.getBytes(); }
    catch (err) { signal.throwIfAborted(); if (!/demasiado grande/.test(errorMessage(err))) throw err; bytes = doc.bytes; withoutAnnotations = true; }
    const folder = isDesktop ? await choosePartsFolder(names, doc.nativeSource) : null;
    if (isDesktop && !folder) return;
    const outputs: Uint8Array[] = [];
    let writing = Promise.resolve();
    setProgress(parts.length === 1 ? 'Creando el archivo…' : `Creando 1 de ${parts.length} archivos…`);
    await splitPdf(bytes, parts.map(part => Array.from({ length: part.last - part.first + 1 }, (_, i) => ({ page: part.first + i }))), (index, output) => {
      if (index + 1 < parts.length) setProgress(`Creando ${index + 2} de ${parts.length} archivos…`);
      // Desktop writes each part right away, so a large book's parts never pile up in memory.
      if (folder) { writing = writing.then(() => { signal.throwIfAborted(); return folder.write(index, output); }); writing.catch(() => {}); }
      else outputs.push(output);
    }, doc.password, signal);
    setProgress('Guardando…'); await writing; signal.throwIfAborted();
    const saved = folder?.folder ?? await savePartsZip(outputs, names, `${doc.name.replace(/\.pdf$/i, '')} — dividido.zip`, doc.nativeSource);
    if (!saved) return;
    props.onNotify?.(`${plural(parts.length, 'PDF guardado', 'PDF guardados')} en «${saved}».${withoutAnnotations ? ' Sin las anotaciones de Folio: el PDF es demasiado grande para incluirlas.' : ''}`);
    props.onClose();
  }
  async function appendSource(bytes: Uint8Array, name: string, password = '') {
    setBusy(true); setError('');
    try {
      const inspection = await inspectPdf(bytes, password);
      if (!inspection.canAssemble) throw new Error('Este PDF no permite reorganizar sus páginas.');
      const loading = getDocument({ ...pdfAssetSettings(), data: new Uint8Array(bytes), password }); previewTasks.current.push(loading);
      const preview = await loading.promise.catch(() => null);
      const source = sources.length; setSources([...sources, { bytes, password }]); setSourcePreviews([...sourcePreviews, preview]);
      insertPages(Array.from({ length: inspection.pages }, (_, i) => ({ key: crypto.randomUUID(), source, page: i + 1, label: `${name} · ${i + 1}` })));
      setPendingSource(null); setSourcePassword('');
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes('contraseña')) { setPendingSource({ bytes, name }); if (password) setError('Contraseña incorrecta.'); }
      else setError(message);
    } finally { setBusy(false); }
  }
  async function appendFile(file?: File) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { setError('El PDF supera el límite de 100 MB.'); return; }
    try { await appendSource(new Uint8Array(await file.arrayBuffer()), file.name); }
    catch (err) { setError(errorMessage(err)); }
  }
  async function unprotect() {
    // The owner password, not the one used to open the PDF, removes the encryption.
    await task(async signal => {
      const bytes = await processPdf(await props.getBytes(), { operation: 'unprotect' }, currentOwnerPassword, signal).catch(err => {
        throw new Error(/contraseña|permisos/.test(errorMessage(err)) ? 'La contraseña de propietario no es correcta.' : errorMessage(err));
      });
      signal.throwIfAborted(); await props.onReplace(bytes);
    });
  }
  async function readRoot(file?: File) {
    try {
      if (!file) return;
      if (file.size > 1024 * 1024) throw new Error('El certificado supera 1 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer()), text = new TextDecoder().decode(bytes);
      setRoots([text.includes('-----BEGIN CERTIFICATE-----') ? Uint8Array.from(atob(text.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), c => c.charCodeAt(0)) : bytes]); setRootName(file.name); setError('');
    } catch { setRoots([]); setRootName(''); setError('No se pudo leer el certificado de confianza. Elige un archivo CER o PEM válido.'); }
  }
  async function readPfx(file?: File) {
    if (!file) return;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('El certificado supera 4 MB.');
      setPfx(new Uint8Array(await file.arrayBuffer())); setPfxName(file.name); setError('');
    } catch (err) { setPfx(null); setPfxName(''); setError(errorMessage(err)); }
  }
  const titles: Record<string, string> = { home: 'Herramientas', pages: 'Organizar páginas', split: 'Dividir PDF', forms: 'Rellenar formulario', 'create-field': 'Crear campo de formulario', 'remove-image': 'Eliminar imagen', redact: 'Censurar', crop: 'Recortar página', compress: 'Comprimir PDF', security: 'Proteger PDF', sanitize: 'Eliminar datos ocultos', ocr: 'Reconocer texto (OCR)', convert: 'Convertir PDF', signatures: 'Firmas digitales', compare: 'Comparar documentos' };
  // Adding and replacing text or images happens in Editar PDF.
  const actions = [
    ['edit-pdf', 'Editar PDF', FilePenLine, doc.canEdit],
    ['pages', 'Organizar páginas', Files, doc.canAssemble], ['split', 'Dividir PDF', Scissors, doc.canAssemble], ['forms', 'Rellenar formulario', FormInput, doc.canFill],
    ['remove-image', 'Eliminar imagen', ImageMinus, doc.canEdit],
    ['crop', 'Recortar página', Crop, doc.canEdit], ['redact', 'Censurar', EyeOff, doc.canEdit],
    ['create-field', 'Crear campo', TextCursorInput, doc.canEdit], ['ocr', 'Reconocer texto (OCR)', ScanText, doc.canEdit],
    ['convert', 'Convertir PDF', FileOutput, doc.canCopy], ['compare', 'Comparar documentos', GitCompareArrows, doc.canCopy],
    ['signatures', 'Firmas digitales', Signature, true],
    // Removing the protection may need the owner password even when editing is not allowed.
    ['compress', 'Comprimir PDF', FileArchive, doc.canEdit], ['security', 'Proteger PDF', LockKeyhole, doc.canEdit || encrypted && !doc.signed],
    ['sanitize', 'Eliminar datos ocultos', ShieldCheck, doc.canEdit],
  ] as const;
  // One line on what each tool does, under its name.
  const descriptions: Record<string, string> = {
    'edit-pdf': 'Cambia textos e imágenes', pages: 'Reordena, gira, extrae o elimina', split: 'Separa en varios archivos', crop: 'Quita márgenes de una página',
    forms: 'Escribe en los campos del PDF', 'create-field': 'Añade un campo para rellenar', 'remove-image': 'Borra una imagen de la página',
    redact: 'Oculta datos de forma definitiva', ocr: 'Haz buscable un PDF escaneado', convert: 'A Word, texto o imágenes',
    compare: 'Encuentra cambios entre versiones', signatures: 'Firma o verifica firmas', compress: 'Reduce el tamaño del archivo',
    security: 'Contraseña y permisos', sanitize: 'Quita metadatos y contenido oculto',
  };
  const categories = [
    { id: 'pages', title: 'Páginas', actions: ['pages', 'split', 'crop'] },
    { id: 'content', title: 'Contenido', actions: ['edit-pdf', 'remove-image'] },
    { id: 'forms', title: 'Formularios', actions: ['forms', 'create-field'] },
    { id: 'review', title: 'Revisión y firmas', actions: ['compare', 'signatures'] },
    { id: 'export', title: 'Exportación y OCR', actions: ['convert', 'ocr', 'compress'] },
    { id: 'protection', title: 'Protección', actions: ['redact', 'security', 'sanitize'] },
  ];
  const chooseAction = (key: string) => {
    if (busy || compareBusy) return;
    setError('');
    if (key === 'edit-pdf' && props.onOpenEditor) { if (props.section === 'edit-pdf') setSection('edit-pdf'); else props.onOpenEditor(); return; }
    if (props.inline && editDraft) return;
    if (['remove-image', 'crop', 'redact', 'create-field'].includes(key)) {
      // Revisit the already selected area without remounting this form or
      // clearing its field draft. A different tool needs a new area.
      if (props.section === key && (props.area || key === 'redact')) setSection(key);
      else tool(key as Tool);
    }
    else { if (props.inline && props.onOpenSection) { props.onOpenSection(key); return; } if (key === 'compare') setCompareVisited(true); setSection(key); }
  };
  const returnToTools = () => {
    if (busy || compareBusy) return;
    const previous = section;
    setError(''); setSection('home');
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.workbench [data-tool-key="${CSS.escape(previous)}"]`)?.focus());
  };
  const planChanged = plan.length !== initialPlan.current.length || plan.some((page, index) => page.key !== initialPlan.current[index].key || (page.rotation || 0) !== (initialPlan.current[index].rotation || 0));
  const title = section === 'edit-pdf' ? 'Editar PDF' : titles[section] || 'Herramientas';
  const className = `workbench ${section === 'pages' ? 'pages-workbench' : ''}${section === 'compare' ? ' compare-workbench' : ''}${section === 'split' ? ' split-workbench' : ''}${section === 'forms' || section === 'convert' ? ' bounded-workbench' : ''}${section === 'edit-pdf' ? ' content-workbench' : ''}`;
  const formFields = fields?.filter(f => !['signature', 'button'].includes(f.type)) || [], labels = fieldLabels(formFields);
  const fieldChanges = formFields.filter(f => !f.readOnly && values[f.id] !== initialValue(f)), focused = formFields.find(f => f.id === focusedField);
  const content = <>
    {props.inline && section === 'home' && <div className="workspace-editor-heading"><h2>Herramientas</h2><button type="button" className="secondary-button" disabled={busy || editDraft} onClick={props.onClose}>Listo</button></div>}
    {props.inline && section === 'home' && editDraft && <p className="modal-description">Tienes una edición sin aplicar. Vuelve a Editar PDF para aplicarla o descartarla.</p>}
    {/* The phone editor leaves through Listo or the dialog's close button. */}
    {section !== 'home' && <div className="workbench-navigation">{props.inline && <h2 className="workspace-editor-title">Editar PDF</h2>}{(props.inline || section !== 'edit-pdf') && <button type="button" className="workbench-back secondary-button" aria-label="Volver a Herramientas" title="Volver a Herramientas" disabled={busy || compareBusy} onClick={returnToTools}><ArrowLeft size={17} aria-hidden="true" /><span className="edit-back-label">{props.inline ? 'Herramientas' : 'Volver a Herramientas'}</span></button>}{section === 'edit-pdf' && <div className="edit-pdf-history">
      <button type="button" className="secondary-button" aria-label="Deshacer" title="Deshacer" disabled={busy || editDraft || !props.canUndo} onClick={() => props.onHistory?.('undo')}><Undo2 size={15} /><span className="edit-history-label">Deshacer</span></button>
      <button type="button" className="secondary-button" aria-label="Rehacer" title="Rehacer" disabled={busy || editDraft || !props.canRedo} onClick={() => props.onHistory?.('redo')}><Redo2 size={15} /><span className="edit-history-label">Rehacer</span></button>
      {props.inline && props.onSave && <button type="button" className={'edit-pdf-save ' + (!busy && !editDraft && props.canSave ? 'primary-button' : 'secondary-button')} disabled={busy || editDraft || !props.canSave} onClick={props.onSave}><Save size={15} />{doc.drive ? 'Guardar en Drive' : isNative && (isAndroid || isDesktop) ? 'Guardar' : isNative ? 'Guardar una copia' : 'Descargar'}</button>}
      <button type="button" className="secondary-button edit-pdf-done" disabled={busy || props.inline && editDraft} onClick={props.onClose}>Listo</button>
    </div>}</div>}
    {error && <p className="operation-error" role="alert">{error}</p>}
    {section === 'home' && <div className="tool-categories">{categories.map(category => <section className="tool-category" key={category.id} aria-labelledby={`tool-category-${category.id}`}><h3 className="tool-category-heading" id={`tool-category-${category.id}`}>{category.title}</h3><div className="operation-grid">{category.actions.map(key => {
      const action = actions.find(action => action[0] === key)!;
      const [, label, Icon, enabled] = action;
      return <button type="button" key={key} data-tool-key={key} disabled={!enabled || busy || compareBusy || props.inline && editDraft && key !== 'edit-pdf'} onClick={() => chooseAction(key)} aria-label={label}><span className="tool-icon" aria-hidden="true"><Icon size={22} /></span><span className="tool-text"><span>{label}</span>{descriptions[key] && <small aria-hidden="true">{descriptions[key]}</small>}</span></button>;
    })}</div></section>)}</div>}
    {section === 'pages' && <>
      <div className="page-plan-actions">
        <label className="secondary-button"><Plus size={16} />Insertar PDF<input type="file" accept="application/pdf,.pdf" className="sr-only" disabled={busy} onChange={e => { void appendFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <button className="secondary-button" disabled={busy} onClick={() => void insertBlank()}><Plus size={16} />Página en blanco</button>
        <button title="Girar selección 90°" aria-label="Girar páginas seleccionadas" disabled={!selected.length || busy} onClick={() => setPlan(plan.map(p => selected.includes(p.key) ? { ...p, rotation: ((p.rotation || 0) + 90) % 360 } : p))}><RotateCw size={18} /></button>
        <button title="Duplicar selección" aria-label="Duplicar páginas seleccionadas" disabled={!selected.length || busy} onClick={() => setPlan(plan.flatMap(p => selected.includes(p.key) ? [p, { ...p, key: crypto.randomUUID() }] : [p]))}><Copy size={18} /></button>
        <button title="Eliminar selección" aria-label="Eliminar páginas seleccionadas" disabled={!selected.length || busy || selected.length === plan.length} onClick={() => { setPlan(plan.filter(p => !selected.includes(p.key))); setSelected([]); }}><Trash2 size={18} /></button>
        {/* Without dragging, this moves any number of selected pages in one step. */}
        {!pageDrag.enabled && <select aria-label="Mover páginas seleccionadas a la posición" value="" disabled={!selected.length || busy} onChange={e => moveSelection(Number(e.target.value))}><option value="" disabled>Mover a…</option>{Array.from({ length: plan.length - selected.length + 1 }, (_, i) => <option key={i} value={i}>Posición {i + 1}</option>)}</select>}
      </div>
      {pendingSource && <form className="security-form" onSubmit={e => { e.preventDefault(); void appendSource(pendingSource.bytes, pendingSource.name, sourcePassword); }}><label>Contraseña de {pendingSource.name}<input type="password" autoFocus data-autofocus value={sourcePassword} onChange={e => setSourcePassword(e.target.value)} /></label><div className="operation-actions"><button type="button" className="secondary-button" onClick={() => { setPendingSource(null); setSourcePassword(''); setError(''); }}>Cancelar inserción</button><button className="primary-button" disabled={busy || !sourcePassword}>Desbloquear e insertar</button></div></form>}
      {pageDrag.enabled && <p className="page-plan-drag-help" role="status" aria-live="polite">{pageDrag.draggingKeys.length ? `${pageDrag.label}${pageDrag.destinationPosition ? ` → posición ${pageDrag.destinationPosition}` : ''}. Suelta para colocar; Esc cancela.` : `Haz clic para seleccionar páginas y ${isMac ? '⇧' : 'Mayús'}+clic para un rango. Arrastra para reordenarlas.`}</p>}
      <div className={`page-plan${pageDrag.enabled ? ' drag-enabled' : ''}${pageDrag.draggingKeys.length ? ' is-dragging' : ''}`} ref={pageDrag.grid} onClickCapture={pageDrag.clickCapture} onDragStart={event => { if (pageDrag.enabled) event.preventDefault(); }}>{plan.map((p, i) => {
        const pdf = p.source == null ? doc.pdf : sourcePreviews[p.source];
        return <article key={p.key} data-plan-key={p.key} className={`${selected.includes(p.key) ? 'selected' : ''}${pageDrag.draggingKeys.includes(p.key) ? ' plan-dragging' : ''}${pageDrag.drop?.key === p.key ? ` plan-drop-${pageDrag.drop.side}` : ''}`} onPointerDown={event => pageDrag.begin(event, p.key)}>
        <label><input type="checkbox" checked={selected.includes(p.key)} disabled={busy} onChange={event => selectPage(p.key, event.nativeEvent as MouseEvent, event.target.checked)} aria-label={`Seleccionar posición ${i + 1}`} /><span>{i + 1}</span></label>
        {pageDrag.enabled && <button className="plan-drag-handle" title="Arrastrar para mover" aria-label={`Arrastrar posición ${i + 1}`} disabled={busy} tabIndex={-1}><GripVertical size={16} /></button>}
        {/* The checkbox is the accessible control; the thumbnail only mirrors it for pointers. */}
        {p.page && pdf ? <div aria-hidden="true" ref={node => { node?.querySelector('button')?.setAttribute('tabindex', '-1'); }} onClick={event => selectPage(p.key, event)}><Thumbnail pdf={pdf} number={p.page} rotation={p.rotation || 0} selected={false} onClick={() => {}} /></div> : <div className="plan-placeholder" onClick={event => selectPage(p.key, event)}><FileText size={32} /></div>}
        <span className="plan-label" title={p.label}>{p.label}</span><div className="plan-move"><button aria-label={`Mover posición ${i + 1} antes`} disabled={i === 0 || busy} onClick={() => move(i, -1)}><ArrowUp size={15} /></button><button aria-label={`Mover posición ${i + 1} después`} disabled={i === plan.length - 1 || busy} onClick={() => move(i, 1)}><ArrowDown size={15} /></button></div>
      </article>; })}</div>
      {!!pageDrag.draggingKeys.length && <div className="page-plan-drag-preview" aria-hidden="true" style={{ left: Math.max(8, Math.min(pageDrag.location.x + 16, window.innerWidth - 220)), top: Math.max(8, Math.min(pageDrag.location.y + 16, window.innerHeight - 54)) }}><Files size={17} /><span>{pageDrag.label}</span></div>}
      <div className="operation-actions page-plan-footer"><span>{plural(plan.length, 'página', 'páginas')} · {plural(selected.length, 'seleccionada', 'seleccionadas')}{planChanged ? ' · Cambios pendientes' : ''}</span><button className="secondary-button" disabled={!selected.length || busy} onClick={() => void extractSelection()}>Extraer selección</button><button className="primary-button" disabled={!planChanged || !plan.length || busy} onClick={() => void apply({ operation: 'pages', plan, sources })}>{busy ? <LoaderCircle size={16} className="spin" /> : null}Aplicar cambios</button></div>
    </>}
    {section === 'split' && <SplitPdf doc={doc} busy={busy} actionLabel={isDesktop ? 'Elegir carpeta y dividir' : isNative ? 'Dividir y guardar ZIP' : 'Dividir y descargar ZIP'} onSplit={(parts, names) => void task(signal => splitDocument(parts, names, signal))} />}
    {section === 'forms' && <div className="forms-workbench-body">
      {fields === null && !error && <p className="operation-loading"><LoaderCircle size={18} className="spin" />Leyendo campos…</p>}
      {fields?.length === 0 && <p className="modal-description">Este PDF no tiene campos de formulario.</p>}
      {/* WebKit does not focus a clicked checkbox, so pointers also pick the field to locate. */}
      <div className="form-fields">{formFields.map(f => <label key={f.id} onFocus={() => setFocusedField(f.id)} onPointerDown={() => setFocusedField(f.id)}>
        <span>{labels.get(f.id)}{f.type === 'radiobutton' && f.buttonValue ? ` · ${f.buttonValue}` : ''}<small>{f.pages.length > 1 ? 'Páginas ' + f.pages.join(', ') : 'Página ' + f.page}</small></span>
        {['checkbox', 'radiobutton'].includes(f.type) ? <input type={f.type === 'radiobutton' ? 'radio' : 'checkbox'} name={f.type === 'radiobutton' ? f.name : undefined} checked={!!values[f.id]} disabled={f.readOnly || busy} onChange={e => setValues(f.type === 'radiobutton' ? { ...values, ...Object.fromEntries(formFields.filter(other => other.type === 'radiobutton' && other.name === f.name).map(other => [other.id, other.id === f.id])) } : { ...values, [f.id]: e.target.checked })} /> :
          // A choice without a selection stays unselected unless the user picks an option.
          ['combobox', 'listbox'].includes(f.type) ? <select value={f.exportOptions.includes(String(values[f.id])) ? String(values[f.id]) : ''} disabled={f.readOnly || busy} onChange={e => setValues({ ...values, [f.id]: e.target.value })}>{!f.exportOptions.includes(f.value) && <option value="">Sin seleccionar</option>}{f.options.map((label, index) => <option key={index} value={f.exportOptions[index]}>{label}</option>)}</select> :
            f.multiline ? <textarea value={String(values[f.id] || '')} disabled={f.readOnly || busy} maxLength={f.maxLength || 100000} onChange={e => setValues({ ...values, [f.id]: e.target.value })} /> : <input value={String(values[f.id] || '')} disabled={f.readOnly || busy} maxLength={f.maxLength || 100000} onChange={e => setValues({ ...values, [f.id]: e.target.value })} />}
      </label>)}</div>
      {/* A fixed pane: a preview inside the list would move the fields while clicking them. */}
      {!!formFields.length && <div className="form-field-location" aria-hidden="true">
        {focused ? <AreaPreview key={focused.id} pdf={doc.pdf} area={focused} around={fieldContext} /> : 'Elige un campo para ver dónde está en la página.'}
      </div>}
      {!!fields?.length && <div className="forms-workbench-footer"><label className="check-option"><input type="checkbox" checked={flatten} disabled={!doc.canEdit || busy} onChange={e => setFlatten(e.target.checked)} />Convertir los campos a contenido fijo</label><div className="operation-actions"><button className="primary-button" disabled={busy || !fieldChanges.length && !flatten} onClick={() => void apply({ operation: 'fill', values: Object.fromEntries(fieldChanges.map(f => [f.id, values[f.id]])), flatten })}>Aplicar valores</button></div></div>}
    </div>}
    {props.section === 'edit-pdf' && <>
      <div className="content-editor-slot" hidden={section !== 'edit-pdf'}>
        {editSelection ? <ContentEditor key={(editSelection.item?.id || editSelection.kind + editSelection.area.rect.join(',')) + ':' + (editSelection.reset || 0)} doc={doc} area={editSelection.area} initialItem={editSelection.item} kind={editSelection.kind} active={section === 'edit-pdf'} busy={busy} getBytes={props.getBytes} onApply={apply} onCancel={() => selectEdit(null)} onReset={() => { setEditDirty(false); setEditSelection(previous => previous ? { ...previous, reset: (previous.reset || 0) + 1 } : null); }} onDirtyChange={setEditDirty} cancelLabel="Descartar edición" /> : <PdfContentPicker doc={doc} page={editPage} getBytes={props.getBytes} busy={busy} onPageChange={next => { setEditPage(next); props.onEditPageChange?.(next); }} onSelect={item => { if (item.editable) selectEdit({ kind: item.kind === 'text' ? 'replace-text' : 'replace-image', area: { page: editPage, rect: item.rect }, item }); }} onAdd={(kind, area) => selectEdit({ kind, area })} />}
      </div>
    </>}
    {['remove-image', 'crop'].includes(section) && props.area && <><AreaPreview pdf={doc.pdf} area={props.area} measure={section === 'crop'} />{props.onAreaChange && <AreaFields pdf={doc.pdf} area={props.area} disabled={busy} onChange={props.onAreaChange} />}<p className="modal-description">{section === 'crop' ? 'El recorte cambia el área visible de esta página. El contenido exterior permanece en el PDF.' : 'La parte de la imagen dentro del área quedará en blanco; el texto se conserva.'}</p><div className="operation-actions"><button className="secondary-button" disabled={busy} onClick={() => tool(section as Tool)}>Cambiar área</button><button className="primary-button" disabled={busy} onClick={() => void apply({ operation: section as 'remove-image' | 'crop', ...props.area! })}>Aplicar</button></div></>}
    {section === 'redact' && <><p className="modal-description">Se eliminarán el texto, las imágenes y los gráficos de {plural(props.redactions.length, 'área', 'áreas')}. Los formularios se convertirán a contenido fijo; se quitarán metadatos, adjuntos e índice del documento. Revisa la selección antes de aplicar.</p><div className="redaction-list">{props.redactions.map((area, index) => <span key={index}>Página {area.page} · Área {index + 1}</span>)}</div><div className="operation-actions"><button className="primary-button" disabled={busy || !props.redactions.length} onClick={() => void apply({ operation: 'redact', areas: props.redactions })}>Censurar {plural(props.redactions.length, 'área', 'áreas')}</button></div></>}
    {section === 'compress' && <><p className="modal-description">Reduce el tamaño del archivo sin perder calidad de imagen. Tamaño actual: {formatSize(doc.size)}.</p><div className="operation-actions"><button className="primary-button" disabled={busy} onClick={() => void apply({ operation: 'compress' })}>Comprimir</button></div></>}
    {section === 'sanitize' && <><p className="modal-description">Se quitarán metadatos, archivos adjuntos y acciones automáticas. El texto y las imágenes de las páginas permanecen.</p><div className="operation-actions"><button className="primary-button" disabled={busy} onClick={() => void apply({ operation: 'sanitize' })}>Eliminar datos ocultos</button></div></>}
    {section === 'security' && <>
      {encrypted && <form className="security-form" onSubmit={e => { e.preventDefault(); void unprotect(); }}>
        <p className="modal-description">Este PDF está protegido. Para quitar la contraseña y las restricciones, escribe su contraseña de propietario.</p>
        <label>Contraseña de propietario actual<input required type="password" autoComplete="current-password" maxLength={100} value={currentOwnerPassword} onChange={e => setCurrentOwnerPassword(e.target.value)} /></label>
        <div className="operation-actions"><button className={doc.canEdit ? 'secondary-button' : 'primary-button'} disabled={!currentOwnerPassword || busy}>Quitar protección</button></div>
      </form>}
      {doc.canEdit && <form className="security-form" onSubmit={e => { e.preventDefault(); if (userPassword !== confirmPassword) { setError('Las contraseñas de apertura no coinciden.'); return; } void apply({ operation: 'protect', userPassword, ownerPassword, permissions: (allowPrint ? 4 | 2048 : 0) | (allowCopy ? 16 : 0) | (allowComments ? 32 | 256 : 0) | (allowChanges ? 8 | 1024 : 0) | 512 }); }}>
        <label>Contraseña de apertura<input type="password" autoComplete="new-password" maxLength={100} value={userPassword} onChange={e => setUserPassword(e.target.value)} /></label>
        <label>Repetir contraseña de apertura<input type="password" autoComplete="new-password" maxLength={100} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></label>
        <label>Contraseña de propietario<input required type="password" autoComplete="new-password" maxLength={100} value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)} /></label>
        <label className="check-option"><input type="checkbox" checked={allowCopy} onChange={e => setAllowCopy(e.target.checked)} />Permitir copiar texto</label><label className="check-option"><input type="checkbox" checked={allowPrint} onChange={e => setAllowPrint(e.target.checked)} />Permitir imprimir</label>
        <label className="check-option"><input type="checkbox" checked={allowComments} onChange={e => setAllowComments(e.target.checked)} />Permitir comentar y rellenar formularios</label><label className="check-option"><input type="checkbox" checked={allowChanges} onChange={e => setAllowChanges(e.target.checked)} />Permitir modificar y organizar páginas</label>
        <p className="modal-description">La contraseña de apertura se pide para abrir el PDF. La de propietario permite cambiar estos permisos.</p><div className="operation-actions"><button className="primary-button" disabled={!ownerPassword || busy}>Proteger</button></div>
      </form>}
    </>}
    {section === 'create-field' && props.area && <form className="security-form" onSubmit={e => { e.preventDefault(); void apply({ operation: 'create-field', ...props.area!, name: fieldName, fieldType, options: fieldOptions.split('\n').filter(Boolean), multiline: flatten }); }}>
      <label>Nombre del campo<input required maxLength={200} value={fieldName} onChange={e => setFieldName(e.target.value)} autoFocus data-autofocus /></label>
      <label>Tipo<select value={fieldType} onChange={e => setFieldType(e.target.value as typeof fieldType)}><option value="text">Texto</option><option value="checkbox">Casilla</option><option value="combobox">Lista desplegable</option></select></label>
      {fieldType === 'text' && <label className="check-option"><input type="checkbox" checked={flatten} onChange={e => setFlatten(e.target.checked)} />Varias líneas</label>}
      {fieldType === 'combobox' && <label>Una opción por línea<textarea value={fieldOptions} onChange={e => setFieldOptions(e.target.value)} /></label>}
      {props.onAreaChange && <AreaFields pdf={doc.pdf} area={props.area} disabled={busy} onChange={props.onAreaChange} />}
      <div className="operation-actions"><button className="primary-button" disabled={!fieldName.trim() || busy}>Crear campo</button></div>
    </form>}
    {section === 'convert' && <ConversionOptions doc={doc} page={props.page} busy={busy} onConvert={(format, pages, options) => { void task(async signal => {
      const bytes = await props.getBytes();
      const output = await convertPdf(bytes, doc.pdf, doc.password, format, pages, setProgress, signal, options);
      signal.throwIfAborted(); const extension = format === 'png' ? 'zip' : format;
      if (await saveExport(output, doc.name.replace(/\.pdf$/i, '') + '.' + extension, extension, doc.nativeSource)) props.onClose();
    }); }} />}
    {section === 'ocr' && <>
      <div className="security-form"><label>Páginas<select aria-label="Páginas a procesar" value={ocrScope} onChange={e => setOcrScope(e.target.value as typeof ocrScope)} disabled={busy}><option value="current">Página actual ({props.page})</option><option value="all">Todas ({plural(doc.pdf.numPages, 'página', 'páginas')})</option><option value="range">Un intervalo o varias páginas</option></select></label>
      {ocrScope === 'range' && <label>Intervalo<input aria-label="Intervalo de páginas" value={pageRange} onChange={e => setPageRange(e.target.value)} placeholder="1-3, 6" disabled={busy} /></label>}
      <label>Idioma<select aria-label="Idioma" value={language} onChange={e => setLanguage(e.target.value as typeof language)} disabled={busy}><option value="spa+eng">Español e inglés</option><option value="spa">Español</option><option value="eng">Inglés</option></select></label></div>
      <p className="modal-description">Permite buscar y copiar el texto de las páginas escaneadas; las que ya tienen texto se omiten. Funciona sin conexión. Revisa el resultado: puede contener errores.</p>
      <div className="operation-actions"><button className="primary-button" disabled={busy} onClick={() => void task(async signal => {
        const pages = selectedPages();
        const content = await Promise.all(pages.map(async number => (await (await doc.pdf.getPage(number)).getTextContent()).items));
        // Recognizing a page that already has text would duplicate it.
        const scanned = pages.filter((_, index) => !content[index].some(item => 'str' in item && item.str.trim()));
        if (!scanned.length) throw new Error(pages.length === 1 ? 'Esta página ya tiene texto seleccionable.' : 'Las páginas elegidas ya tienen texto seleccionable.');
        await onApply(await recognizePdf(doc.pdf, scanned, language, setProgress, signal), signal);
      })}>Reconocer texto</button></div>
    </>}
    {compareVisited && <div hidden={section !== 'compare'}><CompareDocuments doc={doc} getBytes={props.getBytes} onBusyChange={setCompareBusy} /></div>}
    {section === 'signatures' && <>
      <div className="signature-results">{signatures?.length === 0 && <p className="modal-description">Este PDF no contiene firmas digitales.</p>}{signatures?.map((signature, index) => <article key={index}>
        <strong>{signature.signer || signature.field}</strong><dl><div><dt>Integridad</dt><dd>{signature.integrity ? 'Válida' : 'No válida'}</dd></div><div><dt>Documento cubierto</dt><dd>{signature.coversWholeDocument ? 'Completo' : 'Hay datos posteriores a la firma'}</dd></div><div><dt>Certificado vigente</dt><dd>{signature.certificateCurrent ? 'Sí' : 'No'}</dd></div><div><dt>Cadena de confianza</dt><dd>{signature.trustChecked ? signature.trusted ? 'Verificada con la raíz elegida' : 'No válida para la raíz elegida' : 'Sin raíz de confianza elegida'}</dd></div><div><dt>Revocación y sello de tiempo</dt><dd>No comprobados</dd></div></dl>{signature.error && <p className="operation-error">{signature.error}</p>}
      </article>)}</div>
      <FilePicker label="Raíz de confianza (.cer o .pem, opcional)" buttonText="Elegir certificado" accept=".cer,.der,.pem" selectedName={rootName} disabled={busy} resetAfterSelect onSelect={files => void readRoot(files[0])} />
      <div className="operation-actions"><button className="secondary-button" disabled={busy} onClick={() => void task(async signal => setSignatures(await checkSignatures(await props.getBytes(), doc.password, roots, signal)))}>Verificar firmas</button></div>
      {!doc.signed && encrypted && <p className="modal-description">Quita la protección del PDF antes de firmarlo.</p>}
      {!doc.signed && !encrypted && doc.canEdit && <form className="security-form signing-form" onSubmit={e => { e.preventDefault(); if (!pfx) return; void task(async signal => { const bytes = await signPdf(await props.getBytes(), pfx, pfxPassword, reason, signal, setProgress); await props.onReplace(bytes); }); }}>
        <FilePicker label="Certificado con clave privada (.p12 o .pfx)" buttonText="Elegir certificado" accept=".p12,.pfx" selectedName={pfxName} disabled={busy} resetAfterSelect onSelect={files => void readPfx(files[0])} />
        <label>Contraseña del certificado<input type="password" autoComplete="off" value={pfxPassword} onChange={e => setPfxPassword(e.target.value)} disabled={busy} /></label><label>Motivo de firma<input maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></label>
        <p className="modal-description">El certificado solo se usa para firmar; Folio no lo guarda.</p><div className="operation-actions"><button className="primary-button" disabled={!pfx || busy}>Firmar documento</button></div>
      </form>}
    </>}
    {busy && <p className="operation-loading" role="status"><LoaderCircle size={16} className="spin" />{progress || 'Procesando…'}{controller.current && <button className="text-button" onClick={() => controller.current?.abort()}>Cancelar</button>}</p>}
  </>;
  return props.inline ? <section className={`${className} workspace-editor`} aria-label="Editar PDF">{content}</section> : <Modal title={title} onClose={() => { if (!busy) props.onClose(); }} className={className}>{content}</Modal>;
}
