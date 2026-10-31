import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { applicationUrl, createApplicationTransport, normalizeOrigin } from './browser-api.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ROOT = resolve(REPOSITORY_ROOT, 'run');
const ACCOUNT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOM_COMMANDS = Object.freeze(['open', 'view', 'fill', 'select', 'click', 'submit', 'batch', 'back', 'reload', 'close']);
const API_COMMANDS = Object.freeze(['login', 'logout', 'page', 'action', 'result']);
const WORKER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'browser-worker.mjs');
const CLIENT_SESSION_FILE = 'client-session.json';

export function runtimeConfigRoot(env = process.env) {
  return env.FCTP_BROWSER_CONFIG_ROOT ? resolve(REPOSITORY_ROOT, env.FCTP_BROWSER_CONFIG_ROOT) : RUN_ROOT;
}

function validatePagePath(pathname) {
  applicationUrl('http://127.0.0.1', pathname);
  return pathname;
}

function parseJsonObject(source, label) {
  let value;
  try { value = JSON.parse(source); } catch { throw new TypeError(`${label} must be valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

export function parseCommand(args) {
  const [role, command, ...operands] = args;
  if (typeof role !== 'string' || !ACCOUNT_PATTERN.test(role)) throw new TypeError('Unknown browser account');
  if (API_COMMANDS.includes(command)) {
    if (command === 'login' || command === 'logout') {
      if (operands.length !== 0) throw new TypeError(`Invalid operands for ${command}`);
      return { role, command };
    }
    if (command === 'page') {
      if (operands.length !== 1) throw new TypeError('Invalid operands for page');
      return { role, command, path: validatePagePath(operands[0]) };
    }
    if (command === 'action') {
      if (operands.length !== 2) throw new TypeError('Invalid operands for action');
      return {
        role,
        command,
        descriptor: parseJsonObject(operands[0], 'Action descriptor'),
        inputs: parseJsonObject(operands[1], 'Action inputs')
      };
    }
    if (operands.length !== 1 || typeof operands[0] !== 'string' || !operands[0]) throw new TypeError('Invalid operands for result');
    return { role, command, actionId: operands[0] };
  }
  if (!DOM_COMMANDS.includes(command)) throw new TypeError('Unknown browser command');
  const counts = { open: 0, view: 0, fill: 2, select: 2, click: 1, submit: 1, batch: 1, back: 0, reload: 0, close: 0 };
  if (operands.length !== counts[command]) throw new TypeError(`Invalid operands for ${command}`);
  if (['fill', 'select', 'click', 'submit'].includes(command) && (!operands[0] || operands[0].length > 512)) throw new TypeError('Invalid control reference');
  if (command === 'batch') return { role, command, steps: parseBatch(operands[0]) };
  return { role, command, ...(operands.length ? { ref: operands[0] } : {}), ...(operands.length > 1 ? { value: operands[1] } : {}) };
}

export function parseBatch(source) {
  let value;
  try { value = JSON.parse(source); } catch { throw new TypeError('Batch must be a JSON array'); }
  return validateBatch(value);
}

export function validateBatch(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new TypeError('Batch must contain between 1 and 32 steps');
  return value.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step) || !Object.hasOwn(step, 'command') || !Object.hasOwn(step, 'ref')) throw new TypeError('Invalid batch step fields');
    const keys = Object.keys(step);
    if (keys.some((key) => !['command', 'ref', 'value'].includes(key)) || !['fill', 'select', 'click', 'submit'].includes(step.command) || typeof step.ref !== 'string' || !step.ref || step.ref.length > 512) throw new TypeError('Invalid batch step');
    if (['fill', 'select'].includes(step.command) ? typeof step.value !== 'string' || keys.length !== 3 : Object.hasOwn(step, 'value') || keys.length !== 2) throw new TypeError('Invalid batch step value');
    return { command: step.command, ref: step.ref, ...(Object.hasOwn(step, 'value') ? { value: step.value } : {}) };
  });
}

export function validateRuntimeConfig(value) {
  if (!value || typeof value !== 'object' || typeof value.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId)) throw new TypeError('Invalid run configuration');
  const client = normalizeOrigin(value.clientOrigin, 'client origin');
  if (!Array.isArray(value.accounts) || value.accounts.length === 0) throw new TypeError('Run configuration requires application accounts');
  const names = new Set();
  for (const account of value.accounts) {
    if (!account || typeof account !== 'object' || typeof account.name !== 'string' || !ACCOUNT_PATTERN.test(account.name)) throw new TypeError('Run configuration contains an invalid account name');
    if (names.has(account.name)) throw new TypeError('Run configuration contains duplicate account names');
    names.add(account.name);
    if (typeof account.handle !== 'string' || !account.handle.trim()) throw new TypeError('Run configuration account requires a handle');
    if (account.homeOrigin !== undefined) normalizeOrigin(account.homeOrigin, 'account home origin');
  }
  return { client };
}

export function socketPathFor(config, role, runRoot = RUN_ROOT) {
  validateRuntimeConfig(config);
  if (!config.accounts.some((entry) => entry.name === role)) throw new TypeError('Unknown browser account');
  return resolve(runRoot, 'runtime', config.runId, role, 'browser.sock');
}

export function startupDiagnosticPathFor(config, role, runRoot = RUN_ROOT) {
  validateRuntimeConfig(config);
  if (!config.accounts.some((entry) => entry.name === role)) throw new TypeError('Unknown browser account');
  return resolve(runRoot, 'runtime', config.runId, role, 'browser-startup-failure.txt');
}

export function clientSessionPathFor(config, role, runRoot = RUN_ROOT) {
  validateRuntimeConfig(config);
  if (!config.accounts.some((entry) => entry.name === role)) throw new TypeError('Unknown browser account');
  return resolve(runRoot, 'runtime', config.runId, role, CLIENT_SESSION_FILE);
}

function storedClientSession(value, config, account) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.origin !== config.clientOrigin || value.handle !== account.handle) return undefined;
  if (typeof value.accountId !== 'string' || !value.accountId) return undefined;
  if (typeof value.clientToken !== 'string' || !value.clientToken) return undefined;
  return { accountId: value.accountId, handle: value.handle, clientToken: value.clientToken };
}

async function readClientSession(path, config, account) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError('Client session path must be a regular file');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return storedClientSession(parsed, config, account);
}

async function writeClientSession(path, session, origin) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError('Client session path must be a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ origin, ...session })}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function removeClientSession(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readConfig(configRoot = runtimeConfigRoot()) {
  const config = JSON.parse(await readFile(resolve(configRoot, 'runtime-config.json'), 'utf8'));
  validateRuntimeConfig(config);
  return config;
}

async function request(socketPath, request, timeoutMs = 15_000) {
  return new Promise((resolveResponse, reject) => {
    const connection = net.createConnection(socketPath);
    let data = '';
    connection.setTimeout(timeoutMs, () => connection.destroy(new Error('Browser daemon request timed out')));
    connection.once('connect', () => connection.end(`${JSON.stringify(request)}\n`));
    connection.on('data', (chunk) => {
      data += chunk.toString();
      if (data.length > 2_000_000) connection.destroy(new Error('Browser daemon response exceeded limit'));
    });
    connection.once('error', reject);
    connection.once('end', () => {
      try {
        const response = JSON.parse(data);
        if (!response.ok) reject(new Error(response.error ?? 'Browser command failed'));
        else resolveResponse(response.view);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function readStartupDiagnostic(config, role, runRoot) {
  const path = startupDiagnosticPathFor(config, role, runRoot);
  try {
    const message = await readFile(path, 'utf8');
    await unlink(path);
    return message.trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function waitReady(socketPath, child, config, role, runRoot) {
  const deadline = Date.now() + 12_000;
  let lastError;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      return await request(socketPath, { command: 'view' });
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  const diagnostic = await readStartupDiagnostic(config, role, runRoot);
  if (diagnostic) throw new Error(diagnostic);
  throw new Error(lastError?.code === 'ENOENT' ? 'Browser daemon did not become ready' : 'Browser daemon failed to start');
}

async function readPassword() {
  let password = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) password += chunk;
  if (password.endsWith('\r\n')) return password.slice(0, -2);
  if (password.endsWith('\n')) return password.slice(0, -1);
  return password;
}

async function apiCommand(parsed, account, config, configRoot) {
  const sessionPath = clientSessionPathFor(config, parsed.role, configRoot);
  const clientSession = await readClientSession(sessionPath, config, account);
  const transport = createApplicationTransport({
    origin: config.clientOrigin,
    account,
    ...(clientSession === undefined ? {} : { clientSession }),
    onSessionChanged: async (session) => {
      if (session) await writeClientSession(sessionPath, session, config.clientOrigin);
      else await removeClientSession(sessionPath);
    }
  });
  if (parsed.command === 'login') return transport.login(await readPassword());
  if (parsed.command === 'logout') return transport.logout();
  if (parsed.command === 'page') return transport.page(parsed.path);
  if (parsed.command === 'action') return transport.action(parsed.descriptor, parsed.inputs);
  return transport.result(parsed.actionId);
}

function visibleLoginResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const visible = { ...result };
  delete visible.clientToken;
  return visible;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const parsed = parseCommand(args);
    const configRoot = runtimeConfigRoot();
    const config = await readConfig(configRoot);
    const account = config.accounts.find((entry) => entry.name === parsed.role);
    if (!account) throw new TypeError('Unknown browser account');
    if (API_COMMANDS.includes(parsed.command)) {
      const result = await apiCommand(parsed, account, config, configRoot);
      process.stdout.write(`${JSON.stringify(parsed.command === 'login' ? visibleLoginResult(result) : result)}\n`);
      return;
    }
    const runRoot = configRoot;
    const socketPath = socketPathFor(config, parsed.role, runRoot);
    if (parsed.command === 'open') {
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(socketPath), 0o700);
      try {
        const view = await request(socketPath, { command: 'view' });
        process.stdout.write(view.markdown);
        return;
      } catch (error) {
        if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') throw error;
        if (error.code === 'ECONNREFUSED') await unlink(socketPath);
      }
      await unlink(startupDiagnosticPathFor(config, parsed.role, runRoot)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      const child = spawn(process.execPath, [WORKER_PATH, parsed.role], { cwd: RUN_ROOT, detached: true, stdio: 'ignore', env: process.env });
      child.unref();
      const view = await waitReady(socketPath, child, config, parsed.role, runRoot);
      process.stdout.write(view.markdown);
      return;
    }
    const view = await request(socketPath, parsed, parsed.command === 'batch' ? 1_800_000 : 15_000);
    if (view) process.stdout.write(view.markdown);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Browser command failed'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
