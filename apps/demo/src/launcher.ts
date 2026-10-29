import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startClientServer } from './client-server.js';
import { createClientApplication, type ClientApplication } from '../../client-server/src/app.js';
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
const demoPlayerPassword = 'demo-player-password';
const demoGovernorPassword = 'demo-governor-password';

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
  let clientServer: Awaited<ReturnType<typeof startClientServer>> | undefined;
  let application: ClientApplication | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const shutdowns = [authority?.authority.close(), policy?.host.close(), simulation?.host.close()];
    if (clientServer) shutdowns.push(clientServer.close());
    if (application) shutdowns.push(application.close());
    const results = await Promise.allSettled(shutdowns);
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'One or more demo services failed to close');
  };

  try {
    authority = await createAuthorityApp({
      origin: origin(ports.authority),
      storeFile: resolve(dataDir, 'authority.store.json'),
      keyFile: resolve(dataDir, 'authority.keys.json'),
      adminSecret: secrets.authority,
      playerNames: ['player'],
      administratorNames: ['governor'],
      accountPasswords: { player: demoPlayerPassword, governor: demoGovernorPassword }
    });
    policy = await createPolicyApp({ origin: origin(ports.policy), storeFile: resolve(dataDir, 'policy.store.json'), keyFile: resolve(dataDir, 'policy.keys.json'), authorityOrigin: origin(ports.authority), peerOrigin: origin(ports.simulation), adminSecret: secrets.policy });
    simulation = await createSimulationApp({ origin: origin(ports.simulation), storeFile: resolve(dataDir, 'simulation.store.json'), keyFile: resolve(dataDir, 'simulation.keys.json'), authorityOrigin: origin(ports.authority), peerOrigin: origin(ports.policy), adminSecret: secrets.simulation });

    await authority.authority.listen(ports.authority, '127.0.0.1');
    await policy.host.listen(ports.policy, '127.0.0.1');
    await simulation.host.listen(ports.simulation, '127.0.0.1');

    const config = {
      origins: { authority: origin(ports.authority), policy: origin(ports.policy), simulation: origin(ports.simulation) },
      actors: { registry: authority.ids.actor.registry, home: authority.ids.actor.home, player: authority.ids.actor.player, policy: policy.ids.actor, simulation: simulation.ids.actor }
    };
    const governorAccountId = `@governor@${new URL(authority.ids.actor.home).host}`;
    application = await createClientApplication({
      storeFile: resolve(dataDir, 'client.store.json'),
      seedServers: [config.origins.authority, config.origins.policy, config.origins.simulation],
      administratorBindings: [
        { accountId: governorAccountId, authorityActorIds: [authority.ids.actor.registry], credentialSource: 'authority-administrator' },
        { accountId: governorAccountId, authorityActorIds: [policy.ids.actor], credentialSource: 'policy-administrator' },
        { accountId: governorAccountId, authorityActorIds: [simulation.ids.actor], credentialSource: 'simulation-administrator' }
      ],
      administratorCredentials: {
        'authority-administrator': secrets.authority,
        'policy-administrator': secrets.policy,
        'simulation-administrator': secrets.simulation
      }
    });
    clientServer = await startClientServer({ port: ports.client, config, application });
    authority.authority.startWorkers();
    policy.host.startWorkers();
    simulation.host.startWorkers();
    return { ports, origins: { ...config.origins, client: clientServer.origin }, authority, policy, simulation, application, close };
  } catch (error) {
    await close();
    throw error;
  }
}
