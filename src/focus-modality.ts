// Browsers can keep :focus-visible active for a mouse click made while Ctrl or
// Meta is held. Track the actual interaction so those clicks do not draw a
// keyboard focus ring, including when they open an auto-focused dialog.
export function installFocusModality(): () => void {
  const root = document.documentElement;
  const modifiers = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'CapsLock', 'NumLock', 'ScrollLock']);
  const pointer = () => { root.dataset.focusModality = 'pointer'; };
  const keyboard = (event: KeyboardEvent) => {
    if (!modifiers.has(event.key)) root.dataset.focusModality = 'keyboard';
  };
  // Start with native keyboard focus available for programmatic and assistive
  // navigation; only a real pointer interaction suppresses the outline.
  root.dataset.focusModality = 'keyboard';
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('keydown', keyboard, true);
  return () => {
    document.removeEventListener('pointerdown', pointer, true);
    document.removeEventListener('keydown', keyboard, true);
    delete root.dataset.focusModality;
  };
}
