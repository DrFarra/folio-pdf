import { useRef, type ReactNode } from 'react';
import { Cloud, FileText, X } from 'lucide-react';
import { isDesktop, shortcutLabel } from '../platform';
import type { LoadedDocument } from '../types';
import type { useDocumentTabDrag } from '../useDocumentTabDrag';

type Tab = { key: string; doc: LoadedDocument };

type Props<T extends Tab> = {
  tabs: T[]; activeKey: string | null;
  /** Whether a tab has unsaved changes. */
  modified: (tab: T) => boolean;
  disabled: boolean;
  /** The active Drive document's sync indicator. */
  driveIndicator: ReactNode;
  drag: ReturnType<typeof useDocumentTabDrag>;
  /** The active tab was chosen again (from the library). */
  onShow: () => void;
  onSwitch: (key: string) => void;
  onClose: (key: string) => void;
};

/** The desktop header's document tabs: chosen with a click or the arrow keys, closed
 * with their × or Delete, and reordered by dragging. */
export default function DocumentTabStrip<T extends Tab>({ tabs, activeKey, modified, disabled, driveIndicator, drag, onShow, onSwitch, onClose }: Props<T>) {
  const wheel = useRef(0);
  const dragged = tabs.find(tab => tab.key === drag.draggingKey);
  return <>
    <div className={`document-tab-strip${drag.enabled ? ' drag-enabled' : ''}${drag.draggingKey ? ' is-dragging' : ''}`} ref={drag.strip} onClickCapture={drag.clickCapture} onDragStart={event => { if (drag.enabled) event.preventDefault(); }} onWheel={event => {
      if (event.deltaX || event.ctrlKey || event.metaKey) return;
      // The strip snaps to whole tabs, so a scrollBy moves at least one tab: gather small trackpad steps first.
      wheel.current += event.deltaY * (event.deltaMode ? 40 : 1);
      if (Math.abs(wheel.current) >= 50) { event.currentTarget.scrollBy({ left: wheel.current }); wheel.current = 0; }
    }} role="tablist" aria-label="Documentos abiertos">
      {tabs.map(tab => { const changed = modified(tab), active = tab.key === activeKey; return <div className={`document-tab ${active ? 'selected' : ''}${drag.draggingKey === tab.key ? ' plan-tab-dragging' : ''}${drag.drop?.key === tab.key ? ` tab-drop-${drag.drop.side}` : ''}`} key={tab.key} data-tab-key={tab.key} onPointerDown={event => drag.begin(event, tab.key)}>
        <button role="tab" aria-selected={active} aria-controls="document-reader" aria-label={tab.doc.name} aria-describedby={changed ? `modified-${tab.key}` : undefined} title={tab.doc.name} tabIndex={active ? 0 : -1} disabled={disabled} onClick={() => { if (active) onShow(); else onSwitch(tab.key); }} onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const i = tabs.findIndex(item => item.key === tab.key); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length; onSwitch(tabs[next].key); }
          else if (event.key === 'Delete') { event.preventDefault(); onClose(tab.key); }
        }}>{tab.doc.drive ? active ? driveIndicator : <Cloud size={14} aria-label="Documento de Google Drive" /> : <FileText size={14} />}<span>{tab.doc.name}</span>{changed && <span className="modified-dot" id={`modified-${tab.key}`} title="Cambios sin guardar"><span className="sr-only">Cambios sin guardar</span></span>}</button>
        {/* Outside the Tab order: the focused tab closes with Delete or the shortcut. */}
        <button className="document-tab-close" aria-label={`Cerrar ${tab.doc.name}`} title={isDesktop ? `Cerrar pestaña (${shortcutLabel('W')})` : 'Cerrar pestaña'} tabIndex={-1} disabled={disabled} onClick={() => onClose(tab.key)}><X size={13} /></button>
      </div>; })}
    </div>
    {dragged && <div className="document-tab-drag-preview" aria-hidden="true" style={{ left: Math.max(8, Math.min(drag.location.x + 16, window.innerWidth - 270)), top: Math.max(8, Math.min(drag.location.y + 16, window.innerHeight - 48)) }}><FileText size={16} /><span>{dragged.doc.name}</span></div>}
  </>;
}
