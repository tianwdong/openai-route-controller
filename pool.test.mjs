import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordPoolExhaustion, observePoolRecovery, poolRecoveryBatch, nodeRegion, diverseStandbys,
  newWatchdogState, normalizeState, recoveryBackoffDelayForReason,
} from './lib.mjs';

test('subscription labels support Chinese, flags, English and old names', () => {
  for (const [name, region] of [
    ['🇨🇳 台湾 04 [Home] | 2x Trojan', 'TW'], ['🇯🇵 日本 01', 'JP'],
    ['🇰🇷 韩国 Trojan', 'KR'], ['新加坡 02', 'SG'], ['美國 01', 'US'],
    ['🇹🇼 01', 'TW'], ['Japan 01', 'JP'], ['JP3-HY2', 'JP'],
    ['US-1TCP', 'US'], ['fast JP-2', 'JP'], ['business', 'OTHER'],
  ]) assert.equal(nodeRegion(name), region, name);
});

test('standby diversity preserves first ranked and fills from qualified alternatives', () => {
  const nodes = ['🇨🇳 台湾 01', '🇨🇳 台湾 02', '🇯🇵 日本 01', '🇨🇳 台湾 01 Trojan'];
  assert.deepEqual(diverseStandbys(nodes, 2), [nodes[0], nodes[2]]);
  assert.deepEqual(diverseStandbys([nodes[0], nodes[1], nodes[3]], 2), [nodes[0], nodes[3]]);
  assert.deepEqual(diverseStandbys(nodes.slice(0, 2), 2), nodes.slice(0, 2));
  assert.deepEqual(diverseStandbys(nodes, 0), []);
});

test('pool outage requires broad exhaustion; persists across bounded retries', () => {
  const initial = { current: 'A' };
  assert.equal(recordPoolExhaustion(initial, 2, 45, 1000), initial);
  const failed = recordPoolExhaustion(initial, 39, 45, 1000);
  assert.equal(failed.poolOutage.rounds, 1);
  assert.equal(recordPoolExhaustion(failed, 6, 45, 2000).poolOutage.rounds, 2);
});

test('all candidates remain reachable through bounded rotating batches', () => {
  const candidates = Array.from({ length: 45 }, (_, i) => `node-${i}`);
  const visited = new Set();
  for (let cursor = 0; cursor < 48; cursor += 6) {
    const batch = poolRecoveryBatch(candidates, { cursor });
    assert.equal(batch.length, 6);
    batch.forEach(n => visited.add(n));
  }
  assert.equal(visited.size, 45);
});

test('recovery requires four successes spanning 90 seconds on the same node', () => {
  let state = recordPoolExhaustion({ current: 'A' }, 40, 45, 1000);
  for (const t of [2000, 32000, 62000]) state = observePoolRecovery(state, { ok: true }, t);
  assert.ok(state.poolOutage);
  assert.equal(observePoolRecovery(state, { ok: true }, 92000).poolOutage, null);
  assert.ok(observePoolRecovery({ ...state, current: 'B' }, { ok: true }, 92000).poolOutage);
  const failed = observePoolRecovery(state, { ok: false }, 70000);
  assert.equal(observePoolRecovery(failed, { ok: true }, 92000).poolOutage.passes, 1);
  assert.equal(observePoolRecovery(state, { ok: true }, 200000).poolOutage.passes, 1);
});

test('small pools can enter outage mode after exhausting all alternatives', () => {
  assert.ok(recordPoolExhaustion({ current: 'A' }, 1, 1, 1000).poolOutage);
  assert.ok(recordPoolExhaustion({ current: 'A' }, 2, 2, 1000).poolOutage);
  assert.equal(recordPoolExhaustion({ current: 'A' }, 0, 0, 1000).poolOutage, undefined);
});

function recoveringPool() {
  let state = recordPoolExhaustion({ current: 'A', currentSelectedAt: 1000 }, 40, 45, 1000);
  for (const at of [2000, 32000, 62000]) state = observePoolRecovery(state, { ok: true }, at);
  return state;
}

test('unresolved business faults reset recovery observation despite a successful path probe', () => {
  const state = observePoolRecovery(recoveringPool(), { ok: true }, 92000, { blocked: true });
  assert.ok(state.poolOutage);
  assert.equal(state.poolOutage.passes, 0);
  assert.equal(observePoolRecovery(state, { ok: true }, 95000).poolOutage.passes, 1);
});

test('switching away and back cannot combine different selection tenures', () => {
  const state = { ...recoveringPool(), currentSelectedAt: 90000 };
  const after = observePoolRecovery(state, { ok: true }, 92000);
  assert.equal(after.poolOutage.passes, 1);
  assert.equal(after.poolOutage.stableSince, 92000);
});

test('duplicate and backwards timestamps cannot accumulate a stable recovery', () => {
  const state = recoveringPool();
  assert.equal(observePoolRecovery(state, { ok: true }, 62000).poolOutage.passes, 3);
  assert.equal(observePoolRecovery(state, { ok: true }, 61000).poolOutage.passes, 1);
});

test('loading pool state preserves retry metadata but restarts stability observation', () => {
  const saved = { ...newWatchdogState(), ...recoveringPool() };
  const after = normalizeState(JSON.parse(JSON.stringify(saved)));
  assert.equal(after.poolOutage.rounds, 1);
  assert.equal(after.poolOutage.passes, 0);
  const malformed = normalizeState({ ...saved, poolOutage: { cursor: -2, rounds: 'bad' } });
  assert.equal(malformed.poolOutage.cursor, 0);
  assert.equal(malformed.poolOutage.rounds, 1);
  assert.equal(normalizeState({ ...saved, poolOutage: 'bad' }).poolOutage, null);
});

test('pool batches tolerate missing or corrupt cursors without losing nodes', () => {
  const candidates = ['A', 'B', 'C', 'D'];
  for (const cursor of [undefined, -1, NaN, Infinity]) {
    assert.deepEqual(poolRecoveryBatch(candidates, { cursor }, 2), ['A', 'B']);
  }
  assert.deepEqual(poolRecoveryBatch([], { cursor: 1 }), []);
  assert.deepEqual(poolRecoveryBatch(candidates, { cursor: 0 }, 0), []);
});

test('pool backoff retains the critical and active-traffic retry ceiling', () => {
  for (const reason of ['passive_transport_errors', 'provider_health_unavailable', 'hard_current_probe_failures']) {
    assert.ok(recoveryBackoffDelayForReason(6, reason, { poolOutageRounds: 6 }) <= 60000, reason);
  }
  assert.equal(recoveryBackoffDelayForReason(6, 'intermittent_path_failures', {
    poolOutageRounds: 6, activeTraffic: true,
  }), 60000);
  assert.equal(recoveryBackoffDelayForReason(6, 'provider_health_unavailable', {
    poolOutageRounds: 6,
  }), 30000);
  assert.equal(recoveryBackoffDelayForReason(0, 'intermittent_path_failures', {
    poolOutageRounds: 4,
  }), 120000);
});
