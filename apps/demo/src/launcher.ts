import { access, mkdir } from 'node:fs/promises';
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
const demoPlayer2Password = 'demo-player-2-password';
const demoGovernorPassword = 'demo-governor-password';

async function storeExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

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
  const governorHandle = `@governor@${new URL(origin(ports.authority)).host}`;
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true });
  const freshAuthority = !await storeExists(resolve(dataDir, 'authority.store.json'));
  const freshPolicy = !await storeExists(resolve(dataDir, 'policy.store.json'));
  const freshSimulation = !await storeExists(resolve(dataDir, 'simulation.store.json'));
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
      administrator: governorHandle,
      playerNames: ['player', 'player-2'],
      administratorNames: ['governor'],
      accountPasswords: { player: demoPlayerPassword, 'player-2': demoPlayer2Password, governor: demoGovernorPassword }
    });
    policy = await createPolicyApp({
      origin: origin(ports.policy), storeFile: resolve(dataDir, 'policy.store.json'), keyFile: resolve(dataDir, 'policy.keys.json'),
      adminSecret: secrets.policy,
      administrator: governorHandle,
      additionalRoutes: [{
        id: `${origin(ports.policy)}/objects/routes/outbound`, type: 'Route', name: 'Outbound Passage',
        from: `${origin(ports.policy)}/objects/ports/west`, to: `${origin(ports.simulation)}/objects/boundaries/east`
      }]
    });
    simulation = await createSimulationApp({ origin: origin(ports.simulation), storeFile: resolve(dataDir, 'simulation.store.json'), keyFile: resolve(dataDir, 'simulation.keys.json'), peerOrigin: origin(ports.policy), adminSecret: secrets.simulation, administrator: governorHandle });

    await authority.authority.listen(ports.authority, '127.0.0.1');
    await policy.host.listen(ports.policy, '127.0.0.1');
    await simulation.host.listen(ports.simulation, '127.0.0.1');

    const origins = {
      authority: origin(ports.authority),
      policy: origin(ports.policy),
      simulation: origin(ports.simulation)
    };
    const admissionFixture = {
      trustedRegistry: { mode: 'allowlist', allowlist: [authority.ids.actor.registry], denylist: [] },
      acceptedRegistry: { mode: 'allowlist', allowlist: [authority.ids.actor.registry], denylist: [] },
      acceptedTerritory: { mode: 'allowlist', allowlist: [policy.ids.actor, simulation.ids.actor], denylist: [] },
      vesselBuildingRegistry: { mode: 'allowlist', allowlist: [authority.ids.actor.registry], denylist: [] }
    };
    if (freshPolicy) {
      const admission = await fetch(new URL('/local/admin/admission', origins.policy), {
        method: 'POST',
        headers: { Authorization: `Bearer ${secrets.policy}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...admissionFixture, publicPorts: policy.ids.ports })
      });
      if (!admission.ok) throw new Error(`Demo admission fixture failed: HTTP ${admission.status}`);
    }
    if (freshSimulation) {
      const admission = await fetch(new URL('/local/admin/admission', origins.simulation), {
        method: 'POST',
        headers: { Authorization: `Bearer ${secrets.simulation}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(admissionFixture)
      });
      if (!admission.ok) throw new Error(`Demo admission fixture failed: HTTP ${admission.status}`);
    }
    let governorNative: string | undefined;
    if (freshAuthority) {
      for (const name of ['player', 'player-2', 'governor']) {
        const playerId = authority.ids.players[name]!;
        const nativeToken = await authority.home.issueNativeToken(playerId);
        if (name === 'governor') governorNative = nativeToken;
        for (const territory of [policy, simulation]) {
          await authority.home.requestDigest(playerId, { id: territory.ids.actor, inbox: territory.host.actor('territory').inbox });
        }
      }
      await authority.home.requestDigest(authority.ids.players.governor!, { id: authority.ids.actor.registry, inbox: authority.authority.actor('registry').inbox as string });
    }
    for (let round = 0; round < 3; round += 1) {
      await authority.authority.server.processOutbox();
      await authority.authority.server.processInbox();
      await policy.host.server.processInbox();
      await simulation.host.server.processInbox();
    }
    if (governorNative !== undefined) {
      for (const authorityId of [authority.ids.actor.home, authority.ids.actor.registry, policy.ids.actor, simulation.ids.actor]) {
        const claimed = await fetch(new URL('/local/home/administration', origins.authority), {
          method: 'POST',
          headers: { Authorization: `Bearer ${governorNative}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ authorityId })
        });
        if (!claimed.ok) throw new Error(`Demo administration claim failed: HTTP ${claimed.status}`);
      }
    }
    application = await createClientApplication({
      storeFile: resolve(dataDir, 'client.store.json'),
      seedServers: [origins.authority, origins.policy, origins.simulation]
    });
    clientServer = await startClientServer({ port: ports.client, application });
    authority.authority.startWorkers();
    policy.host.startWorkers();
    simulation.host.startWorkers();
    return { ports, origins: { ...origins, client: clientServer.origin }, authority, policy, simulation, application, close };
  } catch (error) {
    await close();
    throw error;
  }
}
