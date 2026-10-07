import { Check, Monitor, Moon, Sun, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { version } from '../../package.json';
import { assetUrl } from '../assets';
import { isDesktop, openExternalUrl } from '../platform';
import Modal from './Modal';
import type { ReadingPreferences } from '../reading-preferences';
import type { DeviceLayout } from '../mobile';
import './ReadingSettings.css';

type Props = {
  layout: DeviceLayout;
  theme: string; onTheme: (value: string) => void;
  zoom: string; onZoom: (value: string) => void;
  preferences: ReadingPreferences; onPreferences: (value: ReadingPreferences) => void;
  rememberRecent: boolean; onRemember: (value: boolean) => void; openDocuments: number;
  confirmClear: boolean; onClear: () => void; onCancelClear: () => void; onClose: () => void;
};
export default function ReadingSettings(props: Props) {
  const { preferences: prefs } = props, phone = props.layout === 'phone', desktop = props.layout === 'desktop';
  // The licence ships with the app, so it also opens offline; the full third-party notices are online.
  // Its hard-wrapped paragraphs are joined so they reflow to the dialog; indented lines keep their own.
  const [license, setLicense] = useState<{ text?: string; failed?: boolean } | null>(null);
  const showLicense = () => {
    setLicense({});
    void fetch(assetUrl('/licenses/LICENSE.txt')).then(response => response.ok ? response.text() : Promise.reject()).then(text => setLicense(current => current && { text: text.replace(/\r\n?/g, '\n').replace(/([^\n])\n(?=\S)/g, '$1 ') }), () => setLicense(current => current && { failed: true }));
  };
  const visit = (url: string) => { void openExternalUrl(url).catch(() => {}); };
  const update = <K extends keyof ReadingPreferences>(key: K, value: ReadingPreferences[K]) => props.onPreferences({ ...prefs, [key]: value });
  return <><Modal title="Ajustes" onClose={props.onClose} className="settings-modal">
    <h3>Apariencia</h3>
    <div className="settings-options settings-theme">{[['light', 'Claro', Sun], ['dark', 'Oscuro', Moon], ['system', 'Sistema', Monitor]].map(([value, label, Icon]) => {
      const Component = Icon as typeof Sun;
      return <button key={value as string} aria-pressed={props.theme === value} className={props.theme === value ? 'selected' : ''} onClick={() => props.onTheme(value as string)}><Component size={18} /><span>{label as string}</span></button>;
    })}</div>
    <h3>{phone ? 'Al abrir documentos' : 'Lectura'}</h3>
    <p className="modal-description">Se aplican al abrir un PDF. Para el documento abierto, usa {desktop ? 'la barra de herramientas o Más acciones' : 'Vista del documento'}.</p>
    <label className="reading-setting"><span>Zoom inicial</span><select aria-label="Zoom inicial" value={props.zoom} onChange={event => props.onZoom(event.target.value)}><option value="page">Ajustar página</option><option value="width">Ajustar ancho</option>{[50, 75, 100, 125, 150, 200, 300].map(value => <option key={value} value={String(value)}>{value} %</option>)}</select></label>
    <label className="reading-setting"><span>Desplazamiento</span><select aria-label="Modo de desplazamiento" value={prefs.mode} onChange={event => update('mode', event.target.value as ReadingPreferences['mode'])}><option value="continuous">Continuo</option><option value="single">Una página</option>{!phone && <option value="spread">Dos páginas</option>}</select></label>
    {desktop && <label className="reading-setting"><span>Zoom con rueda</span><select aria-label="Velocidad de zoom con rueda" value={prefs.wheelSpeed} onChange={event => update('wheelSpeed', Number(event.target.value))}><option value="50">Lento</option><option value="100">Normal</option><option value="150">Rápido</option></select></label>}
    <label className="reading-setting"><span>Separación entre páginas</span><div className="reading-range"><input aria-label="Separación entre páginas" type="range" min="8" max="40" value={prefs.pageGap} onChange={event => update('pageGap', Number(event.target.value))} /><output>{prefs.pageGap} px</output></div></label>
    <label className="settings-toggle"><span>Animar al cambiar de página</span><input type="checkbox" checked={prefs.smoothScroll} onChange={event => update('smoothScroll', event.target.checked)} /></label>
    <label className="settings-toggle"><span>Reabrir en la última página</span><input type="checkbox" checked={prefs.restorePage} onChange={event => update('restorePage', event.target.checked)} /></label>
    {/* Touch layouts open documents with the panel closed and size it to the screen. */}
    {desktop && <details className="settings-advanced" open><summary>Panel lateral</summary>
    <label className="reading-setting"><span>Al abrir un documento</span><select aria-label="Al abrir un documento" value={prefs.initialPanel} onChange={event => update('initialPanel', event.target.value as ReadingPreferences['initialPanel'])}><option value="closed">Cerrado</option><option value="pages">Páginas</option><option value="outline">Índice</option><option value="bookmarks">Marcadores</option></select></label>
    <label className="reading-setting"><span>Ancho del panel</span><div className="reading-range"><input aria-label="Ancho del panel" type="range" min="180" max="360" step="10" value={prefs.panelWidth} onChange={event => update('panelWidth', Number(event.target.value))} /><output>{prefs.panelWidth} px</output></div></label>
    </details>}
    <h3>Archivos locales</h3>
    <label className="settings-toggle"><span>Añadir a la biblioteca los PDF que abras</span><input type="checkbox" checked={props.rememberRecent} onChange={event => props.onRemember(event.target.checked)} /></label>
    <details className="settings-advanced"><summary>Eliminar datos locales</summary><p className="modal-description">{isDesktop ? 'Se vaciará la biblioteca y se eliminarán las anotaciones, marcadores y cambios guardados en este equipo.' : 'Se vaciará la biblioteca y se eliminarán sus copias, anotaciones, marcadores y cambios guardados.'} Los archivos originales no se modifican.</p>
    {props.confirmClear && props.openDocuments > 0 && <p className="modal-description">{props.openDocuments === 1 ? 'También se cerrará el documento abierto' : `También se cerrarán los ${props.openDocuments} documentos abiertos`} y perderás los cambios que no hayas guardado en un PDF.</p>}
    <button className={`clear-library ${props.confirmClear ? 'confirm' : ''}`} onClick={props.onClear}><Trash2 size={16} /><span>{!props.confirmClear ? 'Eliminar biblioteca y anotaciones locales' : props.openDocuments > 0 ? 'Eliminar y cerrar documentos' : 'Confirmar: eliminar biblioteca y anotaciones locales'}</span></button>
    {props.confirmClear && <button className="text-button" onClick={props.onCancelClear}>Cancelar eliminación</button>}
    </details>
    <h3>Acerca de Folio</h3>
    <p className="modal-description">Folio es software libre bajo la licencia AGPL-3.0 o posterior y se ofrece sin ninguna garantía.</p>
    <div className="settings-about-links">
      <button className="secondary-button" onClick={showLicense}>Ver licencia</button>
      <button className="secondary-button" onClick={() => visit(`https://raw.githubusercontent.com/FarraPY/folio-pdf/v${version}/THIRD-PARTY-NOTICES.txt`)}>Avisos de terceros</button>
      <button className="secondary-button" onClick={() => visit(`https://github.com/FarraPY/folio-pdf/releases/tag/v${version}`)}>Código fuente</button>
      {/* Desktop builds have no automatic updates: this opens the latest release. */}
      {isDesktop && <button className="secondary-button" onClick={() => visit('https://github.com/FarraPY/folio-pdf/releases/latest')}>Buscar actualizaciones</button>}
    </div>
    <div className="modal-actions"><span className="folio-version">Folio · {version}</span><button className="primary-button" onClick={props.onClose}><Check size={15} />Listo</button></div>
  </Modal>
  {license && <Modal title="Licencia de Folio" onClose={() => setLicense(null)} className="license-modal">
    {license.text ? <pre className="license-text">{license.text}</pre> : <p className="modal-description" role={license.failed ? 'alert' : 'status'}>{license.failed ? 'No se pudo abrir la licencia. Puedes leerla en gnu.org/licenses/agpl-3.0.' : 'Cargando la licencia…'}</p>}
  </Modal>}
  </>;
}
