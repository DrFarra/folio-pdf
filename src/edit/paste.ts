import { useEffect, useRef } from 'react';
import { errorMessage } from '../errors';
import { readImage } from './EditToolbar';
import type { EditStore } from './store';

/** While Editar is open, a pasted screenshot or image lands in the middle of the view, on the
 * page shown there; with no page in view, the next click places it. */
export function usePastedImages(editing: boolean, store: EditStore, onError: (message: string) => void) {
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    if (!editing) return;
    const paste = (event: ClipboardEvent) => {
      if (store.state.draft || (event.target as HTMLElement | null)?.closest?.('dialog')) return;
      const file = [...(event.clipboardData?.files || [])].find(item => /^image\/(png|jpeg)$/.test(item.type));
      if (!file) return;
      event.preventDefault();
      void readImage(file)
        .then(image => {
          const view = document.querySelector('.reading-area')?.getBoundingClientRect();
          const shown = (box: DOMRect) =>
            view ? Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)) : 0;
          const page = [...document.querySelectorAll('.edit-layer')]
            .map(node => node.getBoundingClientRect())
            .sort((a, b) => shown(b) - shown(a))[0];
          if (!view || !page || !shown(page)) {
            store.set({ image: { ...image, name: 'la imagen pegada' }, tool: 'image', selection: null, notice: '' });
            return;
          }
          const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
          window.dispatchEvent(
            new CustomEvent('folio:edit-place-image', {
              detail: {
                image,
                clientX: clamp(view.left + view.width / 2, page.left + 1, page.right - 1),
                clientY: clamp(
                  view.top + view.height / 2,
                  Math.max(page.top, view.top) + 1,
                  Math.min(page.bottom, view.bottom) - 1,
                ),
              },
            }),
          );
        })
        .catch(error => report.current(errorMessage(error)));
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [editing, store]);
}
