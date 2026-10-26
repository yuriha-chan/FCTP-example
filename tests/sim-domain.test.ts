import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceTick,
  admitVessel,
  configureManufacturing,
  configureMining,
  configurePort,
  createSimulationState,
  departVessel,
  scheduleHandling,
  startManufacturing,
  startMining,
  type SimulationConfig,
} from '../apps/territory-sim/src/domain.js';

const config = (): SimulationConfig => ({
  commodities: { ore: 'urn:commodity:ore', nativeMetal: 'urn:commodity:metal', importedMetal: 'urn:commodity:imported-metal', refinedProduct: 'urn:commodity:refined' },
  commodityMasses: { 'urn:commodity:ore': 1, 'urn:commodity:metal': 1, 'urn:commodity:imported-metal': 1, 'urn:commodity:refined': 1 },
  depositAmount: 12,
  miningCapacity: 4,
  miningEnabled: true,
  manufacturingSlots: 1,
  manufacturingTime: 2,
  portCapacity: 20,
  berthCapacity: 2,
});

test('native mining and manufacture reserve inputs and publish only completed output', () => {
  const state = createSimulationState(config());
  startMining(state, 3);
  assert.equal(state.depositRemaining, 9);
  assert.equal(state.rawStock.length, 0);
  advanceTick(state);
  assert.deepEqual(state.rawStock, [{ commodity: config().commodities.ore, count: 3, quantityKind: 'Stack', data: {} }]);

  configureManufacturing(state, 2, 2);
  startManufacturing(state, 'native', 2);
  assert.deepEqual(state.rawStock, [{ commodity: config().commodities.ore, count: 1, quantityKind: 'Stack', data: {} }]);
  assert.throws(() => startManufacturing(state, 'native', 2), /insufficient stock/);
  assert.equal(advanceTick(state).length, 0);
  const finished = advanceTick(state);
  assert.deepEqual(finished, [{ type: 'production', tick: 3, kind: 'manufacture', output: config().commodities.nativeMetal, count: 2 }]);
  assert.deepEqual(state.productStock, [{ commodity: config().commodities.nativeMetal, count: 2, quantityKind: 'Stack', data: {} }]);
});

test('facility enabled state, capacity, slots, and configured duration constrain starts and completion', () => {
  const state = createSimulationState(config());
  configureMining(state, false, 2);
  assert.throws(() => startMining(state, 1), /disabled/);
  configureMining(state, true, 2);
  assert.throws(() => startMining(state, 3), /capacity/);
  startMining(state, 2, 2);
  assert.equal(advanceTick(state).length, 0);
  assert.equal(state.rawStock.length, 0);
  assert.equal(advanceTick(state)[0]?.type, 'production');

  startManufacturing(state, 'native', 1);
  assert.throws(() => startManufacturing(state, 'native', 1), /slots are full/);
  assert.equal(advanceTick(state).length, 0);
  assert.equal(advanceTick(state)[0]?.type, 'production');
  configureManufacturing(state, 2, 1);
  startManufacturing(state, 'native', 1);
  assert.equal(advanceTick(state)[0]?.type, 'production');
  assert.deepEqual(state.productStock, [{ commodity: config().commodities.nativeMetal, count: 2, quantityKind: 'Stack', data: {} }]);
});

test('timed load/unload reserve stock, vessel space, port space and conserve cargo', () => {
  const state = createSimulationState(config());
  startMining(state, 3);
  advanceTick(state);
  startManufacturing(state, 'native', 3);
  advanceTick(state);
  advanceTick(state);
  admitVessel(state, 'vessel-1', 5);
  assert.deepEqual(advanceTick(state), [{ type: 'berthing', tick: 4, vessel: 'vessel-1' }]);
  scheduleHandling(state, 'vessel-1', 'load', [{ commodity: config().commodities.nativeMetal, count: 2 }], 2);
  assert.throws(() => scheduleHandling(state, 'vessel-1', 'load', [{ commodity: config().commodities.nativeMetal, count: 2 }], 1), /unreserved product stock/);
  assert.throws(() => departVessel(state, 'vessel-1'), /pending cargo handling/);
  assert.deepEqual(advanceTick(state), []);
  const loaded = advanceTick(state);
  assert.deepEqual(loaded, [{
    type: 'cargo-operation', tick: 6, vessel: 'vessel-1', operation: 'load',
    cargo: { entries: [{ variety: config().commodities.nativeMetal, count: 2, data: {} }] },
  }]);
  assert.deepEqual(state.productStock, [{ commodity: config().commodities.nativeMetal, count: 1, quantityKind: 'Stack', data: {} }]);
  assert.deepEqual(state.vessels[0]?.cargo, [{ commodity: config().commodities.nativeMetal, count: 2, quantityKind: 'Stack', data: {} }]);

  scheduleHandling(state, 'vessel-1', 'unload', [{ commodity: config().commodities.nativeMetal, count: 2 }], 1);
  assert.throws(() => scheduleHandling(state, 'vessel-1', 'unload', [{ commodity: config().commodities.nativeMetal, count: 1 }], 1), /unreserved vessel cargo/);
  const unloaded = advanceTick(state);
  assert.deepEqual(unloaded[0], {
    type: 'cargo-operation', tick: 7, vessel: 'vessel-1', operation: 'unload',
    cargo: { entries: [{ variety: config().commodities.nativeMetal, count: 2, data: {} }] },
  });
  assert.deepEqual(state.rawStock, [{ commodity: config().commodities.nativeMetal, count: 2, quantityKind: 'Stack', data: {} }]);
  assert.deepEqual(state.vessels[0]?.cargo, []);
  departVessel(state, 'vessel-1');
});

test('imported metal unloads into raw inventory and can be reprocessed', () => {
  const state = createSimulationState(config());
  admitVessel(state, 'importer', 4, { entries: [{ variety: config().commodities.importedMetal, count: 2, data: {} }] });
  advanceTick(state);
  scheduleHandling(state, 'importer', 'unload', [{ commodity: config().commodities.importedMetal, count: 2 }], 1);
  advanceTick(state);
  assert.deepEqual(state.rawStock, [{ commodity: config().commodities.importedMetal, count: 2, quantityKind: 'Stack', data: {} }]);
  startManufacturing(state, 'imported', 2);
  assert.deepEqual(state.rawStock, []);
  advanceTick(state);
  assert.deepEqual(state.productStock, []);
  advanceTick(state);
  assert.deepEqual(state.productStock, [{ commodity: config().commodities.refinedProduct, count: 2, quantityKind: 'Stack', data: {} }]);
});

test('load reservations are global across vessels and cannot reuse stock', () => {
  const state = createSimulationState(config());
  startMining(state, 2);
  assert.throws(() => configurePort(state, 1, 2), /occupied and reserved/);
  advanceTick(state);
  startManufacturing(state, 'native', 2);
  advanceTick(state);
  advanceTick(state);
  admitVessel(state, 'first', 3);
  admitVessel(state, 'second', 3);
  advanceTick(state);
  assert.throws(() => scheduleHandling(state, 'first', 'load', [
    { commodity: config().commodities.nativeMetal, count: 1 },
    { commodity: config().commodities.nativeMetal, count: 2 },
  ], 2), /unreserved product stock/);
  scheduleHandling(state, 'first', 'load', [{ commodity: config().commodities.nativeMetal, count: 2 }], 2);
  assert.throws(() => scheduleHandling(state, 'second', 'load', [{ commodity: config().commodities.nativeMetal, count: 1 }], 1), /unreserved product stock/);
});

test('vessel capacity uses mass and admission preserves Items and Stack data', () => {
  const options = config();
  options.commodityMasses[options.commodities.ore] = 3;
  const state = createSimulationState(options);
  const cargo = { entries: [
    { id: 'urn:item:unique', variety: options.commodities.ore, data: { grade: 'A' } },
    { variety: options.commodities.ore, count: 2, data: { grade: 'B' } },
  ] };
  assert.throws(() => admitVessel(state, 'too-small', 8, cargo), /vessel capacity/);
  admitVessel(state, 'faithful', 9, cargo);
  assert.deepEqual(state.vessels[0]?.cargo, [
    { commodity: options.commodities.ore, count: 1, quantityKind: 'Item', id: 'urn:item:unique', data: { grade: 'A' } },
    { commodity: options.commodities.ore, count: 2, quantityKind: 'Stack', data: { grade: 'B' } },
  ]);
  assert.throws(() => createSimulationState({ ...options, commodityMasses: { ...options.commodityMasses, [options.commodities.ore]: 0 } }), /positive finite mass/);
});

test('warehouse slots reserve pending output and unload capacity', () => {
  const options = config();
  options.portCapacity = 2;
  const state = createSimulationState(options);
  assert.throws(() => startMining(state, 3), /port capacity/);
  startMining(state, 2);
  advanceTick(state);
  admitVessel(state, 'incoming', 2, { entries: [{ variety: options.commodities.ore, count: 2, data: {} }] });
  advanceTick(state);
  assert.throws(() => scheduleHandling(state, 'incoming', 'unload', [{ commodity: options.commodities.ore, count: 1 }], 1), /port capacity/);
});

test('manufacturing rejects Item and nonempty-data ingredients without consuming cargo', () => {
  const options = config();
  const state = createSimulationState(options);
  admitVessel(state, 'ingredient', 2, { entries: [{ id: 'urn:item:ore', variety: options.commodities.ore, data: {} }] });
  advanceTick(state);
  scheduleHandling(state, 'ingredient', 'unload', [{ commodity: options.commodities.ore, count: 1, quantityKind: 'Item', id: 'urn:item:ore', data: {} }], 1);
  const effects = advanceTick(state);
  assert.throws(() => startManufacturing(state, 'native', 1), /only supports homogeneous/);
  assert.equal(state.rawStock[0]?.id, 'urn:item:ore');
  assert.deepEqual(effects[0]?.cargo, { entries: [{ id: 'urn:item:ore', variety: options.commodities.ore, data: {} }] });
  scheduleHandling(state, 'ingredient', 'load', [{ commodity: options.commodities.ore, count: 1, quantityKind: 'Item', id: 'urn:item:ore', data: {} }], 1);
  const loaded = advanceTick(state);
  assert.deepEqual(loaded[0]?.cargo, { entries: [{ id: 'urn:item:ore', variety: options.commodities.ore, data: {} }] });
  assert.deepEqual(state.vessels[0]?.cargo, [{ commodity: options.commodities.ore, count: 1, quantityKind: 'Item', id: 'urn:item:ore', data: {} }]);
});
