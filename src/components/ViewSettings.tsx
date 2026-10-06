import { Check, RotateCw } from 'lucide-react';
import Modal from './Modal';
import type { ReadingPreferences } from '../reading-preferences';
import './ReadingSettings.css';

type Props = {
  touch: boolean;
  mode: ReadingPreferences['mode']; onMode: (value: ReadingPreferences['mode']) => void;
  zoom: string; scale: number; onZoom: (value: string) => void;
  rotation: number; onRotate: () => void; onClose: () => void;
};
export default function ViewSettings(props: Props) {
  const zoom = props.zoom === 'custom' ? String(Math.round(props.scale * 100)) : props.zoom;
  // A fitted zoom is not a fixed value: only a custom zoom joins the list.
  const values = [...new Set([50, 75, 100, 125, 150, 200, 300, ...props.zoom === 'custom' ? [Math.round(props.scale * 100)] : []])].sort((a, b) => a - b);
  return <Modal title="Vista del documento" onClose={props.onClose} className="view-settings-modal">
    <label className="reading-setting"><span>Desplazamiento</span><select aria-label="Modo de desplazamiento" value={props.mode} onChange={event => props.onMode(event.target.value as ReadingPreferences['mode'])}><option value="continuous">Continuo</option><option value="single">Una página</option></select></label>
    <label className="reading-setting"><span>Zoom</span><select aria-label="Nivel de zoom" value={zoom} onChange={event => props.onZoom(event.target.value)}><option value="page">Ajustar página</option><option value="width">Ajustar ancho</option>{values.map(value => <option key={value} value={String(value)}>{value} %</option>)}</select></label>
    <button className="secondary-button view-rotate" onClick={props.onRotate}><RotateCw size={18} />Girar vista · {props.rotation}°</button>
    {props.touch && props.mode === 'single' && <p className="modal-description">Desliza a los lados para cambiar de página.</p>}
    <div className="modal-actions"><button className="primary-button" onClick={props.onClose}><Check size={16} />Listo</button></div>
  </Modal>;
}
