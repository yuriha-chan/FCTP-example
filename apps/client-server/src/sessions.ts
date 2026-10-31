import { createHash, randomBytes } from 'node:crypto';

export interface ClientSessionRecord {
  accountId: string;
  issuedAt: string;
}

export function createClientToken(): string {
  return randomBytes(32).toString('base64url');
}

export function digestClientToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}
