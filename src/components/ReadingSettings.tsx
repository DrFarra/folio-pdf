import { Check, Monitor, Moon, Sun, Trash2 } from 'lucide-react';
import Modal from './Modal';
import type { ReadingPreferences } from '../reading-preferences';
import './ReadingSettings.css';

type Props = {
  phone?: boolean;
  theme: string; onTheme: (value: string) => void;
  zoom: string; onZoom: (value: string) => void;
  preferences: ReadingPreferences; onPreferences: (value: ReadingPreferences) => void;
  rememberRecent: boolean; onRemember: (value: boolean) => void;
  confirmClear: boolean; onClear: () => void; onCancelClear: () => void; onClose: () => void;
};
export default function ReadingSettings(props: Props) {
  const { preferences: prefs } = props;
  const update = <K extends keyof ReadingPreferences>(key: K, value: ReadingPreferences[K]) => props.onPreferences({ ...prefs, [key]: value });
  return <Modal title="Preferencias de lectura" onClose={props.onClose} className="settings-modal">
    <h3>Apariencia</h3>
    <div className="settings-options settings-theme">{[['light', 'Claro', Sun], ['dark', 'Oscuro', Moon], ['system', 'Sistema', Monitor]].map(([value, label, Icon]) => {
      const Component = Icon as typeof Sun;
      return <button key={value as string} aria-pressed={props.theme === value} className={props.theme === value ? 'selected' : ''} onClick={() => props.onTheme(value as string)}><Component size={18} /><span>{label as string}</span></button>;
    })}</div>
    <h3>Lectura</h3>
    <label className="reading-setting"><span>Zoom inicial</span><select aria-label="Zoom inicial" value={props.zoom} onChange={event => props.onZoom(event.target.value)}><option value="page">Ajustar página</option><option value="width">Ajustar ancho</option>{[50, 75, 100, 125, 150, 200, 300].map(value => <option key={value} value={String(value)}>{value} %</option>)}</select></label>
    <label className="reading-setting"><span>Desplazamiento</span><select aria-label="Modo de desplazamiento" value={prefs.mode} onChange={event => update('mode', event.target.value as ReadingPreferences['mode'])}><option value="continuous">Continuo</option><option value="single">Una página</option></select></label>
    {!props.phone && <label className="reading-setting"><span>Zoom con rueda</span><select aria-label="Velocidad de zoom con rueda" value={prefs.wheelSpeed} onChange={event => update('wheelSpeed', Number(event.target.value))}><option value="50">Lento</option><option value="100">Normal</option><option value="150">Rápido</option></select></label>}
    <label className="reading-setting"><span>Separación entre páginas</span><div className="reading-range"><input aria-label="Separación entre páginas" type="range" min="8" max="40" value={prefs.pageGap} onChange={event => update('pageGap', Number(event.target.value))} /><output>{prefs.pageGap} px</output></div></label>
    <label className="settings-toggle"><span>Animar al cambiar de página</span><input type="checkbox" checked={prefs.smoothScroll} onChange={event => update('smoothScroll', event.target.checked)} /></label>
    <label className="settings-toggle"><span>Reabrir en la última página</span><input type="checkbox" checked={prefs.restorePage} onChange={event => update('restorePage', event.target.checked)} /></label>
    <h3>Panel lateral</h3>
    <label className="reading-setting"><span>Al abrir un documento</span><select aria-label="Panel inicial" value={prefs.initialPanel} onChange={event => update('initialPanel', event.target.value as ReadingPreferences['initialPanel'])}><option value="closed">Cerrado</option><option value="pages">Páginas</option><option value="outline">Índice</option><option value="bookmarks">Marcadores</option></select></label>
    {!props.phone && <label className="reading-setting"><span>Ancho del panel</span><div className="reading-range"><input aria-label="Ancho del panel" type="range" min="180" max="360" step="10" value={prefs.panelWidth} onChange={event => update('panelWidth', Number(event.target.value))} /><output>{prefs.panelWidth} px</output></div></label>}
    <h3>Archivos locales</h3>
    <label className="settings-toggle"><span>Recordar documentos recientes</span><input type="checkbox" checked={props.rememberRecent} onChange={event => props.onRemember(event.target.checked)} aria-label={props.phone ? 'Guardar documentos recientes en este dispositivo' : 'Guardar documentos recientes en este navegador'} /></label>
    <button className={`clear-library ${props.confirmClear ? 'confirm' : ''}`} onClick={props.onClear}><Trash2 size={16} /><span>{props.confirmClear ? 'Confirmar: eliminar archivos y anotaciones locales' : 'Eliminar biblioteca y anotaciones locales'}</span></button>
    {props.confirmClear && <button className="text-button" onClick={props.onCancelClear}>Cancelar eliminación</button>}
    <div className="modal-actions"><button className="primary-button" onClick={props.onClose}><Check size={15} />Listo</button></div>
  </Modal>;
}
