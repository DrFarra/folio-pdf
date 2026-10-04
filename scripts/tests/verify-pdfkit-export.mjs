import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';

// An independent PDF engine verifies PDFKit's on-disk export. This also checks
// non-overlay annotations on unseen pages, which page_info deliberately omits.
const source = process.argv[2];
assert(source, 'Missing PDFKit export path.');
const descriptor = fs.openSync(source, 'r');
let closed = false, bytesRead = 0;
const stream = new mupdf.Stream({
  fileSize: () => fs.fstatSync(descriptor).size,
  read(memory, offset, length, position) { const count = fs.readSync(descriptor, memory, offset, length, position); bytesRead += count; return count; },
  close() { if (!closed) { closed = true; fs.closeSync(descriptor); } },
});
const doc = mupdf.Document.openDocument(stream, 'application/pdf');
assert.equal(doc.countPages(), 2);
const first = doc.loadPage(0), second = doc.loadPage(1);
const firstTypes = first.getAnnotations().map(annotation => annotation.getType());
const unseenTypes = second.getAnnotations().map(annotation => annotation.getType());
assert.equal(firstTypes.filter(type => type === 'Highlight').length, 1, 'The new highlight was not preserved.');
assert(!first.getAnnotations().some(annotation => annotation.getObject().get('NM').asString() === 'source-highlight'), 'The removed source highlight survives in the exported file.');
assert.equal(firstTypes.filter(type => type === 'Text').length, 2, 'The original/new notes were not preserved.');
assert.equal(unseenTypes.filter(type => type === 'Highlight').length, 1, 'An unseen highlight was lost.');
assert.equal(unseenTypes.filter(type => type === 'Square').length, 1, 'An unseen non-overlay annotation was lost.');
const originalNote = first.getAnnotations().find(annotation => annotation.getObject().get('NM').asString() === 'source-note');
assert(originalNote && Math.abs(originalNote.getOpacity() - .35) < .01, 'An unchanged original note lost its name/opacity.');
const addedHighlight = first.getAnnotations().find(annotation => annotation.getObject().get('NM').asString() === 'native-added-highlight');
assert(addedHighlight && Math.abs(addedHighlight.getOpacity() - .35) < .01, 'A new highlight lost its default opacity.');
assert(first.toStructuredText().asText().includes('Folio native PDFKit'), 'The page text was lost.');
console.log(JSON.stringify({ passed: true, engine: 'MuPDF independent file inspection', fileBacked: true, bytesRead, firstTypes, unseenTypes, unseenNonOverlayPreserved: true, originalOpacityAndNamePreserved: true, addedHighlightDefaultOpacity: true }));
for (const page of [first, second]) page.destroy();
doc.destroy();
stream.destroy();
