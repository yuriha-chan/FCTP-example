import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDiscovery, formatPolicyState, formatRegistryState, formatResource, formatVerification } from '../apps/client/src/presentation.js';

test('verification reports cryptography, attribution, issuer and binding independently', () => {
  const passed = formatVerification({
    proofCryptography: 'verified', keyAttribution: 'attributed', expectedIssuer: 'verified',
    binding: { bound: true }
  });
  assert.match(passed, /Signature: verified/);
  assert.match(passed, /Signer: recognized/);
  assert.match(passed, /Expected issuer: matches/);
  assert.match(passed, /Entry request binding: bound/);

  const failed = formatVerification({ proofCryptography: 'failed', keyAttribution: 'not attributed: key controller mismatch', expectedIssuer: 'failed', binding: { bound: false } });
  assert.match(failed, /Signature: failed/);
  assert.match(failed, /Signer: not recognized/);
  assert.match(failed, /Expected issuer: does not match/);
  const unknown = formatVerification({ proofCryptography: 'failed', keyAttribution: 'not attributed: unknown', expectedIssuer: { status: 'unknown', reason: 'missing destination' }, binding: { bound: false } });
  assert.match(unknown, /Signer: unknown/);
  assert.match(unknown, /Expected issuer: not established/);
});

test('B discovery displays facilities, queued jobs, visit cargo and viewer scope', () => {
  const text = formatDiscovery({ kind: 'simulation', state: {
    tick: 8,
    sharedStock: { raw: [{ commodity: 'https://goods.test/ore', count: 3 }], products: [] },
    facilities: { mining: { enabled: true, capacity: 4 }, manufacturing: { slots: 2, time: 3 }, port: { capacity: 10, berths: 1 } },
    visit: { entryRequest: 'request:one', status: 'berthed', cargo: [{ commodity: 'https://goods.test/ore', count: 2 }], handling: [] },
    queuedProduction: [{ kind: 'manufacture', output: 'https://goods.test/metal', count: 2, remainingTicks: 1 }]
  }, vessel: 'vessel:one' });
  assert.match(text, /Facilities: mining enabled \(capacity 4\)/);
  assert.match(text, /2 × metal/);
  assert.match(text, /Production in progress: manufacture/);
  assert.match(text, /Current local visit: berthed/);
  assert.match(text, /2 × ore/);
});

test('administrator view reports actual visits and scoped A view reports its local visit', () => {
  const visits = {
    one: { request: { id: 'entry:one', vessel: { id: 'vessel:one' } }, status: 'berthed', port: 'https://port.test/one' },
    two: { request: { id: 'entry:two', vessel: { id: 'vessel:two' } }, status: 'departed', port: 'https://port.test/two' }
  };
  const admin = formatPolicyState({ state: { policy: {}, visits } });
  assert.match(admin, /Local visits recorded: 2/);
  assert.match(admin, /entry:one/);
  assert.match(admin, /entry:two/);
  const scoped = formatPolicyState({ policy: {}, visit: { entryRequest: 'entry:scoped', status: 'berthed', cargo: { entries: [{ variety: 'https://goods.test/ore', count: 2, data: { grade: 'high' } }] } } }, 'vessel:one');
  assert.match(scoped, /entry:scoped/);
  assert.match(scoped, /grade: high/);
  assert.doesNotMatch(formatPolicyState({ state: { policy: {} }, vessel: 'vessel:one' }), /empty harbour|no visits/i);
});

test('A full state enumerates visits at the top level for administrators', () => {
  const text = formatPolicyState({ state: { policy: {} }, visits: {
    first: { vessel: 'vessel:one', entryRequest: 'entry:one', port: 'https://port.test/one' },
    second: { vessel: 'vessel:two', entryRequest: 'entry:two', departed: true, port: 'https://port.test/two' }
  } });
  assert.match(text, /Local visits recorded: 2/);
  assert.match(text, /entry:one/);
  assert.match(text, /Current local visit: departed/);
  assert.match(text, /entry:two/);
});

test('B full state selects the latest scoped visit and joins real simulation vessel and handling data', () => {
  const text = formatDiscovery({ kind: 'simulation', state: {
    simulation: {
      vessels: [
        { id: 'vessel:one#entry%3Aold', status: 'berthed', cargo: [{ commodity: 'https://goods.test/stale', count: 1 }] },
        { id: 'vessel:one#entry%3Acurrent', status: 'berthed', cargo: [{ commodity: 'https://goods.test/item', quantityKind: 'Item', id: 'https://items.test/unique', data: { grade: 'rare' } }] }
      ],
      handlingJobs: [{ vessel: 'vessel:one#entry%3Acurrent', operation: 'load', cargo: [{ commodity: 'https://goods.test/handled', count: 2 }], remainingTicks: 3 }]
    },
    visits: {
      old: { vessel: 'vessel:one', request: { id: 'entry:old', vessel: { id: 'vessel:one' } }, simulationVessel: 'vessel:one#entry%3Aold', exited: true },
      current: { vessel: 'vessel:one', request: { id: 'entry:current', vessel: { id: 'vessel:one' } }, simulationVessel: 'vessel:one#entry%3Acurrent', exited: false }
    }
  }, vessel: 'vessel:one' });
  assert.match(text, /Entry request: entry:current/);
  assert.match(text, /Current local visit: berthed/);
  assert.match(text, /1 × item \(item unique\) \[grade: rare\]/);
  assert.match(text, /Cargo handling: load 2 × handled \(3 ticks left\)/);
  assert.match(text, /Handling in progress: load 2 × handled \(3 ticks left\)/);
  assert.doesNotMatch(text, /entry:old|stale/);
});

test('Registry discovery count, location, adoption, and vessel details are readable', () => {
  const text = formatRegistryState({
    vessel: { id: 'https://fleet.test/vessels/one', name: 'One', possessor: 'https://players.test/p' },
    cargo: { entries: [{ variety: 'https://goods.test/ore', id: 'https://items.test/a', count: 2, data: { grade: 'high' } }, { variety: 'https://goods.test/ore', id: 'https://items.test/b', count: 3, data: { grade: 'low' } }] },
    adoption: true, location: { status: 'berthed', territory: 'https://territory.test/a', port: 'https://port.test/a' },
    pendingRequests: [{ id: 'one' }, { id: 'two' }]
  });
  assert.match(text, /One/);
  assert.match(text, /adopted/);
  assert.match(text, /Pending Registry requests: 2/);
  assert.match(text, /item a.*grade: high.*item b.*grade: low/);
  assert.doesNotMatch(text, /https:\/\//);
  const fleet = formatResource({
    'https://fleet.test/vessels/one': { vessel: { id: 'https://fleet.test/vessels/one', name: 'One' }, cargo: { entries: [] }, adoption: false, location: { status: 'no-recorded-active-berth' } },
    'https://fleet.test/vessels/two': { vessel: { id: 'https://fleet.test/vessels/two', name: 'Two' }, cargo: { entries: [] }, adoption: true, location: { status: 'berthed' } }
  });
  assert.match(fleet, /Fleet: 2 vessels/);
  assert.match(fleet, /One[\s\S]*Two/);
  assert.match(fleet, /Territory notifications: adopted/);
});

test('Production declarations retain ingredients, tools, locations, duration, yields, and distinct entries', () => {
  const text = formatResource({
    type: 'Variety', production: [
      { type: 'manufacture', ingredients: [{ variety: 'https://goods.test/ore', count: 3, data: { grade: 'high' } }], tool: 'https://tools.test/press', duration: 4, location: [{ id: 'https://places.test/foundry', name: 'Foundry', territory: 'https://territories.test/one' }], yield: [{ probability: 0.5, count: 2, data: { purity: 9 } }], extension: 'retained' },
      { type: 'mine', ingredients: [], duration: 1, location: { id: 'https://places.test/mine', name: 'Mine', territory: 'https://territories.test/two' }, yield: [{ probability: 1, count: 1 }] }
    ]
  });
  assert.match(text, /3 × ore \[grade: high\]/);
  assert.match(text, /tool press/);
  assert.match(text, /duration 4/);
  assert.match(text, /location foundry \/ Foundry \/ one/);
  assert.match(text, /yield 0.5 chance of 2 with \{"purity":9\}/);
  assert.match(text, /extension: retained/);
  assert.match(text, /mine; ingredients none; duration 1; location mine \/ Mine \/ two/);
  assert.doesNotMatch(text, /https:\/\//);
});

test('Item quantities without count mean one and malformed URI escapes remain displayable', () => {
  assert.match(formatResource({ id: 'https://example.test/%E0%A4%A', name: 'Safe' }), /Name: Safe/);
  assert.doesNotMatch(formatResource({ id: 'https://example.test/%E0%A4%A', name: 'Safe' }), /https:\/\//);
  assert.match(formatPolicyState({ policy: {}, visit: { vessel: 'vessel:one', cargo: [{ variety: 'https://goods.test/%E0%A4%A', id: 'https://items.test/one' }] } }, 'vessel:one'), /1 × %E0%A4%A \(item one\)/);
});
