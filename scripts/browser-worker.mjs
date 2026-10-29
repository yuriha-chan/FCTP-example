import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand, runtimeConfigRoot, socketPathFor, startupDiagnosticPathFor, validateBatch, validateRuntimeConfig } from './browser.mjs';
import { createJsonLineServer, createSerializedDispatcher } from './browser-transport.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const role = process.argv[2];
const configRoot = runtimeConfigRoot();
const runtimeRoot = resolve(configRoot, 'runtime');
const configPath = resolve(configRoot, 'runtime-config.json');
const auditPathFor = (runId) => resolve(runtimeRoot, runId, role, 'browser-audit.jsonl');
let browser;
let clientServer;
let server;
let closing;
let config;
let socketPath;
let auditPath;
let createBrowserSession;
let startClientServer;

function redact(message) {
  return String(message).slice(0, 500);
}

async function audit(command, ref, status) {
  const record = { role, time: new Date().toISOString(), op: command, ref: ref ?? null, status };
  await import('node:fs/promises').then(({ appendFile }) => appendFile(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 }));
}

async function dispatch(request) {
  if (!request || typeof request !== 'object' || !['view', 'fill', 'select', 'click', 'submit', 'batch', 'back', 'reload', 'close'].includes(request.command)) throw new TypeError('Invalid browser daemon command');
  if (request.command === 'batch') {
    const steps = validateBatch(request.steps);
    return await browser.batch(steps);
  }
  if (request.command === 'view') return await browser.view();
  if (request.command === 'fill' || request.command === 'select' || request.command === 'click' || request.command === 'submit') {
    if (typeof request.ref !== 'string' || request.ref.length > 512) throw new TypeError('Invalid control reference');
    if (['fill', 'select'].includes(request.command) && typeof request.value !== 'string') throw new TypeError('Invalid control value');
  }
  if (request.command === 'fill') return await browser.fill(request.ref, request.value);
  if (request.command === 'select') return await browser.select(request.ref, request.value);
  if (request.command === 'click') return await browser.click(request.ref);
  if (request.command === 'submit') return await browser.submit(request.ref);
  if (request.command === 'back') return await browser.back();
  if (request.command === 'reload') return await browser.reload();
  if (request.command === 'close') {
    return { closeAfterResponse: true };
  }
  throw new TypeError('Unknown browser daemon command');
}

async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    const outcomes = await Promise.allSettled([
      browser?.close(),
      clientServer?.close(),
      new Promise((resolveClose, rejectClose) => {
        if (!server?.listening) resolveClose();
        else server.close((error) => error ? rejectClose(error) : resolveClose());
      }),
      socketPath ? unlink(socketPath).catch((error) => { if (error.code !== 'ENOENT') throw error; }) : Promise.resolve()
    ]);
    const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Browser daemon shutdown failed');
  })();
  return closing;
}

async function start() {
  parseCommand([role, 'view']);
  config = JSON.parse(await readFile(configPath, 'utf8'));
  const origins = validateRuntimeConfig(config);
  ({ createBrowserSession } = await import('../dist/apps/browser-harness/index.js'));
  ({ startClientServer } = await import('../dist/apps/demo/client-server.js'));
  socketPath = socketPathFor(config, role, configRoot);
  auditPath = auditPathFor(config.runId);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(socketPath), 0o700);
  clientServer = await startClientServer({ port: 0, host: '127.0.0.1', root: ROOT });
  browser = await createBrowserSession({ url: clientServer.origin, allowedOrigins: [clientServer.origin, ...Object.values(origins)] });
  const initialView = await browser.view();
  const serializedDispatch = createSerializedDispatcher(async (request) => {
    try {
      const result = await dispatch(request);
      await audit(request.command, request.ref, 'ok');
      return result;
    } catch (error) {
      await audit(request?.command ?? 'invalid', request?.ref, 'error');
      throw error;
    }
  });
  server = createJsonLineServer(serializedDispatch, { timeoutMs: 1_800_000, formatError: (error) => redact(error instanceof Error ? error.message : 'Browser command failed') });
  server.on('close-after-response', () => { void shutdown(); });
  server.listen(socketPath);
  await new Promise((resolveListen, rejectListen) => {
    server.once('listening', resolveListen);
    server.once('error', rejectListen);
  });
  await chmod(socketPath, 0o600);
  if (!initialView.markdown) throw new Error('Browser page rendered no visible content');
}

process.once('SIGINT', () => { void shutdown().finally(() => { process.exitCode = 0; }); });
process.once('SIGTERM', () => { void shutdown().finally(() => { process.exitCode = 0; }); });
try {
  await start();
} catch (error) {
  const message = redact(error instanceof Error ? error.message : 'Browser daemon failed to start');
  if (/playwright|chromium|browser executable|host system dependencies|missing dependencies|executable (?:does not exist|doesn't exist|not found)|shared librar|lib[a-z0-9_-]+\.so|ERR_MODULE_NOT_FOUND|cannot find package/i.test(message)) {
    await writeStartupDiagnostic(`Browser startup is blocked by missing browser dependencies: ${message}`);
  } else {
    await writeStartupDiagnostic(`Browser daemon failed to start: ${message}`);
  }
  try {
    await shutdown();
  } catch (shutdownError) {
    throw new AggregateError([error, shutdownError], 'Browser daemon startup and cleanup failed');
  }
  throw error;
}

async function writeStartupDiagnostic(message) {
  if (!config || !role) return;
  const path = startupDiagnosticPathFor(config, role, configRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${message.slice(0, 500)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
