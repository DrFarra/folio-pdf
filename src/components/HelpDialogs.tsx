import { Highlighter, Layers, ShieldCheck } from 'lucide-react';
import Modal from './Modal';
import { fileSaveLabel, here, redoShortcut, savesInPlace } from '../app/model';
import { isDesktop, isIOS, isMac, isNative, shortcutLabel } from '../platform';

// The help's summary of the shortcuts. Browsers keep Ctrl+W and Ctrl+Tab for their own tabs.
const summary = [
  ['Paleta de comandos', shortcutLabel('K')],
  ['Abrir PDF', shortcutLabel('O')],
  ['Buscar', shortcutLabel('F')],
  [fileSaveLabel, shortcutLabel('S')],
  ...(isNative ? [['Guardar una copia…', shortcutLabel('S', true)]] : []),
  ['Imprimir', shortcutLabel('P')],
  ['Deshacer', shortcutLabel('Z')],
  ['Rehacer', redoShortcut],
  ...(isDesktop
    ? [
        ['Cambiar de pestaña', isMac ? '⌃Tab' : 'Ctrl+Tab'],
        ['Cerrar pestaña', shortcutLabel('W')],
      ]
    : []),
  ['Cambiar de página', '← / →'],
  ['Zoom', isMac || isIOS ? '⌘+ / ⌘−' : 'Ctrl + / Ctrl −'],
  ['Tamaño real', shortcutLabel('0')],
  ['Seleccionar texto', 'V'],
  ['Resaltador', 'H'],
  ['Nota', 'N'],
  ['Lápiz', 'D'],
  ['Salir de una herramienta', 'Esc'],
];

// Every shortcut, by group, as «?» lists them.
const groups: [string, [string, string[]][]][] = [
  [
    'General',
    [
      ['Paleta de comandos', [shortcutLabel('K')]],
      ['Abrir PDF', [shortcutLabel('O')]],
      ['Guardar', [shortcutLabel('S')]],
      ['Imprimir', [shortcutLabel('P')]],
      ['Buscar en el PDF', [shortcutLabel('F')]],
      ['Cerrar documento', [shortcutLabel('W')]],
      ['Atajos de teclado', ['?']],
    ],
  ],
  [
    'Lectura',
    [
      ['Página siguiente', ['→', 'AvPág']],
      ['Página anterior', ['←', 'RePág']],
      ['Acercar', [shortcutLabel('+')]],
      ['Alejar', [shortcutLabel('-')]],
      ['Tamaño real', [shortcutLabel('0')]],
      ['Siguiente pestaña', ['Ctrl+Tab']],
    ],
  ],
  [
    'Anotar',
    [
      ['Seleccionar texto', ['V']],
      ['Resaltador', ['H']],
      ['Nota', ['N']],
      ['Lápiz', ['D']],
      ['Deshacer', [shortcutLabel('Z')]],
      ['Rehacer', [shortcutLabel('Z', true)]],
      ['Salir de la herramienta', ['Esc']],
    ],
  ],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Atajos de teclado" className="shortcuts-modal" onClose={onClose}>
      <div className="shortcuts-grid">
        {groups.map(([group, items]) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {items.map(([label, keys]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {keys.map(key => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

export function HelpDialog({ touch, onClose }: { touch: boolean; onClose: () => void }) {
  return (
    <Modal title={touch ? 'Ayuda' : 'Ayuda y atajos'} onClose={onClose} className="help-modal">
      <div className="help-feature">
        <Highlighter size={21} />
        <div>
          <strong>Anotar</strong>
          <p>
            {touch
              ? 'Mantén pulsado el texto para copiarlo, resaltarlo o comentarlo. Anotar muestra el resaltador, las notas, el lápiz y la goma; Listo vuelve a la lectura. Toca un resaltado para cambiar su color, comentarlo o borrarlo.'
              : 'Selecciona texto para copiarlo, resaltarlo o comentarlo. Anotar muestra el resaltador, las notas, el lápiz y la goma. Con el resaltador activo, cada selección queda resaltada; haz clic en un resaltado para cambiarlo o borrarlo.'}
          </p>
        </div>
      </div>
      <div className="help-feature">
        <ShieldCheck size={21} />
        <div>
          <strong>Guardar cambios</strong>
          <p>
            Los cambios se conservan en {here}.{' '}
            {savesInPlace
              ? `Guardar${touch ? '' : ` (${shortcutLabel('S')})`} actualiza el PDF original; Guardar una copia crea otro archivo.`
              : `Para tenerlos en un PDF, usa ${fileSaveLabel}${touch ? ' o Compartir' : ` (${shortcutLabel('S')})`}.`}
          </p>
        </div>
      </div>
      {touch ? (
        <div className="help-feature">
          <Layers size={21} />
          <div>
            <strong>Navegar</strong>
            <p>
              Toca el nombre del documento para cambiar de PDF. Páginas reúne miniaturas, índice, marcadores y
              anotaciones. Toca el número de página para ir a otra. Pellizca para ampliar y toca el PDF para ocultar o
              mostrar los controles.
            </p>
          </div>
        </div>
      ) : (
        <>
          <h3 className="shortcuts-heading">Atajos de teclado</h3>
          <div className="shortcut-grid">
            {summary.map(([label, keys]) => (
              <div key={label}>
                <span>{label}</span>
                <kbd>{keys}</kbd>
              </div>
            ))}
          </div>
          <p className="help-limit">
            Usa Herramientas para editar, organizar páginas, rellenar formularios, reconocer texto, comparar documentos
            o trabajar con firmas.
          </p>
        </>
      )}
    </Modal>
  );
}
