import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changePolicy,
  createTerritoryState,
  loadCargo,
  manufacture,
  mineOre,
  prepareVessel,
  territoryAProduction,
  unloadCargo,
  transferWarehouseToPort
} from '../apps/territory-policy/src/domain.js';
import type { Policy } from '../apps/territory-policy/src/domain.js';

const ore = territoryAProduction.ore.id;
const metal = territoryAProduction.metal.id;
const policy: Policy = {
  miningPermitted: true,
  miningQuota: 8,
  oreReserve: 8,
  manufacturePermits: ['ore-to-metal'],
  recipes: territoryAProduction.recipes,
  warehouseLimits: { [ore]: 20, [metal]: 10 },
  portLimits: { [ore]: 20, [metal]: 10 },
  decisions: { entry: 'allow' }
};
const initial = () => createTerritoryState(policy, [
  { variety: territoryAProduction.ore, mass: 2 },
  { variety: territoryAProduction.metal, mass: 1 }
]);

function succeed(result: ReturnType<typeof mineOre>) {
  assert.equal(result.success, true);
  return result.state;
}

test('mining, manufacture, port transfer, loading and unloading conserve local quantities', () => {
  let state = succeed(mineOre(initial(), ore, 4));
  assert.deepEqual(state.productionReservations, {});
  state = succeed(manufacture(state, 'ore-to-metal', 2));
  assert.equal(state.rawInventory[ore], 0);
  assert.equal(state.rawInventory[metal], 2);
  state = succeed(transferWarehouseToPort(state, metal, 2));
  state = succeed(prepareVessel(state, 'vessel-1', 3));
  state = succeed(loadCargo(state, 'vessel-1', metal, 2));
  assert.equal(state.portInventory[metal], 0);
  assert.equal(state.vessels['vessel-1']?.manifest.entries[0]?.count, 2);
  state = succeed(unloadCargo(state, 'vessel-1', metal, 1));
  assert.equal(state.portInventory[metal], 1);
  assert.equal(state.vessels['vessel-1']?.manifest.entries[0]?.count, 1);
});

test('policy decisions, limits, quotas, reserves and insufficiency reject without partial inventory changes', () => {
  const starting = initial();
  const denied = changePolicy(starting, { ...policy, miningPermitted: false }, 'admin:alice');
  assert.equal(denied.success, true);
  assert.equal(denied.state.audit.at(-1)?.actor, 'admin:alice');
  const blockedMine = mineOre(denied.state, ore, 1);
  assert.equal(blockedMine.success, false);
  assert.equal(blockedMine.state.rawInventory[ore], undefined);

  const mined = succeed(mineOre(starting, ore, 4));
  const noPermit = changePolicy(mined, { ...policy, manufacturePermits: [] }, 'admin:bob');
  assert.equal(manufacture(noPermit.state, 'ore-to-metal', 1).success, false);
  const shortage = manufacture(mined, 'ore-to-metal', 3);
  assert.equal(shortage.success, false);
  assert.equal(shortage.state.rawInventory[ore], 4);
  assert.equal(mineOre(mined, ore, 5).success, false);
  assert.equal(mineOre(initial(), ore, 9).success, false);

  const capped = changePolicy(mined, { ...policy, portLimits: { [metal]: 0 } }, 'admin:carol');
  const metalState = succeed(manufacture(capped.state, 'ore-to-metal', 1));
  const portFail = transferWarehouseToPort(metalState, metal, 1);
  assert.equal(portFail.success, false);
  assert.equal(portFail.state.rawInventory[metal], 1);
  assert.equal(portFail.state.portInventory[metal], undefined);
});

test('cargo operations reject insufficient stock and capacity without moving quantities', () => {
  let state = succeed(prepareVessel(initial(), 'small', 0));
  const insufficient = loadCargo(state, 'small', metal, 1);
  assert.equal(insufficient.success, false);
  state = succeed(mineOre(state, ore, 2));
  state = succeed(prepareVessel(state, 'hauler', 2));
  const tooHeavy = loadCargo(state, 'hauler', ore, 2);
  assert.equal(tooHeavy.success, false);
  assert.equal(tooHeavy.state.portInventory[ore], undefined);
  const unladen = unloadCargo(state, 'hauler', ore, 1);
  assert.equal(unladen.success, false);
});

test('cargo preserves Items and nonempty Stack data and bulk unload cannot consume either', () => {
  const item = { id: 'https://fctp.example/item/one', variety: metal, data: { serial: 'one' }, extension: 'preserved' };
  const stack = { variety: metal, count: 2, data: { grade: 'special' }, extension: 'preserved' };
  const admitted = prepareVessel(initial(), 'incoming', 10, { entries: [item, stack] });
  assert.equal(admitted.success, true);
  if (!admitted.success) return;
  assert.deepEqual(admitted.state.vessels.incoming?.manifest.entries, [item, stack]);

  const unsupported = unloadCargo(admitted.state, 'incoming', metal, 1);
  assert.equal(unsupported.success, false);
  assert.deepEqual(unsupported.state.vessels.incoming?.manifest.entries, [item, stack]);
  assert.equal(unsupported.state.portInventory[metal], undefined);

  const stocked = succeed(mineOre(admitted.state, ore, 1));
  const ported = succeed(transferWarehouseToPort(stocked, ore, 1));
  const loaded = loadCargo(ported, 'incoming', ore, 1);
  assert.equal(loaded.success, true);
  if (loaded.success) assert.deepEqual(loaded.state.vessels.incoming?.manifest.entries, [item, stack, { variety: ore, count: 1, data: {} }]);
});

test('admission validates cargo and rejects duplicate Item IDs; mining requires configured mine production', () => {
  const invalid = prepareVessel(initial(), 'invalid', 100, { entries: [{ variety: metal, count: -1, data: {} }] });
  assert.equal(invalid.success, false);
  const duplicate = { id: 'https://fctp.example/item/same', variety: metal, data: {} };
  const duplicateIds = prepareVessel(initial(), 'duplicate', 100, { entries: [duplicate, duplicate] });
  assert.equal(duplicateIds.success, false);
  const before = initial();
  const minedManufacture = mineOre(before, metal, 1);
  assert.equal(minedManufacture.success, false);
  assert.deepEqual(minedManufacture.state.rawInventory, before.rawInventory);
});
