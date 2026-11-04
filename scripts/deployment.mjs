import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAuthorityAccountName, validateHomeAccountName } from '@fctp/identity';

const services = new Set(['authority', 'policy', 'simulation', 'client']);
const applicationRoot = fileURLToPath(new globalThis.URL('../', import.meta.url));

function fail(message) {
  throw new TypeError(message);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalOrigin(value, field) {
  if (typeof value !== 'string') fail(`Invalid ${field}`);
  let url;
  try { url = new globalThis.URL(value); } catch { fail(`Invalid ${field}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value !== url.origin) fail(`Invalid ${field}`);
  return url.origin;
}

function resolveFile(path, base) {
  if (typeof path !== 'string' || !path) fail('Invalid file path');
  return isAbsolute(path) ? path : resolve(base, path);
}

async function readSecret(path) {
  let details;
  try { details = await stat(path); } catch { fail('Unable to read secret file'); }
  if (!details.isFile()) fail('Secret path must be a regular file');
  let value;
  try { value = await readFile(path, 'utf8'); } catch { fail('Unable to read secret file'); }
  value = value.replace(/\r?\n$/, '');
  if (!value) fail('Secret file is empty');
  return value;
}

function validateNames(value, field, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) || new Set(value).size !== value.length) fail(`Invalid ${field}`);
  return [...value];
}

function validateStringOrigins(value, field) {
  if (!Array.isArray(value)) fail(`Invalid ${field}`);
  return value.map((entry) => canonicalOrigin(entry, field));
}

function validateStartingPorts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('Invalid starting ports');
  return value.map((entry) => {
    if (typeof entry !== 'string') fail('Invalid starting ports');
    let url;
    try { url = new globalThis.URL(entry); } catch { fail('Invalid starting ports'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Invalid starting ports');
    return entry;
  });
}

function validateVesselNames(value, playerNames) {
  const source = value ?? {};
  if (!record(source)) fail('Invalid vessel names');
  const names = {};
  for (const [name, vesselName] of Object.entries(source)) {
    if (!playerNames.includes(name) || typeof vesselName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(vesselName)) fail('Invalid vessel names');
    names[name] = vesselName;
  }
  if (new Set(Object.values(names)).size !== Object.keys(names).length) fail('Invalid vessel names');
  return names;
}

function validateAdministrator(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^@[A-Za-z0-9._-]+@[^@\s/]+$/.test(value)) fail('Invalid administrator');
  return value;
}

function validateDisplayName(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) fail(`Invalid ${field}`);
  return value.trim();
}

function validateObjectStorageEndpoint(value) {
  if (typeof value !== 'string' || !value) fail('Invalid object storage endpoint');
  let url;
  try { url = new globalThis.URL(value); } catch { fail('Invalid object storage endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) fail('Invalid object storage endpoint');
  return url.origin;
}

async function validateObjectStorage(value, base) {
  if (!record(value)) fail('Invalid object storage configuration');
  const endpoint = validateObjectStorageEndpoint(value.endpoint);
  if (typeof value.region !== 'string' || !value.region.trim() || typeof value.bucket !== 'string' || !value.bucket.trim()) fail('Invalid object storage configuration');
  if (value.forcePathStyle !== undefined && typeof value.forcePathStyle !== 'boolean') fail('Invalid object storage configuration');
  const accessKeyId = await readSecret(resolveFile(value.accessKeyIdFile, base));
  const secretAccessKey = await readSecret(resolveFile(value.secretAccessKeyFile, base));
  return {
    endpoint,
    region: value.region,
    bucket: value.bucket,
    accessKeyId,
    secretAccessKey,
    ...(value.forcePathStyle === undefined ? {} : { forcePathStyle: value.forcePathStyle })
  };
}

function validateRoutes(value, origin, service) {
  if (!Array.isArray(value)) fail('Invalid additional routes');
  const reserved = service === 'policy' ? ['approach', 'coastal'] : ['approach'];
  const ids = new Set(reserved.map((name) => `${origin}/objects/routes/${name}`));
  return value.map((route) => {
    if (!record(route) || typeof route.id !== 'string' || !route.id.startsWith(`${origin}/objects/routes/`) || ids.has(route.id) || route.type !== 'Route' || typeof route.name !== 'string' || !route.name || typeof route.from !== 'string' || !globalThis.URL.canParse(route.from) || typeof route.to !== 'string' || !globalThis.URL.canParse(route.to) || route.from === route.to) fail('Invalid additional route');
    ids.add(route.id);
    return globalThis.structuredClone(route);
  });
}

export async function readDeploymentConfig(service, path) {
  if (!services.has(service)) fail('Unknown deployment service');
  const configPath = resolve(path);
  let source;
  try { source = await readFile(configPath, 'utf8'); } catch { fail('Unable to read deployment config'); }
  let input;
  try { input = JSON.parse(source); } catch { fail('Invalid deployment config JSON'); }
  if (!record(input)) fail('Deployment config must be an object');
  const base = dirname(configPath);
  const origin = canonicalOrigin(input.origin, 'origin');
  const listenHost = input.listenHost ?? '0.0.0.0';
  const port = input.port ?? 8080;
  const dataDir = resolveFile(input.dataDir ?? '/data', base);
  const workerIntervalMs = input.workerIntervalMs ?? 1000;
  if (typeof listenHost !== 'string' || !listenHost || !Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(workerIntervalMs) || workerIntervalMs < 1) fail('Invalid listen configuration');
  const config = { service, origin, listenHost, port, dataDir, workerIntervalMs };

  if (service === 'authority') {
    const playerNames = validateNames(input.playerNames, 'player names');
    const administratorNames = input.administratorNames === undefined ? [] : validateNames(input.administratorNames, 'administrator names', true);
    const administrator = validateAdministrator(input.administrator);
    const homeAccountName = validateHomeAccountName(input.homeAccountName ?? 'system.home');
    const registryAccountName = validateAuthorityAccountName(input.registryAccountName ?? 'system.registry', 'registry');
    const serverDisplayName = validateDisplayName(input.serverDisplayName, 'server display name') ?? new globalThis.URL(origin).host;
    const homeDisplayName = validateDisplayName(input.homeDisplayName, 'home display name') ?? `${serverDisplayName} Home`;
    const registryDisplayName = validateDisplayName(input.registryDisplayName, 'registry display name') ?? `${serverDisplayName} Registry`;
    if (administratorNames.some((name) => playerNames.includes(name))) fail('Invalid account names');
    const vesselNames = validateVesselNames(input.vesselNames, playerNames);
    const startingPorts = validateStartingPorts(input.startingPorts);
    const adminSecret = await readSecret(resolveFile(input.adminSecretFile, base));
    const passwordFile = resolveFile(input.accountPasswordsFile, base);
    let accountPasswords;
    let passwordDetails;
    try { passwordDetails = await stat(passwordFile); } catch { fail('Invalid account password file'); }
    if (!passwordDetails.isFile()) fail('Invalid account password file');
    try { accountPasswords = JSON.parse(await readFile(passwordFile, 'utf8')); } catch { fail('Invalid account password file'); }
    const accountNames = [...playerNames, ...administratorNames];
    if (!record(accountPasswords) || Object.keys(accountPasswords).length !== accountNames.length || accountNames.some((name) => typeof accountPasswords[name] !== 'string' || !accountPasswords[name])) fail('Invalid account passwords');
    const objectStorage = input.objectStorage === undefined ? undefined : await validateObjectStorage(input.objectStorage, base);
    Object.assign(config, { playerNames, administratorNames, ...(administrator === undefined ? {} : { administrator }), homeAccountName, registryAccountName, serverDisplayName, homeDisplayName, registryDisplayName, vesselNames, startingPorts, adminSecret, accountPasswords, ...(objectStorage === undefined ? {} : { objectStorage }) });
  }

  if (service === 'policy' || service === 'simulation') {
    const administrator = validateAdministrator(input.administrator);
    const adminSecret = await readSecret(resolveFile(input.adminSecretFile, base));
    const peerOrigin = service === 'simulation' ? canonicalOrigin(input.peerOrigin, 'peer origin') : undefined;
    const additionalRoutes = input.additionalRoutes === undefined ? [] : validateRoutes(input.additionalRoutes, origin, service);
    const territoryAccountName = validateAuthorityAccountName(input.territoryAccountName ?? 'system.territory', 'territory');
    const serverDisplayName = validateDisplayName(input.serverDisplayName, 'server display name') ?? new globalThis.URL(origin).host;
    const territoryDisplayName = validateDisplayName(input.territoryDisplayName, 'territory display name') ?? `${serverDisplayName} Territory`;
    Object.assign(config, { ...(peerOrigin === undefined ? {} : { peerOrigin }), ...(administrator === undefined ? {} : { administrator }), adminSecret, additionalRoutes, territoryAccountName, serverDisplayName, territoryDisplayName });
  }

  if (service === 'client') {
    const seedServers = input.seedServers === undefined ? [] : validateStringOrigins(input.seedServers, 'seed server');
    if (input.administratorBindings !== undefined || input.administratorCredentialFiles !== undefined) fail('Invalid administrator configuration');
    Object.assign(config, { seedServers, root: input.staticRoot === undefined ? applicationRoot : resolveFile(input.staticRoot, base) });
  }

  return config;
}

export async function startDeployment(service, config) {
  if (!services.has(service) || config?.service !== service) fail('Deployment service does not match config');
  await mkdir(config.dataDir, { recursive: true });
  const storeFile = resolve(config.dataDir, 'store.json');
  const keyFile = resolve(config.dataDir, 'keys.json');
  let app;
  let application;
  let server;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([
      ...(server && service === 'client' ? [server.close()] : []),
      ...(application ? [application.close()] : []),
      ...(app ? [service === 'authority' ? app.authority.close() : app.host.close()] : [])
    ]);
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Deployment shutdown failed');
  };
  try {
    if (service === 'authority') {
      const { createAuthorityApp } = await import('../apps/test-authority/dist/app.js');
      app = await createAuthorityApp({ origin: config.origin, storeFile, keyFile, adminSecret: config.adminSecret, ...(config.administrator === undefined ? {} : { administrator: config.administrator }), playerNames: config.playerNames, administratorNames: config.administratorNames, vesselNames: config.vesselNames, startingPorts: config.startingPorts, accountPasswords: config.accountPasswords, homeAccountName: config.homeAccountName, registryAccountName: config.registryAccountName, serverDisplayName: config.serverDisplayName, homeDisplayName: config.homeDisplayName, registryDisplayName: config.registryDisplayName, ...(config.objectStorage === undefined ? {} : { objectStorage: config.objectStorage }) });
    }
    if (service === 'policy') {
      const { createPolicyApp } = await import('../apps/territory-policy/dist/app.js');
      app = await createPolicyApp({ origin: config.origin, storeFile, keyFile, ...(config.administrator === undefined ? {} : { administrator: config.administrator }), adminSecret: config.adminSecret, additionalRoutes: config.additionalRoutes, territoryAccountName: config.territoryAccountName, serverDisplayName: config.serverDisplayName, territoryDisplayName: config.territoryDisplayName });
    }
    if (service === 'simulation') {
      const { createSimulationApp } = await import('../apps/territory-sim/dist/app.js');
      app = await createSimulationApp({ origin: config.origin, storeFile, keyFile, peerOrigin: config.peerOrigin, ...(config.administrator === undefined ? {} : { administrator: config.administrator }), adminSecret: config.adminSecret, additionalRoutes: config.additionalRoutes, territoryAccountName: config.territoryAccountName, serverDisplayName: config.serverDisplayName, territoryDisplayName: config.territoryDisplayName });
    }
    if (service === 'client') {
      const { createClientApplication } = await import('../apps/client-server/dist/app.js');
      const { startClientServer } = await import('../dist/apps/demo/client-server.js');
      application = await createClientApplication({ storeFile, seedServers: config.seedServers });
      server = await startClientServer({ port: config.port, host: config.listenHost, origin: config.origin, root: config.root, application });
    }
    else {
      const listening = await (service === 'authority' ? app.authority : app.host).listen(config.port, config.listenHost);
      server = { origin: config.origin, listenAddress: `${config.listenHost}:${listening.port}`, close: listening.close };
    }
    if (service !== 'client') (service === 'authority' ? app.authority : app.host).startWorkers(config.workerIntervalMs);
    const listenAddress = server.listenAddress ?? `${config.listenHost}:${new globalThis.URL(server.origin).port}`;
    return { origin: config.origin, listenAddress, close, ...(app ? { app } : {}), ...(application ? { application } : {}), ...(server ? { server } : {}) };
  } catch (error) {
    await close();
    throw error;
  }
}
