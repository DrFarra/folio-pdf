// Install the handler before MuPDF's asynchronous module initialization can yield.
const signatures = import('./signatures.mjs');
self.onmessage = async (event: MessageEvent<{ operation: 'sign' | 'verify'; bytes: Uint8Array; password?: string; pfx?: Uint8Array; reason?: string; roots?: Uint8Array[] }>) => {
  const request = event.data;
  try {
    const { signDocument, verifySignatures } = await signatures;
    const result = request.operation === 'sign' ? await signDocument(request.bytes, request.pfx!, request.password || '', request.reason, progress => self.postMessage({ progress })) : await verifySignatures(request.bytes, request.password, request.roots);
    self.postMessage({ result }, { transfer: result instanceof Uint8Array ? [result.buffer] : [] });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'No se pudo procesar la firma.' }); }
  finally { request.pfx?.fill(0); }
};
