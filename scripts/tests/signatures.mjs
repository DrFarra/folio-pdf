import fs from 'node:fs';
import assert from 'node:assert/strict';
import forge from 'node-forge';
import { signDocument, verifySignatures } from '../../src/engine/signatures.mjs';
import { inspectDocument } from '../../src/engine/mupdf-engine.mjs';
import { operateDocument } from '../../src/engine/operations.mjs';

fs.mkdirSync('test-results', { recursive: true });
const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
const cert = forge.pki.createCertificate(); cert.publicKey = keys.publicKey; cert.serialNumber = '01';
cert.validity.notBefore = new Date(Date.now() - 86400000); cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
cert.setSubject([{ name: 'commonName', value: 'Folio QA signing test' }]); cert.setIssuer(cert.subject.attributes);
cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', digitalSignature: true, keyCertSign: true }]);
cert.sign(keys.privateKey, forge.md.sha256.create());
const pfx = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'qa-only', { algorithm: '3des' });
const bytes = Uint8Array.from(forge.asn1.toDer(pfx).getBytes(), c => c.charCodeAt(0));
const signed = await signDocument(fs.readFileSync('public/sample.pdf'), bytes, 'qa-only', 'Acceptance test');
fs.writeFileSync('test-results/signed-real.pdf', signed);
const untrusted = await verifySignatures(signed); assert.equal(untrusted.length, 1); assert(untrusted[0].integrity); assert(untrusted[0].coversWholeDocument); assert(!untrusted[0].trusted); assert(!untrusted[0].trustChecked);
assert.equal(inspectDocument(signed).signed, true);
await assert.rejects(() => signDocument(signed, bytes, 'qa-only'), /ya contiene/);
await assert.rejects(() => signDocument(fs.readFileSync('public/sample.pdf'), bytes, 'wrong'), /contraseña/);
for (const userPassword of ['', 'reader']) {
  const protectedPdf = operateDocument(new Uint8Array(fs.readFileSync('public/sample.pdf')), { operation: 'protect', userPassword, ownerPassword: 'owner' });
  await assert.rejects(() => signDocument(protectedPdf, bytes, 'qa-only'), /Quita la protección del PDF antes de firmarlo/);
}
const root = Uint8Array.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), c => c.charCodeAt(0));
const trusted = await verifySignatures(signed, '', [root]); assert.equal(trusted[0].trusted, true);
const tampered = new Uint8Array(signed), marker = new TextEncoder().encode('Acceptance test');
let offset = -1;
for (let i = 0; i < tampered.length - marker.length; i++) if (marker.every((n, k) => tampered[i + k] === n)) { offset = i; break; }
assert(offset > 0); tampered[offset] ^= 1;
const invalid = await verifySignatures(tampered); assert(!invalid[0].integrity);
const appended = new Uint8Array(signed.length + 6); appended.set(signed); appended.set(new TextEncoder().encode('%extra'), signed.length);
const partial = await verifySignatures(appended); assert(partial[0].integrity); assert(!partial[0].coversWholeDocument);
const results = { actualRsaSignature: true, algorithm: 'SHA-256 / RSA-2048', completeByteRange: true, mutationRejected: true, wrongPfxPasswordRejected: true, encryptedPdfRejectedInSpanish: true, trustedRootVerified: true, untrustedNotMisrepresented: true, laterRevisionDetected: true, revocationChecked: false };
fs.writeFileSync('test-results/signatures-results.json', JSON.stringify(results, null, 2));
// Synthetic test identity; never an application signing identity.
fs.writeFileSync('test-results/qa-identity.p12', bytes); fs.writeFileSync('test-results/qa-root.cer', root);
console.log(JSON.stringify(results));
