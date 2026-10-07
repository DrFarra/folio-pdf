import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { isDesktop, isNative } from './platform';

// iOS WebKit reports focus moved by the app (a dialog focusing its close
// button) as :focus-visible even after a tap. On touch layouts the ring waits
// for keys that navigate a hardware keyboard; the on-screen keyboard sends none.
const navigationKeys = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
addEventListener('keydown', event => { if (navigationKeys.has(event.key)) document.documentElement.dataset.keyboard = 'true'; }, true);
addEventListener('pointerdown', () => { delete document.documentElement.dataset.keyboard; }, true);
// Pinching zooms the PDF, never the interface (Safari ignores user-scalable=no).
addEventListener('gesturestart', event => event.preventDefault(), { passive: false });

// A failed render must not leave a blank, frameless window: offer a reload and,
// in the desktop app, a way to close it.
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('Folio: error en la interfaz.', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="welcome" role="alert" data-tauri-drag-region>
      <h2>Folio encontró un error</h2>
      <p>Tus documentos y los cambios guardados se conservan. Recarga Folio para seguir.</p>
      <button className="primary-button" onClick={() => location.reload()}>Recargar Folio</button>
      {isDesktop && <button className="text-button" onClick={() => void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().destroy())}>Cerrar Folio</button>}
    </div>;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>,
);

// The packaged desktop app has no browser chrome: its context menu would print
// or reload the interface, and a reload closes the documents opened from dialogs.
if (import.meta.env.PROD && isDesktop) {
  document.addEventListener('contextmenu', event => {
    if (!(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]')) && !getSelection()?.toString()) event.preventDefault();
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'F5' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') event.preventDefault();
  }, true);
}

if (import.meta.env.PROD && !isNative && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
