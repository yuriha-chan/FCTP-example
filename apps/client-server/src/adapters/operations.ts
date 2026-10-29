export function encodeOperationId(authorityId: string, actionId: string): string {
  return `operation:${Buffer.from(JSON.stringify([authorityId, actionId])).toString('base64url')}`;
}

export function decodeOperationId(operationId: string): { authorityId: string; actionId: string } | undefined {
  if (!operationId.startsWith('operation:')) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(operationId.slice('operation:'.length), 'base64url').toString('utf8'));
    if (!Array.isArray(value) || typeof value[0] !== 'string' || typeof value[1] !== 'string') return undefined;
    return { authorityId: value[0], actionId: value[1] };
  } catch {
    return undefined;
  }
}

export function validateOperationRequest(authorityId: string, kind: string, request: { method: string; href: string }): void {
  const url = new URL(request.href);
  if (request.method !== 'POST' || url.origin !== new URL(authorityId).origin || url.pathname !== `/local/${kind}` || url.search || url.hash || url.username || url.password) {
    throw new TypeError('Operation endpoint does not match the selected authority and operation');
  }
}

export function encodeJobId(authorityId: string, localId: string): string {
  return `job:${Buffer.from(JSON.stringify([authorityId, localId])).toString('base64url')}`;
}

export function localJobId(jobId: string, authorityId: string): string {
  if (!jobId.startsWith('job:')) throw new TypeError('Job identity has no issuing authority');
  const value: unknown = JSON.parse(Buffer.from(jobId.slice('job:'.length), 'base64url').toString('utf8'));
  if (!Array.isArray(value) || value[0] !== authorityId || typeof value[1] !== 'string' || !/^\d+$/.test(value[1])) throw new TypeError('Job identity does not match its authority');
  return value[1];
}
