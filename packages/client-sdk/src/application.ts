export interface ActionEvidence {
  source: string;
  observedAt: string;
  changes?: Record<string, unknown>;
}

export type LoginState =
  | { status: 'signed-in'; homeServer: string; nativeToken: string; expiresAt?: string }
  | { status: 'signed-out' }
  | { status: 'authentication-rejected'; reason: string };

export interface AccountRecord {
  id: string;
  handle: string;
  homeServer: string;
  actorId?: string;
  homeAuthority?: string;
  login: LoginState;
}

export interface ServerRecord {
  server: string;
  origin: string;
  authorities: string[];
  name?: string;
}

export type AuthorityRole = 'home' | 'territory' | 'registry' | 'asset-server';

export interface AuthorityRecord {
  handle: string;
  actorId: string;
  server: string;
  roles: AuthorityRole[];
  name?: string;
}

export interface PageContext {
  accountId?: string;
  placeId?: string;
  vesselId?: string;
  routeId?: string;
  resourceId?: string;
}

export type AccountScopedRequest<T extends object> = T & { accountId: string };

export interface ActionDescriptor {
  id: string;
  label: string;
  endpoint: string;
  method: 'POST' | 'PATCH';
  targetId?: string;
  inputs: Array<{ name: string; required: boolean }>;
  blockers: string[];
  expectedResult?: string;
}

export interface PageResponse<T> {
  context: PageContext;
  data: T;
  observations: Record<string, SourcedObservation<unknown>>;
  actions: ActionDescriptor[];
}

export interface PublicAccountRecord extends Omit<AccountRecord, 'login'> {
  login: { status: LoginState['status']; expiresAt?: string; reason?: string };
}

export function toPublicAccount(account: AccountRecord): PublicAccountRecord {
  const { id, handle, homeServer, actorId, homeAuthority, login } = account;
  return {
    id, handle, homeServer, ...(actorId === undefined ? {} : { actorId }),
    ...(homeAuthority === undefined ? {} : { homeAuthority }),
    login: login.status === 'signed-in'
      ? { status: login.status, ...(login.expiresAt === undefined ? {} : { expiresAt: login.expiresAt }) }
      : login.status === 'authentication-rejected' ? { status: login.status, reason: login.reason } : { status: login.status }
  };
}

export type SourcedObservation<T> =
  | { state: 'available' | 'empty'; source: string; observedAt: string; value: T }
  | { state: 'stale'; source: string; observedAt: string; value: T; error?: string }
  | { state: 'not-retrieved'; source: string }
  | { state: 'unavailable'; source: string; error: string; observedAt?: string };

export function observationIsCurrent<T>(observation: SourcedObservation<T>): boolean {
  return observation.state === 'available' || observation.state === 'empty';
}

export interface ActionRecord {
  id: string;
  statusUrl: string;
  accountId: string;
  targetId: string;
  resultReferences: Array<{ kind: 'request' | 'resource' | 'job' | 'event'; id: string }>;
  intent: { kind: string; inputs: Record<string, unknown> };
  submittedAt: string;
  submission: { status: 'sending' | 'accepted' | 'rejected' | 'unverified'; result?: string; error?: string };
  outcome: { status: 'pending' | 'completed' | 'failed' | 'unverified'; evidence: ActionEvidence[] };
}

export function actionIsComplete(record: ActionRecord): boolean {
  return record.submission.status === 'accepted' && record.outcome.status === 'completed' && record.outcome.evidence.length > 0;
}
