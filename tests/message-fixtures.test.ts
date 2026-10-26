import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseActivity } from '@fctp/federation';
import { createLocalDocumentLoader, verifyProofCryptography, withDocuments } from '@fctp/identity';
import { validateModel } from '@fctp/protocol';

const fixtureUrl = (name: string): URL => new URL(`./fixtures/messages/${name}.json`, import.meta.url);
const fixture = async (name: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(fixtureUrl(name), 'utf8')) as Record<string, unknown>;
const modelNames = ['EntryRequest', 'EntryRejected', 'BerthingEvent', 'CargoOperationEvent', 'DepartureRequest', 'DepartureEvent', 'VoyageEvent', 'ExitEvent', 'TokenDigest', 'TokenRevoke', 'RouteRequest', 'RouteRequestApproval', 'RouteRequestDenial', 'Variety', 'CargoManifest'] as const;

test('golden message and production fixtures satisfy their runtime contracts and preserve extensions', async () => {
  for (const model of modelNames) {
    const value = await fixture(model);
    const result = validateModel(value, model);
    assert.equal(result.success, true, `${model}: ${JSON.stringify(result.success ? [] : result.issues)}`);
    assert.deepEqual(result.success && result.data, value);
  }
  const entry = await fixture('EntryRequest');
  assert.deepEqual(entry.extension, { retained: true });
  const variety = await fixture('Variety');
  assert.deepEqual(variety.extension, { publisherNote: 'example' });
});

test('invalid fixtures fail for model-specific structure and proof verification reasons', async () => {
  const invalid = await fixture('invalid');
  for (const model of modelNames) {
    if (model === 'ExitEvent') continue;
    const value = invalid[model] as Record<string, unknown>;
    const result = validateModel(value, model);
    assert.equal(result.success, false, `${model} unexpectedly validated`);
    assert.ok(result.issues.some((issue) => ['/id', '/cargo', '/proof', '/revision', '/entries'].includes(issue.path)), model);
  }
  const publicKey = await fixture('territory-public-key');
  const keyId = String(publicKey.id);
  const loader = withDocuments(createLocalDocumentLoader(), new Map([[keyId, publicKey]]));
  assert.equal(validateModel(invalid.ExitEvent, 'ExitEvent').success, true);
  assert.equal((await verifyProofCryptography(invalid.ExitEvent as Record<string, unknown>, loader)).verified, false);
});

test('signed ExitEvent and its Create envelope validate and verify independently after JSON roundtrip', async () => {
  const publicKey = await fixture('territory-public-key');
  const loader = withDocuments(createLocalDocumentLoader(), new Map([[String(publicKey.id), publicKey]]));
  const exit = JSON.parse(JSON.stringify(await fixture('ExitEvent'))) as Record<string, unknown>;
  const envelope = JSON.parse(JSON.stringify(await fixture('CreateEnvelope'))) as Record<string, unknown>;
  assert.equal(validateModel(exit, 'ExitEvent').success, true);
  assert.deepEqual(await verifyProofCryptography(exit, loader), { verified: true });
  assert.deepEqual(await verifyProofCryptography(envelope, loader), { verified: true });
  const parsed = parseActivity(envelope);
  assert.equal(parsed.objectId, exit.id);
  assert.deepEqual(await verifyProofCryptography(parsed.object as Record<string, unknown>, loader), { verified: true });
  const alteredEnvelope = structuredClone(envelope);
  alteredEnvelope.published = '2026-10-26T10:00:01Z';
  assert.equal((await verifyProofCryptography(alteredEnvelope, loader)).verified, false);
});
