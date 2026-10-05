// Exercise the QA bootstrap's one-shot scheduling without a simulator clock.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src-tauri/src/native_qa.js', import.meta.url), 'utf8');
function harness() {
  let at = 1000, session, selected = '';
  const state = { text: false, rendered: false, rendering: true };
  const span = { textContent: 'Folio fixture', firstChild: {} };
  class Input { set value(value) { this.currentValue = value; } get value() { return this.currentValue || ''; } dispatchEvent() {} }
  const input = new Input();
  const document = {
    title: 'Folio', documentElement: { clientWidth: 402, scrollWidth: 402 },
    querySelector(selector) {
      if (selector === '.phone-layout' || selector === '.pdf-page') return {};
      if (selector === '.app-header h1') return { textContent: 'Folio.pdf' };
      if (selector === '[aria-label="Buscar texto en el PDF"]') return input;
      if (selector === '.search-summary') return { textContent: '1 coincidencia' };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.textLayer') return [{ querySelectorAll: () => state.text ? [span] : [] }];
      if (selector === '.textLayer span') return state.text ? [span] : [];
      if (selector === '.pdf-page canvas') return [{}];
      if (selector === '.pdf-page canvas[data-rendering="false"]') return state.rendered ? [{}] : [];
      if (selector === '.pdf-page canvas[data-rendering="true"]') return state.rendering ? [{}] : [];
      if (selector === '.search-result') return input.value ? [{}] : [];
      return [];
    },
    createRange: () => ({ selectNodeContents(node) { selected = node.textContent; } }),
  };
  const window = {
    addEventListener() {},
    getSelection: () => ({ toString: () => selected, removeAllRanges() {}, addRange() {} }),
    __TAURI_INTERNALS__: { async invoke(command, args) {
      assert.equal(command, 'store_session'); session = structuredClone(args.session);
    } },
  };
  vm.runInNewContext(source, {
    window, document, navigator: { userAgent: 'Mac QA fixture' }, location: { href: 'tauri://localhost' },
    Date: class extends Date { static now() { return at; } }, console: { error() {} },
    innerWidth: 402, innerHeight: 874, HTMLInputElement: Input, Event: class {},
    setInterval() {}, setTimeout(callback) { callback(); },
  });
  return { state, advance(ms) { at += ms; }, async probe() {
    await window.__FOLIO_NATIVE_QA__.probe(); await window.__FOLIO_NATIVE_QA__.persist();
    return session;
  } };
}

const cold = harness();
await cold.probe(); cold.advance(2500);
assert.deepEqual((await cold.probe()).documents, {}, 'A mounted reader must not consume the selection probe while its page renders.');
cold.state.rendered = true; cold.state.rendering = false; cold.advance(2500);
assert.deepEqual((await cold.probe()).documents, {}, 'Raster alone is insufficient before text is published.');
cold.state.text = true;
const ready = (await cold.probe()).documents['Folio.pdf'];
assert.equal(ready.checksCompleted, true);
assert.equal(ready.selectionMatchesSpan, true);
assert.equal(ready.search.found, true);
assert.equal(ready.error, undefined);

const stuck = harness();
await stuck.probe(); stuck.advance(30500);
const failed = (await stuck.probe()).documents['Folio.pdf'];
assert.equal(failed.checksCompleted, true, 'Missing text must finish with a diagnostic instead of waiting forever.');
assert.match(failed.error.message, /within 30 seconds/);
assert.equal(failed.before.textSpanCount, 0);
console.log('Native QA: waits for raster and text, then selects/searches; missing content fails within the deadline.');
