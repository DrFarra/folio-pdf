import { errorMessage } from './errors';
import { savesInPlace } from './app/model';
import { CloseBlockedDialog } from './components/DocumentDialogs';
import { readImage } from './edit/EditToolbar';
import './tabs.css';
import './mac-platform.css';
import './mobile.css';
import './desktop.css';
import './redesign-desktop.css';
import './redesign-touch.css';
import './tablet.css';
import './motion.css';
import { isDesktop, isMac } from './platform';
import { useFolio } from './app/use-folio';
import { FolioContext } from './app/folio-context';
import AppHeader from './components/shell/AppHeader';
import AppWorkspace from './components/shell/AppWorkspace';
import AppOverlays from './components/shell/AppOverlays';

/** Folio: its state and coordination (useFolio), shared with the view's parts through
 * FolioContext. The shell takes dropped files and holds the dialog shown when changes
 * could not be stored before closing. */
export default function App() {
  const folio = useFolio();
  const {
    closeBlocked,
    closeTab,
    doc,
    download,
    dragCounter,
    editing,
    library,
    notify,
    openFiles,
    phone,
    readerChromeHidden,
    readingPreferences,
    saveLabel,
    setCloseBlocked,
    setDragOver,
    tablet,
    windowState,
  } = folio;
  return (
    <FolioContext.Provider value={folio}>
      <div
        className={`app-shell page-tone-${readingPreferences.pageTone}${isDesktop && isMac ? ' native-mac' : ''}${isDesktop && isMac && windowState.fullscreen ? ' mac-fullscreen' : ''}${phone ? ' phone-layout' : tablet ? ' tablet-layout' : ''}${readerChromeHidden ? ' reader-chrome-hidden' : ''}${library ? ' library-visible' : ''}`}
        onDragEnter={e => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            dragCounter.current++;
            setDragOver(true);
          }
        }}
        onDragLeave={e => {
          e.preventDefault();
          if (--dragCounter.current <= 0) {
            dragCounter.current = 0;
            setDragOver(false);
          }
        }}
        onDragOver={e => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={e => {
          e.preventDefault();
          dragCounter.current = 0;
          setDragOver(false);
          const image = editing
              ? Array.from(e.dataTransfer.files).find(file => /^image\/(png|jpeg)$/.test(file.type))
              : undefined,
            point = { clientX: e.clientX, clientY: e.clientY };
          if (image) {
            void readImage(image)
              .then(value =>
                window.dispatchEvent(new CustomEvent('folio:edit-place-image', { detail: { image: value, ...point } })),
              )
              .catch(error => notify(errorMessage(error), 'error'));
            return;
          }
          if (!isDesktop) void openFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {closeBlocked && (
          <CloseBlockedDialog
            name={doc?.name}
            window={closeBlocked === 'window'}
            saveLabel={saveLabel}
            onBack={() => setCloseBlocked(null)}
            onSave={() => {
              setCloseBlocked(null);
              void download({ copy: !savesInPlace });
            }}
            onDiscard={() => {
              const key = closeBlocked;
              setCloseBlocked(null);
              if (key === 'window')
                void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().destroy());
              else requestAnimationFrame(() => void closeTab(key, true));
            }}
          />
        )}
        <AppHeader />
        <AppWorkspace />
        <AppOverlays />
      </div>
    </FolioContext.Provider>
  );
}
