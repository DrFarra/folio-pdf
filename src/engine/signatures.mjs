import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import forge from 'node-forge';
import * as mupdf from 'mupdf';
import { PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString } from 'pdf-lib';
import { open, hasSignature } from './mupdf-engine.mjs';

const binary = bytes => {
  let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192)); return value;
};
const fromBinary = value => Uint8Array.from(value, c => c.charCodeAt(0));
const concat = (a, b) => { const result = new Uint8Array(a.length + b.length); result.set(a); result.set(b, a.length); return result; };
const DAMAGED = 'La firma está dañada o no cubre todo el documento.', UNPREPARED = 'No se pudo preparar la firma en este PDF.';

function signatureObjects(doc) {
  const result = [], seen = new Set();
  function walk(array, type = '', name = '', depth = 0) {
    if (depth > 32) throw new Error('La estructura de firmas es demasiado profunda.');
    for (let i = 0; i < array.length; i++) {
      const field = array.get(i), ref = field.asIndirect();
      if (ref && seen.has(ref)) continue; if (ref) seen.add(ref);
      const ft = field.get('FT').asName() || type, label = [name, field.get('T').asString()].filter(Boolean).join('.');
      if (ft === 'Sig' && !field.get('V').isNull()) result.push({ field: label, signature: field.get('V') });
      walk(field.get('Kids'), ft, label, depth + 1);
    }
  }
  walk(doc.getTrailer().get('Root', 'AcroForm', 'Fields')); return result;
}

export async function verifySignatures(bytes, password = '', roots = []) {
  const doc = open(bytes, password), result = [];
  pkijs.setEngine('folio', globalThis.crypto, new pkijs.CryptoEngine({ name: 'folio', crypto: globalThis.crypto, subtle: globalThis.crypto.subtle }));
  try {
    for (const { field, signature } of signatureObjects(doc)) {
      const record = { field, integrity: false, coversWholeDocument: false, trusted: false, trustChecked: roots.length > 0 };
      try {
        const range = signature.get('ByteRange').asJS();
        if (!Array.isArray(range) || range.length !== 4 || !range.every(Number.isSafeInteger) || range[0] !== 0 || range[1] < 1 || range[2] <= range[1] || range[3] < 1 || range[2] + range[3] > bytes.length) throw new Error(DAMAGED);
        // The single unsigned gap must contain only this signature's Contents.
        const gap = new TextDecoder('ascii').decode(bytes.subarray(range[1], range[2])).trim();
        if (!/^<[\da-f\s]+>$/i.test(gap)) throw new Error(DAMAGED);
        const cmsBytes = signature.get('Contents').asByteString();
        const gapBytes = Uint8Array.from(gap.slice(1, -1).replace(/\s/g, '').match(/../g) || [], h => parseInt(h, 16));
        if (gapBytes.length !== cmsBytes.length || !gapBytes.every((n, i) => n === cmsBytes[i])) throw new Error(DAMAGED);
        const parsed = asn1js.fromBER(new Uint8Array(cmsBytes).buffer);
        if (parsed.offset < 0) throw new Error(DAMAGED);
        const content = new pkijs.ContentInfo({ schema: parsed.result });
        if (content.contentType !== '1.2.840.113549.1.7.2') throw new Error(DAMAGED);
        const cms = new pkijs.SignedData({ schema: content.content });
        const data = concat(bytes.subarray(0, range[1]), bytes.subarray(range[2], range[2] + range[3]));
        const verification = await cms.verify({ signer: 0, data: data.buffer, checkChain: false, extendedMode: true });
        record.integrity = verification.signatureVerified === true;
        record.coversWholeDocument = range[2] + range[3] === bytes.length;
        const certificate = verification.signerCertificate;
        if (certificate) {
          const cn = certificate.subject.typesAndValues.find(value => value.type === '2.5.4.3');
          record.signer = cn?.value.valueBlock.value || certificate.subject.typesAndValues.map(value => value.value.valueBlock.value).join(', ');
          record.notBefore = certificate.notBefore.value.toISOString(); record.notAfter = certificate.notAfter.value.toISOString();
          record.certificateCurrent = new Date() >= certificate.notBefore.value && new Date() <= certificate.notAfter.value;
        }
        if (roots.length) {
          const trustedCerts = roots.map(root => { const parsed = asn1js.fromBER(new Uint8Array(root).buffer); if (parsed.offset < 0) throw new Error('El certificado de confianza no es válido.'); return new pkijs.Certificate({ schema: parsed.result }); });
          try { const trusted = await cms.verify({ signer: 0, data: data.buffer, checkChain: true, trustedCerts, extendedMode: true }); record.trusted = trusted.signerCertificateVerified === true; }
          catch { record.trusted = false; }
        }
        record.revocationChecked = false;
        if (!record.integrity) record.error = 'La integridad de la firma no es válida.';
      } catch (error) { record.error = error instanceof Error && /^(La firma|El certificado)/.test(error.message) ? error.message : DAMAGED; }
      result.push(record);
    }
    return result;
  } finally { doc.destroy(); }
}

export async function signDocument(bytes, pfxBytes, password, reason = '', progress = () => {}) {
  progress('Comprobando el PDF…');
  const check = new mupdf.PDFDocument(bytes);
  try {
    // pdf-lib cannot write into an encrypted file, and an owner password
    // alone also encrypts it.
    if (!check.getTrailer().get('Encrypt').isNull()) throw new Error('Quita la protección del PDF antes de firmarlo.');
    if (hasSignature(check)) throw new Error('Este PDF ya contiene firmas; no se reemplazan al firmar.');
    if (!check.hasPermission('edit')) throw new Error('Los permisos del PDF no permiten firmarlo.');
  }
  finally { check.destroy(); }
  if (pfxBytes.length > 4 * 1024 * 1024) throw new Error('El certificado supera 4 MB.');
  let pfx;
  progress('Abriendo certificado…');
  try { pfx = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(binary(pfxBytes)), false, password); }
  catch { throw new Error('No se pudo abrir el certificado. Comprueba la contraseña.'); }
  const keyBags = [...Object.values(pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })).flat(), ...Object.values(pfx.getBags({ bagType: forge.pki.oids.keyBag })).flat()];
  const key = keyBags.find(bag => bag?.key)?.key;
  if (!key?.n) throw new Error('El certificado debe incluir una clave privada RSA.');
  const certificates = Object.values(pfx.getBags({ bagType: forge.pki.oids.certBag })).flat().map(bag => bag?.cert).filter(Boolean);
  const certificate = certificates.find(cert => cert.publicKey.n?.compareTo(key.n) === 0 && cert.publicKey.e.compareTo(key.e) === 0);
  if (!certificate) throw new Error('No se encontró el certificado correspondiente a la clave privada.');
  const now = new Date(); if (now < certificate.validity.notBefore || now > certificate.validity.notAfter) throw new Error('El certificado está vencido o todavía no es válido.');
  const usage = certificate.getExtension('keyUsage'); if (usage && !usage.digitalSignature && !usage.nonRepudiation) throw new Error('El certificado no permite firmas digitales.');
  const signer = certificate.subject.getField('CN')?.value || 'Firmante';
  progress('Preparando la firma…');
  const doc = await PDFDocument.load(bytes); const context = doc.context;
  const placeholderLength = 32768;
  const signature = context.register(context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 9999999999, 9999999999, 9999999999], Contents: PDFHexString.of('0'.repeat(placeholderLength)),
    M: PDFString.fromDate(now), Name: PDFString.of(signer), Reason: PDFString.of(reason.slice(0, 2000)) }));
  const page = doc.getPages()[0];
  const widget = context.register(context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [0, 0, 0, 0], T: PDFString.of('FolioSignature'), V: signature, F: 4, P: page.ref }));
  page.node.addAnnot(widget); const form = doc.getForm(); form.acroForm.addField(widget); form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  const output = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  const raw = binary(output), marker = '<' + '0'.repeat(placeholderLength) + '>', start = raw.indexOf(marker);
  if (start < 0 || raw.indexOf(marker, start + 1) >= 0) throw new Error(UNPREPARED);
  const end = start + marker.length;
  const pattern = /\/ByteRange\s*\[\s*0\s+9999999999\s+9999999999\s+9999999999\s*\]/g;
  const matches = [...raw.matchAll(pattern)]; if (matches.length !== 1) throw new Error(UNPREPARED);
  const match = matches[0], range = `/ByteRange [0 ${start} ${end} ${output.length - end}]`.padEnd(match[0].length, ' ');
  if (range.length !== match[0].length) throw new Error(UNPREPARED);
  output.set(fromBinary(range), match.index);
  const signed = concat(output.subarray(0, start), output.subarray(end));
  progress('Firmando documento…');
  const cms = forge.pkcs7.createSignedData(); cms.content = forge.util.createBuffer(binary(signed));
  certificates.forEach(cert => cms.addCertificate(cert));
  cms.addSigner({ key, certificate, digestAlgorithm: forge.pki.oids.sha256, authenticatedAttributes: [
    { type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: now },
  ] });
  cms.sign({ detached: true }); const der = forge.asn1.toDer(cms.toAsn1()).getBytes();
  const hex = [...fromBinary(der)].map(n => n.toString(16).padStart(2, '0')).join('');
  if (hex.length > placeholderLength) throw new Error('El certificado es demasiado grande para firmar con él.');
  output.set(fromBinary(hex.padEnd(placeholderLength, '0')), start + 1);
  progress('Verificando la firma generada…');
  const verification = await verifySignatures(output); if (verification.length !== 1 || !verification[0].integrity || !verification[0].coversWholeDocument) throw new Error('La firma generada no pasó la verificación.');
  return output;
}
