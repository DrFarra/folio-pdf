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

/** Waits until finite animations (sheets sliding, menus growing) have finished,
 * so geometry checks measure the settled layout. Looping spinners are ignored. */
export async function settled(page) {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity));
}
