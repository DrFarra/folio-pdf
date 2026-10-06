import { pdfAssetSettings } from '../assets';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import type { LoadedDocument } from '../types';
import { getDocument } from '../pdf';
import { errorMessage } from '../errors';
import { extractText } from '../engine/client';
import { compareText, visualDifference } from '../comparison';
import FilePicker from './FilePicker';

type Pair = { before: PDFDocumentProxy; after: PDFDocumentProxy; beforeText: string[]; afterText: string[]; name: string };
export default function CompareDocuments({ doc, getBytes, onBusyChange }: { doc: LoadedDocument; getBytes: () => Promise<Uint8Array>; onBusyChange?: (busy: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [pair, setPair] = useState<Pair | null>(null);
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<'visual' | 'text'>('visual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pixels, setPixels] = useState<number | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const tasks = useRef<PDFDocumentLoadingTask[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => () => { controller.current?.abort(); tasks.current.forEach(task => { void task.destroy(); }); }, []);
  async function compare() {
    if (!file) return; setBusy(true); setError(''); setPair(null); setImages([]);
    controller.current?.abort(); controller.current = new AbortController(); const signal = controller.current.signal;
    await Promise.all(tasks.current.map(task => task.destroy())); tasks.current = [];
    try {
      const beforeBytes = await getBytes(), afterBytes = new Uint8Array(await file.arrayBuffer());
      const settings = { ...pdfAssetSettings() };
      tasks.current = [getDocument({ ...settings, data: new Uint8Array(beforeBytes), password: doc.password }), getDocument({ ...settings, data: new Uint8Array(afterBytes), password })];
      // PDF.js identifies a wrong password or a damaged file; report that before any text error.
      const text = Promise.all([extractText(beforeBytes, doc.password, signal), extractText(afterBytes, password, signal)]); text.catch(() => {});
      const [before, after] = await Promise.all(tasks.current.map(task => task.promise)), [beforeText, afterText] = await text;
      signal.throwIfAborted(); setPage(1); setPair({ before, after, beforeText, afterText, name: file.name });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (!signal.aborted) setError(name === 'PasswordException' ? password ? 'La contraseña del segundo PDF no es correcta.' : 'El segundo PDF está protegido. Escribe su contraseña.'
        : name === 'InvalidPDFException' ? 'El archivo elegido no es un PDF válido.' : errorMessage(err, 'No se pudieron comparar los documentos.'));
    }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!pair || mode !== 'visual') return;
    let alive = true; const renders: { cancel: () => void }[] = []; setPixels(null); setImages([]);
    void (async () => {
      const beforePage = page <= pair.before.numPages ? await pair.before.getPage(page) : null;
      const afterPage = page <= pair.after.numPages ? await pair.after.getPage(page) : null;
      const sizes = [beforePage, afterPage].filter(Boolean).map(page => page!.getViewport({ scale: 1 }));
      const width = Math.max(...sizes.map(s => s.width)), height = Math.max(...sizes.map(s => s.height));
      const scale = Math.min(1.5, 700 / width, 1000 / height), canvases: HTMLCanvasElement[] = [];
      for (const pdfPage of [beforePage, afterPage]) {
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale); canvases.push(canvas);
        const context = canvas.getContext('2d', { willReadFrequently: true })!; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        if (pdfPage) {
          const viewport = pdfPage.getViewport({ scale });
          const render = pdfPage.render({ canvas, viewport }); renders.push(render); await render.promise;
        }
        if (!alive) return;
      }
      const difference = visualDifference(canvases[0].getContext('2d')!.getImageData(0, 0, canvases[0].width, canvases[0].height), canvases[1].getContext('2d')!.getImageData(0, 0, canvases[1].width, canvases[1].height));
      const diff = document.createElement('canvas'); diff.width = canvases[0].width; diff.height = canvases[0].height; diff.getContext('2d')!.putImageData(difference.image, 0, 0);
      if (alive) { setPixels(difference.changedPixels); setImages([...canvases, diff].map(canvas => canvas.toDataURL('image/png'))); }
      [...canvases, diff].forEach(canvas => { canvas.width = 0; canvas.height = 0; });
    })().catch(err => { if (alive && err.name !== 'RenderingCancelledException') setError(errorMessage(err, 'No se pudo comparar esta página.')); });
    return () => { alive = false; renders.forEach(render => render.cancel()); };
  }, [pair, page, mode]);
  const differences = pair ? compareText(pair.beforeText[page - 1] || '', pair.afterText[page - 1] || '') : [];
  return <div className="compare-documents">
    <FilePicker label="Segundo PDF" buttonText="Elegir PDF" accept=".pdf,application/pdf" selectedName={file?.name} disabled={busy} onSelect={files => setFile(files[0])} />
    <label className="compare-password">Contraseña del segundo PDF (si tiene)<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>
    <button className="primary-button" disabled={!file || busy} onClick={() => void compare()}>{busy && <LoaderCircle size={16} className="spin" />}Comparar</button>
    {error && <p className="operation-error" role="alert">{error}</p>}
    {pair && <><div className="compare-controls"><label>Página<select aria-label="Página de comparación" value={page} onChange={e => setPage(Number(e.target.value))}>{Array.from({ length: Math.max(pair.before.numPages, pair.after.numPages) }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label><label>Comparación<select aria-label="Comparación" value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="visual">Visual</option><option value="text">Texto</option></select></label></div>
      {mode === 'text' ? <div className="text-differences">{differences.some(change => change.kind !== 'same') ? differences.map((change, index) => <p className={change.kind} key={index}><span>{change.kind === 'added' ? '+' : change.kind === 'removed' ? '−' : ''}</span>{change.text}</p>) : <p>Sin diferencias en el texto de esta página.</p>}</div> :
        images.length ? <><p className="area-label">{pixels === 0 ? 'Sin diferencias visuales en esta página.' : `${pixels?.toLocaleString('es')} píxeles diferentes en la vista comparada.`}</p><div className="visual-comparison">{[doc.name, pair.name, 'Diferencias'].map((name, index) => <figure key={index}><figcaption title={name}>{name}</figcaption><img src={images[index]} alt={`Página ${page}: ${name}`} /></figure>)}</div></> : <p className="operation-loading"><LoaderCircle size={16} className="spin" />Comparando página…</p>}
    </>}
  </div>;
}
