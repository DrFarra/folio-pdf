import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Layers, ListOrdered, LoaderCircle, Scissors } from 'lucide-react';
import type { LoadedDocument } from '../types';
import { plural, readOutline } from '../pdf';
import { chapterParts, defaultNames, equalParts, everyParts, fileNames, pagesLabel, rangeParts, type OutlineItem, type Part } from '../split';
import { NumberField } from './ContentEditor';
import { Thumbnail } from './PDFPage';
import './SplitPdf.css';

type Mode = 'ranges' | 'blocks' | 'chapters';
type Props = { doc: LoadedDocument; busy: boolean; actionLabel: string; onSplit: (parts: Part[], names: string[]) => void };
// ponytail: only the first cards render; thousands of thumbnails would slow a large book down. Page through them if users ask.
const PREVIEW = 60;
const levelNames = ['Capítulos', 'Secciones', 'Subsecciones'];

export default function SplitPdf({ doc, busy, actionLabel, onSplit }: Props) {
  const total = doc.pdf.numPages, half = Math.ceil(total / 2);
  const [mode, setMode] = useState<Mode>('ranges');
  const [ranges, setRanges] = useState(total > 1 ? `1-${half}, ${half + 1}-` : '1');
  const [blockKind, setBlockKind] = useState<'every' | 'equal'>('every');
  const [every, setEvery] = useState(Math.max(1, Math.min(10, half)));
  const [pieces, setPieces] = useState(Math.min(2, total));
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [depth, setDepth] = useState(0);
  const [edited, setEdited] = useState<Record<number, string>>({});
  useEffect(() => {
    let alive = true;
    void readOutline(doc.pdf).then(items => { if (alive) setOutline(items); }, () => { if (alive) setOutline([]); });
    return () => { alive = false; };
  }, [doc.pdf]);
  // Outline levels worth offering: at least two parts, and more than the level above.
  const levels = useMemo(() => {
    const counts = levelNames.map((_, level) => chapterParts(outline || [], level, total).length);
    return counts.flatMap((count, level) => count > 1 && (level === 0 || count > counts[level - 1]) ? [{ level, count }] : []);
  }, [outline, total]);
  const hasChapters = levels.length > 0;
  // A book whose outline has one root ("Contenido") starts at its chapters.
  useEffect(() => { if (levels.length && !levels.some(item => item.level === depth)) setDepth(levels[0].level); }, [levels, depth]);
  const plan = useMemo(() => {
    try {
      if (mode === 'ranges') return { error: '', ...rangeParts(ranges, total) };
      if (mode === 'blocks') return { error: '', skipped: '', parts: blockKind === 'every' ? everyParts(every, total) : equalParts(pieces, total) };
      return { error: '', skipped: '', parts: chapterParts(outline || [], depth, total) };
    } catch (error) { return { error: (error as Error).message, skipped: '', parts: [] as Part[] }; }
  }, [mode, ranges, blockKind, every, pieces, outline, depth, total]);
  const base = doc.name.replace(/\.pdf$/i, '');
  const defaults = useMemo(() => defaultNames(base, plan.parts, mode === 'chapters'), [base, plan.parts, mode]);
  // A different division starts from the suggested names again.
  useEffect(() => setEdited({}), [plan.parts]);
  const stem = (index: number) => edited[index] ?? defaults[index].replace(/\.pdf$/i, '');
  const pages = plan.parts.reduce((sum, part) => sum + part.last - part.first + 1, 0);
  const ready = !busy && !plan.error && plan.parts.length > 0;
  const choose = (next: Mode) => { if (!busy) setMode(next); };
  const modes: [Mode, string, string, typeof ListOrdered, boolean][] = [
    ['ranges', 'Intervalos', 'Un archivo por intervalo', ListOrdered, true],
    ['blocks', 'Cada N páginas', 'Bloques fijos o partes iguales', Layers, total > 1],
    ['chapters', 'Capítulos', outline === null ? 'Leyendo el índice…' : hasChapters ? 'Un archivo por capítulo del índice' : 'Este PDF no tiene índice', BookOpen, hasChapters],
  ];

  return <div className="split-pdf">
    <div className="split-options">
      <div className="split-modes" role="radiogroup" aria-label="Cómo dividir">
        {modes.map(([key, label, hint, Icon, enabled]) => <button type="button" key={key} role="radio" aria-checked={mode === key} disabled={busy || !enabled} className={`split-mode${mode === key ? ' active' : ''}`} onClick={() => choose(key)}>
          <Icon size={19} aria-hidden="true" /><span><strong>{label}</strong><small>{hint}</small></span>
        </button>)}
      </div>
      <div className="split-settings">
        {mode === 'ranges' && <>
          <label>Intervalos<input aria-label="Intervalos de páginas" value={ranges} disabled={busy} spellCheck={false} placeholder="1-5, 6-12, 13-" onChange={event => setRanges(event.target.value)} /></label>
          <p className="split-hint">Separa los intervalos con comas. «13-» llega hasta la última página ({total}).</p>
          <div className="split-shortcuts">
            <button type="button" className="secondary-button" disabled={busy || total < 2} onClick={() => { setMode('blocks'); setBlockKind('every'); setEvery(1); }}>Una página por archivo</button>
            <button type="button" className="secondary-button" disabled={busy || total < 2} onClick={() => { setMode('blocks'); setBlockKind('equal'); setPieces(2); }}>Por la mitad</button>
          </div>
        </>}
        {mode === 'blocks' && <>
          <div className="split-choice" role="radiogroup" aria-label="Tipo de bloque">
            {([['every', 'Cada N páginas'], ['equal', 'Partes iguales']] as const).map(([key, label]) => <button type="button" key={key} role="radio" aria-checked={blockKind === key} disabled={busy} onClick={() => setBlockKind(key)}>{label}</button>)}
          </div>
          {blockKind === 'every'
            ? <label>Páginas por archivo<NumberField aria-label="Páginas por archivo" min={1} max={total} step={1} disabled={busy} value={every} onValue={value => setEvery(Math.round(value))} /></label>
            : <label>Número de archivos<NumberField aria-label="Número de archivos" min={1} max={total} step={1} disabled={busy} value={pieces} onValue={value => setPieces(Math.round(value))} /></label>}
        </>}
        {mode === 'chapters' && <>
          {levels.length > 1 && <label>Nivel del índice<select aria-label="Nivel del índice" value={depth} disabled={busy} onChange={event => setDepth(Number(event.target.value))}>{levels.map(({ level, count }) => <option key={level} value={level}>{levelNames[level]} ({count})</option>)}</select></label>}
          <p className="split-hint">Cada archivo empieza en un marcador del índice y termina antes del siguiente. Las páginas anteriores al primero forman «Preliminares».</p>
        </>}
        {plan.error && <p className="split-problem" role="alert">{plan.error}</p>}
        {!plan.error && plan.skipped && <p className="split-note" role="status">No se incluirán las páginas {plan.skipped}.</p>}
      </div>
    </div>

    <section className="split-preview" aria-label="Archivos resultantes">
      <header><Scissors size={15} aria-hidden="true" /><span>{plan.parts.length ? `${plural(plan.parts.length, 'archivo', 'archivos')} · ${plural(pages, 'página', 'páginas')}` : 'Sin archivos'}</span></header>
      <ol className="split-parts">{plan.parts.slice(0, PREVIEW).map((part, index) => <li key={`${part.first}-${part.last}-${index}`} className="split-part">
        <div className="split-thumb" aria-hidden="true" ref={node => { node?.querySelector('button')?.setAttribute('tabindex', '-1'); }}>
          <Thumbnail pdf={doc.pdf} number={part.first} selected={false} onClick={() => {}} />
          <span className="split-index">{index + 1}</span>
        </div>
        <div className="split-part-body">
          <span className="split-name"><input aria-label={`Nombre del archivo ${index + 1}`} title={stem(index)} value={stem(index)} disabled={busy} maxLength={120} spellCheck={false} onChange={event => setEdited(names => ({ ...names, [index]: event.target.value }))} /><span aria-hidden="true">.pdf</span></span>
          <small>{pagesLabel(part)} · {plural(part.last - part.first + 1, 'página', 'páginas')}</small>
        </div>
      </li>)}</ol>
      {plan.parts.length > PREVIEW && <p className="split-more">y {plural(plan.parts.length - PREVIEW, 'archivo más', 'archivos más')}, con los nombres sugeridos</p>}
    </section>

    <div className="operation-actions split-actions">
      <span>{plan.parts.length > 1 ? 'Folio no modifica el documento original.' : plan.parts.length === 1 ? 'Solo se creará un archivo.' : ''}</span>
      <button type="button" className="primary-button" disabled={!ready} onClick={() => onSplit(plan.parts, fileNames(plan.parts.map((_, index) => stem(index))))}>{busy ? <LoaderCircle size={16} className="spin" /> : <Scissors size={16} />}{actionLabel}</button>
    </div>
  </div>;
}
