import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { createActivity } from '../packages/federation/dist/index.js';
import { createLocalDocumentLoader, generateActorKey, signJsonLd, withDocuments } from '../packages/identity/dist/index.js';

const directory = new URL('../tests/fixtures/messages/', import.meta.url);
const territory = 'https://fctp.example/actors/territory-blue';
const registry = 'https://fctp.example/actors/registry-main';
const vessel = 'https://fctp.example/vessels/ship-1';
const port = 'https://fctp.example/ports/harbor-1';
const route = 'https://fctp.example/routes/blue-red';
const entryId = 'https://fctp.example/requests/entry-1';
const time = '2026-10-26T10:00:00Z';
const cargo = { entries: [{ variety: 'https://fctp.example/varieties/ore', count: 4, data: { assay: { purity: 0.97 } } }] };
const base = { vessel, territory, port };
const models = {
  EntryRequest: { id: entryId, type: 'EntryRequest', vessel: { id: vessel, registry, possessor: 'https://fctp.example/actors/player-1', capacity: 100 }, cargo, journey: { events: [] }, destination: { territory, port, route }, extension: { retained: true } },
  EntryRejected: { id: 'https://fctp.example/events/rejected-1', type: 'EntryRejected', request: entryId, territory, reason: 'Route is closed' },
  BerthingEvent: { id: 'https://fctp.example/events/berthing-1', type: 'BerthingEvent', ...base, request: entryId, effectiveAt: time },
  CargoOperationEvent: { id: 'https://fctp.example/events/cargo-1', type: 'CargoOperationEvent', ...base, operation: 'unload', cargo, effectiveAt: time },
  DepartureRequest: { id: 'https://fctp.example/requests/departure-1', type: 'DepartureRequest', ...base, route },
  DepartureEvent: { id: 'https://fctp.example/events/departure-1', type: 'DepartureEvent', ...base, request: 'https://fctp.example/requests/departure-1', effectiveAt: time },
  VoyageEvent: { id: 'https://fctp.example/events/voyage-1', type: 'VoyageEvent', vessel, territory, kind: 'waypoint', details: { sequence: 2 }, effectiveAt: time },
  TokenDigest: { tokenDigest: 'AAECAwQFBgcICQoLDA0ODw==', actor: 'https://fctp.example/actors/player-1', revision: 3 },
  TokenRevoke: { tokenRevoke: 'revoke', actor: 'https://fctp.example/actors/player-1', revision: 4 },
  RouteRequest: { id: 'https://fctp.example/requests/route-1', applyFrom: territory, applyTo: 'https://fctp.example/actors/territory-red', object: { id: route, from: territory, to: 'https://fctp.example/actors/territory-red' } },
  RouteRequestApproval: { id: 'https://fctp.example/events/route-approved-1', request: { id: 'https://fctp.example/requests/route-1', applyFrom: territory, applyTo: 'https://fctp.example/actors/territory-red' }, object: { id: route, from: territory, to: 'https://fctp.example/actors/territory-red' } },
  RouteRequestDenial: { id: 'https://fctp.example/events/route-denied-1', request: 'https://fctp.example/requests/route-1', reason: 'Endpoint declined' },
  Variety: { id: 'https://fctp.example/varieties/ingot', name: 'Refined ingot', holder: territory, mass: 2.5, version: '1', production: [{ type: 'mine', duration: 1, yield: [{ probability: 1, count: 2, data: { grade: 'raw' } }] }, { type: 'manufacture', ingredients: [{ variety: 'https://fctp.example/varieties/ore', count: 3, data: {} }], location: [{ id: 'https://fctp.example/areas/foundry', name: 'Foundry', territory }], tool: 'https://fctp.example/assets/smelter', duration: 5, yield: [{ probability: 1, count: 1, data: { grade: 'refined' } }] }], extension: { publisherNote: 'example' } },
  CargoManifest: cargo
};
const key = await generateActorKey(territory, `${territory}#message-fixture-key`);
const loader = withDocuments(createLocalDocumentLoader(), new Map([[String(key.publicKey.id), key.publicKey]]));
models.RouteRequest = await signJsonLd(models.RouteRequest, key.keyPair, loader);
models.ExitEvent = await signJsonLd({ '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: 'https://fctp.example/events/exit-1', type: 'ExitEvent', vessel, territory, route, entryRequest: entryId, departureEvent: 'https://fctp.example/events/departure-1', cargo, effectiveAt: time }, key.keyPair, loader);
models.CreateEnvelope = await signJsonLd(createActivity({ id: 'https://fctp.example/activities/exit-1', actor: territory, object: models.ExitEvent, to: registry, published: time }), key.keyPair, loader);
await mkdir(directory, { recursive: true });
await writeFile(new URL('territory-public-key.json', directory), `${JSON.stringify(key.publicKey, null, 2)}\n`);
for (const [name, value] of Object.entries(models)) await writeFile(new URL(`${name}.json`, directory), `${JSON.stringify(value, null, 2)}\n`);
const invalid = Object.fromEntries(Object.entries(models).filter(([name]) => !['ExitEvent', 'CreateEnvelope'].includes(name)).map(([name, value]) => [name, { ...value, id: 'not-an-absolute-uri' }]));
invalid.ExitEvent = { ...models.ExitEvent, proof: { ...models.ExitEvent.proof, proofValue: `${models.ExitEvent.proof.proofValue.slice(0, -4)}AAAA` } };
invalid.CreateEnvelope = { ...models.CreateEnvelope, published: 'not-an-instant' };
invalid.EntryRequest = { ...models.EntryRequest, cargo: { entries: [{ variety: 'https://fctp.example/varieties/ore', count: -1, data: {} }] } };
invalid.TokenDigest = { ...models.TokenDigest, revision: -1 };
invalid.TokenRevoke = { ...models.TokenRevoke, revision: -1 };
invalid.CargoManifest = { entries: [{ variety: 'not-a-uri', count: 2, data: {} }] };
await writeFile(new URL('invalid.json', directory), `${JSON.stringify(invalid, null, 2)}\n`);
