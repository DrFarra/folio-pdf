import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Cloud, FileText, Folder, RefreshCw, Search, LogOut } from 'lucide-react';
import { isNative } from '../platform';
import { driveCached, driveConnect, driveDisconnect, driveList, driveOpen, drivePendingOpen, driveStatus, driveSync, type DriveItem, type DriveOpened, type DriveStatus } from '../drive';
import './DriveBrowser.css';

export function DriveBrowser({ onClose, onOpen }: { onClose: () => void; onOpen: (file: DriveOpened, pending?: boolean) => Promise<void> }) {
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
  const [conflicts, setConflicts] = useState<string[]>([]);
  const request = useRef(0);
  const folder = path.at(-1)!.id;
  const refreshStatus = async () => { const value = await driveStatus(); setStatus(value); return value; };
  const action = async (message: string, operation: () => Promise<void>) => {
    setBusy(message); setError(''); setNotice('');
    try { await operation(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(''); }
  };
  useEffect(() => { if (isNative) void action('Cargando Drive…', async () => { await refreshStatus(); }); }, []);
  async function list(more = false) {
    const id = ++request.current;
    setBusy('Cargando documentos…'); setError('');
    try {
      const result = mode === 'cached' ? await driveCached() : await driveList(folder, search, more ? next : undefined);
      if (id !== request.current) return;
      setItems(old => more ? [...old, ...(result.items || [])] : result.items || []);
      setNext('nextPageToken' in result ? result.nextPageToken : undefined);
    } catch (e) { if (id === request.current) { setError(String(e)); if (!more) setItems([]); } }
    finally { if (id === request.current) setBusy(''); }
  }
  useEffect(() => { setItems([]); setNext(undefined); if (status.account) void list(); return () => { request.current++; }; }, [status.account?.id, folder, search, mode]);
  async function sync(id: string, copy = false) {
    await action('Guardando en Google Drive…', async () => {
      const result = await driveSync(id, copy); setNotice(result.message);
      if (result.status === 'conflict') setConflicts(ids => [...new Set([...ids, id])]);
      else { setConflicts(ids => ids.filter(value => value !== id)); await refreshStatus(); }
    });
  }
  return <section className="drive-browser" aria-label="Google Drive">
    <header><button className="drive-icon" onClick={onClose} disabled={!!busy} aria-label="Volver a Documentos"><ArrowLeft /></button><div><h1><Cloud /> Google Drive</h1><p>{status.account?.email || 'Tus carpetas y documentos, en todos tus dispositivos'}</p></div>
      {status.account && <button className="drive-icon" disabled={!!busy} aria-label="Desconectar Google Drive" onClick={() => void action('Desconectando…', async () => { await driveDisconnect(); setStatus({ account: null, pending: [] }); setItems([]); setNotice('Sesión desconectada. Las copias locales y ediciones pendientes se conservan.'); })}><LogOut /></button>}
    </header>
    {!isNative ? <p>Google Drive está disponible en la aplicación instalada de Folio.</p> : !status.account ? <div className="drive-welcome"><Cloud size={48} /><h2>Conecta tus documentos</h2><p>Explora las carpetas de tu Drive, abre tus PDF y guarda los cambios en el mismo archivo.</p><button disabled={!!busy} onClick={() => void action('Esperando autorización de Google…', async () => { await driveConnect(); await refreshStatus(); })}>Iniciar sesión con Google</button></div> : <>
      <nav className="drive-locations" aria-label="Ubicaciones de Drive"><button aria-pressed={mode === 'drive' && path[0].id === 'root'} disabled={!!busy} onClick={() => { setMode('drive'); setPath([{ id: 'root', title: 'Mi unidad' }]); setQuery(''); setSearch(''); }}>Mi unidad</button><button aria-pressed={mode === 'drive' && path[0].id === 'shared'} disabled={!!busy} onClick={() => { setMode('drive'); setPath([{ id: 'shared', title: 'Compartidos conmigo' }]); setQuery(''); setSearch(''); }}>Compartidos conmigo</button><button aria-pressed={mode === 'cached'} disabled={!!busy} onClick={() => setMode('cached')}>Sin conexión</button></nav>
      {status.pending.length > 0 && <section className="drive-pending" aria-label="Ediciones pendientes"><h2>Ediciones pendientes ({status.pending.length})</h2><p>Se conservan en este dispositivo hasta confirmar el guardado en Drive.</p>{status.pending.map(p => <article key={p.id}><div><strong>{p.name}</strong><small>{new Date(p.created).toLocaleString('es')}</small></div><button disabled={!!busy} onClick={() => void action('Abriendo edición…', async () => { await onOpen(await drivePendingOpen(p.id), true); })}>Abrir edición</button><button disabled={!!busy} onClick={() => void sync(p.id)}>Reintentar</button>{conflicts.includes(p.id) && <button disabled={!!busy} onClick={() => void sync(p.id, true)}>Guardar como copia de conflicto</button>}</article>)}</section>}
      {mode === 'drive' && <><nav className="drive-breadcrumbs" aria-label="Carpeta actual">{path.map((part, i) => <span key={part.id}>{i > 0 && <ChevronRight size={16} />}<button disabled={!!busy} onClick={() => { setPath(path.slice(0, i + 1)); setSearch(''); setQuery(''); }}>{part.title}</button></span>)}</nav><form className="drive-search" onSubmit={e => { e.preventDefault(); setSearch(query); }}><Search size={18} /><input aria-label="Buscar en esta carpeta" placeholder="Buscar en esta carpeta" value={query} onChange={e => setQuery(e.target.value)} /><button disabled={!!busy}>Buscar</button></form></>}
      <div className="drive-list-heading"><p>{mode === 'cached' ? 'PDF descargados en este dispositivo' : 'Carpetas y documentos PDF'}</p><button className="drive-icon" disabled={!!busy} aria-label="Actualizar Drive" onClick={() => void list()}><RefreshCw size={18} /></button></div>
      <ul className="drive-files">{items.map(item => { const directory = item.mimeType === 'application/vnd.google-apps.folder'; return <li key={item.id}><button disabled={!!busy} onClick={() => directory ? (setPath(p => [...p, { id: item.id, title: item.title }]), setQuery(''), setSearch('')) : void action('Abriendo PDF de Drive…', async () => { await onOpen(await driveOpen(item.id, mode === 'cached')); })}>{directory ? <Folder /> : <FileText />}<span>{item.title}<small>{directory ? 'Carpeta' : `${(Number(item.fileSize || 0) / 1048576).toLocaleString('es', { maximumFractionDigits: 1 })} MB${item.editable === false ? ' · Solo lectura' : ''}`}</small></span><ChevronRight size={18} /></button></li>; })}</ul>
      {!busy && !error && items.length === 0 && <p className="drive-empty">{mode === 'cached' ? 'Los PDF que abras desde Drive aparecerán aquí.' : 'No hay carpetas ni PDF que coincidan con esta búsqueda.'}</p>}
      {next && <button disabled={!!busy} onClick={() => void list(true)}>Cargar más</button>}
    </>}
    {busy && <p role="status">{busy}</p>}{notice && <p className="drive-notice" role="status">{notice}</p>}{error && <div className="drive-error" role="alert"><p>{error}</p>{status.account && <button disabled={!!busy} onClick={() => void action('Conectando…', async () => { await driveConnect(); await refreshStatus(); })}>Volver a conectar Google</button>}</div>}
  </section>;
}
