import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Cloud, FileText, X } from 'lucide-react';
import { isDesktop, shortcutLabel } from '../platform';
import type { LoadedDocument } from '../types';
import type { useDocumentTabDrag } from '../useDocumentTabDrag';

type Tab = { key: string; doc: LoadedDocument };

type Props<T extends Tab> = {
  tabs: T[];
  activeKey: string | null;
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
export default function DocumentTabStrip<T extends Tab>({
  tabs,
  activeKey,
  modified,
  disabled,
  driveIndicator,
  drag,
  onShow,
  onSwitch,
  onClose,
}: Props<T>) {
  const wheel = useRef(0);
  const dragged = tabs.find(tab => tab.key === drag.draggingKey);
  // Tabs that don't fit stay reachable from a "+N" menu beside the strip.
  const [hidden, setHidden] = useState(0);
  const [menu, setMenu] = useState(false);
  const overflow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = drag.strip.current;
    if (!strip) return;
    const measure = () => {
      const box = strip.getBoundingClientRect();
      setHidden(
        [...strip.children].filter(tab => {
          const rect = tab.getBoundingClientRect();
          return rect.left < box.left - 1 || rect.right > box.right + 1;
        }).length,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    strip.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      strip.removeEventListener('scroll', measure);
    };
  }, [drag.strip, tabs.length]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !overflow.current?.contains(event.target as Node))
        setMenu(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menu]);
  useEffect(() => {
    if (!hidden) setMenu(false);
  }, [hidden]);
  // The active tab scrolls into view.
  useEffect(() => {
    const selected = document.querySelector<HTMLElement>('.document-tab.selected'),
      strip = selected?.parentElement;
    if (!selected || !strip) return;
    const start = (tab: Element) => (tab as HTMLElement).offsetLeft - strip.offsetLeft,
      left = start(selected);
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    // Revealing to the right stops at a tab's start, so no half-hidden tab shows only its close button.
    else if (left + selected.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = Math.min(
        left,
        [...strip.children].map(start).find(value => value >= left + selected.offsetWidth - strip.clientWidth) ?? left,
      );
  }, [activeKey]);
  return (
    <>
      <div
        className={`document-tab-strip${drag.enabled ? ' drag-enabled' : ''}${drag.draggingKey ? ' is-dragging' : ''}`}
        ref={drag.strip}
        onClickCapture={drag.clickCapture}
        onDragStart={event => {
          if (drag.enabled) event.preventDefault();
        }}
        onWheel={event => {
          if (event.deltaX || event.ctrlKey || event.metaKey) return;
          // The strip snaps to whole tabs, so a scrollBy moves at least one tab: gather small trackpad steps first.
          wheel.current += event.deltaY * (event.deltaMode ? 40 : 1);
          if (Math.abs(wheel.current) >= 50) {
            event.currentTarget.scrollBy({ left: wheel.current });
            wheel.current = 0;
          }
        }}
        role="tablist"
        aria-label="Documentos abiertos"
      >
        {tabs.map(tab => {
          const changed = modified(tab),
            active = tab.key === activeKey;
          return (
            <div
              className={`document-tab ${active ? 'selected' : ''}${drag.draggingKey === tab.key ? ' plan-tab-dragging' : ''}${drag.drop?.key === tab.key ? ` tab-drop-${drag.drop.side}` : ''}`}
              key={tab.key}
              data-tab-key={tab.key}
              onPointerDown={event => drag.begin(event, tab.key)}
            >
              <button
                role="tab"
                aria-selected={active}
                aria-controls="document-reader"
                aria-label={tab.doc.name}
                aria-describedby={changed ? `modified-${tab.key}` : undefined}
                title={tab.doc.name}
                tabIndex={active ? 0 : -1}
                disabled={disabled}
                onClick={() => {
                  if (active) onShow();
                  else onSwitch(tab.key);
                }}
                onKeyDown={event => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const i = tabs.findIndex(item => item.key === tab.key);
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : (i + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length;
                    onSwitch(tabs[next].key);
                  } else if (event.key === 'Delete') {
                    event.preventDefault();
                    onClose(tab.key);
                  }
                }}
              >
                {tab.doc.drive ? (
                  active ? (
                    driveIndicator
                  ) : (
                    <Cloud size={14} aria-label="Documento de Google Drive" />
                  )
                ) : (
                  <FileText size={14} />
                )}
                <span>{tab.doc.name}</span>
                {changed && (
                  <span className="modified-dot" id={`modified-${tab.key}`} title="Cambios sin guardar">
                    <span className="sr-only">Cambios sin guardar</span>
                  </span>
                )}
              </button>
              {/* Outside the Tab order: the focused tab closes with Delete or the shortcut. */}
              <button
                className="document-tab-close"
                aria-label={`Cerrar ${tab.doc.name}`}
                title={isDesktop ? `Cerrar pestaña (${shortcutLabel('W')})` : 'Cerrar pestaña'}
                tabIndex={-1}
                disabled={disabled}
                onClick={() => onClose(tab.key)}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      {hidden > 0 && (
        <div className="document-tab-overflow" ref={overflow}>
          <button
            aria-label={`${hidden} ${hidden === 1 ? 'documento más' : 'documentos más'}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={disabled}
            onClick={() => setMenu(value => !value)}
          >
            +{hidden}
            <ChevronDown size={14} />
          </button>
          {menu && (
            <div className="document-tab-menu" role="menu" aria-label="Todos los documentos abiertos">
              {tabs.map(tab => {
                const active = tab.key === activeKey;
                return (
                  <button
                    key={tab.key}
                    role="menuitem"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      setMenu(false);
                      if (active) onShow();
                      else onSwitch(tab.key);
                    }}
                  >
                    <span className="document-tab-menu-name">{tab.doc.name}</span>
                    {modified(tab) && <span className="document-tab-menu-unsaved">sin guardar</span>}
                    {active && <Check size={15} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {dragged && (
        <div
          className="document-tab-drag-preview"
          aria-hidden="true"
          style={{
            left: Math.max(8, Math.min(drag.location.x + 16, window.innerWidth - 270)),
            top: Math.max(8, Math.min(drag.location.y + 16, window.innerHeight - 48)),
          }}
        >
          <FileText size={16} />
          <span>{dragged.doc.name}</span>
        </div>
      )}
    </>
  );
}
