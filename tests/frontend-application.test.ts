import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { encodeJobId, encodeOperationId } from '../apps/client-server/src/adapters/operations.js';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request as PlaywrightRequest } from 'playwright';
import type {
  ActionRecord,
  AdministrationData,
  AuthoringDraft,
  ExploreCapabilityRecord,
  ExploreConnectionRecord,
  ExplorePlaceDetailData,
  ExplorePlaceRecord,
  ExplorePlacesData,
  ExploreResourceRecord,
  ExploreVesselPosition,
  LibraryData,
  LogisticsVesselCandidate,
  LogisticsVesselCandidatesData,
  LogisticsVesselData,
  PageResponse,
  ProductionData,
  ProductionJob,
  ProductionOperation,
  RoutePlanRecord,
  SourcedObservation
} from '@fctp/client-sdk';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://application.invalid/';
const sessionKey = 'fctp.client-sessions';
const settleTimeout = 5_000;
const observedAt = '2026-02-03T04:05:06.000Z';

const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Application } from './apps/frontend/src/application.tsx';

createRoot(document.getElementById('root')).render(
  React.createElement(React.StrictMode, null, React.createElement(Application))
);
`;

interface StoredSession {
  accountId: string;
  handle: string;
  clientToken: string;
  actorId?: string;
  homeAuthority?: string;
}

interface MockRequest {
  method: string;
  path: string;
  search: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  authorization: string | undefined;
}

interface MockResponse {
  status?: number;
  json?: unknown;
}

interface WorkflowInput {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  accountId: string | undefined;
  body: Record<string, unknown> | undefined;
}

interface DirectoryResponse {
  servers: Array<{ server: string; origin: string; authorities: string[]; name?: string }>;
  authorities: Array<{ actorId: string; server: string; roles: string[]; name?: string; handle?: string }>;
}

interface ResourceInput {
  id: string;
  refresh: boolean;
  accountId: string | undefined;
  authorityId: string | undefined;
}

interface ActivityActionInput {
  accountId: string;
  actionId: string;
  refresh: boolean;
}

interface AdministrationReadInput {
  accountId: string;
}

interface AdministrationControlInput {
  accountId: string;
  authorityId: string;
  control: string;
  inputs: Record<string, unknown>;
}

function accountRecord(id: string): Record<string, unknown> {
  return {
    id,
    handle: id,
    homeServer: 'home.example',
    login: { status: 'signed-in' }
  };
}

function directoryFor(origin: string): DirectoryResponse {
  const host = new URL(origin).host;
  const actorId = `${origin}/actors/registry`;
  return {
    servers: [{ server: host, origin, authorities: [actorId], name: 'Harbor Server' }],
    authorities: [{
      actorId,
      server: host,
      roles: ['registry'],
      name: 'Harbor Registry',
      handle: `@harbor.registry@${host}`
    }]
  };
}

function resourcePage(input: { actorId: string; accountId: string | undefined; description: string; name: string }): Record<string, unknown> {
  const value = { id: input.actorId, type: 'Actor', name: input.name, description: input.description };
  return {
    context: {
      resourceId: input.actorId,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId })
    },
    data: { resourceId: input.actorId, value },
    observations: {
      [`observation:${input.actorId}`]: { state: 'available', source: input.actorId, observedAt, value }
    },
    actions: []
  };
}

function pageOf<T>(accountId: string | undefined, data: T, observations: Record<string, SourcedObservation<unknown>> = {}): PageResponse<T> {
  return {
    context: accountId === undefined ? {} : { accountId },
    data,
    observations,
    actions: []
  };
}

interface ActionInput {
  id: string;
  accountId: string;
  targetId: string;
  intent: ActionRecord['intent'];
  resultReferences?: ActionRecord['resultReferences'];
  submission?: ActionRecord['submission'];
  outcome?: ActionRecord['outcome'];
  journey?: ActionRecord['journey'];
}

function actionOf(input: ActionInput): ActionRecord {
  return {
    id: input.id,
    statusUrl: `https://activity.invalid/status/${encodeURIComponent(input.id)}`,
    accountId: input.accountId,
    targetId: input.targetId,
    resultReferences: input.resultReferences ?? [],
    intent: input.intent,
    submittedAt: '2026-02-03T04:05:06.000Z',
    submission: input.submission ?? { status: 'accepted' },
    outcome: input.outcome ?? { status: 'pending', evidence: [] },
    ...(input.journey === undefined ? {} : { journey: input.journey })
  };
}

function explorePlacesOf(input: {
  places: ExplorePlaceRecord[];
  connections?: ExploreConnectionRecord[];
  areas?: ExploreResourceRecord[];
  maps?: ExploreResourceRecord[];
  listings?: ExploreResourceRecord[];
  capabilities?: ExploreCapabilityRecord[];
  blockers?: ExplorePlacesData['blockers'];
  positions?: ExploreVesselPosition[];
}): ExplorePlacesData {
  return {
    places: input.places,
    connections: input.connections ?? [],
    areas: input.areas ?? [],
    maps: input.maps ?? [],
    listings: input.listings ?? [],
    capabilities: input.capabilities ?? [],
    blockers: input.blockers ?? [],
    ...(input.positions === undefined ? {} : { positions: input.positions })
  };
}

function explorePlaceDetailOf(input: {
  place: ExplorePlaceRecord;
  onward?: ExplorePlaceRecord[];
  connections?: ExploreConnectionRecord[];
  areas?: ExploreResourceRecord[];
  maps?: ExploreResourceRecord[];
  listings?: ExploreResourceRecord[];
  capabilities?: ExploreCapabilityRecord[];
  blockers?: ExplorePlaceDetailData['blockers'];
  positions?: ExploreVesselPosition[];
}): ExplorePlaceDetailData {
  return {
    place: input.place,
    onward: input.onward ?? [],
    connections: input.connections ?? [],
    areas: input.areas ?? [],
    maps: input.maps ?? [],
    listings: input.listings ?? [],
    capabilities: input.capabilities ?? [],
    blockers: input.blockers ?? [],
    ...(input.positions === undefined ? {} : { positions: input.positions })
  };
}

function routePlanOf(input: {
  id: string;
  accountId: string;
  from: string;
  to: string;
  legs: RoutePlanRecord['legs'];
  blockers?: RoutePlanRecord['blockers'];
  createdAt?: string;
}): RoutePlanRecord {
  return {
    id: input.id,
    accountId: input.accountId,
    from: input.from,
    to: input.to,
    legs: input.legs,
    blockers: input.blockers ?? [],
    createdAt: input.createdAt ?? observedAt
  };
}

function vesselCandidateOf(input: {
  id: string;
  name?: string;
  registry?: string;
  possessor?: string;
  ownership?: LogisticsVesselCandidate['ownership'];
  registrySupported?: boolean;
  source?: string;
  state?: LogisticsVesselCandidate['state'];
  observedAt?: string;
  error?: string;
}): LogisticsVesselCandidate {
  return {
    id: input.id,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.registry === undefined ? {} : { registry: input.registry }),
    ...(input.possessor === undefined ? {} : { possessor: input.possessor }),
    ownership: input.ownership ?? 'verified-owned',
    ...(input.registrySupported === undefined ? {} : { registrySupported: input.registrySupported }),
    source: input.source ?? input.id,
    state: input.state ?? 'available',
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
    ...(input.error === undefined ? {} : { error: input.error })
  };
}

function vesselCandidatesOf(
  accountId: string,
  candidates: LogisticsVesselCandidate[],
  blockers: string[] = []
): LogisticsVesselCandidatesData {
  return { accountId, candidates, blockers };
}

function vesselOf(input: {
  accountId: string;
  vesselId: string;
  name: string;
  registry?: string;
  possessor?: string;
  portId?: string;
}): LogisticsVesselData {
  const registry = input.registry ?? 'https://registry.invalid/actors/registry';
  return {
    accountId: input.accountId,
    vesselId: input.vesselId,
    vessel: {
      id: input.vesselId,
      registry,
      possessor: input.possessor ?? 'https://actors.invalid/owner',
      name: input.name
    },
    registry: {
      authorityId: registry,
      source: `${registry}/local/state`,
      state: 'available',
      observedAt,
      cargo: { entries: [] },
      adoption: true,
      location: {
        status: 'docked',
        ...(input.portId === undefined ? {} : { port: input.portId })
      }
    },
    territories: []
  };
}

function productionOperationOf(input: {
  operationId: string;
  authorityId: string;
  kind: ProductionOperation['kind'];
  label: string;
  effect?: string;
  inputs?: ProductionOperation['inputs'];
  defaults?: ProductionOperation['defaults'];
  blockers?: string[];
  available?: boolean;
  outputDestination?: string;
  source?: string;
  observedAt?: string;
}): ProductionOperation {
  return {
    operationId: input.operationId,
    authorityId: input.authorityId,
    kind: input.kind,
    label: input.label,
    effect: input.effect ?? `${input.label} changes the observed world.`,
    inputs: input.inputs ?? [],
    defaults: input.defaults ?? {},
    blockers: input.blockers ?? [],
    available: input.available ?? true,
    ...(input.outputDestination === undefined ? {} : { outputDestination: input.outputDestination }),
    source: input.source ?? `${input.authorityId}/local/actions`,
    observedAt: input.observedAt ?? observedAt
  };
}

function productionJobOf(input: {
  jobId: string;
  authorityId: string;
  accountId: string;
  vesselId: string;
  operation: ProductionJob['operation'];
  status: ProductionJob['status'];
  source?: string;
  observedAt?: string;
  progress?: ProductionJob['progress'];
  output?: string;
  evidence?: ProductionJob['evidence'];
  error?: string;
}): ProductionJob {
  return {
    jobId: input.jobId,
    authorityId: input.authorityId,
    accountId: input.accountId,
    vesselId: input.vesselId,
    operation: input.operation,
    status: input.status,
    source: input.source ?? `${input.authorityId}/local/state`,
    observedAt: input.observedAt ?? observedAt,
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    ...(input.error === undefined ? {} : { error: input.error })
  };
}

function productionOf(input: {
  accountId: string;
  vesselId: string;
  operations?: ProductionOperation[];
  authorities?: ProductionData['authorities'];
  jobs?: ProductionJob[];
}): ProductionData {
  return {
    accountId: input.accountId,
    vesselId: input.vesselId,
    operations: input.operations ?? [],
    authorities: input.authorities ?? [],
    jobs: input.jobs ?? []
  };
}

function libraryOf(data: Partial<LibraryData> = {}): LibraryData {
  return {
    assets: data.assets ?? [],
    varieties: data.varieties ?? [],
    grants: data.grants ?? [],
    drafts: data.drafts ?? []
  };
}

function draftOf(input: {
  id: string;
  accountId: string;
  kind: AuthoringDraft['kind'];
  fields: Record<string, unknown>;
  savedAt?: string;
  publication?: AuthoringDraft['publication'];
}): AuthoringDraft {
  return {
    id: input.id,
    accountId: input.accountId,
    kind: input.kind,
    fields: input.fields,
    savedAt: input.savedAt ?? observedAt,
    ...(input.publication === undefined ? {} : { publication: input.publication })
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ApplicationMock {
  readonly requests: MockRequest[] = [];
  directory: DirectoryResponse = { servers: [], authorities: [] };
  private readonly accounts = new Map<string, { id: string; handle: string; actorId?: string; homeAuthority?: string }>();
  private readonly tokenAccounts = new Map<string, string>();
  private readonly waiters: Array<() => void> = [];

  onLogin: (body: Record<string, unknown>) => MockResponse = () => ({ status: 404, json: { error: 'unexpected-login' } });
  onDiscover: (body: Record<string, unknown>) => DirectoryResponse = () => this.directory;
  onResource: (input: ResourceInput) => Record<string, unknown> = (input) => resourcePage({
    actorId: input.id,
    accountId: input.accountId,
    name: 'Harbor Registry',
    description: 'Retained authority record'
  });
  onActivityList: (accountId: string) => MockResponse = () => ({ status: 404, json: { error: 'unexpected-activity-list' } });
  onActivityAction: (input: ActivityActionInput) => MockResponse = () => ({ status: 404, json: { error: 'unexpected-activity-action' } });
  onAdministration: (input: AdministrationReadInput) => MockResponse = () => ({ status: 404, json: { error: 'unexpected-administration' } });
  onAdministrationControl: (input: AdministrationControlInput) => MockResponse = () => ({ status: 404, json: { error: 'unexpected-administration-control' } });
  onWorkflow: (input: WorkflowInput) => MockResponse | Promise<MockResponse> | undefined = () => undefined;

  seed(sessions: readonly StoredSession[]): void {
    for (const session of sessions) {
      this.accounts.set(session.accountId, {
        id: session.accountId,
        handle: session.handle,
        ...(session.actorId === undefined ? {} : { actorId: session.actorId }),
        ...(session.homeAuthority === undefined ? {} : { homeAuthority: session.homeAuthority })
      });
      this.tokenAccounts.set(session.clientToken, session.accountId);
    }
  }

  record(request: PlaywrightRequest, url: URL): MockRequest {
    const headers = request.headers();
    const record: MockRequest = {
      method: request.method(),
      path: url.pathname,
      search: url.search,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: request.postData(),
      authorization: headers.authorization
    };
    this.requests.push(record);
    this.notify();
    return record;
  }

  waitFor(predicate: (request: MockRequest) => boolean, timeout = settleTimeout): Promise<MockRequest> {
    const existing = this.requests.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<MockRequest>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Timed out waiting for an application request')); }, timeout);
      const check = (): void => {
        const match = this.requests.find(predicate);
        if (!match) {
          this.waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve(match);
      };
      check();
    });
  }

  waitUntil(predicate: () => boolean, message: string, timeout = settleTimeout): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(message)); }, timeout);
      const check = (): void => {
        if (!predicate()) {
          this.waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      check();
    });
  }

  async handle(request: MockRequest): Promise<MockResponse> {
    if (request.method === 'POST' && request.path === '/api/accounts/login') {
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      const response = this.onLogin(body);
      const payload = response.json as { status?: unknown; account?: { id?: unknown; handle?: unknown }; clientToken?: unknown } | undefined;
      if (payload && payload.status === 'signed-in'
        && typeof payload.account?.id === 'string'
        && typeof payload.account.handle === 'string'
        && typeof payload.clientToken === 'string') {
        this.accounts.set(payload.account.id, { id: payload.account.id, handle: payload.account.handle });
        this.tokenAccounts.set(payload.clientToken, payload.account.id);
      }
      return response;
    }

    if (request.method === 'GET' && request.path === '/api/accounts') {
      const accountId = this.accountFor(request);
      if (accountId === undefined) return { status: 401, json: { error: 'rejected-session' } };
      const account = this.accounts.get(accountId)!;
      return {
        json: {
          accounts: [{
            ...accountRecord(accountId),
            handle: account.handle,
            ...(account.actorId === undefined ? {} : { actorId: account.actorId }),
            ...(account.homeAuthority === undefined ? {} : { homeAuthority: account.homeAuthority })
          }]
        }
      };
    }

    if (request.path === '/api/servers') {
      if (request.method === 'GET') return { json: this.directory };
      if (request.method === 'POST') {
        const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
        this.directory = this.onDiscover(body);
        return { json: this.directory };
      }
    }

    const workflow = this.workflowInput(request);
    if (workflow !== undefined) {
      const publicExplore = workflow.method === 'GET'
        && workflow.path.startsWith('/api/explore/')
        && workflow.accountId === undefined;
      if (!publicExplore && (workflow.accountId === undefined || !this.authorized(request, workflow.accountId))) {
        return { status: 401, json: { error: 'rejected-session' } };
      }
      const workflowResponse = await this.onWorkflow(workflow);
      if (workflowResponse !== undefined) return workflowResponse;
    }

    if (request.method === 'GET' && request.path === '/api/activity') {
      const accountId = request.query.accountId;
      if (accountId === undefined || !this.authorized(request, accountId)) return { status: 401, json: { error: 'rejected-session' } };
      return this.onActivityList(accountId);
    }

    const activityRefreshMatch = /^\/api\/activity\/([^/]+)\/refresh$/.exec(request.path);
    if (request.method === 'POST' && activityRefreshMatch) {
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
      if (accountId === undefined || !this.authorized(request, accountId)) return { status: 401, json: { error: 'rejected-session' } };
      return this.onActivityAction({ accountId, actionId: decodeURIComponent(activityRefreshMatch[1]!), refresh: true });
    }

    const activityMatch = /^\/api\/activity\/([^/]+)$/.exec(request.path);
    if (request.method === 'GET' && activityMatch) {
      const accountId = request.query.accountId;
      if (accountId === undefined || !this.authorized(request, accountId)) return { status: 401, json: { error: 'rejected-session' } };
      return this.onActivityAction({ accountId, actionId: decodeURIComponent(activityMatch[1]!), refresh: false });
    }

    if (request.method === 'GET' && request.path === '/api/administration') {
      const accountId = request.query.accountId;
      if (accountId === undefined || !this.authorized(request, accountId)) return { status: 401, json: { error: 'rejected-session' } };
      return this.onAdministration({ accountId });
    }

    if (request.method === 'POST' && request.path === '/api/administration/controls') {
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
      const authorityId = typeof body.authorityId === 'string' ? body.authorityId : undefined;
      const control = typeof body.control === 'string' ? body.control : undefined;
      const inputs = typeof body.inputs === 'object' && body.inputs !== null && !Array.isArray(body.inputs)
        ? body.inputs as Record<string, unknown>
        : undefined;
      if (accountId === undefined || !this.authorized(request, accountId)) return { status: 401, json: { error: 'rejected-session' } };
      if (authorityId === undefined || control === undefined || inputs === undefined) {
        return { status: 400, json: { error: 'invalid-control' } };
      }
      return this.onAdministrationControl({ accountId, authorityId, control, inputs });
    }

    const resourceMatch = /^\/api\/resources\/([^/]+)(\/refresh)?$/.exec(request.path);
    if (resourceMatch) {
      const id = decodeURIComponent(resourceMatch[1]!);
      const refresh = resourceMatch[2] !== undefined;
      const body = refresh ? JSON.parse(request.body ?? '{}') as Record<string, unknown> : undefined;
      const accountId = refresh
        ? (typeof body?.accountId === 'string' ? body.accountId : undefined)
        : (request.query.accountId ?? undefined);
      const authorityId = refresh
        ? (typeof body?.authorityId === 'string' ? body.authorityId : undefined)
        : (request.query.authorityId ?? undefined);
      if (this.accountFor(request) === undefined) return { status: 401, json: { error: 'rejected-session' } };
      return { json: this.onResource({ id, refresh, accountId, authorityId }) };
    }

    return { status: 404, json: { error: 'unexpected-request' } };
  }

  private workflowInput(request: MockRequest): WorkflowInput | undefined {
    const isWorkflow = request.path.startsWith('/api/explore/')
      || request.path === '/api/activity' || request.path.startsWith('/api/activity/')
      || request.path.startsWith('/api/logistics/')
      || request.path.startsWith('/api/production')
      || request.path.startsWith('/api/library')
      || request.path.startsWith('/api/drafts');
    if (!isWorkflow) return undefined;
    let body: Record<string, unknown> | undefined;
    if (request.body !== null) {
      const parsed = JSON.parse(request.body) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    }
    const bodyAccountId = typeof body?.accountId === 'string' ? body.accountId : undefined;
    return {
      method: request.method,
      path: request.path,
      query: request.query,
      authorization: request.authorization,
      accountId: request.query.accountId ?? bodyAccountId,
      body
    };
  }

  private notify(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private accountFor(request: MockRequest): string | undefined {
    const token = request.authorization?.replace(/^Bearer /, '');
    return token === undefined ? undefined : this.tokenAccounts.get(token);
  }

  private authorized(request: MockRequest, accountId: string | undefined): boolean {
    const tokenAccount = this.accountFor(request);
    return tokenAccount !== undefined && accountId !== undefined && tokenAccount === accountId;
  }
}

let browser: Browser | undefined;
let bundle: string | undefined;
let stylesheet: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-application-fixture.js',
      loader: 'js'
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    outdir: join(tmpdir(), 'fctp-frontend-application-fixture'),
    loader: { '.css': 'local-css' },
    define: { 'process.env.NODE_ENV': '"development"' }
  });
  const script = result.outputFiles.find((file) => file.path.endsWith('.js'));
  const css = result.outputFiles.find((file) => file.path.endsWith('.css'));
  assert(script, 'esbuild produced no application fixture bundle');
  assert(css, 'esbuild produced no real stylesheet output');
  bundle = script.text;
  stylesheet = css.text;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

interface OpenOptions {
  sessions?: readonly StoredSession[];
  configureMock?: (mock: ApplicationMock) => void;
}

async function openApplicationPage(t: TestContext, options: OpenOptions = {}): Promise<{ page: Page; mock: ApplicationMock; errors: string[]; context: BrowserContext }> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  const activeStylesheet = stylesheet;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'application fixture bundle was not built');
  assert(activeStylesheet, 'application stylesheet was not built');

  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  if (options.sessions !== undefined) {
    const storedSessions = options.sessions.map(({ accountId, handle, clientToken }) => ({ accountId, handle, clientToken }));
    await context.addInitScript((seed: { key: string; value: string }) => {
      localStorage.setItem(seed.key, seed.value);
    }, { key: sessionKey, value: JSON.stringify(storedSessions) });
  }

  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });
  const mock = new ApplicationMock();
  options.configureMock?.(mock);
  if (options.sessions !== undefined) mock.seed(options.sessions);

  await page.route(`${fixtureOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    if (url.pathname === '/bundle.css') {
      await route.fulfill({ status: 200, contentType: 'text/css', body: activeStylesheet });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const record = mock.record(request, url);
      const response = await mock.handle(record);
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.json ?? {})
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  await page.goto(fixtureOrigin);
  return { page, mock, errors, context };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, message: string, timeout = settleTimeout): Promise<void> {
  const started = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - started >= timeout) throw new Error(message);
    await sleep(25);
  }
}

function readerDialog(page: Page, heading: string): Locator {
  return page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
}

function topicTab(page: Page, name: string): Locator {
  return page.getByRole('tab', { name, exact: true });
}

function connectionsRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Connections' });
}

function accountOption(page: Page, handle: string): Locator {
  return page.getByRole('option').filter({ hasText: handle });
}

async function selectAccount(page: Page, handle: string): Promise<void> {
  const target = accountOption(page, handle);
  await target.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await target.count(), 1, `expected one account choice for ${handle}`);
  await target.click();
  await page.waitForFunction((text) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    const selected = options.find((candidate) => candidate.textContent?.includes(text));
    return selected?.getAttribute('aria-selected') === 'true';
  }, handle, { timeout: settleTimeout });
}

async function selectAccountWithoutPointer(page: Page, handle: string): Promise<void> {
  await page.evaluate((text) => {
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .find((candidate) => candidate.textContent?.includes(text));
    if (!(option instanceof HTMLElement)) throw new Error(`missing account choice for ${text}`);
    option.click();
  }, handle);
  await page.waitForFunction((text) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    const selected = options.find((candidate) => candidate.textContent?.includes(text));
    return selected?.getAttribute('aria-selected') === 'true';
  }, handle, { timeout: settleTimeout });
}

async function discover(page: Page, mock: ApplicationMock, origin: string): Promise<MockRequest> {
  const input = connectionsRegion(page).getByRole('textbox', { name: /server origin or account\/authority handle/i });
  await input.waitFor({ state: 'visible', timeout: settleTimeout });
  await input.fill(origin);
  await input.press('Enter');
  return mock.waitFor((request) => request.method === 'POST' && request.path === '/api/servers');
}

async function waitForReadAuthority(page: Page): Promise<Locator> {
  const buttons = connectionsRegion(page).getByRole('button', { name: /read authority/i });
  await buttons.first().waitFor({ state: 'visible', timeout: settleTimeout });
  return buttons;
}

function parsedBody(request: MockRequest): unknown {
  return request.body === null ? undefined : JSON.parse(request.body) as unknown;
}

type AdministrationTarget = AdministrationData['targets'][number];
type AdministrationControl = AdministrationData['controls'][number];

function administrationOf(
  accountId: string,
  targets: AdministrationTarget[],
  controls: AdministrationControl[],
  states: AdministrationData['states']
): AdministrationData {
  return { accountId, targets, controls, requests: [], states };
}

function administrationTarget(
  authorityId: string,
  name: string,
  kind: AdministrationTarget['kind'],
  roles: AdministrationTarget['roles']
): AdministrationTarget {
  return {
    authorityId,
    server: new URL(authorityId).host,
    roles,
    name,
    ...(kind === undefined ? {} : { kind }),
    source: `${authorityId}/local/state`,
    state: 'available',
    observedAt
  };
}

function administrationControl(
  name: AdministrationControl['name'],
  authorityId: string,
  label: string
): AdministrationControl {
  return { name, authorityId, label, inputs: [] };
}

test('signs in, persists the account, discovers an origin, reads and refreshes an authority, then leaves one visible panel', async (t) => {
  const handle = '@alice@a.example';
  const password = 'integration-password';
  const token = 'token-alice';
  const origin = 'http://alpha.test:4200';
  const directory = directoryFor(origin);
  const authority = directory.authorities[0]!;
  const resourcePath = `/api/resources/${encodeURIComponent(authority.actorId)}`;

  const { page, mock, errors } = await openApplicationPage(t, {
    configureMock: (candidate) => {
      candidate.onLogin = (body) => {
        const credentials = body as { handle?: unknown; password?: unknown };
        if (credentials.handle === handle && credentials.password === password) {
          return { json: { status: 'signed-in', account: accountRecord(handle), clientToken: token } };
        }
        return { status: 401, json: { status: 'rejected', reason: 'invalid handle or password' } };
      };
      candidate.onDiscover = () => directory;
      candidate.onResource = ({ id, accountId, refresh }) => resourcePage({
        actorId: id,
        accountId,
        name: 'Harbor Registry',
        description: refresh ? 'Explicitly refreshed authority snapshot' : 'Initial retained authority snapshot'
      });
    }
  });

  await page.getByLabel('Handle', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await page.getByLabel('Password').waitFor({ state: 'visible', timeout: settleTimeout });
  await page.getByLabel('Handle', { exact: true }).fill(handle);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await accountOption(page, handle).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await accountOption(page, handle).count(), 1);

  const logins = mock.requests.filter((request) => request.path === '/api/accounts/login');
  assert.equal(logins.length, 1);
  assert.deepEqual(parsedBody(logins[0]!), { handle, password });
  assert.equal(logins[0]!.authorization, undefined);
  const loginBody = parsedBody(logins[0]!) as Record<string, unknown>;
  assert.equal('origin' in loginBody, false);
  assert.equal('home' in loginBody, false);

  const storedRaw = await page.evaluate((key) => localStorage.getItem(key), sessionKey);
  assert.ok(storedRaw, 'the client session must be persisted');
  const stored = JSON.parse(storedRaw) as StoredSession[];
  assert.deepEqual(stored.map((entry) => entry.accountId), [handle]);
  assert.equal(stored[0]!.clientToken, token);

  assert.equal(await page.evaluate(() => document.styleSheets.length > 0), true, 'the real stylesheet must be applied');

  const serverGetsBeforeReload = mock.requests.filter((request) => request.method === 'GET' && request.path === '/api/servers').length;
  await page.reload();
  await accountOption(page, handle).waitFor({ state: 'visible', timeout: settleTimeout });
  await mock.waitUntil(
    () => mock.requests.filter((request) => request.method === 'GET' && request.path === '/api/servers').length > serverGetsBeforeReload,
    'expected a retained directory read after restoring the session'
  );

  for (const request of mock.requests.filter((candidate) => candidate.path === '/api/servers')) {
    assert.equal(request.authorization, undefined, 'public directory requests must not attach a session credential');
  }

  const discovery = await discover(page, mock, origin);
  assert.deepEqual(parsedBody(discovery), { origin });
  assert.equal(discovery.authorization, undefined, 'explicit discovery must remain public');
  assert.equal(mock.requests.filter((request) => request.method === 'POST' && request.path === '/api/servers').length, 1);

  await connectionsRegion(page).getByRole('paragraph').filter({ hasText: authority.handle! }).waitFor({ state: 'visible', timeout: settleTimeout });

  const readButtons = await waitForReadAuthority(page);
  assert.equal(await readButtons.count(), 1, 'each known authority must have one contextual reader control');
  await readButtons.first().click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('heading', { name: 'Harbor Registry' }).waitFor({ state: 'visible', timeout: settleTimeout });

  const read = await mock.waitFor((request) => request.method === 'GET' && request.path === resourcePath);
  assert.equal(read.query.accountId, handle, 'the reader must use the exact selected account');
  assert.equal(read.authorization, `Bearer ${token}`, 'the reader must use the exact selected client session');

  await dialog.getByText(/Type:\s*Actor/i).waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByText(/Available/i).first().waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('paragraph').filter({ hasText: observedAt }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal((await dialog.innerText()).includes(authority.actorId), false, 'exact authority IDs belong in the disclosure');

  const details = dialog.locator('details').filter({ hasText: 'Resource details' });
  await details.locator('summary').click();
  const technical = await details.textContent();
  assert.ok(technical?.includes(`Source ${authority.actorId}`), 'the disclosure must retain the exact source');
  assert.ok(technical?.includes('State available'));
  assert.ok(technical?.includes(`Observed ${observedAt}`));

  await sleep(200);
  assert.equal(
    mock.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/resources/')).length,
    0,
    'opening the reader must not observe the world through POST'
  );

  await dialog.getByRole('button', { name: 'Refresh' }).click();
  const refresh = await mock.waitFor((request) => request.method === 'POST' && request.path === `${resourcePath}/refresh`);
  assert.equal(refresh.authorization, `Bearer ${token}`);
  const refreshBody = parsedBody(refresh) as Record<string, unknown>;
  assert.equal(refreshBody.accountId, handle);
  await dialog.getByText('Explicitly refreshed authority snapshot', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(
    mock.requests.filter((request) => request.method === 'POST' && request.path === `${resourcePath}/refresh`).length,
    1,
    'Refresh must be the only user-driven POST'
  );

  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true, 'refresh must preserve focus inside the dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await page.waitForFunction(() => {
    const active = document.activeElement as HTMLElement | null;
    return Boolean(active && active.tagName === 'BUTTON' && /read authority/i.test(active.textContent ?? ''));
  }, undefined, { timeout: settleTimeout });
  assert.equal(await readButtons.first().evaluate((element) => element === document.activeElement), true, 'closing must return focus to the originating authority control');

  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  await page.waitForFunction(() => {
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]')) as HTMLElement[];
    const visible = panels.filter((panel) => panel.getClientRects().length > 0);
    return visible.length === 1 && (visible[0]?.textContent ?? '').includes('Explore');
  }, undefined, { timeout: settleTimeout });
  assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1, 'exactly one topic panel must be visible');

  const bodyText = await page.locator('body').innerText();
  assert.equal(bodyText.includes(password), false, 'the password must not appear in visible text');
  assert.equal(bodyText.includes(token), false, 'the client token must not appear in visible text');
  assert.deepEqual(errors, []);
});

test('keeps same-name accounts isolated while reopening the same retained authority reader', async (t) => {
  const first = '@same@a.example';
  const second = '@same@b.example';
  const tokenFirst = 'token-alpha';
  const tokenSecond = 'token-beta';
  const origin = 'http://alpha.test:4200';
  const directory = directoryFor(origin);
  const authority = directory.authorities[0]!;
  const resourcePath = `/api/resources/${encodeURIComponent(authority.actorId)}`;

  const { page, mock, errors } = await openApplicationPage(t, {
    sessions: [
      { accountId: first, handle: first, clientToken: tokenFirst },
      { accountId: second, handle: second, clientToken: tokenSecond }
    ],
    configureMock: (candidate) => {
      candidate.onDiscover = () => directory;
      candidate.onResource = ({ id, accountId }) => resourcePage({
        actorId: id,
        accountId,
        name: 'Harbor Registry',
        description: accountId === first ? 'Alpha private registry record' : 'Beta private registry record'
      });
    }
  });

  await accountOption(page, first).waitFor({ state: 'visible', timeout: settleTimeout });
  await accountOption(page, second).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await accountOption(page, first).count(), 1);
  assert.equal(await accountOption(page, second).count(), 1);

  await selectAccount(page, first);
  const discovery = await discover(page, mock, origin);
  assert.deepEqual(parsedBody(discovery), { origin });
  assert.equal(discovery.authorization, undefined);

  await connectionsRegion(page).getByRole('paragraph').filter({ hasText: authority.handle! }).waitFor({ state: 'visible', timeout: settleTimeout });
  const firstButtons = await waitForReadAuthority(page);
  assert.equal(await firstButtons.count(), 1);
  await firstButtons.first().click();

  let dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByText('Alpha private registry record', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  const firstRead = await mock.waitFor((request) => request.method === 'GET' && request.path === resourcePath && request.query.accountId === first);
  assert.equal(firstRead.authorization, `Bearer ${tokenFirst}`);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });

  const serverGetsBeforeSwitch = mock.requests.filter((request) => request.method === 'GET' && request.path === '/api/servers').length;
  await selectAccount(page, second);
  await mock.waitUntil(
    () => mock.requests.filter((request) => request.method === 'GET' && request.path === '/api/servers').length > serverGetsBeforeSwitch,
    'expected the connections panel to reload for the exact selected account'
  );
  assert.equal((await page.locator('body').innerText()).includes('Alpha private registry record'), false, 'private reader content must not cross the account switch');

  const secondButtons = await waitForReadAuthority(page);
  assert.equal(await secondButtons.count(), 1);
  await secondButtons.first().click();

  dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByText('Beta private registry record', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal((await dialog.innerText()).includes('Alpha private registry record'), false);

  const secondRead = await mock.waitFor((request) => request.method === 'GET' && request.path === resourcePath && request.query.accountId === second);
  assert.equal(secondRead.authorization, `Bearer ${tokenSecond}`, 'reopening must use the newly selected account session');
  assert.equal(secondRead.query.accountId, second);

  assert.equal(await page.getByRole('tab').count(), 6, 'the same shell must remain coherent across the account switch');
  assert.equal(await accountOption(page, first).count(), 1);
  assert.equal(await accountOption(page, second).count(), 1);
  assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });

  const bodyText = await page.locator('body').innerText();
  assert.equal(bodyText.includes(tokenFirst), false);
  assert.equal(bodyText.includes(tokenSecond), false);
  assert.equal(bodyText.includes('Alpha private registry record'), false);
  assert.equal(bodyText.includes('Beta private registry record'), false);
  assert.deepEqual(errors, []);
});

test('selects a second authority, sends one observed policy control, and links exact Activity evidence back to that authority', async (t) => {
  const handle = '@operator@alpha.example';
  const token = 'token-operator';
  const firstAuthority = 'https://alpha.test/actors/territory';
  const secondAuthority = 'https://beta.test/actors/territory';
  const actionId = 'https://activity.invalid/actions/policy-1';
  const evidenceAt = '2026-02-04T05:06:07.000Z';
  const observedPolicy = {
    miningPermitted: true,
    miningQuota: 20,
    oreReserve: 100,
    manufacturePermits: ['ore-to-metal'],
    customFlag: 'keep-me'
  };
  const targets = [
    administrationTarget(firstAuthority, 'Alpha Territory', 'policy', ['territory']),
    administrationTarget(secondAuthority, 'Beta Territory', 'policy', ['territory'])
  ];
  const controls = [
    administrationControl('policy', secondAuthority, 'Policy'),
    administrationControl('tick', secondAuthority, 'Advance simulation tick')
  ];
  const states = { [secondAuthority]: { kind: 'policy', state: { policy: observedPolicy } } };
  let submittedInputs: Record<string, unknown> | undefined;

  const pendingAction = (accountId: string): ActionRecord => actionOf({
    id: actionId,
    accountId,
    targetId: secondAuthority,
    intent: {
      kind: 'administration-control',
      inputs: {
        authorityId: secondAuthority,
        control: 'policy',
        authorityKind: 'policy',
        inputs: submittedInputs ?? {}
      }
    },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });

  const { page, mock, errors } = await openApplicationPage(t, {
    sessions: [{ accountId: handle, handle, clientToken: token }],
    configureMock: (candidate) => {
      candidate.onAdministration = ({ accountId }) => ({
        json: pageOf(accountId, administrationOf(accountId, targets, controls, states))
      });
      candidate.onActivityList = (accountId) => ({ json: pageOf(accountId, { actions: [] }) });
      candidate.onActivityAction = ({ accountId, actionId: requestedId, refresh }) => {
        if (refresh) {
          return {
            json: pageOf(accountId, {
              action: actionOf({
                id: requestedId,
                accountId,
                targetId: secondAuthority,
                intent: {
                  kind: 'administration-control',
                  inputs: {
                    authorityId: secondAuthority,
                    control: 'policy',
                    authorityKind: 'policy',
                    inputs: submittedInputs ?? {}
                  }
                },
                submission: { status: 'accepted' },
                outcome: {
                  status: 'completed',
                  evidence: [{
                    source: 'https://evidence.invalid/policy',
                    observedAt: evidenceAt,
                    changes: { miningQuota: 42 }
                  }]
                }
              })
            })
          };
        }
        return { json: pageOf(accountId, { action: pendingAction(accountId) }) };
      };
      candidate.onAdministrationControl = (input) => {
        submittedInputs = input.inputs;
        return {
          json: {
            action: pendingAction(input.accountId)
          }
        };
      };
    }
  });

  await accountOption(page, handle).waitFor({ state: 'visible', timeout: settleTimeout });
  await selectAccount(page, handle);
  await page.getByRole('tab', { name: 'Administration', exact: true }).click();

  const administration = page.getByRole('region', { name: 'Administration' });
  await administration.waitFor({ state: 'visible', timeout: settleTimeout });
  await administration.getByRole('heading', { name: 'Alpha Territory', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  const targetSelect = administration.getByLabel('Administration target');
  await targetSelect.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await targetSelect.inputValue(), firstAuthority, 'the first published authority should be the retained default');
  await targetSelect.selectOption(secondAuthority);
  await administration.getByRole('heading', { name: 'Beta Territory', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  const observedSettings = administration.locator('details').filter({ hasText: 'Observed settings' });
  await observedSettings.locator('summary').click();
  const observed = await observedSettings.locator('pre').innerText();
  assert.ok(observed.includes('"miningQuota": 20'), 'the selected authority observation must be inspectable');
  assert.ok(observed.includes('"customFlag": "keep-me"'), 'observed extension values must remain inspectable');

  const quota = administration.getByLabel('Mining quota');
  assert.equal(await quota.inputValue(), '20');
  await quota.fill('42');
  await administration.getByRole('button', { name: 'Apply policy', exact: true }).click();

  const result = administration.getByRole('region', { name: 'Submission result' });
  await result.waitFor({ state: 'visible', timeout: settleTimeout });
  await result.getByText('Submission: accepted', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await result.getByText('Outcome: pending', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  const controlRequest = await mock.waitFor((request) => request.method === 'POST' && request.path === '/api/administration/controls');
  assert.equal(controlRequest.authorization, `Bearer ${token}`, 'the control must use the exact selected session');
  assert.deepEqual(parsedBody(controlRequest), {
    accountId: handle,
    authorityId: secondAuthority,
    control: 'policy',
    inputs: {
      customFlag: 'keep-me',
      miningPermitted: true,
      miningQuota: 42,
      oreReserve: 100,
      manufacturePermits: ['ore-to-metal']
    }
  });

  await result.getByRole('button', { name: 'Open Activity', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Activity' });
  await activity.waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByText(`Target: ${secondAuthority}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  const detailRequest = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/activity/${encodeURIComponent(actionId)}`
    && request.query.accountId === handle
  );
  assert.equal(detailRequest.authorization, `Bearer ${token}`, 'Activity detail must use the same exact account session');

  await sleep(200);
  assert.equal(
    mock.requests.filter((request) => request.method === 'POST' && request.path === '/api/administration/controls').length,
    1,
    'navigating to Activity must not replay the control submission'
  );
  assert.equal(
    mock.requests.filter((request) => request.method === 'POST' && request.path === `/api/activity/${encodeURIComponent(actionId)}/refresh`).length,
    0,
    'opening Activity must not reconcile automatically'
  );

  await activity.getByRole('button', { name: 'Refresh', exact: true }).click();
  const refreshRequest = await mock.waitFor((request) =>
    request.method === 'POST' && request.path === `/api/activity/${encodeURIComponent(actionId)}/refresh`
  );
  assert.equal(refreshRequest.authorization, `Bearer ${token}`);
  assert.deepEqual(parsedBody(refreshRequest), { accountId: handle });

  await activity.getByText('Outcome: completed', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByText('Source: https://evidence.invalid/policy', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByText(`Observed: ${evidenceAt}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByText('Changes: miningQuota: 42', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await activity.getByRole('button', { name: 'Open administration', exact: true }).click();
  await administration.waitFor({ state: 'visible', timeout: settleTimeout });
  await administration.getByRole('heading', { name: 'Beta Territory', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await targetSelect.inputValue(), secondAuthority, 'Activity must restore the exact administration authority');
  assert.equal(await administration.getByRole('heading', { name: 'Alpha Territory', exact: true }).count(), 0);

  await targetSelect.selectOption(firstAuthority);
  await administration.getByRole('heading', { name: 'Alpha Territory', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await activity.getByRole('button', { name: 'Open administration', exact: true }).click();
  await administration.getByRole('heading', { name: 'Beta Territory', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await targetSelect.inputValue(), secondAuthority, 'repeating a recovery handoff must reselect its exact target after a manual selection');
  assert.equal(await page.getByRole('tab', { name: 'Administration', exact: true }).evaluate((element) => element === document.activeElement), true, 'recovery navigation must move focus out of the hidden source panel');

  await sleep(200);
  assert.equal(
    mock.requests.filter((request) => request.method === 'POST' && request.path === '/api/administration/controls').length,
    1,
    'the whole workflow must send exactly one control'
  );
  assert.equal(
    mock.requests.filter((request) => request.method === 'POST' && request.path === '/api/administration/refresh').length,
    0,
    'neither navigation nor Activity refresh may observe the administration target again'
  );
  assert.equal(
    mock.requests.filter((request) => request.method === 'POST' && request.path === `/api/activity/${encodeURIComponent(actionId)}/refresh`).length,
    1,
    'only the explicit Activity Refresh may reconcile the action'
  );
  assert.deepEqual(errors, []);
});

test('opens the exact published resource from Activity and restores focus on Escape', async (t) => {
  const handle = '@reader@b.example';
  const token = 'token-reader';
  const resourceId = 'https://resources.invalid/published/survey';
  const actionId = 'https://activity.invalid/actions/publication-1';
  const evidenceAt = '2026-03-04T05:06:07.000Z';
  const action = actionOf({
    id: actionId,
    accountId: handle,
    targetId: 'https://library.invalid/entries/survey',
    intent: { kind: 'publication', inputs: {} },
    resultReferences: [{ kind: 'resource', id: resourceId }],
    submission: { status: 'accepted' },
    outcome: {
      status: 'completed',
      evidence: [{ source: 'https://evidence.invalid/publication', observedAt: evidenceAt }]
    }
  });

  const { page, mock, errors } = await openApplicationPage(t, {
    sessions: [{ accountId: handle, handle, clientToken: token }],
    configureMock: (candidate) => {
      candidate.onActivityList = (accountId) => ({ json: pageOf(accountId, { actions: [action] }) });
      candidate.onActivityAction = ({ accountId }) => ({ json: pageOf(accountId, { action }) });
      candidate.onResource = ({ id, accountId }) => resourcePage({
        actorId: id,
        accountId,
        name: 'Published Survey',
        description: 'Published survey content'
      });
    }
  });

  await accountOption(page, handle).waitFor({ state: 'visible', timeout: settleTimeout });
  await selectAccount(page, handle);
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();

  const activity = page.getByRole('region', { name: 'Activity' });
  await activity.waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByRole('button', { name: 'View details', exact: true }).click();

  const detail = activity.getByRole('region', { name: 'Action details' });
  await detail.waitFor({ state: 'visible', timeout: settleTimeout });
  await detail.getByText(`Target: ${action.targetId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  const readButton = detail.getByRole('button', { name: 'Read resource', exact: true });
  await readButton.waitFor({ state: 'visible', timeout: settleTimeout });
  await readButton.click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('heading', { name: 'Published Survey', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByText('Published survey content', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  const read = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/resources/${encodeURIComponent(resourceId)}`
  );
  assert.equal(read.query.accountId, handle, 'the reader must use the exact selected account');
  assert.equal(read.authorization, `Bearer ${token}`, 'the reader must use the exact selected session');

  await sleep(200);
  assert.equal(mock.requests.filter((request) => request.method === 'POST').length, 0, 'opening a published resource must not select or mutate anything');

  assert.equal(await page.evaluate(() => document.styleSheets.length > 0), true, 'the real stylesheet must be applied');
  assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1, 'exactly one topic panel must be visible');
  assert.equal(await page.getByRole('tab', { name: 'Activity', exact: true }).getAttribute('aria-selected'), 'true');

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await page.waitForFunction(() => {
    const active = document.activeElement as HTMLElement | null;
    return Boolean(active && active.tagName === 'BUTTON' && /read resource/i.test(active.textContent ?? ''));
  }, undefined, { timeout: settleTimeout });
  assert.equal(await readButton.evaluate((element) => element === document.activeElement), true, 'Escape must return focus to the invoking Activity control');
  assert.deepEqual(errors, []);
});

test('derives Home ownership from the selected full handle and isolates same-name accounts across a host switch', async (t) => {
  const first = 'account:home-a';
  const second = 'account:home-b';
  const firstHandle = '@harbor.home@a.example';
  const secondHandle = '@harbor.home@b.example';
  const other = '@other.home@a.example';
  const tokenFirst = 'token-harbor-a';
  const tokenSecond = 'token-harbor-b';
  const firstAuthority = 'https://home.a.example/actors/home';
  const secondAuthority = 'https://home.b.example/actors/home';
  const resourceFirst = 'https://resources.invalid/published/alpha-home';
  const resourceSecond = 'https://resources.invalid/published/beta-home';
  const actionFirstId = 'https://activity.invalid/actions/availability-a';
  const actionSecondId = 'https://activity.invalid/actions/availability-b';

  const homeData = (accountId: string, authorityId: string, name: string): AdministrationData => administrationOf(
    accountId,
    [administrationTarget(authorityId, name, 'home', ['home'])],
    [administrationControl('availability', authorityId, 'Account availability')],
    {
      [authorityId]: {
        kind: 'home',
        accounts: [
          { handle: firstHandle, actorId: 'https://actors.invalid/alpha-home', available: accountId === first },
          { handle: secondHandle, actorId: 'https://actors.invalid/beta-home', available: true },
          { handle: other, actorId: 'https://actors.invalid/other-home', available: false }
        ]
      }
    }
  );

  const actionFirst = actionOf({
    id: actionFirstId,
    accountId: first,
    targetId: firstAuthority,
    intent: {
      kind: 'administration-control',
      inputs: { authorityId: firstAuthority, control: 'availability', handle: secondHandle, available: false }
    },
    resultReferences: [{ kind: 'resource', id: resourceFirst }],
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });
  const actionSecond = actionOf({
    id: actionSecondId,
    accountId: second,
    targetId: secondAuthority,
    intent: { kind: 'publication', inputs: {} },
    resultReferences: [{ kind: 'resource', id: resourceSecond }],
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });

  const { page, mock, errors } = await openApplicationPage(t, {
    sessions: [
      { accountId: first, handle: firstHandle, clientToken: tokenFirst },
      { accountId: second, handle: secondHandle, clientToken: tokenSecond }
    ],
    configureMock: (candidate) => {
      candidate.onAdministration = ({ accountId }) => ({
        json: pageOf(accountId, accountId === first
          ? homeData(first, firstAuthority, 'Alpha Home')
          : homeData(second, secondAuthority, 'Beta Home'))
      });
      candidate.onAdministrationControl = (input) => ({
        json: { action: actionOf({ ...actionFirst, accountId: input.accountId }) }
      });
      candidate.onActivityList = (accountId) => ({
        json: pageOf(accountId, { actions: accountId === second ? [actionSecond] : [] })
      });
      candidate.onActivityAction = ({ accountId, actionId }) => ({
        json: pageOf(accountId, { action: actionId === actionSecondId ? actionSecond : actionFirst })
      });
      candidate.onResource = ({ id, accountId }) => resourcePage({
        actorId: id,
        accountId,
        name: id === resourceFirst ? 'Alpha published resource' : 'Beta published resource',
        description: id === resourceFirst ? 'Alpha private resource content' : 'Beta private resource content'
      });
    }
  });

  await accountOption(page, firstHandle).waitFor({ state: 'visible', timeout: settleTimeout });
  await accountOption(page, secondHandle).waitFor({ state: 'visible', timeout: settleTimeout });
  await selectAccount(page, firstHandle);
  await page.getByRole('tab', { name: 'Administration', exact: true }).click();

  const administration = page.getByRole('region', { name: 'Administration' });
  await administration.waitFor({ state: 'visible', timeout: settleTimeout });
  await administration.getByRole('heading', { name: 'Alpha Home', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  const ownFirst = administration.getByLabel(`Available for ${firstHandle}`);
  const otherSecond = administration.getByLabel(`Available for ${secondHandle}`);
  await ownFirst.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await ownFirst.isDisabled(), true, 'the verified full handle must identify the caller row');
  assert.equal(await otherSecond.isDisabled(), false, 'another account sharing the local name must remain available');

  await otherSecond.uncheck();
  await administration.getByRole('button', { name: `Apply availability for ${secondHandle}`, exact: true }).click();
  const firstControl = await mock.waitFor((request) => request.method === 'POST' && request.path === '/api/administration/controls');
  assert.equal(firstControl.authorization, `Bearer ${tokenFirst}`);
  assert.deepEqual(parsedBody(firstControl), {
    accountId: first,
    authorityId: firstAuthority,
    control: 'availability',
    inputs: { handle: secondHandle, available: false }
  });

  const result = administration.getByRole('region', { name: 'Submission result' });
  await result.getByRole('button', { name: 'Open Activity', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Activity' });
  await activity.waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByText(`Target: ${firstAuthority}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await activity.getByRole('button', { name: 'Read resource', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Alpha published resource', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  const firstRead = await mock.waitFor((request) =>
    request.method === 'GET' && request.path === `/api/resources/${encodeURIComponent(resourceFirst)}`
  );
  assert.equal(firstRead.query.accountId, first);
  assert.equal(firstRead.authorization, `Bearer ${tokenFirst}`);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });

  await selectAccount(page, secondHandle);
  await mock.waitFor((request) => request.method === 'GET' && request.path === '/api/administration' && request.query.accountId === second);
  await mock.waitFor((request) => request.method === 'GET' && request.path === '/api/activity' && request.query.accountId === second);
  await activity.waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByText(`Target: ${firstAuthority}`, { exact: true }).waitFor({ state: 'hidden', timeout: settleTimeout });
  await page.waitForFunction(() => !(document.body.textContent ?? '').includes('Alpha published resource'), undefined, { timeout: settleTimeout });

  assert.equal((await activity.innerText()).includes(firstAuthority), false, 'the previous account action must not render after the switch');
  assert.equal((await page.locator('body').innerText()).includes('Alpha published resource'), false, 'the previous account reader state must not render after the switch');

  await page.getByRole('tab', { name: 'Administration', exact: true }).click();
  await administration.getByRole('heading', { name: 'Beta Home', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await administration.getByRole('heading', { name: 'Alpha Home', exact: true }).count(), 0);
  const ownSecond = administration.getByLabel(`Available for ${secondHandle}`);
  const otherFirst = administration.getByLabel(`Available for ${firstHandle}`);
  assert.equal(await ownSecond.isDisabled(), true, 'the newly selected full handle must own the disabled row');
  assert.equal(await otherFirst.isDisabled(), false, 'the previous same-name account must remain available under the new owner');
  const administrationRead = mock.requests.filter((request) =>
    request.method === 'GET' && request.path === '/api/administration' && request.query.accountId === second
  ).at(-1);
  assert.equal(administrationRead?.authorization, `Bearer ${tokenSecond}`, 'the refreshed Home scope must use the new exact session');

  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await activity.waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByRole('button', { name: 'View details', exact: true }).click();
  await activity.getByText(`Target: ${secondAuthority}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByRole('button', { name: 'Read resource', exact: true }).click();

  dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Beta published resource', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  const secondRead = await mock.waitFor((request) =>
    request.method === 'GET' && request.path === `/api/resources/${encodeURIComponent(resourceSecond)}`
  );
  assert.equal(secondRead.query.accountId, second, 'later reader reads must use the new exact account');
  assert.equal(secondRead.authorization, `Bearer ${tokenSecond}`, 'later reader reads must use the new exact session');
  assert.equal((await dialog.innerText()).includes('Alpha private resource content'), false, 'the old reader body must not cross the account switch');

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  const oldDetailReads = mock.requests.filter((request) => request.path === `/api/activity/${encodeURIComponent(actionFirstId)}`).length;
  await selectAccount(page, firstHandle);
  await activity.getByText('No activity is recorded for this account.', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await activity.getByRole('region', { name: 'Action details' }).count(), 0, 'returning to an account must not restore a cleared action handoff');
  assert.equal(mock.requests.filter((request) => request.path === `/api/activity/${encodeURIComponent(actionFirstId)}`).length, oldDetailReads);

  const bodyText = await page.locator('body').innerText();
  assert.equal(bodyText.includes(tokenFirst), false);
  assert.equal(bodyText.includes(tokenSecond), false);
  assert.deepEqual(errors, []);
});

test('composes Authoring across topics with an exact draft, field picker, publication readback, and Activity resource reading', async (t) => {
  const accountId = 'account:author-alpha';
  const handle = '@maker@alpha.example';
  const token = 'token-author-alpha';
  const actorId = 'https://actors.invalid/author-alpha';
  const homeAuthority = 'https://home.alpha.example/actors/home';
  const assetId = 'https://resources.invalid/assets/rope';
  const publishedVarietyId = 'https://resources.invalid/varieties/alloy-published';
  const draftId = 'draft:variety-alpha';
  const actionId = 'https://activity.invalid/actions/authoring-alpha';
  const targetId = 'https://library.invalid/entries/alloy';
  let storedDraft: AuthoringDraft | undefined;
  let publishCalls = 0;
  let checkCalls = 0;

  const publishAction = actionOf({
    id: actionId,
    accountId,
    targetId,
    resultReferences: [{ kind: 'resource', id: publishedVarietyId }],
    intent: { kind: 'authoring-publication', inputs: { draftId } },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });
  const verifiedAction = actionOf({
    id: actionId,
    accountId,
    targetId,
    resultReferences: [{ kind: 'resource', id: publishedVarietyId }],
    intent: { kind: 'authoring-publication', inputs: { draftId } },
    submission: { status: 'accepted' },
    outcome: {
      status: 'completed',
      evidence: [{ source: publishedVarietyId, observedAt, changes: { id: publishedVarietyId, type: 'Variety' } }]
    }
  });

  const { page, mock, errors } = await openApplicationPage(t, {
    sessions: [{ accountId, handle, clientToken: token, actorId, homeAuthority }],
    configureMock: (candidate) => {
      candidate.onWorkflow = (request) => {
        const requestAccount = request.accountId ?? accountId;
        if (request.method === 'GET' && request.path === '/api/library') {
          return {
            json: pageOf(requestAccount, libraryOf({
              assets: [{ id: assetId, type: 'Asset', name: 'Rope Asset' }],
              drafts: storedDraft === undefined ? [] : [storedDraft]
            }))
          };
        }
        if (request.method === 'GET' && request.path === '/api/explore/places') {
          return { json: pageOf(requestAccount, explorePlacesOf({ places: [] })) };
        }
        if (request.method === 'GET' && request.path === '/api/logistics/vessels') {
          return { json: pageOf(requestAccount, vesselCandidatesOf(requestAccount, [])) };
        }
        if (request.method === 'GET' && request.path === '/api/activity') {
          return { json: pageOf(requestAccount, { actions: [] }) };
        }
        if (request.method === 'POST' && request.path === '/api/drafts') {
          const body = request.body ?? {};
          const kind = body.kind === 'asset' ? 'asset' : 'variety';
          storedDraft = draftOf({
            id: draftId,
            accountId: requestAccount,
            kind,
            fields: (body.fields ?? {}) as Record<string, unknown>
          });
          return { status: 201, json: { draft: storedDraft } };
        }
        if (request.method === 'GET' && request.path === `/api/drafts/${encodeURIComponent(draftId)}`) {
          return { json: { draft: storedDraft } };
        }
        if (request.method === 'POST' && request.path === `/api/drafts/${encodeURIComponent(draftId)}`) {
          const body = request.body ?? {};
          storedDraft = draftOf({
            id: draftId,
            accountId: requestAccount,
            kind: storedDraft?.kind ?? 'variety',
            fields: (body.fields ?? {}) as Record<string, unknown>
          });
          return { json: { draft: storedDraft } };
        }
        if (request.method === 'POST' && request.path === `/api/drafts/${encodeURIComponent(draftId)}/publish`) {
          publishCalls += 1;
          storedDraft = draftOf({
            id: draftId,
            accountId: requestAccount,
            kind: storedDraft?.kind ?? 'variety',
            fields: storedDraft?.fields ?? {},
            publication: { actionId, resourceIds: [publishedVarietyId] }
          });
          return { json: { action: publishAction, draft: storedDraft } };
        }
        if (request.method === 'GET' && request.path === `/api/activity/${encodeURIComponent(actionId)}`) {
          return { json: pageOf(requestAccount, { action: publishAction }) };
        }
        if (request.method === 'POST' && request.path === `/api/activity/${encodeURIComponent(actionId)}/refresh`) {
          checkCalls += 1;
          return { json: pageOf(requestAccount, { action: verifiedAction }) };
        }
        return { status: 404, json: { error: 'unexpected-workflow-request' } };
      };
      candidate.onResource = ({ id, accountId: readAccountId }) => resourcePage({
        actorId: id,
        accountId: readAccountId,
        name: id === assetId ? 'Rope Asset' : 'Published Alloy',
        description: id === assetId ? 'Retained rope asset' : 'Published alloy variety'
      });
    }
  });

  await accountOption(page, handle).waitFor({ state: 'visible', timeout: settleTimeout });
  await selectAccount(page, handle);

  await topicTab(page, 'Author & Publish').click();
  const authoring = page.getByRole('region', { name: 'Author & Publish' });
  await authoring.waitFor({ state: 'visible', timeout: settleTimeout });
  await authoring.getByRole('button', { name: 'New Asset', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await authoring.getByRole('button', { name: 'New Asset', exact: true }).click();
  let assetEditor = page.getByRole('region', { name: 'Asset draft' });
  await assetEditor.waitFor({ state: 'visible', timeout: settleTimeout });
  await assetEditor.getByLabel('Name', { exact: true }).fill('Draft Rope');

  await topicTab(page, 'Explore').click();
  await topicTab(page, 'Author & Publish').click();
  assetEditor = page.getByRole('region', { name: 'Asset draft' });
  await waitForCondition(
    async () => await assetEditor.getByLabel('Name', { exact: true }).inputValue() === 'Draft Rope',
    'an unsaved Asset draft must survive a topic switch'
  );
  await assetEditor.getByRole('button', { name: 'Close editor', exact: true }).click();

  await authoring.getByRole('button', { name: 'New Variety', exact: true }).click();
  const varietyEditor = page.getByRole('region', { name: 'Variety draft' });
  await varietyEditor.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await page.getByRole('region', { name: 'Asset draft' }).count(), 0, 'Asset and Variety editors must remain separate');
  await varietyEditor.getByLabel('Name', { exact: true }).fill('Alloy');

  await varietyEditor.getByRole('button', { name: 'Choose variety asset', exact: true }).click();
  let picker = page.getByRole('dialog', { name: 'Variety asset' });
  await picker.waitFor({ state: 'visible', timeout: settleTimeout });
  await picker.getByRole('button', { name: 'Inspect Rope Asset', exact: true }).click();
  let reader = readerDialog(page, 'Rope Asset');
  await reader.waitFor({ state: 'visible', timeout: settleTimeout });
  const inspectRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/resources/${encodeURIComponent(assetId)}`
    && request.query.accountId === accountId
  );
  assert.equal(inspectRead.authorization, `Bearer ${token}`, 'picking must read with the exact selected client session');
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await reader.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCondition(
    () => page.evaluate(() => document.activeElement?.textContent?.includes('Inspect Rope Asset') ?? false),
    'closing an inspected picker candidate must return focus to its Inspect control'
  );
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await picker.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCondition(
    () => page.evaluate(() => document.activeElement?.textContent?.includes('Choose variety asset') ?? false),
    'cancelling the picker must return focus to the exact invoking field control'
  );
  assert.equal(await varietyEditor.getByLabel('Asset', { exact: true }).inputValue(), '', 'Cancel must not change the draft field');

  await varietyEditor.getByRole('button', { name: 'Choose variety asset', exact: true }).click();
  picker = page.getByRole('dialog', { name: 'Variety asset' });
  await picker.waitFor({ state: 'visible', timeout: settleTimeout });
  await picker.getByRole('button', { name: 'Select Rope Asset', exact: true }).click();
  await picker.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCondition(
    async () => await varietyEditor.getByLabel('Asset', { exact: true }).inputValue() === assetId,
    'selecting a picker candidate must update only the exact field'
  );
  await varietyEditor.getByLabel('Mass', { exact: true }).fill('2');

  await topicTab(page, 'Explore').click();
  await topicTab(page, 'Author & Publish').click();
  await waitForCondition(async () => {
    const name = await varietyEditor.getByLabel('Name', { exact: true }).inputValue();
    const mass = await varietyEditor.getByLabel('Mass', { exact: true }).inputValue();
    const asset = await varietyEditor.getByLabel('Asset', { exact: true }).inputValue();
    return name === 'Alloy' && mass === '2' && asset === assetId;
  }, 'edited Variety fields must survive a topic switch');

  await varietyEditor.getByRole('button', { name: 'Save draft', exact: true }).click();
  const saveRequest = await mock.waitFor((request) => request.method === 'POST' && request.path === '/api/drafts');
  const saveBody = parsedBody(saveRequest) as Record<string, unknown>;
  assert.equal(saveBody.accountId, accountId);
  assert.equal(saveBody.kind, 'variety');
  const savedFields = saveBody.fields as Record<string, unknown>;
  assert.equal(savedFields.name, 'Alloy');
  assert.equal(savedFields.mass, 2);
  assert.equal(savedFields.asset, assetId);
  assert.equal(saveRequest.authorization, `Bearer ${token}`);
  assert.equal(publishCalls, 0, 'saving is distinct from publishing');
  await waitForCondition(
    async () => !(await varietyEditor.getByRole('button', { name: 'Publish draft', exact: true }).isDisabled()),
    'a saved clean draft must become publishable'
  );

  await varietyEditor.getByRole('button', { name: 'Publish draft', exact: true }).click();
  const publishRequest = await mock.waitFor((request) =>
    request.method === 'POST' && request.path === `/api/drafts/${encodeURIComponent(draftId)}/publish`
  );
  assert.deepEqual(parsedBody(publishRequest), { accountId });
  assert.equal(publishRequest.authorization, `Bearer ${token}`);
  const publication = page.getByRole('region', { name: 'Publication' });
  await publication.waitFor({ state: 'visible', timeout: settleTimeout });
  await publication.getByText(`Action ${actionId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await publication.getByText(/Publication accepted\. Acceptance is not completion/i).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(publishCalls, 1);

  await publication.getByRole('button', { name: 'Check publication', exact: true }).click();
  const checkRequest = await mock.waitFor((request) =>
    request.method === 'POST' && request.path === `/api/activity/${encodeURIComponent(actionId)}/refresh`
  );
  assert.deepEqual(parsedBody(checkRequest), { accountId });
  assert.equal(checkRequest.authorization, `Bearer ${token}`);
  await publication.getByText('Publication completed and verified by evidence.', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(checkCalls, 1);
  assert.equal(publishCalls, 1, 'explicit readback must not republish');

  await publication.getByRole('button', { name: 'Open Activity', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Activity' });
  await activity.waitFor({ state: 'visible', timeout: settleTimeout });
  const detail = activity.getByRole('region', { name: 'Action details' });
  await detail.waitFor({ state: 'visible', timeout: settleTimeout });
  await detail.getByText(`Target: ${targetId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  const actionRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/activity/${encodeURIComponent(actionId)}`
    && request.query.accountId === accountId
  );
  assert.equal(actionRead.authorization, `Bearer ${token}`, 'Open Activity must read the exact action with the exact session');

  const readResource = detail.getByRole('button', { name: 'Read resource', exact: true });
  await readResource.click();
  reader = readerDialog(page, 'Published Alloy');
  await reader.waitFor({ state: 'visible', timeout: settleTimeout });
  const publicationRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/resources/${encodeURIComponent(publishedVarietyId)}`
    && request.query.accountId === accountId
  );
  assert.equal(publicationRead.authorization, `Bearer ${token}`);
  assert.equal(publicationRead.query.accountId, accountId);
  await page.keyboard.press('Escape');
  await reader.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCondition(
    () => page.evaluate(() => document.activeElement?.textContent?.includes('Read resource') ?? false),
    'closing the Activity reader must return focus to its invoking control'
  );
  assert.equal(await readResource.evaluate((element) => element === document.activeElement), true);

  assert.equal(mock.requests.filter((request) => request.path.includes('/local/tick')).length, 0);
  assert.equal(mock.requests.filter((request) => request.path === `/api/drafts/${encodeURIComponent(draftId)}/publish`).length, 1);
  const storageKeys = await page.evaluate(() => Object.keys(localStorage).sort());
  assert.deepEqual(storageKeys, [sessionKey], 'draft and picker state must not be written to browser storage');
  assert.deepEqual(errors, []);
});

test('composes Explore and Logistics for a verified vessel, a directed saved plan, a traverse, and repeated journey recovery', async (t) => {
  const accountId = 'account:travel-alpha';
  const handle = '@traveler@alpha.example';
  const token = 'token-travel-alpha';
  const vesselA = 'https://vessels.invalid/alpha';
  const vesselB = 'https://vessels.invalid/beta';
  const territoryId = 'https://territory.invalid/actors/policy';
  const eastId = 'https://places.invalid/ports/east';
  const westId = 'https://places.invalid/ports/west';
  const routeId = 'https://places.invalid/routes/east-west';
  const planId = 'route-plan:alpha-1';
  const actionId = 'https://activity.invalid/actions/traverse-alpha';
  const plan = routePlanOf({
    id: planId,
    accountId,
    from: eastId,
    to: westId,
    legs: [{ routeId, from: eastId, to: westId, territoryId }]
  });
  const action = actionOf({
    id: actionId,
    accountId,
    targetId: territoryId,
    resultReferences: [{ kind: 'request', id: 'traverse-request-1' }],
    intent: { kind: 'traverse', inputs: { vesselId: vesselA, routePlanId: planId } },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] },
    journey: {
      routePlanId: planId,
      vesselId: vesselA,
      status: 'pending',
      updatedAt: observedAt,
      legs: [{ routeId, from: eastId, to: westId, territoryId, kind: 'local-movement', status: 'pending', requestId: 'movement-request-1' }]
    }
  });
  const places: ExplorePlaceRecord[] = [
    { id: eastId, type: 'Port', authorityId: territoryId, name: 'East Haven', territoryId, state: 'available' },
    { id: westId, type: 'Port', authorityId: territoryId, name: 'West Haven', territoryId, state: 'available' }
  ];
  const connections: ExploreConnectionRecord[] = [{
    id: routeId,
    type: 'Route',
    from: eastId,
    to: westId,
    territoryId,
    authorityId: territoryId,
    name: 'East to West',
    state: 'available'
  }];
  let traverseCalls = 0;

  const { page, mock, errors } = await openApplicationPage(t, {
    sessions: [{ accountId, handle, clientToken: token, actorId: 'https://actors.invalid/travel-alpha', homeAuthority: 'https://home.alpha.example/actors/home' }],
    configureMock: (candidate) => {
      candidate.onWorkflow = (request) => {
        const requestAccount = request.accountId ?? accountId;
        if (request.method === 'GET' && request.path === '/api/logistics/vessels') {
          return {
            json: pageOf(requestAccount, vesselCandidatesOf(requestAccount, [
              vesselCandidateOf({ id: vesselA, name: 'Alice Skiff', registry: 'https://registry.invalid/actors/registry', possessor: 'https://actors.invalid/travel-alpha' }),
              vesselCandidateOf({ id: vesselB, name: 'Bob Cutter', registry: 'https://registry.invalid/actors/registry', possessor: 'https://actors.invalid/travel-alpha' })
            ]))
          };
        }
        if (request.method === 'GET' && request.path === '/api/explore/places') {
          const vesselId = request.query.vesselId;
          return {
            json: pageOf(requestAccount, explorePlacesOf({
              places,
              connections,
              positions: vesselId === undefined ? [] : [{
                accountId: requestAccount,
                vesselId,
                authorityId: territoryId,
                source: `https://positions.invalid/${encodeURIComponent(vesselId)}`,
                state: 'available',
                observedAt,
                status: 'active',
                portId: vesselId === vesselB ? westId : eastId
              }]
            }))
          };
        }
        if (request.method === 'POST' && request.path === '/api/explore/routes') {
          return { json: pageOf(requestAccount, { plan }) };
        }
        if (request.method === 'GET' && request.path === `/api/explore/routes/${encodeURIComponent(planId)}`) {
          return { json: pageOf(requestAccount, { plan }) };
        }
        if (request.method === 'GET' && request.path === `/api/logistics/vessels/${encodeURIComponent(vesselA)}`) {
          return { json: pageOf(requestAccount, vesselOf({ accountId: requestAccount, vesselId: vesselA, name: 'Alice Skiff', portId: eastId })) };
        }
        if (request.method === 'GET' && request.path === `/api/logistics/vessels/${encodeURIComponent(vesselB)}`) {
          return { json: pageOf(requestAccount, vesselOf({ accountId: requestAccount, vesselId: vesselB, name: 'Bob Cutter', portId: westId })) };
        }
        if (request.method === 'POST' && request.path === `/api/logistics/vessels/${encodeURIComponent(vesselA)}/traverse`) {
          traverseCalls += 1;
          return { json: { action } };
        }
        if (request.method === 'GET' && request.path === '/api/activity') {
          return { json: pageOf(requestAccount, { actions: [action] }) };
        }
        if (request.method === 'GET' && request.path === `/api/activity/${encodeURIComponent(actionId)}`) {
          return { json: pageOf(requestAccount, { action }) };
        }
        if (request.method === 'GET' && request.path === '/api/production') {
          return { json: pageOf(requestAccount, productionOf({ accountId: requestAccount, vesselId: request.query.vesselId ?? vesselA })) };
        }
        if (request.method === 'GET' && request.path === '/api/library') {
          return { json: pageOf(requestAccount, libraryOf()) };
        }
        return { status: 404, json: { error: 'unexpected-workflow-request' } };
      };
    }
  });

  await accountOption(page, handle).waitFor({ state: 'visible', timeout: settleTimeout });
  await selectAccount(page, handle);
  await topicTab(page, 'Logistics & Production').click();

  const travel = page.getByRole('region', { name: 'Vessel travel' });
  await travel.waitFor({ state: 'visible', timeout: settleTimeout });
  await travel.getByRole('button', { name: 'Select Alice Skiff', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await travel.getByRole('button', { name: 'Select Alice Skiff', exact: true }).click();
  const vesselRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/logistics/vessels/${encodeURIComponent(vesselA)}`
    && request.query.accountId === accountId
  );
  assert.equal(vesselRead.authorization, `Bearer ${token}`);
  await travel.getByText('Registry cargo', { exact: false }).waitFor({ state: 'visible', timeout: settleTimeout });

  await travel.getByRole('button', { name: 'Open Explore', exact: true }).click();
  const explore = page.getByRole('region', { name: 'Explore' });
  await explore.waitFor({ state: 'visible', timeout: settleTimeout });
  await waitForCondition(
    async () => await topicTab(page, 'Explore').getAttribute('aria-selected') === 'true',
    'opening Explore from the vessel must select the Explore topic'
  );
  const exploreRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === '/api/explore/places'
    && request.query.accountId === accountId
    && request.query.vesselId === vesselA
  );
  assert.equal(exploreRead.authorization, `Bearer ${token}`);
  await explore.getByText('East Haven', { exact: true }).first().waitFor({ state: 'visible', timeout: settleTimeout });
  await explore.getByText('Vessel position evidence', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await explore.getByRole('button', { name: 'Set East Haven as origin', exact: true }).click();
  await explore.getByRole('button', { name: 'Choose destination', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Destination Port' });
  await picker.waitFor({ state: 'visible', timeout: settleTimeout });
  await picker.getByText('Current vessel position.', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await picker.getByRole('button', { name: 'Select West Haven', exact: true }).click();
  await picker.waitFor({ state: 'hidden', timeout: settleTimeout });

  await explore.getByRole('button', { name: 'Create route plan', exact: true }).click();
  const createPlan = await mock.waitFor((request) => request.method === 'POST' && request.path === '/api/explore/routes');
  assert.deepEqual(parsedBody(createPlan), { accountId, from: eastId, to: westId });
  assert.equal(createPlan.authorization, `Bearer ${token}`);
  const proposed = explore.getByRole('region', { name: 'Proposed route' });
  await proposed.waitFor({ state: 'visible', timeout: settleTimeout });
  await proposed.getByText(`Plan ID: ${planId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await proposed.getByRole('button', { name: 'Use this plan', exact: true }).click();
  await waitForCondition(
    async () => await topicTab(page, 'Logistics & Production').getAttribute('aria-selected') === 'true',
    'accepting the plan must select the Logistics topic'
  );
  const selectedPlan = travel.getByRole('region', { name: 'Selected route plan' });
  await selectedPlan.waitFor({ state: 'visible', timeout: settleTimeout });
  await selectedPlan.getByText(`Plan ID: ${planId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  const initialPlanReads = mock.requests.filter((request) =>
    request.method === 'GET' && request.path === `/api/explore/routes/${encodeURIComponent(planId)}`
  ).length;
  assert.ok(initialPlanReads >= 1, 'the accepted plan must be read by its exact account-scoped route');
  for (const request of mock.requests.filter((candidate) => candidate.path === `/api/explore/routes/${encodeURIComponent(planId)}`)) {
    assert.equal(request.query.accountId, accountId);
    assert.equal(request.authorization, `Bearer ${token}`);
  }
  assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1);
  assert.equal(await topicTab(page, 'Logistics & Production').evaluate((element) => element === document.activeElement), true);

  await selectedPlan.getByRole('button', { name: 'Traverse selected route', exact: true }).click();
  const traverse = await mock.waitFor((request) =>
    request.method === 'POST' && request.path === `/api/logistics/vessels/${encodeURIComponent(vesselA)}/traverse`
  );
  assert.deepEqual(parsedBody(traverse), { accountId, routePlanId: planId });
  assert.equal(traverse.authorization, `Bearer ${token}`);
  await travel.getByText('Journey status: Pending', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await travel.getByRole('button', { name: 'Open Activity', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Activity' });
  await activity.waitFor({ state: 'visible', timeout: settleTimeout });
  const detail = activity.getByRole('region', { name: 'Action details' });
  await detail.waitFor({ state: 'visible', timeout: settleTimeout });
  const actionRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/activity/${encodeURIComponent(actionId)}`
    && request.query.accountId === accountId
  );
  assert.equal(actionRead.authorization, `Bearer ${token}`);
  await detail.getByRole('button', { name: 'Open journey', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await topicTab(page, 'Logistics & Production').click();
  await travel.getByRole('button', { name: 'Select Bob Cutter', exact: true }).click();
  const secondVesselRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/logistics/vessels/${encodeURIComponent(vesselB)}`
    && request.query.accountId === accountId
  );
  assert.equal(secondVesselRead.authorization, `Bearer ${token}`);
  await travel.getByText(/Bob Cutter/).first().waitFor({ state: 'visible', timeout: settleTimeout });

  await travel.getByRole('button', { name: 'Open Explore', exact: true }).click();
  await waitForCondition(
    async () => await topicTab(page, 'Explore').getAttribute('aria-selected') === 'true',
    'manual vessel replacement must keep the Explore handoff available'
  );
  const replacedExploreRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === '/api/explore/places'
    && request.query.accountId === accountId
    && request.query.vesselId === vesselB
  );
  assert.equal(replacedExploreRead.authorization, `Bearer ${token}`);
  await waitForCondition(
    async () => await explore.getByText(`Plan ID: ${planId}`, { exact: true }).count() === 0,
    'manual vessel replacement must drop the earlier plan hint from Explore'
  );

  await topicTab(page, 'Activity').click();
  await detail.waitFor({ state: 'visible', timeout: settleTimeout });
  const planReadsBeforeRecovery = mock.requests.filter((request) =>
    request.method === 'GET' && request.path === `/api/explore/routes/${encodeURIComponent(planId)}`
  ).length;
  await detail.getByRole('button', { name: 'Open journey', exact: true }).click();
  await waitForCondition(
    async () => await topicTab(page, 'Logistics & Production').getAttribute('aria-selected') === 'true',
    'Open journey must return to the Logistics topic'
  );
  await mock.waitUntil(
    () => mock.requests.filter((request) => request.method === 'GET' && request.path === `/api/explore/routes/${encodeURIComponent(planId)}`).length > planReadsBeforeRecovery,
    'repeating the journey handoff must read the same exact plan again'
  );
  await travel.getByRole('region', { name: 'Selected route plan' }).getByText(`Plan ID: ${planId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await topicTab(page, 'Logistics & Production').evaluate((element) => element === document.activeElement), true);
  assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1);

  assert.equal(traverseCalls, 1, 'the traverse must be sent exactly once and never replayed by recovery');
  assert.equal(mock.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/traverse')).length, 1);
  assert.equal(mock.requests.filter((request) => request.method === 'POST' && request.path === '/api/explore/refresh').length, 0);
  assert.equal(mock.requests.filter((request) => request.path.includes('/local/tick')).length, 0);
  assert.deepEqual(errors, []);
});

test('composes a place capability into Production, executes an advertised operation, and recovers the exact qualified job', async (t) => {
  const accountId = 'account:production-alpha';
  const handle = '@producer@alpha.example';
  const token = 'token-production-alpha';
  const vesselId = 'https://vessels.invalid/production-alpha';
  const placeId = 'https://places.invalid/ports/foundry';
  const authorityId = 'https://simulation-a.invalid/actors/territory';
  const otherAuthority = 'https://simulation-b.invalid/actors/territory';
  const capabilityId = 'mine';
  const opMine = encodeOperationId(authorityId, 'mine');
  const opSmelt = encodeOperationId(authorityId, 'manufacture');
  const opOther = encodeOperationId(otherAuthority, 'load');
  const jobId = encodeJobId(authorityId, '12');
  const actionId = 'https://activity.invalid/actions/production-alpha';
  const place: ExplorePlaceRecord = {
    id: placeId,
    type: 'Port',
    authorityId,
    name: 'Foundry Quay',
    territoryId: authorityId,
    state: 'available'
  };
  const capability: ExploreCapabilityRecord = {
    id: capabilityId,
    label: 'Mine ore',
    available: true,
    effect: 'Adds ore to the shared stock',
    request: { method: 'POST', href: `${authorityId}/local/mine`, body: { count: 1 } }
  };
  const operations: ProductionOperation[] = [
    productionOperationOf({
      operationId: opMine,
      authorityId,
      kind: 'mine',
      label: 'Mine ore',
      inputs: [{ name: 'count', label: 'Quantity', type: 'count', required: true, default: 1, minimum: 1 }],
      defaults: { count: 1 }
    }),
    productionOperationOf({
      operationId: opSmelt,
      authorityId,
      kind: 'manufacture',
      label: 'Smelt ore',
      inputs: [{ name: 'count', label: 'Quantity', type: 'count', required: true, default: 1, minimum: 1 }],
      defaults: { count: 1 }
    }),
    productionOperationOf({
      operationId: opOther,
      authorityId: otherAuthority,
      kind: 'load',
      label: 'Queue load',
      inputs: [{ name: 'count', label: 'Quantity', type: 'count', required: true, default: 1, minimum: 1 }],
      defaults: { count: 1 }
    })
  ];
  const authorities: ProductionData['authorities'] = [
    { authorityId, kind: 'simulation', source: `${authorityId}/local/actions`, state: 'available', name: 'Simulation A Works', observedAt },
    { authorityId: otherAuthority, kind: 'simulation', source: `${otherAuthority}/local/actions`, state: 'available', name: 'Simulation B Works', observedAt }
  ];
  const pendingJob = productionJobOf({
    jobId,
    authorityId,
    accountId,
    vesselId,
    operation: 'mine',
    status: 'pending',
    progress: { remainingTicks: 3, tick: 10, count: 2 }
  });
  const simulationJob = productionJobOf({
    jobId: encodeJobId(otherAuthority, '12'),
    authorityId: otherAuthority,
    accountId,
    vesselId,
    operation: 'load',
    status: 'progress',
    progress: { remainingTicks: 5, tick: 10, count: 1 }
  });
  const recoveredJob = productionJobOf({
    ...pendingJob,
    status: 'progress',
    progress: { remainingTicks: 2, tick: 11, count: 2 }
  });
  const refreshedJob = productionJobOf({
    ...pendingJob,
    status: 'progress',
    progress: { remainingTicks: 1, tick: 12, count: 2 }
  });
  const action = actionOf({
    id: actionId,
    accountId,
    targetId: authorityId,
    resultReferences: [{ kind: 'job', id: jobId }],
    intent: { kind: 'mine', inputs: { vesselId, authorityId, count: 2 } },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });
  let executeCalls = 0;
  let operationDetailReads = 0;
  let jobReads = 0;
  let jobRefreshCalls = 0;

  const { page, mock, errors } = await openApplicationPage(t, {
    sessions: [{ accountId, handle, clientToken: token, actorId: 'https://actors.invalid/production-alpha', homeAuthority: 'https://home.alpha.example/actors/home' }],
    configureMock: (candidate) => {
      candidate.onWorkflow = (request) => {
        const requestAccount = request.accountId ?? accountId;
        if (request.method === 'GET' && request.path === '/api/logistics/vessels') {
          return {
            json: pageOf(requestAccount, vesselCandidatesOf(requestAccount, [
              vesselCandidateOf({ id: vesselId, name: 'Production Skiff', registry: 'https://registry.invalid/actors/registry', possessor: 'https://actors.invalid/production-alpha' })
            ]))
          };
        }
        if (request.method === 'GET' && request.path === `/api/logistics/vessels/${encodeURIComponent(vesselId)}`) {
          return { json: pageOf(requestAccount, vesselOf({ accountId: requestAccount, vesselId, name: 'Production Skiff', portId: placeId })) };
        }
        if (request.method === 'GET' && request.path === '/api/explore/places') {
          return {
            json: pageOf(requestAccount, explorePlacesOf({
              places: [place],
              positions: [{
                accountId: requestAccount,
                vesselId,
                authorityId,
                source: 'https://positions.invalid/production-alpha',
                state: 'available',
                observedAt,
                status: 'active',
                portId: placeId
              }]
            }))
          };
        }
        if (request.method === 'GET' && request.path === `/api/explore/places/${encodeURIComponent(placeId)}`) {
          return {
            json: pageOf(requestAccount, explorePlaceDetailOf({
              place,
              capabilities: [capability]
            }))
          };
        }
        if (request.method === 'GET' && request.path === '/api/production') {
          return {
            json: pageOf(requestAccount, productionOf({
              accountId: requestAccount,
              vesselId: request.query.vesselId ?? vesselId,
              operations,
              authorities,
               jobs: [pendingJob, simulationJob]
            }))
          };
        }
        if (request.method === 'GET' && request.path.startsWith('/api/production/operations/')) {
          operationDetailReads += 1;
          return { status: 500, json: { error: 'operation detail must not be read' } };
        }
        if (request.method === 'POST' && request.path === `/api/production/operations/${encodeURIComponent(opMine)}/execute`) {
          executeCalls += 1;
          return { json: { action } };
        }
        if (request.method === 'GET' && request.path === '/api/activity') {
          return { json: pageOf(requestAccount, { actions: [action] }) };
        }
        if (request.method === 'GET' && request.path === `/api/activity/${encodeURIComponent(actionId)}`) {
          return { json: pageOf(requestAccount, { action }) };
        }
        if (request.method === 'GET' && request.path === `/api/production/jobs/${encodeURIComponent(jobId)}`) {
          jobReads += 1;
          return { json: pageOf(requestAccount, { job: jobReads === 1 ? pendingJob : recoveredJob }) };
        }
        if (request.method === 'POST' && request.path === `/api/production/jobs/${encodeURIComponent(jobId)}/refresh`) {
          jobRefreshCalls += 1;
          return { json: pageOf(requestAccount, { job: refreshedJob }) };
        }
        if (request.method === 'GET' && request.path === '/api/library') {
          return { json: pageOf(requestAccount, libraryOf()) };
        }
        return { status: 404, json: { error: 'unexpected-workflow-request' } };
      };
    }
  });

  await accountOption(page, handle).waitFor({ state: 'visible', timeout: settleTimeout });
  await selectAccount(page, handle);
  await topicTab(page, 'Logistics & Production').click();

  const travel = page.getByRole('region', { name: 'Vessel travel' });
  await travel.waitFor({ state: 'visible', timeout: settleTimeout });
  await travel.getByRole('button', { name: 'Select Production Skiff', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await travel.getByRole('button', { name: 'Select Production Skiff', exact: true }).click();
  await travel.getByRole('button', { name: 'Open Explore', exact: true }).click();

  const explore = page.getByRole('region', { name: 'Explore' });
  await explore.waitFor({ state: 'visible', timeout: settleTimeout });
  await explore.getByText('Foundry Quay', { exact: true }).first().waitFor({ state: 'visible', timeout: settleTimeout });
  await explore.getByRole('button', { name: 'Open Foundry Quay', exact: true }).click();
  const placeDetailRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/explore/places/${encodeURIComponent(placeId)}`
    && request.query.accountId === accountId
    && request.query.vesselId === vesselId
  );
  assert.equal(placeDetailRead.authorization, `Bearer ${token}`);
  const placeDetail = explore.getByRole('region', { name: 'Place detail' });
  await placeDetail.getByRole('heading', { name: 'Foundry Quay', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await placeDetail.getByRole('button', { name: 'Continue to operations: Mine ore', exact: true }).click();

  await waitForCondition(
    async () => await topicTab(page, 'Logistics & Production').getAttribute('aria-selected') === 'true',
    'a capability continuation must select the Logistics topic'
  );
  const production = page.getByRole('region', { name: 'Production', exact: true });
  await production.waitFor({ state: 'visible', timeout: settleTimeout });
  await production.getByText('Mine ore', { exact: true }).first().waitFor({ state: 'visible', timeout: settleTimeout });
  const productionRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === '/api/production'
    && request.query.accountId === accountId
    && request.query.vesselId === vesselId
  );
  assert.equal(productionRead.authorization, `Bearer ${token}`);
  assert.equal('operationId' in productionRead.query, false, 'a capability must not invent a qualified operation ID');
  assert.equal(await production.getByText('Queue load', { exact: true }).count(), 0, 'the requested authority must not be substituted');

  await production.getByRole('button', { name: 'Select Mine ore', exact: true }).click();
  const form = production.getByRole('region', { name: 'Operation form' });
  await form.waitFor({ state: 'visible', timeout: settleTimeout });
  await form.getByLabel('Quantity', { exact: true }).fill('2');
  await form.getByRole('button', { name: 'Execute Mine ore', exact: true }).click();
  const execute = await mock.waitFor((request) =>
    request.method === 'POST' && request.path === `/api/production/operations/${encodeURIComponent(opMine)}/execute`
  );
  assert.deepEqual(parsedBody(execute), { accountId, vesselId, inputs: { count: 2 } });
  assert.equal(execute.authorization, `Bearer ${token}`);
  await production.getByText('Submission status: accepted', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await production.getByText(`Result job: ${jobId} (authority ${authorityId})`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await production.getByRole('button', { name: 'Open Activity', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Activity' });
  await activity.waitFor({ state: 'visible', timeout: settleTimeout });
  const detail = activity.getByRole('region', { name: 'Action details' });
  await detail.waitFor({ state: 'visible', timeout: settleTimeout });
  await detail.getByText(`Target: ${authorityId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  const actionRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/activity/${encodeURIComponent(actionId)}`
    && request.query.accountId === accountId
  );
  assert.equal(actionRead.authorization, `Bearer ${token}`);
  await detail.getByText('Kind: mine', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await detail.getByText(vesselId, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await detail.getByRole('button', { name: 'Open job', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await detail.getByRole('button', { name: 'Open job', exact: true }).click();
  await waitForCondition(
    async () => await topicTab(page, 'Logistics & Production').getAttribute('aria-selected') === 'true',
    'Open job must return to the Logistics topic'
  );
  const requestedJob = production.getByRole('region', { name: 'Requested job' });
  await requestedJob.waitFor({ state: 'visible', timeout: settleTimeout });
  const jobRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/production/jobs/${encodeURIComponent(jobId)}`
    && request.query.accountId === accountId
    && request.query.vesselId === vesselId
  );
  assert.equal(jobRead.authorization, `Bearer ${token}`);
  await requestedJob.getByText(`Job ${jobId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await requestedJob.getByText(`Authority ${authorityId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal((await requestedJob.innerText()).includes(otherAuthority), false, 'a same-numeric job at another authority must not substitute');
  await sleep(200);
  assert.equal(jobRefreshCalls, 0, 'recovering a job must not refresh it automatically');

  await production.getByRole('button', { name: 'Select Smelt ore', exact: true }).click();
  await production.getByRole('region', { name: 'Operation form' }).getByRole('heading', { name: 'Smelt ore', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await topicTab(page, 'Activity').click();
  await detail.waitFor({ state: 'visible', timeout: settleTimeout });
  await detail.getByRole('button', { name: 'Open job', exact: true }).click();
  await waitForCondition(() => jobReads >= 2, 'repeated recovery must re-read the exact requested job');
  await requestedJob.getByText('Remaining ticks: 2', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await topicTab(page, 'Logistics & Production').click();
  const selectedJobItem = production.getByRole('region', { name: 'Production jobs' })
    .getByRole('listitem')
    .filter({ hasText: authorityId })
    .filter({ hasText: jobId })
    .first();
  await selectedJobItem.getByRole('button', { name: `Select job ${jobId}`, exact: true }).click();
  const selectedJob = production.getByRole('region', { name: 'Selected job' });
  await selectedJob.waitFor({ state: 'visible', timeout: settleTimeout });
  await selectedJob.getByRole('button', { name: 'Refresh selected job', exact: true }).click();
  const jobRefresh = await mock.waitFor((request) =>
    request.method === 'POST' && request.path === `/api/production/jobs/${encodeURIComponent(jobId)}/refresh`
  );
  assert.deepEqual(parsedBody(jobRefresh), { accountId, vesselId });
  assert.equal(jobRefresh.authorization, `Bearer ${token}`);
  await selectedJob.getByText('Remaining ticks: 1', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  assert.equal(executeCalls, 1, 'the operation must be sent exactly once');
  assert.equal(operationDetailReads, 0, 'operation selection must not depend on a redundant operation-detail read');
  assert.equal(jobRefreshCalls, 1, 'only the explicit job refresh may reconcile a job');
  assert.equal(mock.requests.filter((request) => request.path.includes('/local/tick')).length, 0);
  assert.equal(mock.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/refresh') && request.path.startsWith('/api/activity/')).length, 0);
  assert.deepEqual(errors, []);
});

test('isolates opaque same-name accounts across Authoring, Activity, Logistics, and a late Explore response', async (t) => {
  const first = 'account:isolated-alpha';
  const second = 'account:isolated-beta';
  const firstHandle = '@same@alpha.example';
  const secondHandle = '@same@beta.example';
  const tokenFirst = 'token-isolated-alpha';
  const tokenSecond = 'token-isolated-beta';
  const assetFirst = 'https://resources.invalid/assets/alpha-only';
  const assetSecond = 'https://resources.invalid/assets/beta-only';
  const vesselFirst = 'https://vessels.invalid/isolated-alpha';
  const authorityFirst = 'https://territory.invalid/actors/isolated-alpha';
  const planId = 'route-plan:isolated-alpha';
  const routeId = 'https://places.invalid/routes/isolated-alpha';
  const originPlace = 'https://places.invalid/ports/isolated-origin';
  const destinationPlace = 'https://places.invalid/ports/isolated-destination';
  const firstPlaceId = 'https://places.invalid/ports/alpha-harbor';
  const secondPlaceId = 'https://places.invalid/ports/beta-harbor';
  const latePlaceId = 'https://places.invalid/ports/late-alpha';
  const jobId = encodeJobId(authorityFirst, '7');
  const actionId = 'https://activity.invalid/actions/isolated-alpha';
  const lateRefresh = deferred<MockResponse>();

  const firstPlace: ExplorePlaceRecord = {
    id: firstPlaceId,
    type: 'Port',
    authorityId: authorityFirst,
    name: 'Alpha Harbor',
    territoryId: authorityFirst,
    state: 'available'
  };
  const secondPlace: ExplorePlaceRecord = {
    id: secondPlaceId,
    type: 'Port',
    authorityId: 'https://territory.invalid/actors/isolated-beta',
    name: 'Beta Harbor',
    territoryId: 'https://territory.invalid/actors/isolated-beta',
    state: 'available'
  };
  const latePlace: ExplorePlaceRecord = {
    id: latePlaceId,
    type: 'Port',
    authorityId: authorityFirst,
    name: 'Late Alpha Harbor',
    territoryId: authorityFirst,
    state: 'available'
  };
  const plan = routePlanOf({
    id: planId,
    accountId: first,
    from: originPlace,
    to: destinationPlace,
    legs: [{ routeId, from: originPlace, to: destinationPlace, territoryId: authorityFirst }]
  });
  const job = productionJobOf({
    jobId,
    authorityId: authorityFirst,
    accountId: first,
    vesselId: vesselFirst,
    operation: 'mine',
    status: 'pending',
    progress: { remainingTicks: 4, tick: 7, count: 1 }
  });
  const action = actionOf({
    id: actionId,
    accountId: first,
    targetId: authorityFirst,
    resultReferences: [{ kind: 'job', id: jobId }],
    intent: { kind: 'mine', inputs: { vesselId: vesselFirst, authorityId: authorityFirst } },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });
  const journeyAction = actionOf({
    id: `${actionId}-journey`, accountId: first, targetId: authorityFirst,
    intent: { kind: 'traverse', inputs: { vesselId: vesselFirst, routePlanId: planId } },
    journey: {
      routePlanId: planId,
      vesselId: vesselFirst,
      status: 'pending',
      updatedAt: observedAt,
      legs: [{ routeId, from: originPlace, to: destinationPlace, territoryId: authorityFirst, kind: 'local-movement', status: 'pending' }]
    }
  });

  const { page, mock, errors } = await openApplicationPage(t, {
    sessions: [
      { accountId: first, handle: firstHandle, clientToken: tokenFirst, actorId: 'https://actors.invalid/isolated-alpha', homeAuthority: 'https://home.alpha.example/actors/home' },
      { accountId: second, handle: secondHandle, clientToken: tokenSecond, actorId: 'https://actors.invalid/isolated-beta', homeAuthority: 'https://home.beta.example/actors/home' }
    ],
    configureMock: (candidate) => {
      candidate.onWorkflow = (request) => {
        const requestAccount = request.accountId ?? first;
        if (request.method === 'GET' && request.path === '/api/library') {
          return {
            json: pageOf(requestAccount, libraryOf({
              assets: [{
                id: requestAccount === first ? assetFirst : assetSecond,
                type: 'Asset',
                name: requestAccount === first ? 'Alpha Asset' : 'Beta Asset'
              }]
            }))
          };
        }
        if (request.method === 'GET' && request.path === '/api/explore/places') {
          return {
            json: pageOf(requestAccount, explorePlacesOf({
              places: requestAccount === first ? [firstPlace] : [secondPlace]
            }))
          };
        }
        if (request.method === 'POST' && request.path === '/api/explore/refresh') {
          if (requestAccount === first) return lateRefresh.promise;
          return { json: pageOf(requestAccount, explorePlacesOf({ places: [secondPlace] })) };
        }
        if (request.method === 'GET' && request.path === '/api/logistics/vessels') {
          return {
            json: pageOf(requestAccount, vesselCandidatesOf(
              requestAccount,
              requestAccount === first ? [vesselCandidateOf({ id: vesselFirst, name: 'Isolated Skiff' })] : []
            ))
          };
        }
        if (request.method === 'GET' && request.path === `/api/logistics/vessels/${encodeURIComponent(vesselFirst)}`) {
          return { json: pageOf(requestAccount, vesselOf({ accountId: requestAccount, vesselId: vesselFirst, name: 'Isolated Skiff', portId: firstPlaceId })) };
        }
        if (request.method === 'GET' && request.path === `/api/explore/routes/${encodeURIComponent(planId)}`) {
          return { json: pageOf(requestAccount, { plan }) };
        }
        if (request.method === 'GET' && request.path === '/api/activity') {
          return { json: pageOf(requestAccount, { actions: requestAccount === first ? [action, journeyAction] : [] }) };
        }
        if (request.method === 'GET' && request.path === `/api/activity/${encodeURIComponent(actionId)}`) {
          return { json: pageOf(requestAccount, { action }) };
        }
        if (request.method === 'GET' && request.path === `/api/activity/${encodeURIComponent(journeyAction.id)}`) {
          return { json: pageOf(requestAccount, { action: journeyAction }) };
        }
        if (request.method === 'GET' && request.path === '/api/production') {
          return {
            json: pageOf(requestAccount, productionOf({
              accountId: requestAccount,
              vesselId: request.query.vesselId ?? vesselFirst,
              authorities: requestAccount === first
                 ? [{ authorityId: authorityFirst, kind: 'simulation', source: `${authorityFirst}/local/actions`, state: 'available', name: 'Alpha Works', observedAt }]
                : [],
              jobs: requestAccount === first ? [job] : []
            }))
          };
        }
        if (request.method === 'GET' && request.path === `/api/production/jobs/${encodeURIComponent(jobId)}`) {
          return { json: pageOf(requestAccount, { job }) };
        }
        return { status: 404, json: { error: 'unexpected-workflow-request' } };
      };
      candidate.onResource = ({ id, accountId: readAccountId }) => resourcePage({
        actorId: id,
        accountId: readAccountId,
        name: id === assetFirst ? 'Alpha Asset' : 'Beta Asset',
        description: id === assetFirst ? 'Alpha private asset content' : 'Beta private asset content'
      });
    }
  });

  await accountOption(page, firstHandle).waitFor({ state: 'visible', timeout: settleTimeout });
  await accountOption(page, secondHandle).waitFor({ state: 'visible', timeout: settleTimeout });
  await selectAccount(page, firstHandle);
  await topicTab(page, 'Author & Publish').click();

  const authoring = page.getByRole('region', { name: 'Author & Publish' });
  await authoring.waitFor({ state: 'visible', timeout: settleTimeout });
  await authoring.getByText('Alpha Asset', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await authoring.getByRole('button', { name: 'New Variety', exact: true }).click();
  const varietyEditor = page.getByRole('region', { name: 'Variety draft' });
  await varietyEditor.waitFor({ state: 'visible', timeout: settleTimeout });
  await varietyEditor.getByLabel('Name', { exact: true }).fill('Alpha Draft');
  await varietyEditor.getByRole('button', { name: 'Choose variety asset', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Variety asset' });
  await picker.waitFor({ state: 'visible', timeout: settleTimeout });
  await picker.getByRole('button', { name: 'Inspect Alpha Asset', exact: true }).click();
  const reader = readerDialog(page, 'Alpha Asset');
  await reader.waitFor({ state: 'visible', timeout: settleTimeout });
  const firstRead = await mock.waitFor((request) =>
    request.method === 'GET'
    && request.path === `/api/resources/${encodeURIComponent(assetFirst)}`
    && request.query.accountId === first
  );
  assert.equal(firstRead.authorization, `Bearer ${tokenFirst}`);
  assert.equal(await page.getByRole('dialog').count(), 2, 'the picker and inspected reader must both be open before the switch');

  await selectAccountWithoutPointer(page, secondHandle);
  await mock.waitFor((request) => request.method === 'GET' && request.path === '/api/library' && request.query.accountId === second);
  await waitForCondition(async () => await page.getByRole('dialog').count() === 0, 'an account switch must close the private picker and reader');
  await waitForCondition(
    async () => !(await page.locator('body').innerText()).includes('Alpha Draft')
      && !(await page.locator('body').innerText()).includes('Alpha Asset'),
    'an account switch must clear the previous account draft and Library content'
  );
  assert.equal(await page.getByRole('region', { name: 'Variety draft' }).count(), 0, 'the previous editor must not remain open');
  await authoring.getByText('Beta Asset', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await selectAccount(page, firstHandle);
  await authoring.getByText('Alpha Asset', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await page.getByRole('region', { name: 'Variety draft' }).count(), 0, 'returning to an account must not resurrect a cleared draft editor');
  assert.equal(await page.getByRole('dialog').count(), 0, 'returning to an account must not resurrect a cleared picker or reader');

  await topicTab(page, 'Activity').click();
  const activity = page.getByRole('region', { name: 'Activity' });
  await activity.waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByRole('button', { name: 'View details', exact: true }).first().click();
  const detail = activity.getByRole('region', { name: 'Action details' });
  await detail.waitFor({ state: 'visible', timeout: settleTimeout });
  await detail.getByText(`Target: ${authorityFirst}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await detail.getByRole('button', { name: 'Open job', exact: true }).click();
  const travel = page.getByRole('region', { name: 'Vessel travel' });
  await travel.waitFor({ state: 'visible', timeout: settleTimeout });
  const requestedJob = page.getByRole('region', { name: 'Requested job' });
  await requestedJob.getByText(`Job ${jobId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await topicTab(page, 'Activity').click();
  await detail.waitFor({ state: 'visible', timeout: settleTimeout });
  await activity.getByRole('button', { name: 'View details', exact: true }).nth(1).click();
  await detail.getByRole('button', { name: 'Open journey', exact: true }).click();
  await travel.getByRole('region', { name: 'Selected route plan' }).getByText(`Plan ID: ${planId}`, { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  await selectAccount(page, secondHandle);
  await waitForCondition(
    async () => await travel.getByText(`Plan ID: ${planId}`, { exact: true }).count() === 0,
    'switching accounts must clear the previous route plan handoff'
  );
  await waitForCondition(
    async () => await page.getByRole('region', { name: 'Requested job' }).count() === 0,
    'switching accounts must clear the previous job handoff'
  );
  await topicTab(page, 'Activity').click();
  await activity.getByText('No activity is recorded for this account.', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await activity.getByRole('region', { name: 'Action details' }).count(), 0, 'switching accounts must clear the previous action selection');

  await selectAccount(page, firstHandle);
  await activity.getByRole('button', { name: 'View details', exact: true }).first().waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await activity.getByRole('region', { name: 'Action details' }).count(), 0, 'returning to an account must not restore a cleared action handoff');
  await topicTab(page, 'Logistics & Production').click();
  await waitForCondition(
    async () => await travel.getByText(`Plan ID: ${planId}`, { exact: true }).count() === 0,
    'returning to an account must not restore a cleared route handoff'
  );
  await waitForCondition(
    async () => await page.getByRole('region', { name: 'Requested job' }).count() === 0,
    'returning to an account must not restore a cleared job handoff'
  );

  await topicTab(page, 'Explore').click();
  const explore = page.getByRole('region', { name: 'Explore' });
  await explore.getByText('Alpha Harbor', { exact: true }).first().waitFor({ state: 'visible', timeout: settleTimeout });
  await explore.getByRole('button', { name: 'Refresh places', exact: true }).click();
  await mock.waitFor((request) => request.method === 'POST' && request.path === '/api/explore/refresh' && request.query.accountId === undefined
    && (parsedBody(request) as Record<string, unknown>).accountId === first);

  await selectAccount(page, secondHandle);
  lateRefresh.resolve({ json: pageOf(first, explorePlacesOf({ places: [latePlace] })) });
  await explore.getByText('Beta Harbor', { exact: true }).first().waitFor({ state: 'visible', timeout: settleTimeout });
  await sleep(200);
  assert.equal((await explore.innerText()).includes('Late Alpha Harbor'), false, 'a late response for the previous account must not leak into the new account');

  const bodyText = await page.locator('body').innerText();
  assert.equal(bodyText.includes(tokenFirst), false);
  assert.equal(bodyText.includes(tokenSecond), false);
  assert.deepEqual(errors, []);
});
