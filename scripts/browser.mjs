import { chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ROOT = resolve(REPOSITORY_ROOT, 'run');
const ROLE_NAMES = Object.freeze([
  'player-1', 'player-2', 'player-3', 'player-4', 'player-5',
  'administrator-1', 'administrator-2', 'administrator-3'
]);
const COMMANDS = Object.freeze(['open', 'view', 'fill', 'select', 'click', 'submit', 'batch', 'back', 'reload', 'close']);
const WORKER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'browser-worker.mjs');

export function runtimeConfigRoot(env = process.env) {
  return env.FCTP_BROWSER_CONFIG_ROOT ? resolve(REPOSITORY_ROOT, env.FCTP_BROWSER_CONFIG_ROOT) : RUN_ROOT;
}

export function parseCommand(args) {
  const [role, command, ...operands] = args;
  if (!ROLE_NAMES.includes(role)) throw new TypeError('Unknown browser role');
  if (!COMMANDS.includes(command)) throw new TypeError('Unknown browser command');
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
  const origins = value.origins;
  const actors = value.actors;
  if (!origins || !Array.isArray(origins.authority) || origins.authority.length !== 1 || !origins.territoryA || !origins.territoryB || !actors?.players || !actors?.vessels) throw new TypeError('Run configuration is missing public browser origins or actors');
  if (Object.keys(actors.players).length !== 5 || Object.keys(actors.vessels).length !== 5) throw new TypeError('Run config must contain exactly five Player and Vessel mappings');
  const authorityOrigin = new URL(origins.authority[0]);
  const territoryAOrigin = new URL(origins.territoryA);
  const territoryBOrigin = new URL(origins.territoryB);
  const uri = (candidate) => typeof candidate === 'string' && new URL(candidate).protocol.startsWith('http');
  if (![authorityOrigin, territoryAOrigin, territoryBOrigin].every((url) => ['http:', 'https:'].includes(url.protocol))) throw new TypeError('Invalid service origin');
  for (const field of ['registry', 'home']) if (!uri(actors[field])) throw new TypeError(`Invalid public actor: ${field}`);
  for (let index = 1; index <= 5; index += 1) {
    const key = index === 1 ? 'player' : `player-${index}`;
    if (!uri(actors.players[key]) || !uri(actors.vessels[key])) throw new TypeError(`Run config must define ${key} and its vessel`);
  }
  if (!uri(actors.territoryA) || !uri(actors.territoryB)) throw new TypeError('Run config must define both Territory Actors');
  return { authority: authorityOrigin.origin, policy: territoryAOrigin.origin, simulation: territoryBOrigin.origin };
}

export function roleSession(role, config, credentials) {
  if (!ROLE_NAMES.includes(role)) throw new TypeError('Unknown browser role');
  if (!credentials || typeof credentials !== 'object') throw new TypeError('Missing role credentials');
  if (role.startsWith('player-')) {
    const index = Number(role.slice('player-'.length));
    const name = index === 1 ? 'player' : `player-${index}`;
    const player = config.actors.players[name];
    const vessel = config.actors.vessels[name];
    if (credentials.role !== role || credentials.player !== player || credentials.vessel !== vessel || typeof credentials.nativeToken !== 'string' || !credentials.nativeToken) throw new TypeError('Role credentials do not match configured Player and vessel');
    return { sessionRole: 'player', player, vessel, credential: credentials.nativeToken };
  }
  if (role === 'administrator-1') {
    if (credentials.role !== role || typeof credentials.territoryAAdmin !== 'string' || !credentials.territoryAAdmin) throw new TypeError('Missing administrator-1 credential');
    return { sessionRole: 'policy-admin', player: '', vessel: '', credential: credentials.territoryAAdmin };
  }
  if (role === 'administrator-2') {
    if (credentials.role !== role || typeof credentials.territoryBAdmin !== 'string' || !credentials.territoryBAdmin) throw new TypeError('Missing administrator-2 credential');
    return { sessionRole: 'simulation-admin', player: '', vessel: '', credential: credentials.territoryBAdmin };
  }
  if (credentials.role !== role || typeof credentials.authorityAdmin !== 'string' || !credentials.authorityAdmin) throw new TypeError('Missing administrator-3 credential');
  const player = config.actors.players.player;
  const vessel = config.actors.vessels.player;
  return { sessionRole: 'authority-admin', player, vessel, credential: credentials.authorityAdmin };
}

export function extractRef(markdown, label) {
  const line = markdown.split('\n').find((entry) => entry.startsWith(`${label}:`) || entry.startsWith(`${label} [`));
  const matches = [...(line ?? '').matchAll(/\[([A-Za-z0-9-]+)\]/g)];
  const reference = matches.at(-1)?.[1];
  if (!reference) throw new Error(`Visible ${label} control is unavailable`);
  return reference;
}

export function socketPathFor(config, role, runRoot = RUN_ROOT) {
  if (!ROLE_NAMES.includes(role)) throw new TypeError('Unknown browser role');
  validateRuntimeConfig(config);
  return resolve(runRoot, 'runtime', config.runId, role, 'browser.sock');
}

export function credentialPathFor(config, role, runRoot = RUN_ROOT) {
  if (!ROLE_NAMES.includes(role)) throw new TypeError('Unknown browser role');
  validateRuntimeConfig(config);
  const credentialRole = role.startsWith('administrator-') ? role.replace('administrator-', 'admin-') : role;
  return resolve(runRoot, 'runtime', config.runId, credentialRole, 'credentials.json');
}

export function startupDiagnosticPathFor(config, role, runRoot = RUN_ROOT) {
  if (!ROLE_NAMES.includes(role)) throw new TypeError('Unknown browser role');
  validateRuntimeConfig(config);
  return resolve(runRoot, 'runtime', config.runId, role, 'browser-startup-failure.txt');
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

export async function main(args = process.argv.slice(2)) {
  try {
    const parsed = parseCommand(args);
    const configRoot = runtimeConfigRoot();
    const config = await readConfig(configRoot);
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
