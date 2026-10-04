export type SignatureResult = { field: string; signer?: string; integrity: boolean; coversWholeDocument: boolean; trusted: boolean; trustChecked: boolean; certificateCurrent?: boolean; notBefore?: string; notAfter?: string; revocationChecked?: boolean; error?: string };
export function verifySignatures(bytes: Uint8Array, password?: string, roots?: Uint8Array[]): Promise<SignatureResult[]>;
export function signDocument(bytes: Uint8Array, pfxBytes: Uint8Array, password: string, reason?: string, progress?: (message: string) => void): Promise<Uint8Array>;
