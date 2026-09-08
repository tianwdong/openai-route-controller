import test from "node:test";
import assert from "node:assert/strict";
import {
  hasRecentStablePathEvidence,
  newWatchdogState,
  normalizeState,
  pickHotStandbyProbeBatch,
  pickRadarBatch,
  planHotStandbyProbes,
  rankHotStandbys,
  recordHotStandbyProbeAttempts,
  recordNodePathProbe,
  recordNodeProbe,
} from "./lib.mjs";

const now = 1_000_000;
const readyOptions = {
  requiredPasses: 3, probeTtlMs: 45_000, historyWindowMs: 90_000, minSpanMs: 35_000,
};
const fastOptions = {
  requiredPasses: 4, probeTtlMs: 120_000, historyWindowMs: 600_000, minSpanMs: 45_000,
};
const options = { readyOptions, fastOptions };

function fullProbe(state, name, ok, at) {
  const result = { ok, status: ok ? "405/403" : "000", delay: 20 };
  state = recordNodeProbe(state, name, result, at);
  return recordNodePathProbe(state, name, result, at);
}

function explorationFixture() {
  let state = newWatchdogState();
  state.current = "CURRENT";
  state = fullProbe(state, "A-QUALITY", true, now - 1);
  const candidates = ["CURRENT", "A-QUALITY", "B-EXPLORE", "C-EXPLORE"];
  const plan = planHotStandbyProbes(candidates, state, now, options);
  assert.equal(plan.exploration.name, "B-EXPLORE");
  state.hotStandbyExploration = plan.exploration;
  return { state, candidates, plan };
}

test("a short success cannot promote four full-path failures over a better path", () => {
  let state = newWatchdogState();
  for (let index = 0; index < 12; index += 1) {
    state = fullProbe(state, "TW-BETTER", true, now - 300_000 + index * 20_000);
  }
  state = fullProbe(state, "TW-BETTER", false, now - 30_000);
  for (let index = 0; index < 4; index += 1) {
    state = fullProbe(state, "JP-BAD", false, now - 100_000 + index * 20_000);
  }
  const candidates = ["TW-BETTER", "JP-BAD"];
  const before = structuredClone(state.nodes["JP-BAD"].pathEvents);
  assert.deepEqual(pickHotStandbyProbeBatch(candidates, state, now, { limit: 1 }), ["TW-BETTER"]);

  state = recordNodeProbe(state, "JP-BAD", { ok: true, delay: 1 }, now);
  state = recordNodeProbe(state, "TW-BETTER", { ok: false }, now);

  assert.equal(state.nodes["JP-BAD"].consecutiveFailures, 0);
  assert.deepEqual(state.nodes["JP-BAD"].pathEvents, before);
  assert.deepEqual(pickHotStandbyProbeBatch(candidates, state, now, { limit: 1 }), ["TW-BETTER"]);
});

test("hot readiness requires full-path passes and ignores later short failures", () => {
  let state = newWatchdogState();
  for (const at of [now - 60_000, now - 40_000, now - 20_000, now]) {
    state = recordNodeProbe(state, "SHORT-ONLY", { ok: true }, at);
    state = fullProbe(state, "FULL-PATH", true, at);
  }
  state = recordNodeProbe(state, "FULL-PATH", { ok: false }, now + 1);
  assert.deepEqual(rankHotStandbys(["SHORT-ONLY", "FULL-PATH"], state, now + 1, readyOptions), ["FULL-PATH"]);
  assert.equal(hasRecentStablePathEvidence(state, "FULL-PATH", now + 1, fastOptions), true);

  state = fullProbe(state, "FULL-PATH", false, now + 2);
  for (const at of [now + 20_000, now + 40_000, now + 60_000]) {
    state = recordNodeProbe(state, "FULL-PATH", { ok: true }, at);
  }
  assert.deepEqual(rankHotStandbys(["FULL-PATH"], state, now + 60_000, readyOptions), []);
});

test("v7 normalization preserves history, cooldown and a persisted exploration", () => {
  const { state, plan } = explorationFixture();
  state.nodes["B-EXPLORE"] = {
    excludedUntil: now + 90_000,
    ejectionCount: 2,
    pathEvents: [{ at: now - 20_000, ok: false }],
    probeEvents: [{ at: now - 20_000, ok: false, delay: null }],
  };
  const saved = JSON.parse(JSON.stringify(state));
  const normalized = normalizeState(saved);
  assert.equal(normalized.version, 7);
  assert.equal(normalized.current, state.current);
  assert.deepEqual(normalized.hotStandbyExploration, plan.exploration);
  assert.deepEqual(normalized.nodes["B-EXPLORE"].pathEvents, saved.nodes["B-EXPLORE"].pathEvents);
  assert.deepEqual(normalized.nodes["B-EXPLORE"].probeEvents, saved.nodes["B-EXPLORE"].probeEvents);
  assert.equal(normalized.nodes["B-EXPLORE"].excludedUntil, now + 90_000);
  assert.equal(normalized.nodes["B-EXPLORE"].ejectionCount, 2);
  assert.equal(normalized.nodes["B-EXPLORE"].lastHotStandbyProbeAt, 0);
  delete saved.hotStandbyExploration;
  assert.equal(normalizeState(saved).hotStandbyExploration, null);
});

test("the pure planner gives a stale path four consecutive opportunities without widening the batch", () => {
  let state = newWatchdogState();
  state.current = "CURRENT";
  const incumbents = ["JP-INCUMBENT", "TW-INCUMBENT"];
  const stale = "SG-STALE";
  const candidates = [...incumbents, stale];
  for (const name of incumbents) {
    for (let index = 0; index < 10; index += 1) {
      state = fullProbe(state, name, true, now - 220_000 + index * 20_000);
    }
    state = fullProbe(state, name, false, now - 1);
  }
  state = fullProbe(state, stale, false, now - 700_000);
  const readiness = [];
  let firstReservation;
  for (let round = 0; round < 4; round += 1) {
    const at = now + round * 20_000;
    const before = structuredClone(state);
    const plan = planHotStandbyProbes(candidates, state, at, options);
    assert.deepEqual(state, before, "planning must not mutate its input");
    assert.equal(plan.batch.length, 2);
    assert.equal(new Set(plan.batch).size, 2);
    assert.equal(plan.exploration.name, stale);
    firstReservation ||= plan.exploration;
    assert.deepEqual(plan.exploration, firstReservation);
    state.hotStandbyExploration = plan.exploration;
    state = recordHotStandbyProbeAttempts(state, plan.batch, at);
    for (const name of plan.batch) state = fullProbe(state, name, name === stale || round % 3 !== 2, at);
    if (round % 3 === 0) {
      for (const name of pickRadarBatch(candidates, state, at + 1, { coldLimit: 1 })) {
        state = recordNodeProbe(state, name, { ok: name !== stale }, at + 1);
      }
    }
    readiness.push({
      ready: rankHotStandbys([stale], state, at + 1, readyOptions).length > 0,
      fast: hasRecentStablePathEvidence(state, stale, at + 1, fastOptions),
    });
    state = normalizeState(JSON.parse(JSON.stringify(state)));
  }
  assert.deepEqual(readiness, [
    { ready: false, fast: false }, { ready: false, fast: false },
    { ready: true, fast: false }, { ready: true, fast: true },
  ]);
  const maintenance = planHotStandbyProbes(candidates, state, now + 80_000, options);
  assert.equal(maintenance.batch[0], stale);
  assert.equal(maintenance.exploration, null);
});

test("already fast-ready paths stay in the batch ahead of higher-score unqualified paths", () => {
  let state = newWatchdogState();
  for (const at of [now - 60_000, now - 40_000, now - 20_000, now]) {
    state = fullProbe(state, "STABLE", true, at);
  }
  for (const name of ["A-BURST", "B-BURST"]) {
    for (let index = 0; index < 12; index += 1) state = fullProbe(state, name, true, now - 11_000 + index * 1_000);
  }
  const candidates = ["STABLE", "A-BURST", "B-BURST"];
  assert.deepEqual(pickHotStandbyProbeBatch(candidates, state, now), ["A-BURST", "B-BURST"]);
  const plan = planHotStandbyProbes(candidates, state, now, options);
  assert.equal(plan.batch[0], "STABLE");
  assert.equal(plan.batch.length, 2);
  assert.equal(plan.exploration, null);
});

test("a real exploration failure releases its slot even after a cold short success", () => {
  let { state, candidates, plan } = explorationFixture();
  state = recordHotStandbyProbeAttempts(state, plan.batch, now);
  state = fullProbe(state, plan.exploration.name, false, now + 1);
  state = recordNodeProbe(state, plan.exploration.name, { ok: true }, now + 2);
  const next = planHotStandbyProbes(candidates, state, now + 20_000, options);
  assert.equal(next.exploration.name, "C-EXPLORE");
  assert.equal(state.nodes["B-EXPLORE"].excludedUntil, 0);
});

test("infrastructure-only attempts rotate exploration without changing failure or cooldown", () => {
  let { state, candidates } = explorationFixture();
  const reservations = [];
  for (let round = 0; round < 3; round += 1) {
    const at = now + round * 20_000;
    const plan = planHotStandbyProbes(candidates, state, at, options);
    reservations.push(plan.exploration.name);
    state.hotStandbyExploration = plan.exploration;
    state = recordHotStandbyProbeAttempts(state, plan.batch, at);
    const quality = plan.batch.find((name) => name !== plan.exploration.name);
    state = fullProbe(state, quality, true, at + 1);
    // The exploration listener was unavailable: no node/path failure is recorded.
  }
  assert.notEqual(reservations[0], reservations[1]);
  assert.notEqual(reservations[1], reservations[2]);
  for (const name of ["B-EXPLORE", "C-EXPLORE"]) {
    assert.equal(state.nodes[name].failures, 0);
    assert.equal(state.nodes[name].ejectionCount, 0);
    assert.equal(state.nodes[name].excludedUntil, 0);
    assert.ok(state.nodes[name].lastHotStandbyProbeAt >= now);
  }
});

test("removal, current selection, cooling, mapping change and timeout invalidate a reservation", () => {
  const cases = [
    ({ candidates }) => candidates.filter((name) => name !== "B-EXPLORE"),
    ({ state, candidates }) => { state.current = "B-EXPLORE"; return candidates; },
    ({ state, candidates }) => { state.nodes["B-EXPLORE"] = { excludedUntil: now + 300_000 }; return candidates; },
    ({ candidates }) => [...candidates, "D-NEW"],
    ({ candidates }) => candidates,
  ];
  for (const [index, mutate] of cases.entries()) {
    const fixture = explorationFixture();
    const candidates = mutate(fixture);
    const at = index === cases.length - 1 ? now + 120_000 : now + 20_000;
    const next = planHotStandbyProbes(candidates, fixture.state, at, options);
    assert.notEqual(next.exploration?.name, "B-EXPLORE");
    assert.ok(next.batch.length <= 2);
    if (index < 3) assert.equal(next.batch.includes("B-EXPLORE"), false);
  }
});

test("candidate order and duplicate entries do not invalidate an exploration mapping", () => {
  const { state, candidates, plan } = explorationFixture();
  const next = planHotStandbyProbes([...candidates].reverse().concat("B-EXPLORE"), state, now + 1, options);
  assert.deepEqual(next.exploration, plan.exploration);
});

test("capacity and cooling remain hard limits even without another exploration candidate", () => {
  const { state, candidates } = explorationFixture();
  state.nodes["A-QUALITY"].excludedUntil = now + 300_000;
  state.nodes["C-EXPLORE"] = { excludedUntil: now + 300_000 };
  const before = structuredClone(state);
  const expired = planHotStandbyProbes(candidates, state, now + 120_000, { ...options, limit: 10 });
  assert.deepEqual(expired, { batch: ["B-EXPLORE"], exploration: null });
  assert.deepEqual(state, before);
  assert.deepEqual(planHotStandbyProbes(candidates, state, now, { ...options, limit: 0 }), { batch: [], exploration: null });
});

test("attempt recording preserves health and cooldown while tracking only the requested nodes", () => {
  let state = newWatchdogState();
  state = fullProbe(state, "NODE", false, now - 1);
  state.nodes.NODE.excludedUntil = now + 100_000;
  const before = structuredClone(state);
  const recorded = recordHotStandbyProbeAttempts(state, ["NODE", "NODE"], now);
  assert.deepEqual(state, before);
  assert.equal(recorded.nodes.NODE.lastHotStandbyProbeAt, now);
  assert.deepEqual({ ...recorded.nodes.NODE, lastHotStandbyProbeAt: 0 }, before.nodes.NODE);
});
