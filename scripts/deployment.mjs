import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    if (administratorNames.some((name) => playerNames.includes(name))) fail('Invalid account names');
    if (!record(input.vesselNames) || Object.keys(input.vesselNames).length !== playerNames.length || playerNames.some((name) => typeof input.vesselNames[name] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.vesselNames[name])) || new Set(Object.values(input.vesselNames)).size !== playerNames.length) fail('Invalid vessel names');
    const adminSecret = await readSecret(resolveFile(input.adminSecretFile, base));
    const passwordFile = resolveFile(input.accountPasswordsFile, base);
    let accountPasswords;
    let passwordDetails;
    try { passwordDetails = await stat(passwordFile); } catch { fail('Invalid account password file'); }
    if (!passwordDetails.isFile()) fail('Invalid account password file');
    try { accountPasswords = JSON.parse(await readFile(passwordFile, 'utf8')); } catch { fail('Invalid account password file'); }
    const accountNames = [...playerNames, ...administratorNames];
    if (!record(accountPasswords) || Object.keys(accountPasswords).length !== accountNames.length || accountNames.some((name) => typeof accountPasswords[name] !== 'string' || !accountPasswords[name])) fail('Invalid account passwords');
    Object.assign(config, { playerNames, administratorNames, vesselNames: globalThis.structuredClone(input.vesselNames), adminSecret, accountPasswords });
  }

  if (service === 'policy' || service === 'simulation') {
    const playerNames = validateNames(input.playerNames, 'player names');
    const authorityOrigin = canonicalOrigin(input.authorityOrigin, 'authority origin');
    const peerOrigin = canonicalOrigin(input.peerOrigin, 'peer origin');
    const adminSecret = await readSecret(resolveFile(input.adminSecretFile, base));
    const additionalAuthorityOrigins = input.additionalAuthorityOrigins === undefined ? [] : validateStringOrigins(input.additionalAuthorityOrigins, 'additional authority origin');
    const additionalRoutes = input.additionalRoutes === undefined ? [] : validateRoutes(input.additionalRoutes, origin, service);
    Object.assign(config, { playerNames, authorityOrigin, peerOrigin, adminSecret, additionalAuthorityOrigins, additionalRoutes });
  }

  if (service === 'client') {
    const seedServers = input.seedServers === undefined ? [] : validateStringOrigins(input.seedServers, 'seed server');
    const administratorBindings = input.administratorBindings ?? [];
    const credentialFiles = input.administratorCredentialFiles ?? {};
    if (!Array.isArray(administratorBindings) || !record(credentialFiles)) fail('Invalid administrator configuration');
    const administratorCredentials = {};
    for (const [source, file] of Object.entries(credentialFiles)) administratorCredentials[source] = await readSecret(resolveFile(file, base));
    for (const binding of administratorBindings) {
      if (!record(binding) || typeof binding.accountId !== 'string' || !binding.accountId || !Array.isArray(binding.authorityActorIds) || binding.authorityActorIds.length === 0 || binding.authorityActorIds.some((id) => typeof id !== 'string' || !globalThis.URL.canParse(id)) || typeof binding.credentialSource !== 'string' || !administratorCredentials[binding.credentialSource]) fail('Invalid administrator binding');
    }
    Object.assign(config, { seedServers, administratorBindings: globalThis.structuredClone(administratorBindings), administratorCredentials, root: input.staticRoot === undefined ? applicationRoot : resolveFile(input.staticRoot, base) });
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
      app = await createAuthorityApp({ origin: config.origin, storeFile, keyFile, adminSecret: config.adminSecret, playerNames: config.playerNames, administratorNames: config.administratorNames, vesselNames: config.vesselNames, accountPasswords: config.accountPasswords });
    }
    if (service === 'policy') {
      const { createPolicyApp } = await import('../apps/territory-policy/dist/app.js');
      app = await createPolicyApp({ origin: config.origin, storeFile, keyFile, authorityOrigin: config.authorityOrigin, additionalAuthorityOrigins: config.additionalAuthorityOrigins, playerNames: config.playerNames, peerOrigin: config.peerOrigin, adminSecret: config.adminSecret, additionalRoutes: config.additionalRoutes });
    }
    if (service === 'simulation') {
      const { createSimulationApp } = await import('../apps/territory-sim/dist/app.js');
      app = await createSimulationApp({ origin: config.origin, storeFile, keyFile, authorityOrigin: config.authorityOrigin, additionalAuthorityOrigins: config.additionalAuthorityOrigins, playerNames: config.playerNames, peerOrigin: config.peerOrigin, adminSecret: config.adminSecret, additionalRoutes: config.additionalRoutes });
    }
    if (service === 'client') {
      const { createClientApplication } = await import('../apps/client-server/dist/app.js');
      const { startClientServer } = await import('../dist/apps/demo/client-server.js');
      application = await createClientApplication({ storeFile, seedServers: config.seedServers, administratorBindings: config.administratorBindings, administratorCredentials: config.administratorCredentials });
      server = await startClientServer({ port: config.port, host: config.listenHost, root: config.root, application });
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
