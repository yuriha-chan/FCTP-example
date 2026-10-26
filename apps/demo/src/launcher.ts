import { createServer, type Server } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAuthorityApp } from '../../test-authority/src/app.js';
import { createPolicyApp } from '../../territory-policy/src/app.js';
import { createSimulationApp } from '../../territory-sim/src/app.js';

export interface DemoPorts {
  authority: number;
  policy: number;
  simulation: number;
  client: number;
}

export interface DemoAdminSecrets {
  authority: string;
  policy: string;
  simulation: string;
}

export interface StartDemoOptions {
  dataDir: string;
  ports?: Partial<DemoPorts>;
  adminSecrets?: Partial<DemoAdminSecrets>;
}

const defaultPorts: DemoPorts = { authority: 4100, policy: 4101, simulation: 4102, client: 4103 };
const serviceNames = ['authority', 'policy', 'simulation', 'client'] as const;

export async function startDemo(options: StartDemoOptions) {
  const ports = { ...defaultPorts, ...options.ports };
  if (serviceNames.some((name) => !Number.isInteger(ports[name]) || ports[name] <= 0 || ports[name] > 65535)) {
    throw new RangeError('Demo ports must be positive integers no greater than 65535');
  }
  if (new Set(serviceNames.map((name) => ports[name])).size !== serviceNames.length) {
    throw new RangeError('Demo ports must be unique');
  }
  const secrets: DemoAdminSecrets = {
    authority: options.adminSecrets?.authority ?? process.env.DEMO_AUTHORITY_ADMIN_SECRET ?? 'demo-authority-admin',
    policy: options.adminSecrets?.policy ?? process.env.DEMO_POLICY_ADMIN_SECRET ?? 'demo-policy-admin',
    simulation: options.adminSecrets?.simulation ?? process.env.DEMO_SIM_ADMIN_SECRET ?? 'demo-sim-admin'
  };
  const origin = (port: number): string => `http://127.0.0.1:${port}`;
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true });
  let authority: Awaited<ReturnType<typeof createAuthorityApp>> | undefined;
  let policy: Awaited<ReturnType<typeof createPolicyApp>> | undefined;
  let simulation: Awaited<ReturnType<typeof createSimulationApp>> | undefined;
  let staticServer: Server | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const shutdowns = [authority?.authority.close(), policy?.host.close(), simulation?.host.close()];
    if (staticServer?.listening) {
      shutdowns.push(new Promise<void>((resolveClose, reject) => staticServer!.close((error) => error ? reject(error) : resolveClose())));
    }
    const results = await Promise.allSettled(shutdowns);
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'One or more demo services failed to close');
  };

  try {
    authority = await createAuthorityApp({ origin: origin(ports.authority), storeFile: resolve(dataDir, 'authority.store.json'), keyFile: resolve(dataDir, 'authority.keys.json'), adminSecret: secrets.authority });
    policy = await createPolicyApp({ origin: origin(ports.policy), storeFile: resolve(dataDir, 'policy.store.json'), keyFile: resolve(dataDir, 'policy.keys.json'), authorityOrigin: origin(ports.authority), peerOrigin: origin(ports.simulation), adminSecret: secrets.policy });
    simulation = await createSimulationApp({ origin: origin(ports.simulation), storeFile: resolve(dataDir, 'simulation.store.json'), keyFile: resolve(dataDir, 'simulation.keys.json'), authorityOrigin: origin(ports.authority), peerOrigin: origin(ports.policy), adminSecret: secrets.simulation });

    await authority.authority.listen(ports.authority, '127.0.0.1');
    await policy.host.listen(ports.policy, '127.0.0.1');
    await simulation.host.listen(ports.simulation, '127.0.0.1');

    const config = {
      origins: { authority: origin(ports.authority), policy: origin(ports.policy), simulation: origin(ports.simulation) },
      actors: { registry: authority.ids.actor.registry, home: authority.ids.actor.home, player: authority.ids.actor.player, policy: policy.ids.actor, simulation: simulation.ids.actor }
    };
    staticServer = await startStaticClient(ports.client, config);
    authority.authority.startWorkers();
    policy.host.startWorkers();
    simulation.host.startWorkers();
    return { ports, origins: { ...config.origins, client: origin(ports.client) }, authority, policy, simulation, close };
  } catch (error) {
    await close();
    throw error;
  }
}

interface ClientConfig { origins: Record<string, string>; actors: Record<string, string> }

async function startStaticClient(port: number, config: ClientConfig): Promise<Server> {
  const root = resolve('apps/client');
  const js = resolve('dist/client/main.js');
  const allowed: Record<string, { file: string; type: string }> = {
    '/': { file: resolve(root, 'index.html'), type: 'text/html; charset=utf-8' },
    '/index.html': { file: resolve(root, 'index.html'), type: 'text/html; charset=utf-8' },
    '/styles.css': { file: resolve(root, 'styles.css'), type: 'text/css; charset=utf-8' },
    '/dist/client/main.js': { file: js, type: 'text/javascript; charset=utf-8' }
  };
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
      if (pathname === '/config.json') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(config));
        return;
      }
      const asset = allowed[pathname];
      if (!asset) { response.writeHead(404); response.end(); return; }
      const content = await readFile(asset.file);
      response.writeHead(200, { 'Content-Type': asset.type, 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : content);
    })().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!response.headersSent) { response.writeHead(404); response.end(); }
        return;
      }
      if (!response.headersSent) { response.writeHead(500); response.end(); }
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return server;
}
