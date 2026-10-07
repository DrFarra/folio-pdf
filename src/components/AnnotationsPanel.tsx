import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, GraduationCap, Highlighter, PenLine, Search, Share2, StickyNote, Trash2, X } from 'lucide-react';
import type { Annotation } from '../types';
import { normalize, plural } from '../pdf';
import { HIGHLIGHT_PRESETS } from './HighlightColorPicker';
import { highlightLabel, useHighlightLabels } from '../highlight-labels';
import './AnnotationsPanel.css';

type Kind = 'all' | Annotation['kind'];
type Props = {
  annotations: Annotation[]; documentName: string; activeId: string | null; editable: boolean;
  pageName: (page: number) => string; onSelect: (annotation: Annotation) => void; onDelete: (annotation: Annotation) => void;
  onEditNote: (annotation: Annotation) => void; onCopy: (text: string) => Promise<void>; onSave: (text: string, name: string) => Promise<boolean>;
};
const KINDS: { id: Kind; label: string }[] = [{ id: 'all', label: 'Todo' }, { id: 'highlight', label: 'Resaltados' }, { id: 'note', label: 'Notas' }, { id: 'ink', label: 'Dibujos' }];
export const colorName = (hex: string) => HIGHLIGHT_PRESETS.find(([, value]) => value.toLowerCase() === hex.toLowerCase())?.[0] || 'Color personalizado';
// The reader's meaning for a color when there is one, else its name.
const meaning = (hex: string) => highlightLabel(hex) || colorName(hex);

/** Annotations as a study list: filtered by type, color and text, grouped by
 * page, and exported as a Markdown summary of quotes and notes. */
export function AnnotationsPanel(props: Props) {
  const [kind, setKind] = useState<Kind>('all');
  const [colors, setColors] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useHighlightLabels();
  const sorted = useMemo(() => [...props.annotations].sort((a, b) => a.page - b.page || (b.rect[3] - a.rect[3]) || a.created - b.created), [props.annotations]);
  const palette = useMemo(() => [...new Set(sorted.filter(item => item.kind === 'highlight').map(item => item.color.toLowerCase()))], [sorted]);
  const needle = normalize(query.trim());
  const visible = sorted.filter(item => (kind === 'all' || item.kind === kind) && (!colors.length || item.kind === 'highlight' && colors.includes(item.color.toLowerCase()))
    && (!needle || normalize(item.text).includes(needle)));
  const groups = useMemo(() => { const map = new Map<number, Annotation[]>(); for (const item of visible) map.set(item.page, [...(map.get(item.page) || []), item]); return [...map]; }, [visible]);
  useEffect(() => { setColors(current => current.filter(color => palette.includes(color))); }, [palette.join()]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', dismiss); return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);

  // The summary follows the current filters, so "red highlights only" exports just those.
  const summary = () => {
    const title = props.documentName.replace(/\.pdf$/i, '');
    const lines = [`# ${title}`, '', `_${plural(visible.length, 'anotación', 'anotaciones')} · ${new Date().toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}_`];
    for (const [page, items] of groups) {
      lines.push('', `## Página ${props.pageName(page)}`, '');
      for (const item of items) {
        if (item.kind === 'highlight') lines.push(`> ${item.text.replace(/\s*\n\s*/g, ' ').trim() || 'Texto resaltado'}`, `> — *${meaning(item.color)}*`, '');
        else if (item.kind === 'note') lines.push(`- **Nota:** ${item.text.trim().replace(/\n/g, '\n  ')}`, '');
        else lines.push('- _Dibujo a mano_', '');
      }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  };
  // Anki imports tab-separated notes: front (the quote or note), back (meaning, page and document), tags.
  const cards = () => {
    const title = props.documentName.replace(/\.pdf$/i, ''), clean = (text: string) => text.replace(/\s+/g, ' ').trim();
    const tag = (text: string) => normalize(text).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const rows = visible.filter(item => item.kind !== 'ink' && clean(item.text)).map(item => {
      const label = item.kind === 'highlight' ? highlightLabel(item.color) : 'Nota';
      const back = [label, `Página ${props.pageName(item.page)}`, title].filter(Boolean).join(' · ');
      return [clean(item.text), back, ['folio', tag(title), label ? tag(label) : ''].filter(Boolean).join(' ')].join('\t');
    });
    return ['#separator:tab', '#html:false', '#tags column:3', ...rows].join('\n') + '\n';
  };
  const saveCards = async () => { setMenu(false); await props.onSave(cards(), `${props.documentName.replace(/\.pdf$/i, '')} — tarjetas Anki.txt`); };
  const copy = async () => { setMenu(false); await props.onCopy(summary()); setCopied(true); window.setTimeout(() => setCopied(false), 1800); };
  const save = async () => { setMenu(false); await props.onSave(summary(), `${props.documentName.replace(/\.pdf$/i, '')} — anotaciones.txt`); };
  const counts = (id: Kind) => id === 'all' ? sorted.length : sorted.filter(item => item.kind === id).length;
  const filtered = kind !== 'all' || colors.length > 0 || !!needle;

  if (!sorted.length) return <div className="empty-panel annotations-empty"><span className="annotations-empty-art"><StickyNote size={26} /></span><p>Sin anotaciones</p><span>Resalta texto, añade notas o dibuja desde Anotar. Aquí podrás filtrarlas y exportar un resumen.</span></div>;
  return <div className="annotations-panel">
    <div className="annotations-tools">
      <div className="annotations-search">
        <Search size={16} aria-hidden="true" />
        <input type="search" aria-label="Buscar en las anotaciones" placeholder="Buscar en las anotaciones" value={query} onChange={event => setQuery(event.target.value)} />
        {query && <button type="button" aria-label="Borrar búsqueda de anotaciones" onClick={() => setQuery('')}><X size={15} /></button>}
      </div>
      <div className="annotations-export" ref={menuRef}>
        <button type="button" className={`annotations-export-trigger${copied ? ' done' : ''}`} aria-label={copied ? 'Resumen copiado' : 'Exportar resumen'} title="Exportar resumen" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)}>{copied ? <Check size={17} /> : <Share2 size={17} />}</button>
        {menu && <div className="annotations-export-menu" role="menu" aria-label="Exportar resumen">
          <p>Resumen de {plural(visible.length, 'anotación', 'anotaciones')}{filtered ? ' filtradas' : ''}</p>
          <button type="button" role="menuitem" onClick={() => void copy()}><Copy size={17} /><span>Copiar resumen</span></button>
          <button type="button" role="menuitem" onClick={() => void save()}><Download size={17} /><span>Guardar como texto</span></button>
          <button type="button" role="menuitem" disabled={!visible.some(item => item.kind !== 'ink' && item.text.trim())} onClick={() => void saveCards()}><GraduationCap size={17} /><span>Tarjetas para Anki</span></button>
        </div>}
      </div>
    </div>
    <div className="annotations-filters" role="group" aria-label="Filtrar anotaciones">
      {KINDS.filter(item => item.id === 'all' || counts(item.id) > 0).map(item => <button key={item.id} type="button" aria-pressed={kind === item.id} onClick={() => { setKind(item.id); if (item.id !== 'highlight' && item.id !== 'all') setColors([]); }}>{item.label}<small>{counts(item.id)}</small></button>)}
    </div>
    {palette.length > 1 && kind !== 'note' && kind !== 'ink' && <div className="annotations-colors" role="group" aria-label="Filtrar resaltados por color">
      {palette.map(color => <button key={color} type="button" aria-label={meaning(color)} title={meaning(color)} aria-pressed={colors.includes(color)} style={{ '--swatch': color } as React.CSSProperties} onClick={() => setColors(current => current.includes(color) ? current.filter(item => item !== color) : [...current, color])}>{colors.includes(color) && <Check size={12} />}</button>)}
    </div>}
    {groups.length ? groups.map(([page, items]) => <section key={page} className="annotations-group" aria-label={`Página ${props.pageName(page)}`}>
      <h3>Página {props.pageName(page)}<span>{items.length}</span></h3>
      {items.map(item => <article key={item.id} className={`annotation-card ${item.kind}${props.activeId === item.id ? ' selected' : ''}`} style={{ '--annotation-color': item.color } as React.CSSProperties}>
        <button type="button" className="annotation-open" aria-label={`Ir a ${item.kind === 'note' ? 'la nota' : item.kind === 'ink' ? 'el dibujo' : 'el resaltado'} de la página ${props.pageName(page)}`} onClick={() => props.onSelect(item)}>
          <span className="annotation-kind" aria-hidden="true">{item.kind === 'note' ? <StickyNote size={14} /> : item.kind === 'ink' ? <PenLine size={14} /> : <Highlighter size={14} />}</span>
          <span className="annotation-text">{item.kind === 'highlight' && highlightLabel(item.color) && <span className="annotation-label">{highlightLabel(item.color)}</span>}<span className="annotation-body">{item.kind === 'ink' ? 'Dibujo a mano' : item.text.trim() || (item.kind === 'note' ? 'Nota vacía' : 'Texto resaltado')}</span></span>
        </button>
        <div className="annotation-actions">
          {item.kind === 'note' && <button type="button" className="note-edit" disabled={!props.editable} onClick={() => props.onEditNote(item)}>Editar nota</button>}
          <button type="button" className="annotation-delete" aria-label={`Eliminar anotación de la página ${props.pageName(page)}`} title="Eliminar" disabled={!props.editable} onClick={() => props.onDelete(item)}><Trash2 size={15} /></button>
        </div>
      </article>)}
    </section>) : <div className="empty-panel"><Search size={22} /><p>Sin coincidencias</p><button type="button" className="annotations-reset" onClick={() => { setKind('all'); setColors([]); setQuery(''); }}>Quitar filtros</button></div>}
  </div>;
}
