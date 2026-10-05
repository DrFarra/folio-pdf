import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, FileText, FolderOpen, Plus, X } from 'lucide-react';
import type { RecentDocument } from '../types';
import './DocumentSwitcher.css';

type OpenDocument = { key: string; id: string; name: string; page: number; pages: number };
type Props = {
  open: boolean; documents: OpenDocument[]; recents: RecentDocument[]; activeKey: string | null; disabled: boolean;
  onDismiss: () => void; onSelect: (key: string) => void; onRecent: (document: RecentDocument) => void;
  onCloseDocument: (key: string) => void; onImport: () => void; onLibrary: () => void;
};

/** A modeless, anchored document picker. Closing stays mounted for its exit motion. */
export default function DocumentSwitcher({ open, documents, recents, activeKey, disabled, onDismiss, onSelect, onRecent, onCloseDocument, onImport, onLibrary }: Props) {
  const [present, setPresent] = useState(open);
  const [position, setPosition] = useState({ left: 12, top: 60, width: 360, maxHeight: 480 });
  const popup = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  const recentDocuments = recents.filter(recent => !recent.hidden && !documents.some(doc => doc.id === recent.id)).sort((a, b) => b.openedAt - a.openedAt).slice(0, 6);

  useEffect(() => {
    if (open) { setPresent(true); return; }
    const timer = window.setTimeout(() => setPresent(false), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140);
    return () => clearTimeout(timer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = document.getElementById('document-switcher-trigger');
    const place = () => {
      if (!anchor) return;
      const bounds = anchor.getBoundingClientRect(), viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
      const rightEdge = leftEdge + (viewport?.width || innerWidth), bottomEdge = topEdge + (viewport?.height || innerHeight);
      const width = Math.min(360, rightEdge - leftEdge - 24);
      const safeBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-safe-bottom')) || 0;
      const top = bounds.bottom + 6;
      setPosition({ left: Math.max(leftEdge + 12, Math.min(bounds.left, rightEdge - width - 12)), top, width, maxHeight: Math.max(80, bottomEdge - top - 12 - safeBottom) });
    };
    place();
    const observer = new ResizeObserver(place); if (anchor) observer.observe(anchor);
    window.addEventListener('resize', place); window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); };
  }, [open, present]);

  useEffect(() => {
    if (!open || !present) return;
    const trigger = document.getElementById('document-switcher-trigger');
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger?.contains(event.target)) dismiss.current();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismiss.current(); trigger?.focus({ preventScroll: true }); return; }
      const focus = document.activeElement;
      if (focus !== trigger && !popup.current?.contains(focus)) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
      if (!buttons.length) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const index = buttons.indexOf(focus as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1) + buttons.length) % buttons.length;
      buttons[next].focus({ preventScroll: true });
    };
    const focusOutside = (event: FocusEvent) => {
      if (event.target instanceof Node && event.target !== trigger && !popup.current?.contains(event.target)) dismiss.current();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('focusin', focusOutside);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true); document.removeEventListener('focusin', focusOutside); };
  }, [open, present]);

  if (!present) return null;
  return createPortal(<div ref={popup} id="document-switcher" className={`document-switcher${open ? '' : ' is-closing'}`} role="dialog" aria-label="Documentos abiertos y recientes" inert={!open} style={position}>
    <div className="document-switcher-heading">Documentos</div>
    <div className="document-switcher-scroll">
      <div className="document-switcher-label">Abiertos</div>
      {documents.map(doc => <div key={doc.key} className={`document-switcher-row${doc.key === activeKey ? ' selected' : ''}`}>
        <button className="document-switcher-document" aria-label={`Abrir pestaña ${doc.name}`} aria-current={doc.key === activeKey ? 'page' : undefined} disabled={disabled} onClick={() => onSelect(doc.key)}>
          <span className="document-switcher-file"><FileText size={20} /></span><span className="document-switcher-name"><strong>{doc.name}</strong><small>Página {doc.page} de {doc.pages}</small></span>{doc.key === activeKey && <Check size={17} />}
        </button><button className="document-switcher-close" aria-label={`Cerrar ${doc.name}`} disabled={disabled} onClick={() => onCloseDocument(doc.key)}><X size={17} /></button>
      </div>)}
      {recentDocuments.length > 0 && <><div className="document-switcher-label recent">Recientes</div>{recentDocuments.map(recent => <button key={recent.id} className="document-switcher-document document-switcher-recent" aria-label={`Abrir reciente ${recent.name}`} disabled={disabled} onClick={() => onRecent(recent)}><span className="document-switcher-file"><FileText size={20} /></span><span className="document-switcher-name"><strong>{recent.name}</strong><small>{recent.pages} {recent.pages === 1 ? 'página' : 'páginas'}</small></span></button>)}</>}
    </div>
    <div className="document-switcher-actions"><button onClick={onImport} disabled={disabled}><Plus size={19} /><span>Importar PDF</span></button><button onClick={onLibrary} disabled={disabled}><FolderOpen size={19} /><span>Ver biblioteca</span></button></div>
  </div>, document.body);
}
