// Included by the native-qa Cargo feature only, before the application frontend.
// Reports use the QA-only native data directory and fixture documents on CI.
(() => {
  const buildMarker = 'FOLIO_NATIVE_QA_BUILD';
  const id = 'f'.repeat(64), errors = [], documents = {};
  let saving = false, lastRevision = Date.now(), persistError = null;
  let iosNative = null;
  let activeSince = Date.now(), lastActive = '', probing = false;
  const now = () => Date.now();
  const text = (value, limit = 6000) => String(value ?? '').slice(0, limit);
  const describe = (value, depth = 0, seen = new Set()) => {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object') return text(value);
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const error = {};
    for (const key of ['name', 'message', 'stack', 'code']) {
      try { if (value[key] !== undefined) error[key] = text(value[key], key === 'stack' ? 12000 : 6000); } catch {}
    }
    if (Object.keys(error).length) {
      if (depth < 3 && value.cause !== undefined) error.cause = describe(value.cause, depth + 1, seen);
      return error;
    }
    if (depth >= 3) return text(Object.prototype.toString.call(value));
    if (Array.isArray(value)) return value.slice(0, 12).map(item => describe(item, depth + 1, seen));
    const result = {};
    for (const key of Object.keys(value).slice(0, 16)) {
      try { result[key] = describe(value[key], depth + 1, seen); } catch {}
    }
    return result;
  };
  const activeName = () => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label') || '';
  const record = (kind, values) => {
    errors.push({ kind, at: now(), active: activeName(), values: values.map(value => describe(value)) });
    if (errors.length > 100) errors.shift();
  };
  const originalError = console.error.bind(console);
  console.error = (...values) => { record('console.error', values); originalError(...values); };
  window.addEventListener('error', event => record('window.error', [event.error || event.message, { filename: event.filename, line: event.lineno, column: event.colno }]));
  window.addEventListener('unhandledrejection', event => record('unhandledrejection', [event.reason]));
  const rectangle = element => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft };
  };
  const snapshot = () => {
    const layers = Array.from(document.querySelectorAll('.textLayer'));
    const spans = layers.flatMap(layer => Array.from(layer.querySelectorAll('span')).filter(span => span.textContent?.trim()));
    return {
      at: now(), title: document.title, active: activeName(), url: location.href,
      tabs: Array.from(document.querySelectorAll('[role="tab"]')).map(tab => ({ name: tab.getAttribute('aria-label'), selected: tab.getAttribute('aria-selected'), rectangle: rectangle(tab) })),
      alerts: Array.from(document.querySelectorAll('[role="alert"], .toast')).map(alert => text(alert.textContent, 1600)),
      textLayerCount: layers.length, textSpanCount: spans.length,
      textLayerTexts: spans.slice(0, 40).map(span => text(span.textContent, 300)),
      canvasCount: document.querySelectorAll('.pdf-page canvas').length,
      loading: !!document.querySelector('.loading-overlay'),
      search: { query: document.querySelector('[aria-label="Buscar texto en el PDF"]')?.value || '',
        summary: text(document.querySelector('.search-summary')?.textContent, 1000),
        resultCount: document.querySelectorAll('.search-result').length },
      selection: text(window.getSelection()?.toString(), 1000),
      header: rectangle(document.querySelector('.app-header')),
      strip: rectangle(document.querySelector('.document-tab-strip')),
      document: { width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, innerWidth, height: innerHeight },
    };
  };
  const persist = async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke || saving) return;
    saving = true;
    const revision = lastRevision = Math.max(now(), lastRevision + 1);
    try {
      await invoke('store_session', { id, session: { version: 1, nativeQA: true, buildMarker, revision,
        snapshot: snapshot(), errors: errors.slice(), documents, persistError, iosNative } });
      persistError = null;
    } catch (error) { persistError = describe(error); }
    finally { saving = false; }
  };
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const search = async query => {
    let input = document.querySelector('[aria-label="Buscar texto en el PDF"]');
    if (!input) document.querySelector('button[aria-label="Buscar en el PDF"]')?.click();
    for (let n = 0; n < 30 && !input; n++) { await pause(100); input = document.querySelector('[aria-label="Buscar texto en el PDF"]'); }
    if (!input) return { query, found: false, error: 'Search input was not mounted.' };
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let n = 0; n < 60; n++) {
      await pause(100);
      const state = snapshot().search;
      if (state.query === query && !state.summary.includes('Preparando')) {
        return { ...state, found: state.resultCount > 0 };
      }
    }
    return { ...snapshot().search, found: false, error: 'Search indexing did not settle.' };
  };
  const probe = async () => {
    const state = snapshot(), name = state.active;
    if (!name || state.loading || probing || documents[name]?.checksCompleted) return;
    if (name !== lastActive) { lastActive = name; activeSince = now(); return; }
    if (now() - activeSince < 1800) return;
    // Record absent layers too. Waiting forever for text would hide the failure
    // this QA build exists to diagnose.
    probing = true;
    const report = documents[name] = { startedAt: now(), before: state, checksCompleted: false };
    try {
      const span = Array.from(document.querySelectorAll('.textLayer span')).find(node => node.textContent?.trim());
      if (span?.firstChild) {
        const range = document.createRange(); range.selectNodeContents(span);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        report.selectedText = text(selection.toString(), 1000);
        report.selectionMatchesSpan = selection.toString() === span.textContent;
        selection.removeAllRanges();
      } else { report.selectedText = ''; report.selectionMatchesSpan = false; }
      report.search = await search('Folio');
      if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
        iosNative = await window.__TAURI_INTERNALS__.invoke('ios_native_status');
        if (report.selectedText) {
          await window.__TAURI_INTERNALS__.invoke('copy_text', { text: report.selectedText });
          report.nativeClipboardWritten = true;
        }
      }
      report.after = snapshot();
      report.errors = errors.filter(error => error.active === name);
    } catch (error) { report.error = describe(error); }
    finally {
      report.finishedAt = now(); report.checksCompleted = true; probing = false;
      await persist();
    }
  };
  window.__FOLIO_NATIVE_QA__ = { snapshot, search, probe, persist };
  setInterval(() => { void persist(); void probe(); }, 500);
})();
