import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Cloud, FileText, Folder, RefreshCw, Search, LogOut } from 'lucide-react';
import { driveCached, driveCancelConnect, driveConnect, driveDiscard, driveDisconnect, driveList, driveOpen, drivePendingOpen, driveStatus, driveSync, type DriveItem, type DriveOpened, type DriveStatus } from '../drive';
import { errorMessage } from '../errors';
import { formatSize } from '../pdf';
import './DriveBrowser.css';

// Conflicts are owned by the app so they survive leaving and reopening this screen.
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
      <ul className="drive-files">{items.map(item => { const directory = item.mimeType === 'application/vnd.google-apps.folder'; return <li key={item.id}><button disabled={!!busy} onClick={() => directory ? (setPath(p => [...p, { id: item.id, title: item.title }]), setQuery(''), setSearch('')) : void action('Abriendo PDF de Drive…', async () => { await onOpen(await driveOpen(item.id, mode === 'cached')); })}>{directory ? <Folder /> : <FileText />}<span>{item.title}<small>{directory ? 'Carpeta' : `${formatSize(Number(item.fileSize || 0))}${item.editable === false ? ' · Solo lectura' : ''}`}</small></span><ChevronRight size={18} /></button></li>; })}</ul>
      {!busy && !error && items.length === 0 && <p className="drive-empty">{mode === 'cached' ? 'Los PDF que abras desde Drive aparecerán aquí.' : search ? `Ningún PDF ni carpeta coincide con «${search}».` : 'Esta carpeta no tiene PDF ni subcarpetas.'}</p>}
      {next && <button disabled={!!busy} onClick={() => void list(true)}>Cargar más</button>}
    </>}
    {busy && <p role="status">{busy}{connecting && <> <button onClick={() => void driveCancelConnect().catch(() => {})}>Cancelar</button></>}</p>}{notice && <p className="drive-notice" role="status">{notice}</p>}{error && <div className="drive-error" role="alert"><p>{error}</p>{status.account && /venció|Inicia sesión/i.test(error) && <button disabled={!!busy} onClick={connect}>Volver a conectar Google Drive</button>}</div>}
  </section>;
}
