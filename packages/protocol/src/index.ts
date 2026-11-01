export type URI = string;
export type Instant = string;
export type UInt = number;
export type ExtensionFields = Record<string, unknown>;

export interface Ref extends ExtensionFields { id: URI }
export interface Identified extends ExtensionFields { id: URI }
export interface Named extends ExtensionFields { name: string }
export interface Signed extends ExtensionFields { proof: DataIntegrityProof }
export interface DataIntegrityProof extends ExtensionFields {
  type: 'DataIntegrityProof';
  cryptosuite: 'eddsa-rdfc-2022';
  verificationMethod: URI;
  proofValue: string;
  proofPurpose?: string;
  created?: Instant;
}
export interface Media extends ExtensionFields { url: URI; mediaType: string; digest?: string }
export interface CargoManifest extends ExtensionFields { entries: Quantity[] }
export interface FCTPActor extends Identified {
  inbox: URI;
  outbox: URI;
  role: ActorRole;
  publicKeys: URI[];
  capabilities?: string[];
  webfinger?: string;
}
export type ActorRole = 'player' | 'home' | 'registry' | 'territory';
export interface TerritoryResources extends ExtensionFields { ports: URI; routes: URI; areas: Area[]; map?: URI }
export interface Territory extends FCTPActor, Named { role: 'territory'; resources: TerritoryResources }
export interface Port extends Identified, Named { territory: URI; area: URI; listings: URI }
export interface Boundary extends Identified, Named { territory: URI }
export interface Area extends Identified, Named { territory: URI }
export interface Route extends Identified { from: URI; to: URI; distance?: number }
export interface RouteRequest extends Identified, Signed { applyFrom: URI; applyTo: URI; object: Route }
export interface RouteRequestApproval extends Identified { request: RouteRequest; object: Route }
export interface RouteRequestDenial extends Identified { request: URI; reason?: string }
export interface Asset extends Identified, Named { creator: URI[]; holder: URI; media: Media[] }
export interface AssetGrant extends Identified { asset: URI; variety: URI; grantee: URI }
export interface Variety extends Identified, Named {
  holder: URI;
  asset?: URI;
  production?: Production[];
  mass: number;
  version: string;
}
export interface Production extends ExtensionFields {
  type: 'mine' | 'manufacture';
  ingredients?: Quantity[];
  location?: Area[];
  tool?: URI;
  duration: UInt;
  yield: Yield[];
}
export interface Yield extends ExtensionFields { probability: number; count: UInt; data: Record<string, unknown> }
export interface Item extends Identified { variety: URI; data: Record<string, unknown> }
export interface Stack extends ExtensionFields { variety: URI; count: UInt; data: Record<string, unknown> }
export type Quantity = Item | Stack;
export interface Vessel extends Identified { registry: URI; possessor: URI; capacity: number; data?: Record<string, unknown> }
export interface Journey extends ExtensionFields { events: URI[]; exitEvidence?: URI }
export interface EntryRequest extends Identified {
  type: 'EntryRequest'; vessel: Vessel; cargo: CargoManifest; journey: Journey;
  destination: { territory: URI; port: URI; route: URI };
}
export interface EntryRejected extends Identified { type: 'EntryRejected'; request: URI; territory: URI; reason?: string }
export interface BerthingEvent extends Identified { type: 'BerthingEvent'; vessel: URI; territory: URI; port: URI; request: URI; effectiveAt: Instant }
export interface CargoOperationEvent extends Identified {
  type: 'CargoOperationEvent'; vessel: URI; territory: URI; port: URI;
  operation: 'load' | 'unload'; cargo: CargoManifest; effectiveAt: Instant;
}
export interface DepartureRequest extends Identified { type: 'DepartureRequest'; vessel: URI; territory: URI; port: URI; route?: URI }
export interface DepartureEvent extends Identified { type: 'DepartureEvent'; vessel: URI; territory: URI; port: URI; request: URI; effectiveAt: Instant }
export interface VoyageEvent extends Identified {
  type: 'VoyageEvent'; vessel: URI; territory: URI; kind: string; details?: Record<string, unknown>; effectiveAt: Instant;
}
export interface ExitEvent extends Identified, Signed {
  type: 'ExitEvent'; vessel: URI; territory: URI; route: URI; entryRequest: URI;
  departureEvent?: URI; cargo: CargoManifest; effectiveAt: Instant;
}
export interface Listing extends ExtensionFields {
  id: URI; port: URI; seller: URI; offered: CargoManifest; requested?: CargoManifest; description?: string;
}
export interface MapDescriptor extends Identified { representations: MapRepresentation[] }
export interface MapRepresentation extends ExtensionFields { format: URI; resources: MapResource[]; metadata?: Record<string, unknown> }
export interface MapResource extends ExtensionFields { role: string; url: URI; mediaType: string }
export interface TokenDigest extends ExtensionFields { tokenDigest: string; actor: URI; revision: number }
export interface TokenRevoke extends ExtensionFields { tokenRevoke: 'revoke'; actor: URI; revision: number }
export type TokenDeclaration = TokenDigest | TokenRevoke;

export type FctpModelName = 'Ref' | 'Identified' | 'Named' | 'Signed' | 'DataIntegrityProof' | 'Actor' | 'Territory' | 'Port' | 'Boundary' | 'Area' | 'Route' | 'RouteRequest' | 'RouteRequestApproval' | 'RouteRequestDenial' |
  'Asset' | 'AssetGrant' | 'Variety' | 'Item' | 'Stack' | 'CargoManifest' | 'Vessel' | 'EntryRequest' |
  'EntryRejected' | 'BerthingEvent' | 'CargoOperationEvent' | 'DepartureRequest' | 'DepartureEvent' |
  'VoyageEvent' | 'ExitEvent' | 'Listing' | 'MapDescriptor' | 'MapRepresentation' | 'MapResource' |
  'Media' | 'Production' | 'Yield' | 'Journey' | 'TerritoryResources' | 'TokenDigest' | 'TokenRevoke';

export interface ValidationIssue { path: string; message: string }
export type ValidationResult<T> = { success: true; data: T } | { success: false; issues: ValidationIssue[] };

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const uri = (v: unknown): v is string => typeof v === 'string' && (() => { try { return Boolean(new URL(v).protocol); } catch { return false; } })();
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const string = (v: unknown): v is string => typeof v === 'string';

export function validateModel<T extends ExtensionFields>(value: unknown, model: FctpModelName): ValidationResult<T> {
  if (!record(value)) return { success: false, issues: [{ path: '', message: 'Expected object' }] };
  const issues: ValidationIssue[] = [];
  const need = (key: string, predicate: (v: unknown) => boolean, description: string): void => {
    if (!(key in value) || !predicate(value[key])) issues.push({ path: `/${key}`, message: `Expected ${description}` });
  };
  const needUri = (key: string): void => need(key, uri, 'absolute URI');
  const quantity = (q: unknown): boolean => record(q) && uri(q.variety) &&
    (q.id === undefined ? uint(q.count) && record(q.data) : uri(q.id) && record(q.data));
  const cargo = (v: unknown): boolean => record(v) && Array.isArray(v.entries) && v.entries.every(quantity);
  const proof = (v: unknown): boolean => record(v) && v.type === 'DataIntegrityProof' && v.cryptosuite === 'eddsa-rdfc-2022' && uri(v.verificationMethod) && string(v.proofValue);
  const entries: Record<FctpModelName, () => void> = {
    Ref: () => { needUri('id'); },
    Identified: () => { needUri('id'); },
    Named: () => { need('name', string, 'string'); },
    Signed: () => { need('proof', proof, 'eddsa-rdfc-2022 proof'); },
    DataIntegrityProof: () => { need('type', (v) => v === 'DataIntegrityProof', 'DataIntegrityProof'); need('cryptosuite', (v) => v === 'eddsa-rdfc-2022', 'eddsa-rdfc-2022'); needUri('verificationMethod'); need('proofValue', string, 'string'); },
    Actor: () => { needUri('id'); needUri('inbox'); needUri('outbox'); need('role', (v) => ['player', 'home', 'registry', 'territory'].includes(String(v)), 'Actor role'); need('publicKeys', (v) => Array.isArray(v) && v.every(uri), 'URI array'); if ('capabilities' in value) need('capabilities', (v) => Array.isArray(v) && v.every(string), 'string array'); if ('webfinger' in value) need('webfinger', string, 'string'); },
    Territory: () => { needUri('id'); need('name', string, 'string'); need('role', (v) => v === 'territory', 'territory role'); need('resources', (v) => record(v) && uri(v.ports) && uri(v.routes) && Array.isArray(v.areas) && v.areas.every((area) => record(area) && uri(area.id)), 'TerritoryResources'); },
    TerritoryResources: () => { needUri('ports'); needUri('routes'); need('areas', (v) => Array.isArray(v) && v.every((area) => record(area) && uri(area.id) && string(area.name) && uri(area.territory)), 'Area array'); if ('map' in value) needUri('map'); },
    Port: () => { needUri('id'); need('name', string, 'string'); needUri('territory'); needUri('area'); needUri('listings'); },
    Boundary: () => { needUri('id'); need('name', string, 'string'); needUri('territory'); },
    Area: () => { needUri('id'); need('name', string, 'string'); needUri('territory'); },
    Route: () => { needUri('id'); needUri('from'); needUri('to'); if ('distance' in value) need('distance', (v) => typeof v === 'number' && v >= 0, 'nonnegative number'); },
    RouteRequest: () => { needUri('id'); needUri('applyFrom'); needUri('applyTo'); need('object', record, 'Route'); need('proof', proof, 'eddsa-rdfc-2022 proof'); },
    RouteRequestApproval: () => { needUri('id'); need('request', (v) => record(v) && uri(v.id) && uri(v.applyFrom) && uri(v.applyTo), 'RouteRequest'); need('object', (v) => record(v) && uri(v.id) && uri(v.from) && uri(v.to), 'Route'); },
    RouteRequestDenial: () => { needUri('id'); needUri('request'); if ('reason' in value) need('reason', string, 'string'); },
    Asset: () => { needUri('id'); need('name', string, 'string'); need('creator', (v) => Array.isArray(v) && v.every(uri), 'URI array'); needUri('holder'); need('media', (v) => Array.isArray(v) && v.every((media) => record(media) && uri(media.url) && string(media.mediaType)), 'Media array'); },
    Media: () => { needUri('url'); need('mediaType', string, 'string'); if ('digest' in value) need('digest', string, 'string'); },
    AssetGrant: () => { needUri('id'); needUri('asset'); needUri('variety'); needUri('grantee'); },
    Variety: () => { needUri('id'); need('name', string, 'string'); needUri('holder'); need('mass', (v) => typeof v === 'number' && v >= 0, 'nonnegative number'); need('version', string, 'string'); if ('asset' in value) needUri('asset'); if ('production' in value) need('production', (v) => Array.isArray(v) && v.every((item) => record(item) && ['mine', 'manufacture'].includes(String(item.type)) && uint(item.duration) && Array.isArray(item.yield)), 'Production array'); },
    Production: () => { need('type', (v) => v === 'mine' || v === 'manufacture', 'mine or manufacture'); need('duration', uint, 'unsigned integer'); need('yield', (v) => Array.isArray(v) && v.every((candidate) => record(candidate) && typeof candidate.probability === 'number' && uint(candidate.count) && record(candidate.data)), 'Yield array'); if ('ingredients' in value) need('ingredients', (v) => Array.isArray(v) && v.every(quantity), 'Quantity array'); if ('location' in value) need('location', (v) => Array.isArray(v) && v.every((area) => record(area) && uri(area.id)), 'Area array'); if ('tool' in value) needUri('tool'); },
    Yield: () => { need('probability', (v) => typeof v === 'number', 'number'); need('count', uint, 'unsigned integer'); need('data', record, 'object'); },
    Item: () => { needUri('id'); needUri('variety'); need('data', record, 'object'); },
    Stack: () => { needUri('variety'); need('count', uint, 'unsigned integer'); need('data', record, 'object'); },
    CargoManifest: () => { need('entries', (v) => Array.isArray(v) && v.every(quantity), 'quantity array'); },
    Vessel: () => { needUri('id'); needUri('registry'); needUri('possessor'); need('capacity', (v) => typeof v === 'number' && v >= 0, 'nonnegative number'); },
    Journey: () => { need('events', (v) => Array.isArray(v) && v.every(uri), 'URI array'); if ('exitEvidence' in value) needUri('exitEvidence'); },
    EntryRequest: () => { needUri('id'); need('type', (v) => v === 'EntryRequest', 'EntryRequest'); need('vessel', (v) => record(v) && uri(v.id) && uri(v.registry) && uri(v.possessor) && typeof v.capacity === 'number' && v.capacity >= 0, 'Vessel'); need('cargo', cargo, 'CargoManifest'); need('journey', (v) => record(v) && Array.isArray(v.events) && v.events.every(uri) && (!('exitEvidence' in v) || uri(v.exitEvidence)), 'Journey'); need('destination', (v) => record(v) && uri(v.territory) && uri(v.port) && uri(v.route), 'destination'); },
    EntryRejected: () => { needUri('id'); need('type', (v) => v === 'EntryRejected', 'EntryRejected'); needUri('request'); needUri('territory'); },
    BerthingEvent: () => { needUri('id'); need('type', (v) => v === 'BerthingEvent', 'BerthingEvent'); needUri('vessel'); needUri('territory'); needUri('port'); needUri('request'); need('effectiveAt', (v) => typeof v === 'string' && validateInstant(v), 'RFC3339 instant'); },
    CargoOperationEvent: () => { needUri('id'); need('type', (v) => v === 'CargoOperationEvent', 'CargoOperationEvent'); needUri('vessel'); needUri('territory'); needUri('port'); need('operation', (v) => v === 'load' || v === 'unload', 'load or unload'); need('cargo', cargo, 'CargoManifest'); need('effectiveAt', (v) => typeof v === 'string' && validateInstant(v), 'RFC3339 instant'); },
    DepartureRequest: () => { needUri('id'); need('type', (v) => v === 'DepartureRequest', 'DepartureRequest'); needUri('vessel'); needUri('territory'); needUri('port'); },
    DepartureEvent: () => { needUri('id'); need('type', (v) => v === 'DepartureEvent', 'DepartureEvent'); needUri('vessel'); needUri('territory'); needUri('port'); needUri('request'); need('effectiveAt', (v) => typeof v === 'string' && validateInstant(v), 'RFC3339 instant'); },
    VoyageEvent: () => { needUri('id'); need('type', (v) => v === 'VoyageEvent', 'VoyageEvent'); needUri('vessel'); needUri('territory'); need('kind', string, 'string'); need('effectiveAt', (v) => typeof v === 'string' && validateInstant(v), 'RFC3339 instant'); },
    ExitEvent: () => { needUri('id'); need('type', (v) => v === 'ExitEvent', 'ExitEvent'); needUri('vessel'); needUri('territory'); needUri('route'); needUri('entryRequest'); need('cargo', cargo, 'CargoManifest'); need('effectiveAt', (v) => typeof v === 'string' && validateInstant(v), 'RFC3339 instant'); need('proof', proof, 'eddsa-rdfc-2022 proof'); },
    Listing: () => { needUri('id'); needUri('port'); needUri('seller'); need('offered', cargo, 'CargoManifest'); if ('requested' in value) need('requested', cargo, 'CargoManifest'); },
    MapDescriptor: () => { needUri('id'); need('representations', Array.isArray, 'array'); },
    MapRepresentation: () => { needUri('format'); need('resources', (v) => Array.isArray(v) && v.every((resource) => record(resource) && string(resource.role) && uri(resource.url) && string(resource.mediaType)), 'MapResource array'); },
    MapResource: () => { need('role', string, 'string'); needUri('url'); need('mediaType', string, 'string'); },
    TokenDigest: () => { need('tokenDigest', string, 'string'); needUri('actor'); need('revision', uint, 'unsigned integer'); },
    TokenRevoke: () => { need('tokenRevoke', (v) => v === 'revoke', 'revoke'); needUri('actor'); need('revision', uint, 'unsigned integer'); }
  };
  entries[model]();
  if (issues.length) return { success: false, issues };
  return { success: true, data: structuredClone(value) as T };
}

export function assertModel<T extends ExtensionFields>(value: unknown, model: FctpModelName): T {
  const result = validateModel<T>(value, model);
  if (!result.success) throw new TypeError(`Invalid ${model}: ${result.issues.map((i) => `${i.path} ${i.message}`).join(', ')}`);
  return result.data;
}

export function validateInstant(value: string): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second &&
    Number(match[8] ?? 0) < 24 && Number(match[9] ?? 0) < 60;
}

export interface CargoDifference { leftOnly: Quantity[]; rightOnly: Quantity[] }
export function compareCargo(left: CargoManifest, right: CargoManifest): CargoDifference {
  const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : record(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
  const itemKey = (q: Quantity): string => 'id' in q ? `item:${q.id}` : `stack:${q.variety}:${stable(q.data)}`;
  const sum = (entries: Quantity[]): Map<string, { item?: Quantity; count: number }> => {
    const map = new Map<string, { item?: Quantity; count: number }>();
    for (const entry of entries) {
      const key = itemKey(entry);
      const current = map.get(key) ?? { count: 0 };
      current.item = entry;
      current.count += 'id' in entry ? 1 : entry.count;
      map.set(key, current);
    }
    return map;
  };
  const l = sum(left.entries); const r = sum(right.entries);
  const difference = (a: Map<string, { item?: Quantity; count: number }>, b: Map<string, { item?: Quantity; count: number }>): Quantity[] => {
    const output: Quantity[] = [];
    for (const [key, entry] of a) {
      const count = Math.max(0, entry.count - (b.get(key)?.count ?? 0));
      if (count && entry.item) output.push('id' in entry.item ? entry.item : { ...entry.item, count });
    }
    return output;
  };
  return { leftOnly: difference(l, r), rightOnly: difference(r, l) };
}

export function quantityMass(manifest: CargoManifest, varietyMass: ReadonlyMap<URI, number>): number {
  return manifest.entries.reduce((total, entry) => total + (varietyMass.get(entry.variety) ?? 0) * ('id' in entry ? 1 : entry.count), 0);
}

export function validateProduction(production: Production): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!['mine', 'manufacture'].includes(production.type)) issues.push({ path: '/type', message: 'Expected mine or manufacture' });
  if (!uint(production.duration)) issues.push({ path: '/duration', message: 'Expected unsigned integer' });
  if (!Array.isArray(production.yield) || production.yield.some((y) => !Number.isFinite(y.probability) || !uint(y.count) || !record(y.data))) issues.push({ path: '/yield', message: 'Invalid yield candidate' });
  if (production.ingredients?.some((q) => !record(q) || !uri(q.variety) || ('count' in q && !uint(q.count)))) issues.push({ path: '/ingredients', message: 'Invalid ingredient quantity' });
  return issues;
}
