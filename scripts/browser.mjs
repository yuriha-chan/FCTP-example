import { chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ROOT = resolve(REPOSITORY_ROOT, 'run');
const COMMANDS = Object.freeze(['open', 'view', 'fill', 'select', 'click', 'submit', 'batch', 'back', 'reload', 'close']);
const WORKER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'browser-worker.mjs');

export function runtimeConfigRoot(env = process.env) {
  return env.FCTP_BROWSER_CONFIG_ROOT ? resolve(REPOSITORY_ROOT, env.FCTP_BROWSER_CONFIG_ROOT) : RUN_ROOT;
}

export function parseCommand(args) {
  const [role, command, ...operands] = args;
  if (typeof role !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role)) throw new TypeError('Unknown browser account');
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
  const uri = (candidate) => typeof candidate === 'string' && new URL(candidate).protocol.startsWith('http');
  if (!origins || !Array.isArray(origins.authority) || origins.authority.length !== 1 || !origins.territoryA || !origins.territoryB || !actors?.players || !actors?.vessels) throw new TypeError('Run configuration is missing public browser origins or actors');
  if (!Array.isArray(value.players) || value.players.length !== 5 || !Array.isArray(value.administrators) || value.administrators.length !== 3) throw new TypeError('Run config must contain five Players and three administrators');
  const playerNames = value.players.map((player) => player?.name);
  const administratorNames = value.administrators.map((administrator) => administrator?.name);
  if ([...playerNames, ...administratorNames].some((name) => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) || new Set([...playerNames, ...administratorNames]).size !== 8) throw new TypeError('Run config contains invalid or duplicate accounts');
  if (value.players.some((player, index) => player.role !== playerNames[index] || !uri(player.player) || !uri(player.vessel)) || value.administrators.some((administrator, index) => administrator.sessionRole !== ['policy-admin', 'simulation-admin', 'authority-admin'][index])) throw new TypeError('Run config contains invalid role assignments');
  if (Object.keys(actors.players).length !== 5 || Object.keys(actors.vessels).length !== 5 || playerNames.some((name) => !Object.hasOwn(actors.players, name) || !Object.hasOwn(actors.vessels, name))) throw new TypeError('Run config must contain exactly five Player and Vessel mappings');
  const authorityOrigin = new URL(origins.authority[0]);
  const territoryAOrigin = new URL(origins.territoryA);
  const territoryBOrigin = new URL(origins.territoryB);
  if (![authorityOrigin, territoryAOrigin, territoryBOrigin].every((url) => ['http:', 'https:'].includes(url.protocol))) throw new TypeError('Invalid service origin');
  for (const field of ['registry', 'home']) if (!uri(actors[field])) throw new TypeError(`Invalid public actor: ${field}`);
  for (const key of playerNames) {
    if (!uri(actors.players[key]) || !uri(actors.vessels[key])) throw new TypeError(`Run config must define ${key} and its vessel`);
  }
  if (!uri(actors.territoryA) || !uri(actors.territoryB)) throw new TypeError('Run config must define both Territory Actors');
  return { authority: authorityOrigin.origin, policy: territoryAOrigin.origin, simulation: territoryBOrigin.origin };
}

export function socketPathFor(config, role, runRoot = RUN_ROOT) {
  validateRuntimeConfig(config);
  if (![...config.players, ...config.administrators].some((entry) => entry.name === role)) throw new TypeError('Unknown browser account');
  return resolve(runRoot, 'runtime', config.runId, role, 'browser.sock');
}

export function startupDiagnosticPathFor(config, role, runRoot = RUN_ROOT) {
  validateRuntimeConfig(config);
  if (![...config.players, ...config.administrators].some((entry) => entry.name === role)) throw new TypeError('Unknown browser account');
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
    if (![...config.players, ...config.administrators].some((entry) => entry.name === parsed.role)) throw new TypeError('Unknown browser account');
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
