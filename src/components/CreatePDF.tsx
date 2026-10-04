import { useState } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import Modal from './Modal';
import { createImagePdf } from '../conversion';
export default function CreatePDF({ onClose, onCreate }: { onClose: () => void; onCreate: (bytes: Uint8Array, name: string) => Promise<void> }) {
  const [files, setFiles] = useState<File[]>([]), [name, setName] = useState('Documento.pdf');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title="Crear PDF" onClose={() => { if (!busy) onClose(); }} className="workbench">
    <div className="security-form"><label>Nombre<input value={name} maxLength={160} onChange={e => setName(e.target.value)} /></label><label>Imágenes, una por página<input type="file" multiple accept="image/png,image/jpeg" disabled={busy} onChange={e => { setFiles([...files, ...Array.from(e.target.files || [])]); e.target.value = ''; }} /></label></div>
    {!files.length && <p className="modal-description">Sin imágenes se crea una página A4 en blanco.</p>}
    <div className="create-files">{files.map((file, index) => <div key={index}><span>{file.name}</span><button aria-label={`Quitar imagen ${index + 1}`} disabled={busy} onClick={() => setFiles(files.filter((_, i) => i !== index))}><Trash2 size={16} /></button></div>)}</div>
    {error && <p className="operation-error" role="alert">{error}</p>}<div className="operation-actions"><button className="primary-button" disabled={!name.trim() || busy} onClick={async () => { setBusy(true); setError(''); try { await onCreate(await createImagePdf(files), name.replace(/\.pdf$/i, '') + '.pdf'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>{busy && <LoaderCircle size={16} className="spin" />}Crear documento</button></div>
  </Modal>;
}
