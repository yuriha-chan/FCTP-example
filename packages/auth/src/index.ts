import type { TokenDeclaration, TokenDigest, TokenRevoke, URI } from '@fctp/protocol';

const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};
const unpaddedBase64 = (bytes: Uint8Array): string => base64(bytes).replace(/=+$/, '');

export function encodeNativeToken(bytes: Uint8Array): string { return unpaddedBase64(bytes); }
export function decodeNativeToken(token: string): Uint8Array { return fromBase64(token + '='.repeat((4 - token.length % 4) % 4)); }

export async function deriveDiplomaticToken(nativeToken: Uint8Array | string, resourceServerActorId: URI): Promise<string> {
  const keyBytes = typeof nativeToken === 'string' ? decodeNativeToken(nativeToken) : nativeToken;
  const key = await crypto.subtle.importKey('raw', new Uint8Array(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(resourceServerActorId));
  return unpaddedBase64(new Uint8Array(signature));
}

export async function digestDiplomaticToken(token: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(decodeNativeBase64(token)))));
}

function decodeNativeBase64(value: string): Uint8Array {
  return fromBase64(value + '='.repeat((4 - value.length % 4) % 4));
}

export async function createTokenDigest(actor: URI, revision: number, diplomaticToken: string): Promise<TokenDigest> {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('revision must be an unsigned integer');
  return { actor, revision, tokenDigest: await digestDiplomaticToken(diplomaticToken) };
}

export function createTokenRevoke(actor: URI, revision: number): TokenRevoke {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('revision must be an unsigned integer');
  return { actor, revision, tokenRevoke: 'revoke' };
}

export type CredentialState =
  | { revision: number; status: 'active'; tokenDigest: string }
  | { revision: number; status: 'revoked' }
  | { revision: number; status: 'conflicted' };
export type ApplyDeclarationResult = 'applied' | 'stale' | 'duplicate' | 'conflict';

export class TokenCredentialStore {
  readonly #credentials = new Map<URI, CredentialState>();

  get(actor: URI): CredentialState | undefined {
    const state = this.#credentials.get(actor);
    return state && { ...state };
  }

  apply(declaration: TokenDeclaration): ApplyDeclarationResult {
    const current = this.#credentials.get(declaration.actor);
    if (!current || declaration.revision > current.revision) {
      this.#credentials.set(declaration.actor, declaration.tokenRevoke === 'revoke'
        ? { revision: declaration.revision, status: 'revoked' }
        : { revision: declaration.revision, status: 'active', tokenDigest: String(declaration.tokenDigest) });
      return 'applied';
    }
    if (declaration.revision < current.revision) return 'stale';
    if (current.status === 'conflicted') return 'conflict';
    const contentMatches = declaration.tokenRevoke === 'revoke'
      ? current.status === 'revoked'
      : current.status === 'active' && current.tokenDigest === declaration.tokenDigest;
    if (contentMatches) return 'duplicate';
    this.#credentials.set(declaration.actor, { revision: current.revision, status: 'conflicted' });
    return 'conflict';
  }

  async authenticate(actor: URI, diplomaticToken: string): Promise<boolean> {
    const state = this.#credentials.get(actor);
    if (!state || state.status !== 'active') return false;
    const candidate = await digestDiplomaticToken(diplomaticToken);
    const left = encoder.encode(candidate); const right = encoder.encode(state.tokenDigest);
    if (left.length !== right.length) return false;
    let mismatch = 0;
    for (let i = 0; i < left.length; i++) mismatch |= left[i]! ^ right[i]!;
    return mismatch === 0;
  }

  snapshot(): Record<string, CredentialState> { return Object.fromEntries(this.#credentials); }
  restore(snapshot: Record<string, CredentialState>): void { this.#credentials.clear(); for (const [actor, value] of Object.entries(snapshot)) this.#credentials.set(actor, { ...value }); }
}
