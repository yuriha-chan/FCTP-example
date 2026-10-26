declare module '@digitalbazaar/ed25519-multikey' {
  export function generate(options: { id: string; controller: string }): Promise<unknown>;
  export function from(document: Record<string, unknown>): Promise<unknown>;
}
declare module '@digitalbazaar/data-integrity' {
  export class DataIntegrityProof { constructor(options: Record<string, unknown>) }
}
declare module '@digitalbazaar/eddsa-rdfc-2022-cryptosuite' {
  export const cryptosuite: unknown;
}
declare module 'jsonld-signatures' {
  const api: {
    sign(document: Record<string, unknown>, options: Record<string, unknown>): Promise<Record<string, unknown>>;
    verify(document: Record<string, unknown>, options: Record<string, unknown>): Promise<{ verified: boolean; error?: unknown; results?: unknown[] }>;
    purposes: {
      AssertionProofPurpose: new () => unknown;
      ProofPurpose: new (options: { term: string }) => unknown;
    };
  };
  export default api;
}
declare module '@digitalbazaar/data-integrity-context' {
  const value: { contexts: Map<string, Record<string, unknown>> };
  export default value;
}
declare module '@digitalbazaar/multikey-context' {
  const value: { contexts: Map<string, Record<string, unknown>> };
  export default value;
}
