# Dependencias y certificados — 0.4.0

PDF.js se actualizó a 6.2.108, fijado en package-lock.json. Tesseract.js 7.0.0,
PKI.js 3.4.1, ASN1.js 3.0.6 y node-forge 1.4.0 también están fijados.

La auditoría npm del 04/10/2026 informa de un aviso alto en node-forge:
GHSA-86w9-cpqp-85rv, verificación RSA/PKCS#1 v1.5 permisiva. No dispone de versión
corregida publicada para este conjunto. Folio usa node-forge para abrir PKCS#12
y generar firmas RSA, no para verificar RSA ni certificados. La verificación
de CMS, firma, digest y cadena usa PKI.js con WebCrypto. No se suprime el aviso
ni se presenta la auditoría como libre de vulnerabilidades. OpenSSL comprueba
una firma exportada y rechaza contenido modificado. Esto acota el uso; no
sustituye una revisión de seguridad completa.

Los PFX/P12 no se guardan. Se copian al worker, que se termina al finalizar,
cancelar o superar el plazo; sus bytes se vacían. Las contraseñas de documentos
permanecen en memoria durante la sesión. JavaScript del PDF está deshabilitado.
La CSP permite recursos locales y WASM. OCR no envía documentos a un servicio.

Se distingue integridad, cobertura, vigencia del certificado y confianza en
una raíz elegida. Revocación, TSA y confianza del almacén Windows no se
comprueban. No se declara firma cualificada ni una conclusión legal.

El instalador no tiene Authenticode. El ejecutable QA usa identificador y
puerto CDP propios y nunca se distribuye como ejecutable de producción.
