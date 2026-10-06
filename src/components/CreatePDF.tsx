import { useState } from 'react';
import { FileText, LoaderCircle, X } from 'lucide-react';
import Modal from './Modal';
import FilePicker from './FilePicker';
import { createImagePdf } from '../conversion';
import { errorMessage } from '../errors';
import { plural } from '../pdf';
import './CreatePDF.css';

export default function CreatePDF({ onClose, onCreate }: { onClose: () => void; onCreate: (bytes: Uint8Array, name: string) => Promise<void> }) {
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('Documento.pdf');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true); setError('');
    try { await onCreate(await createImagePdf(files), name.trim().replace(/\.pdf$/i, '') + '.pdf'); }
    catch (err) { setError(errorMessage(err, 'No se pudo crear el PDF.')); }
    finally { setBusy(false); }
  }
  return <Modal title="Crear PDF" onClose={() => { if (!busy) onClose(); }} className="create-pdf-modal">
    <form className="create-pdf-form" onSubmit={event => { event.preventDefault(); void create(); }} aria-busy={busy}>
      <div className="create-pdf-fields">
        <label className="create-pdf-name">Nombre<input value={name} maxLength={160} disabled={busy} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
        <FilePicker label="Imágenes (opcional)" buttonText="Añadir imágenes" description="PNG o JPEG · Una por página" accept="image/png,image/jpeg" multiple disabled={busy} onSelect={selected => { setFiles(previous => [...previous, ...selected]); setError(''); }} />
        {files.length ? <div className="create-pdf-selection">
          <p className="create-pdf-summary" role="status">{plural(files.length, 'imagen', 'imágenes')} · {plural(files.length, 'página', 'páginas')}</p>
          <ol className="create-pdf-files" aria-label="Imágenes en orden de página">{files.map((file, index) => <li key={index}>
            <span className="create-pdf-page" aria-hidden="true">{index + 1}</span>
            <span className="create-pdf-filename" title={file.name}>{file.name}</span>
            <button type="button" className="icon-button" aria-label={`Quitar imagen ${index + 1}`} disabled={busy} onClick={() => { setFiles(previous => previous.filter((_, i) => i !== index)); setError(''); }}><X size={18} /></button>
          </li>)}</ol>
        </div> : <p className="create-pdf-empty"><FileText size={18} aria-hidden="true" />Se creará una página A4 en blanco.</p>}
        {error && <p className="operation-error" role="alert">{error}</p>}
      </div>
      <div className="create-pdf-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancelar</button>
        <button type="submit" className="primary-button" disabled={!name.trim() || busy}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? 'Creando…' : 'Crear PDF'}</button>
      </div>
    </form>
  </Modal>;
}
