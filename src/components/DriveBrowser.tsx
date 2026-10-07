import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Cloud, FileText, Folder, RefreshCw, Search, LogOut } from 'lucide-react';
import { driveCached, driveCancelConnect, driveConnect, driveDiscard, driveDisconnect, driveList, driveOpen, drivePendingOpen, driveStatus, driveSync, type DriveItem, type DriveOpened, type DriveProgress, type DriveStatus } from '../drive';
import { errorMessage } from '../errors';
import { formatSize } from '../pdf';
import './DriveBrowser.css';

// Conflicts are owned by the app so they survive leaving and reopening this screen.
// What the open card shows; the rate is smoothed so the time left does not jump around.
export type Transfer = { name: string; phase: DriveProgress['phase'] | 'open'; done: number; total: number; rate: number; at: number };
export function advance(transfer: Transfer, progress: DriveProgress): Transfer {
  const now = performance.now(), seconds = (now - transfer.at) / 1000;
  const sample = progress.phase === 'download' && transfer.phase === 'download' && seconds > 0 ? Math.max(0, progress.done - transfer.done) / seconds : 0;
  const rate = sample ? transfer.rate ? transfer.rate * .75 + sample * .25 : sample : transfer.rate;
  return { ...transfer, phase: progress.phase, done: progress.done, total: progress.total || transfer.total, rate, at: now };
}
function remaining(transfer: Transfer) {
  if (transfer.rate <= 0 || transfer.done < transfer.total * .03) return '';
  const seconds = Math.ceil((transfer.total - transfer.done) / transfer.rate);
  return seconds < 2 ? ' · casi listo' : seconds < 60 ? ` · quedan ${seconds} s` : ` · quedan ${Math.ceil(seconds / 60)} min`;
}
export function TransferCard({ transfer }: { transfer: Transfer }) {
  const downloading = transfer.phase === 'download' && transfer.total > 0, fraction = downloading ? Math.min(1, transfer.done / transfer.total) : 0;
  const title = { connect: 'Conectando con Google Drive…', download: 'Descargando…', verify: 'Comprobando el archivo…', open: 'Abriendo el PDF…' }[transfer.phase];
  return <div className="drive-transfer"><div className="drive-transfer-card" role="status" aria-live="polite">
    <div className="drive-transfer-file"><span><FileText size={22} /></span><div><strong>{transfer.name}</strong><p>{title}</p></div>{downloading && <b>{Math.floor(fraction * 100)} %</b>}</div>
    <div className={`drive-progress${downloading ? '' : ' indeterminate'}`} role="progressbar" aria-label={`Abrir ${transfer.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloading ? Math.floor(fraction * 100) : undefined}><span style={downloading ? { transform: `scaleX(${fraction})` } : undefined} /></div>
    <small>{downloading ? `${formatSize(transfer.done)} de ${formatSize(transfer.total)}${remaining(transfer)}` : transfer.total > 0 ? formatSize(transfer.total) : ' '}</small>
  </div></div>;
}
type Props = { onClose: () => void; onOpen: (file: DriveOpened, pending?: boolean) => Promise<void>; onSynced: (file: DriveOpened) => void; conflicts: string[]; onConflicts: React.Dispatch<React.SetStateAction<string[]>> };
export function DriveBrowser({ onClose, onOpen, onSynced, conflicts, onConflicts: setConflicts }: Props) {
  const [status, setStatus] = useState<DriveStatus>({ account: null, pending: [] });
  const [path, setPath] = useState([{ id: 'root', title: 'Mi unidad' }]);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [next, setNext] = useState<string>();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'drive' | 'cached'>('drive');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [discarding, setDiscarding] = useState('');
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const request = useRef(0);
  const connecting = busy === 'Esperando autorización de Google…';
  const folder = path.at(-1)!.id;
  const refreshStatus = async () => { const value = await driveStatus(); setStatus(value ?? { account: null, pending: [] }); return value; };
  const action = async (message: string, operation: () => Promise<void>) => {
    setBusy(message); setError(''); setNotice(''); setDiscarding('');
    // A cancelled connection is not an error.
    try { await operation(); } catch (e) { const text = errorMessage(e); if (/^Se canceló/.test(text)) setNotice(text); else setError(text); }
    finally { setBusy(''); }
  };
  const connect = () => void action('Esperando autorización de Google…', async () => { await driveConnect(); await refreshStatus(); });
  useEffect(() => { void action('Cargando Drive…', async () => { await refreshStatus(); }); }, []);
  async function list(more = false) {
    const id = ++request.current;
    setBusy('Cargando documentos…'); setError('');
    try {
      const result = mode === 'cached' ? await driveCached() : await driveList(folder, search, more ? next : undefined);
      if (id !== request.current) return;
      setItems(old => more ? [...old, ...(result.items || [])] : result.items || []);
      setNext('nextPageToken' in result ? result.nextPageToken : undefined);
    } catch (e) { if (id === request.current) { setError(errorMessage(e)); if (!more) setItems([]); } }
    finally { if (id === request.current) setBusy(''); }
  }
  useEffect(() => { setItems([]); setNext(undefined); if (status.account) void list(); return () => { request.current++; }; }, [status.account?.id, folder, search, mode]);
  const openFile = (item: DriveItem) => void action('Abriendo PDF de Drive…', async () => {
    const offline = mode === 'cached';
    setTransfer({ name: item.title, phase: offline ? 'open' : 'connect', done: 0, total: Number(item.fileSize || 0), rate: 0, at: performance.now() });
    try {
      const file = await driveOpen(item.id, offline, progress => setTransfer(current => current && advance(current, progress)));
      setTransfer(current => current && { ...current, phase: 'open' });
      await onOpen(file);
    } finally { setTransfer(null); }
  });
  async function sync(id: string, copy = false) {
    await action('Guardando en Google Drive…', async () => {
      const result = await driveSync(id, copy); setNotice(result.message);
      if (result.status === 'conflict') setConflicts(ids => [...new Set([...ids, id])]);
      else { setConflicts(ids => ids.filter(value => value !== id)); if (result.opened) onSynced(result.opened); await refreshStatus(); }
    });
  }
  return <section className="drive-browser" aria-label="Google Drive">
    <header><button className="drive-icon" onClick={() => { if (connecting) void driveCancelConnect().catch(() => {}); onClose(); }} disabled={!!busy && !connecting} aria-label="Volver a la biblioteca"><ArrowLeft /></button><div><h1><Cloud /> Google Drive</h1>{status.account && <p>{status.account.email}</p>}</div>
      {status.account && <button className="drive-icon" disabled={!!busy} aria-label="Desconectar Google Drive" onClick={() => void action('Desconectando…', async () => { await driveDisconnect(); setStatus({ account: null, pending: [] }); setItems([]); setNotice('Google Drive desconectado. Las copias locales y las ediciones pendientes se conservan.'); })}><LogOut /></button>}
    </header>
    {!status.account ? <div className="drive-welcome"><Cloud size={48} /><h2>Conecta Google Drive</h2><p>Abre los PDF de tu Drive y guarda los cambios en el mismo archivo.</p><button disabled={!!busy} onClick={connect}>Conectar Google Drive</button></div> : <>
      <nav className="drive-locations" aria-label="Ubicaciones de Drive"><button aria-pressed={mode === 'drive' && path[0].id === 'root'} disabled={!!busy} onClick={() => { setMode('drive'); setPath([{ id: 'root', title: 'Mi unidad' }]); setQuery(''); setSearch(''); }}>Mi unidad</button><button aria-pressed={mode === 'drive' && path[0].id === 'shared'} disabled={!!busy} onClick={() => { setMode('drive'); setPath([{ id: 'shared', title: 'Compartidos conmigo' }]); setQuery(''); setSearch(''); }}>Compartidos conmigo</button><button aria-pressed={mode === 'cached'} disabled={!!busy} onClick={() => setMode('cached')}>Sin conexión</button></nav>
      {status.pending.length > 0 && <section className="drive-pending" aria-label="Ediciones pendientes"><h2>Ediciones pendientes ({status.pending.length})</h2><p>Se conservan en este dispositivo hasta confirmar el guardado en Drive.</p>{status.pending.map(p => { const conflict = p.conflict || conflicts.includes(p.id); return <article key={p.id}><div><strong>{p.name}</strong><small>{new Date(p.created).toLocaleString('es')}</small>{conflict && <small>Este PDF cambió en Drive. Guarda tu versión como copia para no perder ninguna.</small>}</div><button disabled={!!busy} onClick={() => void action('Abriendo edición…', async () => { await onOpen(await drivePendingOpen(p.id), true); })}>Abrir edición</button><button disabled={!!busy} onClick={() => void sync(p.id)}>Reintentar</button>{conflict && <button disabled={!!busy} onClick={() => void sync(p.id, true)}>Guardar como copia</button>}<button disabled={!!busy} onClick={() => discarding === p.id ? void action('Descartando edición…', async () => { await driveDiscard(p.id); setConflicts(ids => ids.filter(value => value !== p.id)); await refreshStatus(); }) : setDiscarding(p.id)}>{discarding === p.id ? 'Confirmar: descartar' : 'Descartar edición'}</button></article>; })}</section>}
      {mode === 'drive' && <><nav className="drive-breadcrumbs" aria-label="Carpeta actual">{path.map((part, i) => <span key={part.id}>{i > 0 && <ChevronRight size={16} />}<button disabled={!!busy} onClick={() => { setPath(path.slice(0, i + 1)); setSearch(''); setQuery(''); }}>{part.title}</button></span>)}</nav><form className="drive-search" onSubmit={e => { e.preventDefault(); setSearch(query); }}><Search size={18} /><input aria-label="Buscar en esta carpeta" placeholder="Buscar en esta carpeta" value={query} onChange={e => setQuery(e.target.value)} /><button disabled={!!busy}>Buscar</button></form></>}
      <div className="drive-list-heading"><p>{mode === 'cached' ? 'PDF descargados en este dispositivo' : 'Carpetas y documentos PDF'}</p><button className="drive-icon" disabled={!!busy} aria-label="Actualizar Drive" onClick={() => void list()}><RefreshCw size={18} /></button></div>
      <ul className="drive-files">{items.map(item => { const directory = item.mimeType === 'application/vnd.google-apps.folder'; return <li key={item.id}><button disabled={!!busy} onClick={() => directory ? (setPath(p => [...p, { id: item.id, title: item.title }]), setQuery(''), setSearch('')) : openFile(item)}>{directory ? <Folder /> : <FileText />}<span>{item.title}<small>{directory ? 'Carpeta' : `${formatSize(Number(item.fileSize || 0))}${item.editable === false ? ' · Solo lectura' : ''}`}</small></span><ChevronRight size={18} /></button></li>; })}</ul>
      {!busy && !error && items.length === 0 && <p className="drive-empty">{mode === 'cached' ? 'Los PDF que abras desde Drive aparecerán aquí.' : search ? `Ningún PDF ni carpeta coincide con «${search}».` : 'Esta carpeta no tiene PDF ni subcarpetas.'}</p>}
      {next && <button disabled={!!busy} onClick={() => void list(true)}>Cargar más</button>}
    </>}
    {transfer && <TransferCard transfer={transfer} />}
    {busy && !transfer && <p role="status">{busy}{connecting && <> <button onClick={() => void driveCancelConnect().catch(() => {})}>Cancelar</button></>}</p>}{notice && <p className="drive-notice" role="status">{notice}</p>}{error && <div className="drive-error" role="alert"><p>{error}</p>{status.account && /venció|Inicia sesión/i.test(error) && <button disabled={!!busy} onClick={connect}>Volver a conectar Google Drive</button>}</div>}
  </section>;
}
