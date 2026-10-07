// Reach the real controls through the public document modes and action sheet.
export async function enterAnnotationMode(page) {
  const button = page.getByRole('button', { name: 'Anotar documento', exact: true });
  await button.waitFor();
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  await page.getByRole('toolbar', { name: 'Herramientas de anotación', exact: true }).waitFor();
}

export async function desktopDocumentAction(page, name) {
  await page.getByRole('button', { name: 'Más acciones del documento', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Acciones del documento', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name, exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}

// An Android tablet. The screen stays the device's while the viewport may be a
// rotated, split-screen or keyboard-shortened window, which remains tablet layout.
export const androidTabletAgent = 'Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
export function androidTablet(viewport = { width: 1280, height: 800 }, screen = viewport.width >= viewport.height ? { width: 1280, height: 800 } : { width: 800, height: 1280 }) {
  return { viewport, screen, isMobile: true, hasTouch: true, userAgent: androidTabletAgent };
}

// Touch layouts keep the Herramientas editor: on a tablet it opens from the
// document action sheet and stays in the reader.
export async function openTabletEditor(page) {
  await desktopDocumentAction(page, 'Editar PDF');
  await page.locator('main.reader .workspace-editor').waitFor();
}

// The web download from the tablet action sheet (the header is locked while editing).
export async function tabletDownload(page) {
  await page.getByRole('button', { name: 'Más acciones del documento', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Acciones del documento', exact: true }); await dialog.waitFor();
  const download = page.waitForEvent('download'); void download.catch(() => {});
  await dialog.getByRole('button', { name: 'Descargar PDF', exact: true }).click();
  return download;
}

/** Waits until finite animations (sheets sliding, menus growing) have finished,
 * so geometry checks measure the settled layout. Looping spinners are ignored. */
export async function settled(page) {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity));
}
