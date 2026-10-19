import { ArrowDownToLine, Check, Cloud, FilePlus2, FileText, Info, Layers, Maximize, Printer, Redo2, RotateCw, Settings2, Undo2, Upload, Wrench, X } from 'lucide-react';
import Modal from './Modal';
import { savesInPlace } from '../app/model';
import { isNativePdfDocument } from '../nativePdf';
import { isNative, shortcutLabel, type Anchor } from '../platform';
import type { LoadedDocument } from '../types';

// iPad anchors Share and Print to the button that opened the sheet.
const sheetAnchor = (): Anchor | undefined => {
  const box = document.querySelector('[aria-label="Más acciones"], [aria-label="Más acciones del documento"]')?.getBoundingClientRect();
  return box && { left: box.left, top: box.top, width: box.width, height: box.height };
};

type Common = {
  doc: LoadedDocument | null; busy: boolean; loading: boolean;
  /** Where the document's changes are kept, and whether keeping them failed. */
  status: string; storageFailed: boolean;
  onClose: () => void;
};

/** An action chosen from the sheet runs once the sheet has closed. */
const chosen = (onClose: () => void) => (action: () => void) => () => { onClose(); requestAnimationFrame(action); };

type TouchProps = Common & {
  tablet: boolean; saveLabel: string;
  /** Guardar updates the opened file. */
  savesOriginal: boolean;
  /** Why some tools are unavailable for this document. */
  capabilitySummary: string;
  canUndo: boolean; canRedo: boolean;
  on: { save: () => void; saveCopy: () => void; undo: () => void; redo: () => void; drive: () => void; share: (anchor?: Anchor) => void; edit: () => void;
    view: () => void; tools: () => void; print: (anchor?: Anchor) => void; info: () => void; close: () => void };
};

/** Más acciones on phones and tablets: saving first, then the document's other actions. */
export function TouchDocumentActions({ doc, busy, loading, status, storageFailed, onClose, tablet, saveLabel, savesOriginal, capabilitySummary, canUndo, canRedo, on }: TouchProps) {
  const act = chosen(onClose);
  return <Modal title="Acciones del documento" onClose={onClose} className="mobile-actions-modal">
    {storageFailed ? <p className="mobile-storage-error" role="alert">{status}</p> : <p className="mobile-save-status"><Check size={17} />{status}</p>}
    <div className="mobile-file-actions"><button className="primary-button" aria-label={doc?.drive ? saveLabel : savesInPlace ? 'Guardar PDF' : isNative ? 'Guardar una copia del PDF' : 'Descargar PDF'} onClick={act(on.save)} disabled={!doc || busy || loading}><ArrowDownToLine size={20} /><span>{saveLabel}</span></button></div>
    {/* PDFs created in Folio, recovered changes and the sample are saved as new files, so Guardar is the only save. */}
    {savesOriginal ? <p className="modal-description">Guardar actualiza el PDF original.</p> : savesInPlace && doc && !doc.drive && <p className="modal-description">Podrás elegir dónde guardar este PDF.</p>}
    {doc && (!doc.canAnnotate || isNativePdfDocument(doc.pdf)) && <p className="mobile-capability-summary">{capabilitySummary}</p>}
    <div className="mobile-action-grid">
      {/* Annotation mode has its own history buttons; here they appear, as a pair, only with something to revert. */}
      {(canUndo || canRedo) && <><button onClick={act(on.undo)} disabled={busy || !canUndo}><Undo2 size={21} /><span>Deshacer</span></button><button onClick={act(on.redo)} disabled={busy || !canRedo}><Redo2 size={21} /><span>Rehacer</span></button></>}
      {doc?.drive && <button onClick={act(on.drive)}><Cloud size={20} /><span>Ver Drive</span></button>}
      {(doc?.drive || savesOriginal) && <button onClick={act(on.saveCopy)} disabled={!doc || busy || loading}><FilePlus2 size={21} /><span>Guardar una copia</span></button>}
      {tablet && <><button onClick={() => { const anchor = sheetAnchor(); act(() => on.share(anchor))(); }} disabled={!doc || busy}><Upload size={21} /><span>Compartir PDF</span></button><button onClick={act(on.edit)} disabled={!doc?.canEdit || busy}><FileText size={21} /><span>Editar PDF</span></button></>}
      <button onClick={act(on.view)} disabled={!doc}><Settings2 size={21} /><span>Vista del documento</span></button>
      <button onClick={act(on.tools)} disabled={!doc || busy}><Wrench size={21} /><span>Herramientas</span></button>
      <button onClick={() => { const anchor = sheetAnchor(); act(() => on.print(anchor))(); }} disabled={!doc?.canPrint || busy}><Printer size={21} /><span>Imprimir PDF</span></button>
      <button onClick={act(on.info)} disabled={!doc}><Info size={21} /><span>Información del documento</span></button>
      <button className="mobile-close-document" onClick={act(on.close)} disabled={busy || loading}><X size={21} /><span>Cerrar documento</span></button>
    </div>
  </Modal>;
}

type DesktopProps = Common & {
  singlePage: boolean;
  on: { drive: () => void; saveCopy: () => void; toggleSinglePage: () => void; rotate: () => void; print: () => void; fullscreen: () => void; info: () => void; close: () => void };
};

/** Más acciones on desktop: what the toolbar and the rail do not hold. */
export function DesktopDocumentActions({ doc, busy, loading, status, storageFailed, onClose, singlePage, on }: DesktopProps) {
  const act = chosen(onClose);
  return <Modal title="Acciones del documento" onClose={onClose} className="desktop-actions-menu">
    {doc?.drive && <button className="text-button" onClick={act(on.drive)}><Cloud size={16} />Ver Drive</button>}
    {storageFailed && <p className="desktop-save-status" role="alert">{status}</p>}
    <div className="desktop-document-actions">
      {isNative && <button aria-label="Guardar una copia" disabled={!doc || busy || loading} onClick={act(on.saveCopy)}><FilePlus2 size={19} /><span>Guardar una copia…</span><span>{shortcutLabel('S', true)}</span></button>}
      {/* The toolbar holds zoom and the rail returns to the library, so neither repeats here. */}
      <button onClick={act(on.toggleSinglePage)}><Layers size={19} /><span>{singlePage ? 'Ver páginas en continuo' : 'Ver una página a la vez'}</span></button>
      <button onClick={act(on.rotate)}><RotateCw size={19} /><span>Girar vista 90°</span></button>
      <button aria-label="Imprimir PDF" disabled={!doc?.canPrint || busy} onClick={act(on.print)}><Printer size={19} /><span>Imprimir PDF</span></button>
      {!isNative && document.fullscreenEnabled && <button aria-label="Pantalla completa" onClick={act(on.fullscreen)}><Maximize size={19} /><span>Pantalla completa</span></button>}
      <button onClick={act(on.info)}><Info size={19} /><span>Información del documento</span></button>
      <button onClick={act(on.close)}><X size={19} /><span>Cerrar documento</span></button>
    </div>
  </Modal>;
}
