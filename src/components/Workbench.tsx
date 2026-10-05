import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Copy, FileImage, FileText, Files, FormInput, GripVertical, Highlighter, ImagePlus, LoaderCircle, LockKeyhole, Plus, RotateCw, ScanText, Scissors, ShieldCheck, Trash2, Type, FileOutput, Signature, GitCompareArrows, Undo2, Redo2 } from 'lucide-react';
import Modal from './Modal';
import { Thumbnail } from './PDFPage';
import { inspectPdf, processPdf, readFields } from '../engine/client';
import type { Area, Field, Operation, PageEntry, PageContentItem } from '../engine/operations.mjs';
import type { LoadedDocument, Tool } from '../types';
import { formatSize } from '../pdf';
import { recognizePdf } from '../ocr';
import { convertPdf } from '../conversion';
import { saveExport } from '../platform';
import { signPdf, checkSignatures } from '../engine/crypto-client';
import type { SignatureResult } from '../engine/signatures.mjs';
import CompareDocuments from './CompareDocuments';
import ContentEditor, { type ContentEditorKind } from './ContentEditor';
import PdfContentPicker from './PdfContentPicker';
import ConversionOptions from './ConversionOptions';
import { usePagePlanDrag } from './usePagePlanDrag';
import './Workbench.css';

type Props = { doc: LoadedDocument; section: string; page: number; inline?: boolean; documentBusy?: boolean; area: Area | null; redactions: Area[]; onClose: () => void; onSelectTool: (tool: Tool) => void; onOpenEditor?: () => void; onOpenSection?: (section: string) => void; onDraftChange?: (active: boolean) => void; onEditPageChange?: (page: number) => void; onApply: (operation: Operation, signal?: AbortSignal, context?: { keepEditing: boolean; page: number }) => Promise<void>; getBytes: () => Promise<Uint8Array>; onHistory?: (direction: 'undo' | 'redo') => void; canUndo?: boolean; canRedo?: boolean; onReplace: (bytes: Uint8Array, context?: { extraction?: { name: string; plan: PageEntry[] } }) => Promise<void> };
type PlannedPage = PageEntry & { key: string; label: string };
const entry = (page: number): PlannedPage => ({ key: crypto.randomUUID(), page, label: `Página ${page}` });
const contentKinds = ['add-text', 'replace-text', 'add-image', 'replace-image'];

export default function Workbench(props: Props) {
  const { doc, onApply, onSelectTool } = props;
  const [section, setSection] = useState(props.section);
  const [editPage, setEditPage] = useState(props.page);
  const [editSelection, setEditSelection] = useState<{ kind: ContentEditorKind; area: Area; item?: PageContentItem } | null>(null);
  useEffect(() => { props.onDraftChange?.(!!editSelection); }, [!!editSelection, props.onDraftChange]);
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
  const [pendingSource, setPendingSource] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [sourcePassword, setSourcePassword] = useState('');
  const [fields, setFields] = useState<Field[] | null>(null);
  const fieldsSource = useRef<Uint8Array | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [flatten, setFlatten] = useState(false);
  const [userPassword, setUserPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowPrint, setAllowPrint] = useState(true);
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState<'text' | 'checkbox' | 'combobox'>('text');
  const [fieldOptions, setFieldOptions] = useState('');
  const [language, setLanguage] = useState<'spa' | 'eng' | 'spa+eng'>('spa+eng');
  const [pageRange, setPageRange] = useState(String(props.page));
  const [progress, setProgress] = useState('');
  const [pfx, setPfx] = useState<Uint8Array | null>(null);
  const [pfxPassword, setPfxPassword] = useState('');
  const [reason, setReason] = useState('');
  const [signatures, setSignatures] = useState<SignatureResult[] | null>(null);
  const [roots, setRoots] = useState<Uint8Array[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => () => { pfx?.fill(0); }, [pfx]);
  useEffect(() => {
    if (selectionAnchor.current && !plan.some(page => page.key === selectionAnchor.current)) selectionAnchor.current = null;
  }, [plan]);

  useEffect(() => {
    if (section !== 'forms' || fieldsSource.current === doc.bytes) return;
    const controller = new AbortController(); setError('');
    void readFields(doc.bytes, doc.password, controller.signal).then(items => {
      if (controller.signal.aborted) return;
      fieldsSource.current = doc.bytes;
      setFields(items); setValues(Object.fromEntries(items.map(f => [f.id, ['checkbox', 'radiobutton'].includes(f.type) ? f.checked : f.value])));
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [section, doc.bytes, doc.password]);

  async function apply(operation: Operation) {
    await task(signal => onApply(operation, signal, section === 'edit-pdf' ? { keepEditing: true, page: editPage } : undefined));
  }
  function selectedPages(): number[] {
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
    catch (err) { if (!controller.current.signal.aborted) setError((err as Error).message); }
    finally { setBusy(false); setProgress(''); }
  }
  function tool(tool: Tool) { onSelectTool(tool); }
  function move(index: number, delta: number) {
    const next = [...plan], target = index + delta; if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; setPlan(next);
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
  async function appendSource(bytes: Uint8Array, name: string, password = '') {
    setBusy(true); setError('');
    try {
      const inspection = await inspectPdf(bytes, password);
      if (!inspection.canAssemble) throw new Error('Este PDF no permite reorganizar sus páginas.');
      const source = sources.length; setSources([...sources, { bytes, password }]);
      setPlan([...plan, ...Array.from({ length: inspection.pages }, (_, i) => ({ key: crypto.randomUUID(), source, page: i + 1, label: `${name} · ${i + 1}` }))]);
      setPendingSource(null); setSourcePassword('');
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('contraseña')) { setPendingSource({ bytes, name }); if (password) setError('Contraseña incorrecta.'); }
      else setError(message);
    } finally { setBusy(false); }
  }
  async function appendFile(file?: File) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { setError('El límite es de 100 MiB por PDF.'); return; }
    try { await appendSource(new Uint8Array(await file.arrayBuffer()), file.name); }
    catch (err) { setError((err as Error).message); }
  }
  async function readRoot(file?: File) {
    try {
      if (!file) return;
      if (file.size > 1024 * 1024) throw new Error('El certificado supera 1 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer()), text = new TextDecoder().decode(bytes);
      setRoots([text.includes('-----BEGIN CERTIFICATE-----') ? Uint8Array.from(atob(text.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), c => c.charCodeAt(0)) : bytes]); setError('');
    } catch { setRoots([]); setError('No se pudo leer el certificado de confianza. Elige un archivo CER o PEM válido.'); }
  }
  async function readPfx(file?: File) {
    if (!file) return;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('El certificado supera 4 MiB.');
      setPfx(new Uint8Array(await file.arrayBuffer())); setError('');
    } catch (err) { setPfx(null); setError((err as Error).message); }
  }
  const titles: Record<string, string> = { home: 'Herramientas', pages: 'Organizar páginas', forms: 'Rellenar formulario', 'create-field': 'Crear campo de formulario', 'add-text': 'Añadir texto', 'replace-text': 'Reemplazar texto', 'add-image': 'Añadir imagen', 'replace-image': 'Reemplazar imagen', 'remove-image': 'Eliminar imagen', redact: 'Aplicar censura', crop: 'Recortar página', compress: 'Comprimir PDF', security: 'Proteger PDF', sanitize: 'Eliminar datos ocultos', ocr: 'Reconocer texto (OCR)', convert: 'Convertir PDF', signatures: 'Firmas digitales', compare: 'Comparar documentos' };
  const actions = [
    ['edit-pdf', 'Editar PDF', Type, doc.canEdit],
    ['pages', 'Organizar páginas', Files, doc.canAssemble], ['forms', 'Rellenar formulario', FormInput, doc.canFill],
    ['add-text', 'Añadir texto', Type, doc.canEdit], ['replace-text', 'Reemplazar texto', FileText, doc.canEdit],
    ['add-image', 'Añadir imagen', ImagePlus, doc.canEdit], ['remove-image', 'Eliminar imagen', FileImage, doc.canEdit],
    ['replace-image', 'Reemplazar imagen', FileImage, doc.canEdit],
    ['crop', 'Recortar página', Scissors, doc.canEdit], ['redact', 'Censurar contenido', Highlighter, doc.canEdit],
    ['create-field', 'Crear campo', FormInput, doc.canEdit], ['ocr', 'Reconocer texto (OCR)', ScanText, doc.canEdit],
    ['convert', 'Convertir PDF', FileOutput, doc.canCopy], ['compare', 'Comparar documentos', GitCompareArrows, doc.canCopy],
    ['signatures', 'Firmas digitales', Signature, true],
    ['compress', 'Comprimir PDF', Files, doc.canEdit], ['security', 'Proteger PDF', LockKeyhole, doc.canEdit],
    ['sanitize', 'Eliminar datos ocultos', ShieldCheck, doc.canEdit],
  ] as const;
  const categories = [
    { id: 'pages', title: 'Páginas', actions: ['pages', 'crop'] },
    { id: 'content', title: 'Contenido', actions: ['edit-pdf', 'add-text', 'replace-text', 'add-image', 'replace-image', 'remove-image'] },
    { id: 'forms', title: 'Formularios', actions: ['forms', 'create-field'] },
    { id: 'review', title: 'Revisión y firmas', actions: ['compare', 'signatures'] },
    { id: 'export', title: 'Exportación y OCR', actions: ['convert', 'ocr', 'compress'] },
    { id: 'protection', title: 'Protección', actions: ['redact', 'security', 'sanitize'] },
  ];
  const chooseAction = (key: string) => {
    if (busy || compareBusy) return;
    setError('');
    if (key === 'edit-pdf' && props.onOpenEditor) { if (props.section === 'edit-pdf') setSection('edit-pdf'); else props.onOpenEditor(); return; }
    if (props.inline && editSelection) return;
    if (['add-text', 'replace-text', 'add-image', 'replace-image', 'remove-image', 'crop', 'redact', 'create-field'].includes(key)) {
      // Revisit the already selected area without remounting this form or
      // clearing its text/image/field draft. A different tool needs a new area.
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
  const className = `workbench ${section === 'pages' ? 'pages-workbench' : ''}${section === 'compare' ? ' compare-workbench' : ''}${section === 'forms' || section === 'convert' ? ' bounded-workbench' : ''}${section === 'edit-pdf' || contentKinds.includes(section) && props.area ? ' content-workbench' : ''}`;
  const content = <>
    {props.inline && section === 'home' && <div className="workspace-editor-heading"><h2>Herramientas</h2><button type="button" className="secondary-button" disabled={busy || !!editSelection} onClick={props.onClose}>Listo</button></div>}
    {props.inline && section === 'home' && editSelection && <p className="modal-description">Tienes un borrador de edición. Vuelve a Editar PDF para aplicarlo o descartarlo.</p>}
    {section !== 'home' && <div className="workbench-navigation">{props.inline && <h2 className="workspace-editor-title">Editar PDF</h2>}<button type="button" className="workbench-back secondary-button" disabled={busy || compareBusy} onClick={returnToTools}><ArrowLeft size={17} aria-hidden="true" />Volver a Herramientas</button>{section === 'edit-pdf' && <div className="edit-pdf-history">
      <button type="button" className="secondary-button" disabled={busy || !!editSelection || !props.canUndo} onClick={() => props.onHistory?.('undo')}><Undo2 size={15} />Deshacer</button>
      <button type="button" className="secondary-button" disabled={busy || !!editSelection || !props.canRedo} onClick={() => props.onHistory?.('redo')}><Redo2 size={15} />Rehacer</button>
      <button type="button" className="secondary-button edit-pdf-done" disabled={busy || props.inline && !!editSelection} onClick={props.onClose}>Listo</button>
    </div>}</div>}
    {error && <p className="operation-error" role="alert">{error}</p>}
    {section === 'home' && <div className="tool-categories">{categories.map(category => <section className="tool-category" key={category.id} aria-labelledby={`tool-category-${category.id}`}><h3 className="tool-category-heading" id={`tool-category-${category.id}`}>{category.title}</h3><div className="operation-grid">{category.actions.map(key => {
      const action = actions.find(action => action[0] === key)!;
      const [, label, Icon, enabled] = action;
      return <button type="button" key={key} data-tool-key={key} disabled={!enabled || busy || compareBusy || props.inline && !!editSelection && key !== 'edit-pdf'} onClick={() => chooseAction(key)}><Icon size={24} aria-hidden="true" /><span>{label}</span></button>;
    })}</div></section>)}</div>}
    {section === 'pages' && <>
      <div className="page-plan-actions">
        <label className="secondary-button"><Plus size={16} />Insertar PDF<input type="file" accept="application/pdf,.pdf" className="sr-only" disabled={busy} onChange={e => { void appendFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <button className="secondary-button" disabled={busy} onClick={() => setPlan([...plan, { key: crypto.randomUUID(), blank: [595, 842], label: 'Página en blanco' }])}><Plus size={16} />Página en blanco</button>
        <button title="Girar selección 90°" aria-label="Girar páginas seleccionadas" disabled={!selected.length || busy} onClick={() => setPlan(plan.map(p => selected.includes(p.key) ? { ...p, rotation: ((p.rotation || 0) + 90) % 360 } : p))}><RotateCw size={18} /></button>
        <button title="Duplicar selección" aria-label="Duplicar páginas seleccionadas" disabled={!selected.length || busy} onClick={() => setPlan(plan.flatMap(p => selected.includes(p.key) ? [p, { ...p, key: crypto.randomUUID() }] : [p]))}><Copy size={18} /></button>
        <button title="Eliminar selección" aria-label="Eliminar páginas seleccionadas" disabled={!selected.length || busy || selected.length === plan.length} onClick={() => { setPlan(plan.filter(p => !selected.includes(p.key))); setSelected([]); }}><Trash2 size={18} /></button>
      </div>
      {pendingSource && <form className="security-form" onSubmit={e => { e.preventDefault(); void appendSource(pendingSource.bytes, pendingSource.name, sourcePassword); }}><label>Contraseña de {pendingSource.name}<input type="password" autoFocus value={sourcePassword} onChange={e => setSourcePassword(e.target.value)} /></label><div className="operation-actions"><button type="button" className="secondary-button" onClick={() => { setPendingSource(null); setSourcePassword(''); setError(''); }}>Cancelar inserción</button><button className="primary-button" disabled={busy || !sourcePassword}>Desbloquear e insertar</button></div></form>}
      {pageDrag.enabled && <p className="page-plan-drag-help" role="status" aria-live="polite">{pageDrag.draggingKeys.length ? `${pageDrag.label}${pageDrag.destinationPosition ? ` → posición ${pageDrag.destinationPosition}` : ''}. Suelta para colocar; Esc cancela.` : 'Arrastra para reordenar. Ctrl+clic añade páginas; Shift+clic selecciona un rango.'}</p>}
      <div className={`page-plan${pageDrag.enabled ? ' drag-enabled' : ''}${pageDrag.draggingKeys.length ? ' is-dragging' : ''}`} ref={pageDrag.grid} onClickCapture={pageDrag.clickCapture} onDragStart={event => { if (pageDrag.enabled) event.preventDefault(); }}>{plan.map((p, i) => <article key={p.key} data-plan-key={p.key} className={`${selected.includes(p.key) ? 'selected' : ''}${pageDrag.draggingKeys.includes(p.key) ? ' plan-dragging' : ''}${pageDrag.drop?.key === p.key ? ` plan-drop-${pageDrag.drop.side}` : ''}`} onPointerDown={event => pageDrag.begin(event, p.key)}>
        <label><input type="checkbox" checked={selected.includes(p.key)} disabled={busy} onChange={event => selectPage(p.key, event.nativeEvent as MouseEvent, event.target.checked)} aria-label={`Seleccionar posición ${i + 1}`} /><span>{i + 1}</span></label>
        {pageDrag.enabled && <button className="plan-drag-handle" title="Arrastrar para mover" aria-label={`Arrastrar posición ${i + 1}`} disabled={busy} tabIndex={-1}><GripVertical size={16} /></button>}
        {p.page && p.source == null ? <div style={{ transform: `rotate(${p.rotation || 0}deg)` }} onClick={event => selectPage(p.key, event)}><Thumbnail pdf={doc.pdf} number={p.page} selected={false} onClick={() => {}} /></div> : <div className="plan-placeholder" onClick={event => selectPage(p.key, event)}><FileText size={32} /></div>}
        <span className="plan-label" title={p.label}>{p.label}</span><div className="plan-move"><button aria-label={`Mover posición ${i + 1} antes`} disabled={i === 0 || busy} onClick={() => move(i, -1)}><ArrowUp size={15} /></button><button aria-label={`Mover posición ${i + 1} después`} disabled={i === plan.length - 1 || busy} onClick={() => move(i, 1)}><ArrowDown size={15} /></button></div>
      </article>)}</div>
      {!!pageDrag.draggingKeys.length && <div className="page-plan-drag-preview" aria-hidden="true" style={{ left: Math.max(8, Math.min(pageDrag.location.x + 16, window.innerWidth - 220)), top: Math.max(8, Math.min(pageDrag.location.y + 16, window.innerHeight - 54)) }}><Files size={17} /><span>{pageDrag.label}</span></div>}
      <div className="operation-actions page-plan-footer"><span>{plan.length} páginas · {selected.length} seleccionadas{planChanged ? ' · Cambios pendientes' : ''}</span><button className="secondary-button" disabled={!selected.length || busy} onClick={() => void extractSelection()}>Extraer selección</button><button className="primary-button" disabled={!planChanged || !plan.length || busy} onClick={() => void apply({ operation: 'pages', plan, sources })}>{busy ? <LoaderCircle size={16} className="spin" /> : null}Aplicar cambios</button></div>
    </>}
    {section === 'forms' && <div className="forms-workbench-body">
      {fields === null && !error && <p className="operation-loading"><LoaderCircle size={18} className="spin" />Leyendo campos…</p>}
      {fields?.length === 0 && <p className="modal-description">Este PDF no tiene campos de formulario.</p>}
      <div className="form-fields">{fields?.filter(f => !['signature', 'button'].includes(f.type)).map(f => <label key={f.id}>
        <span>{f.label}{f.type === 'radiobutton' && f.buttonValue ? ` · ${f.buttonValue}` : ''}<small>Página {f.page}</small></span>
        {['checkbox', 'radiobutton'].includes(f.type) ? <input type={f.type === 'radiobutton' ? 'radio' : 'checkbox'} name={f.type === 'radiobutton' ? f.name : undefined} checked={!!values[f.id]} disabled={f.readOnly || busy} onChange={e => setValues(f.type === 'radiobutton' ? { ...values, ...Object.fromEntries(fields.filter(other => other.type === 'radiobutton' && other.name === f.name).map(other => [other.id, other.id === f.id])) } : { ...values, [f.id]: e.target.checked })} /> :
          f.options.length ? <select value={String(values[f.id] || '')} disabled={f.readOnly || busy} onChange={e => setValues({ ...values, [f.id]: e.target.value })}>{f.options.map((label, index) => <option key={index} value={f.exportOptions[index]}>{label}</option>)}</select> :
            f.multiline ? <textarea value={String(values[f.id] || '')} disabled={f.readOnly || busy} maxLength={f.maxLength || 100000} onChange={e => setValues({ ...values, [f.id]: e.target.value })} /> : <input value={String(values[f.id] || '')} disabled={f.readOnly || busy} maxLength={f.maxLength || 100000} onChange={e => setValues({ ...values, [f.id]: e.target.value })} />}
      </label>)}</div>
      {!!fields?.length && <div className="forms-workbench-footer"><label className="check-option"><input type="checkbox" checked={flatten} disabled={!doc.canEdit || busy} onChange={e => setFlatten(e.target.checked)} />Convertir los campos a contenido fijo</label><div className="operation-actions"><button className="primary-button" disabled={busy} onClick={() => void apply({ operation: 'fill', values: Object.fromEntries(fields.filter(f => !f.readOnly && !['signature', 'button'].includes(f.type)).map(f => [f.id, values[f.id]])), flatten })}>Aplicar valores</button></div></div>}
    </div>}
    {props.section === 'edit-pdf' && <>
      <div className="content-editor-slot" hidden={section !== 'edit-pdf'}>
        {editSelection ? <ContentEditor key={editSelection.item?.id || editSelection.kind + editSelection.area.rect.join(',')} doc={doc} area={editSelection.area} initialItem={editSelection.item} kind={editSelection.kind} active={section === 'edit-pdf'} busy={busy} getBytes={props.getBytes} onApply={apply} onCancel={() => setEditSelection(null)} cancelLabel="Descartar borrador" /> : <PdfContentPicker doc={doc} page={editPage} getBytes={props.getBytes} busy={busy} onPageChange={next => { setEditPage(next); props.onEditPageChange?.(next); }} onSelect={item => { if (item.editable) setEditSelection({ kind: item.kind === 'text' ? 'replace-text' : 'replace-image', area: { page: editPage, rect: item.rect }, item }); }} onAdd={(kind, area) => setEditSelection({ kind, area })} />}
      </div>
    </>}
    {contentKinds.includes(props.section) && props.area && <div className="content-editor-slot" hidden={section !== props.section}><ContentEditor doc={doc} area={props.area} kind={props.section as ContentEditorKind} active={section === props.section} busy={busy} getBytes={props.getBytes} onApply={apply} onCancel={props.onClose} /></div>}
    {['remove-image', 'crop'].includes(section) && props.area && <><p className="modal-description">{section === 'crop' ? 'El recorte cambia el área visible de esta página. El contenido exterior permanece en el PDF.' : 'Se eliminan los píxeles de imágenes dentro del área seleccionada; el texto permanece.'}</p><div className="operation-actions"><button className="primary-button" disabled={busy} onClick={() => void apply({ operation: section as 'remove-image' | 'crop', ...props.area! })}>Aplicar</button></div></>}
    {section === 'redact' && <><p className="modal-description">Se eliminarán el texto, las imágenes y los gráficos de {props.redactions.length} áreas. Los formularios se convertirán a contenido fijo; se quitarán metadatos, adjuntos e índice del documento. Revisa la selección antes de aplicar.</p><div className="redaction-list">{props.redactions.map((area, index) => <span key={index}>Página {area.page} · Área {index + 1}</span>)}</div><div className="operation-actions"><button className="primary-button" disabled={busy || !props.redactions.length} onClick={() => void apply({ operation: 'redact', areas: props.redactions })}>Eliminar contenido seleccionado</button></div></>}
    {section === 'compress' && <><p className="modal-description">Optimiza objetos y comprime streams sin reducir la calidad de las imágenes. Tamaño actual: {formatSize(doc.size)}.</p><div className="operation-actions"><button className="primary-button" disabled={busy} onClick={() => void apply({ operation: 'compress' })}>Optimizar PDF</button></div></>}
    {section === 'sanitize' && <><p className="modal-description">Se quitarán metadatos, archivos adjuntos y acciones automáticas. El texto y las imágenes de las páginas permanecen.</p><div className="operation-actions"><button className="primary-button" disabled={busy} onClick={() => void apply({ operation: 'sanitize' })}>Eliminar datos ocultos</button></div></>}
    {section === 'security' && <form className="security-form" onSubmit={e => { e.preventDefault(); if (userPassword !== confirmPassword) { setError('Las contraseñas de apertura no coinciden.'); return; } void apply({ operation: 'protect', userPassword, ownerPassword, permissions: (allowPrint ? 4 | 2048 : 0) | (allowCopy ? 16 : 0) | 512 }); }}>
      <label>Contraseña de apertura<input type="password" autoComplete="new-password" maxLength={100} value={userPassword} onChange={e => setUserPassword(e.target.value)} /></label>
      <label>Repetir contraseña de apertura<input type="password" autoComplete="new-password" maxLength={100} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></label>
      <label>Contraseña de propietario<input required type="password" autoComplete="new-password" maxLength={100} value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)} /></label>
      <label className="check-option"><input type="checkbox" checked={allowCopy} onChange={e => setAllowCopy(e.target.checked)} />Permitir copiar texto</label><label className="check-option"><input type="checkbox" checked={allowPrint} onChange={e => setAllowPrint(e.target.checked)} />Permitir imprimir</label>
      <p className="modal-description">La contraseña de propietario permite editar y quitar restricciones. Los permisos dependen del lector; la contraseña de apertura cifra el archivo.</p><div className="operation-actions"><button className="primary-button" disabled={!ownerPassword || busy}>Aplicar protección AES-256</button></div>
      <button type="button" className="text-button" disabled={busy} onClick={() => void apply({ operation: 'unprotect' })}>Quitar protección con contraseña de propietario</button>
    </form>}
    {section === 'create-field' && props.area && <form className="security-form" onSubmit={e => { e.preventDefault(); void apply({ operation: 'create-field', ...props.area!, name: fieldName, fieldType, options: fieldOptions.split('\n').filter(Boolean), multiline: flatten }); }}>
      <label>Nombre del campo<input required maxLength={200} value={fieldName} onChange={e => setFieldName(e.target.value)} autoFocus /></label>
      <label>Tipo<select value={fieldType} onChange={e => setFieldType(e.target.value as typeof fieldType)}><option value="text">Texto</option><option value="checkbox">Casilla</option><option value="combobox">Lista desplegable</option></select></label>
      {fieldType === 'text' && <label className="check-option"><input type="checkbox" checked={flatten} onChange={e => setFlatten(e.target.checked)} />Varias líneas</label>}
      {fieldType === 'combobox' && <label>Una opción por línea<textarea value={fieldOptions} onChange={e => setFieldOptions(e.target.value)} /></label>}
      <div className="operation-actions"><button className="primary-button" disabled={!fieldName.trim() || busy}>Crear campo</button></div>
    </form>}
    {section === 'convert' && <ConversionOptions doc={doc} page={props.page} busy={busy} onConvert={(format, pages, options) => { void task(async signal => {
      const bytes = await props.getBytes();
      const output = await convertPdf(bytes, doc.pdf, doc.password, format, pages, setProgress, signal, options);
      signal.throwIfAborted(); const extension = format === 'png' ? 'zip' : format;
      if (await saveExport(output, doc.name.replace(/\.pdf$/i, '') + '.' + extension, extension, doc.nativeSource)) props.onClose();
    }); }} />}
    {section === 'ocr' && <>
      <div className="security-form"><label>Páginas<input aria-label="Páginas a procesar" value={pageRange} onChange={e => setPageRange(e.target.value)} placeholder={`1-${doc.pdf.numPages}`} disabled={busy} /></label>
      <label>Idioma<select aria-label="Idioma" value={language} onChange={e => setLanguage(e.target.value as typeof language)} disabled={busy}><option value="spa+eng">Español e inglés</option><option value="spa">Español</option><option value="eng">Inglés</option></select></label></div>
      <p className="modal-description">Añade texto seleccionable a las páginas escaneadas. El reconocimiento se procesa aquí, sin conexión. Revisa los errores del OCR antes de usar el texto.</p>
      <div className="operation-actions"><button className="primary-button" disabled={busy} onClick={() => void task(async signal => {
        const pages = selectedPages();
          const content = await Promise.all(pages.map(async number => (await (await doc.pdf.getPage(number)).getTextContent()).items));
          if (content.some(items => items.length > 0)) throw new Error('La selección ya contiene texto. Elige páginas escaneadas para evitar duplicarlo.');
          await onApply(await recognizePdf(doc.pdf, pages, language, setProgress, signal), signal);
      })}>Reconocer texto</button></div>
    </>}
    {compareVisited && <div hidden={section !== 'compare'}><CompareDocuments doc={doc} getBytes={props.getBytes} onBusyChange={setCompareBusy} /></div>}
    {section === 'signatures' && <>
      <div className="signature-results">{signatures?.length === 0 && <p className="modal-description">Este PDF no contiene firmas digitales.</p>}{signatures?.map((signature, index) => <article key={index}>
        <strong>{signature.signer || signature.field}</strong><dl><div><dt>Integridad</dt><dd>{signature.integrity ? 'Válida' : 'No válida'}</dd></div><div><dt>Documento cubierto</dt><dd>{signature.coversWholeDocument ? 'Completo' : 'Hay datos posteriores a la firma'}</dd></div><div><dt>Certificado vigente</dt><dd>{signature.certificateCurrent ? 'Sí' : 'No'}</dd></div><div><dt>Cadena de confianza</dt><dd>{signature.trustChecked ? signature.trusted ? 'Verificada con la raíz elegida' : 'No válida para la raíz elegida' : 'Sin raíz de confianza elegida'}</dd></div><div><dt>Revocación y sello de tiempo</dt><dd>No comprobados</dd></div></dl>{signature.error && <p className="operation-error">{signature.error}</p>}
      </article>)}</div>
      <label className="file-choice">Raíz de confianza (.cer o .pem, opcional)<input type="file" accept=".cer,.der,.pem" disabled={busy} onChange={e => void readRoot(e.target.files?.[0])} /></label>
      <div className="operation-actions"><button className="secondary-button" disabled={busy} onClick={() => void task(async signal => setSignatures(await checkSignatures(await props.getBytes(), doc.password, roots, signal)))}>Verificar firmas</button></div>
      {!doc.signed && doc.canEdit && <form className="security-form signing-form" onSubmit={e => { e.preventDefault(); if (!pfx) return; void task(async signal => { const bytes = await signPdf(await props.getBytes(), pfx, pfxPassword, reason, signal, setProgress); await props.onReplace(bytes); }); }}>
        <label>Certificado con clave privada (.p12 o .pfx)<input type="file" accept=".p12,.pfx" disabled={busy} onChange={e => void readPfx(e.target.files?.[0])} /></label>
        <label>Contraseña del certificado<input type="password" autoComplete="off" value={pfxPassword} onChange={e => setPfxPassword(e.target.value)} disabled={busy} /></label><label>Motivo de firma<input maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></label>
        <p className="modal-description">Firma RSA/SHA-256. El certificado se usa durante la operación y no se guarda en Folio. Los PDF cifrados requieren quitar su protección con la contraseña de propietario antes de firmar.</p><div className="operation-actions"><button className="primary-button" disabled={!pfx || busy}>Firmar documento</button></div>
      </form>}
    </>}
    {busy && <p className="operation-loading" role="status"><LoaderCircle size={16} className="spin" />{progress || 'Procesando…'}{controller.current && <button className="text-button" onClick={() => controller.current?.abort()}>Cancelar</button>}</p>}
  </>;
  return props.inline ? <section className={`${className} workspace-editor`} aria-label="Editar PDF">{content}</section> : <Modal title={title} onClose={() => { if (!busy) props.onClose(); }} className={className}>{content}</Modal>;
}
