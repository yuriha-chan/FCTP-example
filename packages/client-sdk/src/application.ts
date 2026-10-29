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
  handle?: string;
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

export type ExplorePlaceState = 'available' | 'stale' | 'empty' | 'not-retrieved' | 'unavailable';

export interface ExplorePlaceRecord {
  id: string;
  type: string;
  authorityId: string;
  name?: string;
  territoryId?: string;
  areaId?: string;
  listingsId?: string;
  state?: ExplorePlaceState;
  error?: string;
}

export interface ExploreEndpointRecord {
  id: string;
  state: ExplorePlaceState;
  name?: string;
  error?: string;
}

export interface ExploreConnectionRecord {
  id: string;
  type: 'Route';
  from: string;
  to: string;
  territoryId: string;
  authorityId: string;
  name?: string;
  endpoints?: ExploreEndpointRecord[];
  state?: ExplorePlaceState;
  error?: string;
}

export interface ExploreResourceRecord {
  id: string;
  type: string;
  authorityId: string;
  territoryId?: string;
  name?: string;
  boundaries?: string[];
  state?: ExplorePlaceState;
  error?: string;
}

export interface ExploreCapabilityRecord {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  request?: { method: 'GET' | 'POST'; href: string; body?: Record<string, unknown> };
  effect: string;
}

export interface ExploreCapabilitySnapshot {
  territoryId: string;
  authorityId: string;
  accountId?: string;
  vesselId?: string;
  observedAt: string;
  state?: Record<string, unknown>;
  actions: ExploreCapabilityRecord[];
}

export interface ExploreBlockerRecord {
  id: string;
  source: string;
  message: string;
  state?: ExplorePlaceState;
}

export interface ExplorePlacesData {
  places: ExplorePlaceRecord[];
  connections: ExploreConnectionRecord[];
  areas: ExploreResourceRecord[];
  maps: ExploreResourceRecord[];
  listings: ExploreResourceRecord[];
  capabilities: ExploreCapabilityRecord[];
  blockers: ExploreBlockerRecord[];
}

export interface ExplorePlaceDetailData {
  place: ExplorePlaceRecord;
  onward: ExplorePlaceRecord[];
  connections: ExploreConnectionRecord[];
  areas: ExploreResourceRecord[];
  maps: ExploreResourceRecord[];
  listings: ExploreResourceRecord[];
  capabilities: ExploreCapabilityRecord[];
  blockers: ExploreBlockerRecord[];
}

export interface RoutePlanLeg {
  routeId: string;
  from: string;
  to: string;
  territoryId: string;
}

export interface RoutePlanRecord {
  id: string;
  accountId: string;
  from: string;
  to: string;
  legs: RoutePlanLeg[];
  blockers: ExploreBlockerRecord[];
  createdAt: string;
}

export interface ResourceReaderData {
  resourceId: string;
  authorityId?: string;
  value?: unknown;
}

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
  submission: { status: 'sending' | 'accepted' | 'rejected' | 'unverified'; result?: string; error?: string; evidenceBaseline?: ActionEvidence[] };
  outcome: { status: 'pending' | 'completed' | 'failed' | 'unverified'; evidence: ActionEvidence[]; error?: string };
}

export function actionIsComplete(record: ActionRecord): boolean {
  return record.submission.status === 'accepted' && record.outcome.status === 'completed' && record.outcome.evidence.length > 0;
}

export type ProductionOperationKind = 'mine' | 'manufacture' | 'transfer' | 'load' | 'unload';

export interface ProductionOperationInput {
  name: string;
  label: string;
  type: 'count' | 'choice';
  required: boolean;
  default?: string | number;
  minimum?: number;
  choices?: Array<{ value: string; label: string }>;
}

export interface ProductionOperation {
  operationId: string;
  authorityId: string;
  kind: ProductionOperationKind;
  label: string;
  effect: string;
  inputs: ProductionOperationInput[];
  defaults: Record<string, string | number>;
  blockers: string[];
  available: boolean;
  outputDestination?: string;
  source: string;
  observedAt: string;
}

export interface ProductionAuthorityRecord {
  authorityId: string;
  kind: 'policy' | 'simulation';
  source: string;
  state: 'available' | 'empty' | 'stale' | 'not-retrieved' | 'unavailable';
  name?: string;
  error?: string;
  observedAt?: string;
}

export interface ProductionData {
  accountId: string;
  vesselId: string;
  operations: ProductionOperation[];
  authorities: ProductionAuthorityRecord[];
  jobs: ProductionJob[];
}

export interface ProductionJobProgress {
  remainingTicks?: number;
  tick?: number;
  count?: number;
}

export interface ProductionJob {
  jobId: string;
  authorityId: string;
  accountId: string;
  vesselId: string;
  operation: ProductionOperationKind;
  status: 'pending' | 'progress' | 'queued' | 'completed' | 'failed' | 'unverified';
  source: string;
  observedAt: string;
  progress?: ProductionJobProgress;
  output?: string;
  cargo?: unknown;
  evidence?: ActionEvidence[];
  error?: string;
}

export interface LogisticsVesselIdentity {
  id: string;
  registry: string;
  possessor: string;
  capacity?: number;
  name?: string;
}

export interface LogisticsRegistryObservation {
  authorityId: string;
  source: string;
  state: 'available' | 'empty' | 'stale' | 'not-retrieved' | 'unavailable';
  observedAt?: string;
  error?: string;
  cargo?: unknown;
  adoption?: boolean;
  location?: unknown;
  pendingRequests?: unknown[];
}

export interface LogisticsTerritoryObservation {
  authorityId: string;
  kind: 'policy' | 'simulation';
  source: string;
  state: 'available' | 'empty' | 'stale' | 'not-retrieved' | 'unavailable';
  observedAt?: string;
  error?: string;
  visit?: unknown;
  cargo?: unknown;
  sharedStock?: unknown;
}

export interface LogisticsVesselData {
  accountId: string;
  vesselId: string;
  vessel?: LogisticsVesselIdentity;
  registry: LogisticsRegistryObservation;
  territories: LogisticsTerritoryObservation[];
}
