import { BookOpen, GraduationCap, Highlighter, Moon, MoveVertical, Sparkles } from 'lucide-react';
import Modal from './Modal';

const KEY = 'folio.whatsNew', RELEASE = '2026-10-library';
/** Shown once to people updating, not on a first launch or under automation. */
export function shouldShowWhatsNew() {
  try {
    if (navigator.webdriver || localStorage.getItem(KEY) === RELEASE) return false;
    // A first launch has no history to compare with: just remember this release.
    if (!localStorage.getItem('folio.readingPreferences') && !localStorage.getItem('folio.themeChoice')) { localStorage.setItem(KEY, RELEASE); return false; }
    return true;
  } catch { return false; }
}

export function WhatsNew({ touch, onClose }: { touch: boolean; onClose: () => void }) {
  const close = () => { try { localStorage.setItem(KEY, RELEASE); } catch { /* Shown again next time. */ } onClose(); };
  const items: [React.ReactNode, string, string][] = [
    [<BookOpen size={20} />, 'Biblioteca con portadas', 'Retoma donde lo dejaste, ve tu progreso, marca favoritos y ordena tus PDF.'],
    [<MoveVertical size={20} />, touch ? 'Salta de página deslizando' : 'Navega más rápido', touch ? 'Al desplazarte aparece un deslizador en el borde derecho con vista previa. Doble toque para ampliar.' : 'Ctrl+K abre la paleta de comandos: acciones, páginas, capítulos y documentos.'],
    [<Highlighter size={20} />, 'Resaltado inteligente', 'Respeta columnas y tablas, completa palabras, une resaltados del mismo color y cada color tiene un significado.'],
    [<GraduationCap size={20} />, 'Estudia tus anotaciones', 'Filtra por color, busca, exporta un resumen o crea tarjetas para Anki.'],
    [<Moon size={20} />, 'Lee de noche', 'En Vista del documento elige páginas en sepia u oscuras; la pantalla se mantiene encendida mientras lees.'],
  ];
  return <Modal title="Novedades de Folio" onClose={close} className="whats-new-modal">
    <div className="whats-new-hero"><Sparkles size={22} /><p>Folio se ha renovado para que leer y estudiar sea más rápido y cómodo.</p></div>
    <ul className="whats-new-list">{items.map(([icon, title, text]) => <li key={title}><span aria-hidden="true">{icon}</span><div><strong>{title}</strong><p>{text}</p></div></li>)}</ul>
    <div className="modal-actions"><button className="primary-button" onClick={close}>Empezar</button></div>
  </Modal>;
}
