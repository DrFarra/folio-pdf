import { useEffect, useState } from 'react';
import { Check, FileText, LockKeyhole, StickyNote } from 'lucide-react';
import Modal from './Modal';
import { fileSaveLabel, here, savesInPlace } from '../app/model';
import { formatSize } from '../pdf';
import { isDesktop, isNative } from '../platform';
import type { LoadedDocument, RecentDocument } from '../types';

/** A document's (or, for 'window', Folio's) closing waits because its changes could not be stored. */
export function CloseBlockedDialog({
  name,
  window,
  saveLabel,
  onBack,
  onSave,
  onDiscard,
}: {
  name?: string;
  window: boolean;
  saveLabel: string;
  onBack: () => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <Modal title="No se pudieron guardar tus cambios" onClose={onBack}>
      <p className="modal-description">
        {savesInPlace ? 'Guarda' : isNative ? 'Guarda una copia de' : 'Descarga'} «{name}» antes de{' '}
        {window ? 'salir' : 'cerrarlo'} o perderás los cambios.
      </p>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onBack}>
          Volver
        </button>
        <button className="secondary-button" onClick={onSave}>
          {savesInPlace ? saveLabel : fileSaveLabel}
        </button>
        <button className="primary-button" onClick={onDiscard}>
          {window ? 'Salir sin guardar' : 'Cerrar sin guardar'}
        </button>
      </div>
    </Modal>
  );
}

export function DocumentInfoDialog({
  doc,
  annotations,
  bookmarks,
  onClose,
}: {
  doc: LoadedDocument;
  annotations: number;
  bookmarks: number;
  onClose: () => void;
}) {
  return (
    <Modal title="Información del documento" onClose={onClose} className="info-modal">
      <div className="info-file">
        <FileText size={30} />
        <strong>{doc.name}</strong>
      </div>
      <dl className="document-details">
        <div>
          <dt>Páginas</dt>
          <dd>{doc.pdf.numPages}</dd>
        </div>
        <div>
          <dt>Tamaño</dt>
          <dd>{formatSize(doc.size)}</dd>
        </div>
        <div>
          <dt>Anotaciones de Folio</dt>
          <dd>{annotations}</dd>
        </div>
        <div>
          <dt>Marcadores</dt>
          <dd>{bookmarks}</dd>
        </div>
      </dl>
    </Modal>
  );
}

export type PasswordRequest = { name: string; retry: boolean; submit: (value: string) => void };

/** Asks for a PDF's password; each new request (a retry after a wrong one) starts empty. */
export function PasswordDialog({
  request,
  onSubmitted,
  onCancel,
}: {
  request: PasswordRequest;
  onSubmitted: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  useEffect(() => setText(''), [request]);
  return (
    <Modal title="Este PDF tiene contraseña" onClose={onCancel} className="password-modal">
      <p className="modal-description">Introduce la contraseña para abrir «{request.name}».</p>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (text) {
            request.submit(text);
            onSubmitted();
          }
        }}
      >
        <label htmlFor="pdf-password">Contraseña</label>
        <input
          autoFocus
          data-autofocus
          id="pdf-password"
          type="password"
          value={text}
          onChange={e => setText(e.target.value)}
          autoComplete="off"
        />
        {request.retry && <p className="password-error">La contraseña anterior no es correcta. Inténtalo de nuevo.</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancelar
          </button>
          <button className="primary-button" disabled={!text}>
            <LockKeyhole size={15} />
            Abrir PDF
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Writing a note on touch layouts (desktop uses NotePopover beside the note). */
export function NoteDialog({
  isNew,
  page,
  text,
  onText,
  onSave,
  onCancel,
}: {
  isNew: boolean;
  page: string;
  text: string;
  onText: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={isNew ? 'Añadir nota' : 'Editar nota'} onClose={onCancel} className="note-modal">
      <div className="note-page-label">
        <StickyNote size={16} />
        Página {page}
      </div>
      <textarea
        autoFocus
        data-autofocus
        aria-label="Texto de la nota"
        placeholder="Escribe una nota…"
        value={text}
        maxLength={5000}
        onChange={e => onText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
            e.preventDefault();
            onSave();
          }
        }}
      />
      <div className="note-modal-footer">
        <span>{text.length} / 5000</span>
        <button className="secondary-button" onClick={onCancel}>
          Cancelar
        </button>
        <button className="primary-button" disabled={!text.trim()} onClick={onSave}>
          <Check size={16} />
          Guardar nota
        </button>
      </div>
    </Modal>
  );
}

/** Confirms removing a document from the library; an open one is closed with it. */
export function ForgetDocumentDialog({
  target,
  open,
  disabled,
  onCancel,
  onConfirm,
}: {
  target: RecentDocument;
  open: boolean;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={isDesktop ? 'Quitar de la biblioteca' : 'Eliminar de la biblioteca'} onClose={onCancel}>
      <p className="modal-description">
        {isDesktop
          ? `Se quitará «${target.name}» de la biblioteca junto con sus anotaciones, marcadores y cambios guardados en este equipo.`
          : `Se eliminarán de ${here} la copia de «${target.name}», sus anotaciones, marcadores y cambios guardados.`}{' '}
        El archivo original no se modifica.
        {open && ' El documento abierto se cerrará y perderás los cambios que no hayas guardado en un PDF.'}
      </p>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onCancel}>
          Cancelar
        </button>
        <button className="primary-button destructive-button" disabled={disabled} onClick={onConfirm}>
          {isDesktop ? 'Quitar de la biblioteca' : 'Eliminar copia y cambios'}
        </button>
      </div>
    </Modal>
  );
}

export function CapabilityNotice({ summary, onClose }: { summary: string; onClose: () => void }) {
  return (
    <Modal title="Herramientas disponibles" onClose={onClose}>
      <p className="modal-description">{summary}</p>
      <div className="modal-actions">
        <button className="primary-button" onClick={onClose}>
          Entendido
        </button>
      </div>
    </Modal>
  );
}

/** Ir a página on touch layouts: a number, or a slider over the pages. */
export function PageJumpDialog({
  pages,
  page,
  value,
  onValue,
  onGo,
  onCancel,
}: {
  pages: number;
  page: number;
  value: string;
  onValue: (value: string) => void;
  onGo: (page: number) => void;
  onCancel: () => void;
}) {
  const target = Number(value),
    valid = Number.isInteger(target) && target >= 1 && target <= pages;
  return (
    <Modal title="Ir a página" onClose={onCancel} className="page-jump-modal">
      <form
        onSubmit={event => {
          event.preventDefault();
          if (valid) onGo(target);
        }}
      >
        <label htmlFor="jump-page-number">Página (1–{pages})</label>
        <input
          id="jump-page-number"
          autoFocus
          data-autofocus
          type="text"
          inputMode="numeric"
          pattern="[0-9]+"
          value={value}
          onChange={event => onValue(event.target.value.replace(/\D/g, ''))}
        />
        <label className="reading-setting">
          <span>Recorrer páginas</span>
          <input
            aria-label="Recorrer páginas"
            type="range"
            min="1"
            max={pages}
            value={Math.max(1, Math.min(pages, target || page))}
            onChange={event => onValue(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancelar
          </button>
          <button className="primary-button" disabled={!valid}>
            Ir a página
          </button>
        </div>
      </form>
    </Modal>
  );
}
