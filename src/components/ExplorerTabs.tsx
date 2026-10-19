import { Bookmark, Layers, ListTree, MessageSquare } from 'lucide-react';
import { explorerIds, type ExplorerId } from '../app/panels';

/** The explorer's tabs on touch layouts (pages, outline, bookmarks, annotations), chosen with
 * a tap or the arrow keys. A tab reads as selected while its drawer shows, also as it slides away. */
export default function ExplorerTabs({
  selected,
  onSelect,
}: {
  selected: (id: ExplorerId) => boolean;
  onSelect: (id: ExplorerId, focus?: boolean) => void;
}) {
  return (
    <div className="mobile-panel-tabs" role="tablist" aria-label="Explorar PDF">
      {explorerIds.map((id, index) => {
        const Symbol =
          id === 'pages' ? Layers : id === 'outline' ? ListTree : id === 'bookmarks' ? Bookmark : MessageSquare;
        const label =
          id === 'pages' ? 'Páginas' : id === 'outline' ? 'Índice' : id === 'bookmarks' ? 'Marcadores' : 'Anotaciones';
        const active = selected(id);
        return (
          <button
            key={id}
            role="tab"
            data-explorer-tab={id}
            aria-selected={active}
            aria-controls={active ? 'explorer-panel' : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(id)}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              onSelect(
                explorerIds[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? explorerIds.length - 1
                      : (index + (event.key === 'ArrowLeft' ? explorerIds.length - 1 : 1)) % explorerIds.length
                ],
                true,
              );
            }}
          >
            <Symbol size={19} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
