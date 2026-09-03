import test from "node:test";
import assert from "node:assert/strict";

import {
  addPassiveError,
  allowsEmergencyCoolingReuse,
  beginSelectionValidation,
  buildRecoveryCandidatePools,
  connectionRouteKey,
  currentPathInstabilityReason,
  ejectNode,
  ejectNodeOnce,
  filterProviderAliveCandidates,
  hasRecentStablePathEvidence,
  hasRecentTraffic,
  isGroupConnection,
  isOpenAIPathError,
  latestPathProbeWasSuccessful,
  newWatchdogState,
  normalizeState,
  passiveErrorKey,
  pickEmergencyRecoveryBatch,
  pickHotStandbyProbeBatch,
  pickRadarBatch,
  pickRecoveryBatch,
  planConnectionDrain,
  qualifiesProbeSeries,
  rankHotStandbys,
  rankFreshSuccesses,
  recordCurrentProbe,
  recordNodePathProbe,
  recordNodeProbe,
  recordProviderHealth,
  recordSelectionValidation,
  recoveryBackoffDelay,
  recoveryReason,
  restoreRecoveryOrigin,
  rollingNodeStats,
  rollingPathStats,
} from "./lib.mjs";

test("a successful current probe clears prior failures", () => {
  let state = newWatchdogState();
  state = recordCurrentProbe(state, { ok: false }, 100);
  state = recordCurrentProbe(state, { ok: true }, 200);

  assert.equal(state.currentFailures, 0);
  assert.equal(state.currentFailureStartedAt, 0);
  assert.equal(state.lastSuccessAt, 200);
});

test("Mihomo provider health overrides a green short probe and switch hold", () => {
  let state = newWatchdogState();
  state.current = "SG4-HY2";
  state.holdUntil = 500_000;
  state = recordCurrentProbe(state, { ok: true }, 100_000);
  state = recordProviderHealth(state, false, 110_000);

  assert.equal(recoveryReason(state, 110_000), "provider_health_unavailable");

  state = recordProviderHealth(state, true, 120_000);
  assert.equal(state.providerUnhealthyAt, 0);
  assert.equal(recoveryReason(state, 120_000), null);
});

test("a fresh successful full-path probe requires confirmation before trusting provider false", () => {
  let state = newWatchdogState();
  state = recordNodePathProbe(state, "TW-7", { ok: true }, 100_000);

  assert.equal(
    latestPathProbeWasSuccessful(state, "TW-7", 150_000, 60_000),
    true,
  );

  state = recordNodePathProbe(state, "TW-7", { ok: false }, 155_000);
  assert.equal(
    latestPathProbeWasSuccessful(state, "TW-7", 156_000, 60_000),
    false,
  );
  assert.equal(
    latestPathProbeWasSuccessful(state, "TW-7", 220_001, 60_000),
    false,
  );
});

test("recovery candidates exclude proxies Mihomo already marks unavailable", () => {
  const candidates = filterProviderAliveCandidates(
    ["SG4-HY2", "TW-9", "JP-3", "TW-9"],
    {
      "SG4-HY2": { alive: false },
      "TW-9": { alive: true },
      "JP-3": { alive: false },
    },
  );

  assert.deepEqual(candidates, ["TW-9"]);
});

test("candidate qualification requires every separated probe to pass", () => {
  assert.equal(qualifiesProbeSeries([{ ok: true }, { ok: true }], 3), false);
  assert.equal(
    qualifiesProbeSeries([{ ok: true }, { ok: false }, { ok: true }], 3),
    false,
  );
  assert.equal(
    qualifiesProbeSeries([{ ok: true }, { ok: true }, { ok: true }], 3),
    true,
  );
});

test("recent OpenAI traffic suppresses background radar for two minutes", () => {
  const state = newWatchdogState();
  state.lastOpenAITrafficAt = 100_000;

  assert.equal(hasRecentTraffic(state, 219_999, 120_000), true);
  assert.equal(hasRecentTraffic(state, 220_001, 120_000), false);
});

test("a rejected recovery candidate rolls back without erasing the origin failure window", () => {
  let state = newWatchdogState();
  state.current = "SG-3";
  for (const at of [10_000, 30_000, 50_000]) {
    state = recordCurrentProbe(state, { ok: false }, at);
  }
  const origin = {
    current: state.current,
    currentSelectedAt: state.currentSelectedAt,
    currentFailures: state.currentFailures,
    currentFailureStartedAt: state.currentFailureStartedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
  };

  state.current = "US4-HY2";
  state.currentFailures = 1;
  state.currentFailureStartedAt = 60_000;
  state.lastSuccessAt = 55_000;
  state.lastFailureAt = 60_000;
  state = restoreRecoveryOrigin(state, origin);

  assert.equal(state.current, "SG-3");
  assert.equal(state.currentSelectedAt, 0);
  assert.equal(state.currentFailures, 3);
  assert.equal(state.currentFailureStartedAt, 10_000);
  assert.equal(state.lastSuccessAt, 0);
  assert.equal(state.lastFailureAt, 50_000);
});

test("three current failures must span 45 seconds before recovery", () => {
  let state = newWatchdogState();
  state = recordCurrentProbe(state, { ok: false }, 20_000);
  state = recordCurrentProbe(state, { ok: false }, 40_000);
  state = recordCurrentProbe(state, { ok: false }, 60_000);

  assert.equal(recoveryReason(state, 60_000), null);
  assert.equal(recoveryReason(state, 65_000), "current_probe_failures");
});

test("post-switch hold and scheduled retry prevent background switch storms", () => {
  let state = newWatchdogState();
  state = recordCurrentProbe(state, { ok: false }, 20_000);
  state = recordCurrentProbe(state, { ok: false }, 40_000);
  state = recordCurrentProbe(state, { ok: false }, 60_000);
  state.holdUntil = 80_000;

  assert.equal(recoveryReason(state, 70_000), null);
  state.holdUntil = 0;
  state.nextRecoveryAt = 90_000;
  assert.equal(recoveryReason(state, 89_000), null);
  assert.equal(recoveryReason(state, 90_000), "current_probe_failures");
});

test("active traffic requests confirmation after two failures and escapes hold after three", () => {
  let state = newWatchdogState();
  state.current = "SG4-HY2";
  state.holdUntil = 300_000;
  state.lastOpenAITrafficAt = 70_000;
  state = recordCurrentProbe(state, { ok: false }, 50_000);

  assert.equal(recoveryReason(state, 70_000), null);
  state = recordCurrentProbe(state, { ok: false }, 70_000);
  assert.equal(
    recoveryReason(state, 70_000),
    "active_current_probe_validation",
  );

  state = recordCurrentProbe(state, { ok: false }, 71_000);
  assert.equal(
    recoveryReason(state, 71_000),
    "active_current_probe_failures",
  );
});

test("an unverified external selection bypasses hold after two real-path failures", () => {
  let state = newWatchdogState();
  state.current = "JP-1";
  state = beginSelectionValidation(state, null, "JP-1", "manual", 10_000);
  state.holdUntil = 300_000;
  state.lastOpenAITrafficAt = 16_000;
  state = recordCurrentProbe(state, { ok: false }, 10_000);

  assert.equal(recoveryReason(state, 16_000), null);
  state = recordCurrentProbe(state, { ok: false }, 16_000);
  assert.equal(recoveryReason(state, 16_000), "selection_validation_failed");
});

test("four failures over one minute override hold", () => {
  let state = newWatchdogState();
  state.current = "JP5-HY2";
  state.holdUntil = 300_000;
  for (const at of [10_000, 30_000, 50_000, 70_000]) {
    state = recordCurrentProbe(state, { ok: false }, at);
  }

  assert.equal(recoveryReason(state, 69_999), null);
  assert.equal(recoveryReason(state, 70_000), "hard_current_probe_failures");
});

test("two intermittent failures during one selection tenure trigger recovery", () => {
  let state = newWatchdogState();
  state.current = "JP10-HY2";
  state.currentSelectedAt = 10_000;
  for (const [at, ok] of [
    [20_000, false],
    [30_000, true],
    [220_000, false],
    [230_000, true],
  ]) {
    state = recordCurrentProbe(state, { ok }, at);
    state = recordNodePathProbe(state, state.current, { ok }, at);
  }

  assert.equal(state.currentFailures, 0);
  assert.equal(
    recoveryReason(state, 230_000),
    "intermittent_current_path_failures",
  );
});

test("a stricter intermittent policy ignores two isolated probe failures", () => {
  let state = newWatchdogState();
  state.current = "TW-1";
  state.currentSelectedAt = 10_000;
  state = recordNodePathProbe(state, "TW-1", { ok: false }, 30_000);
  state = recordNodePathProbe(state, "TW-1", { ok: false }, 260_000);

  assert.equal(
    recoveryReason(state, 260_000, {
      intermittentFailureThreshold: 3,
      intermittentFailureWindowMs: 5 * 60_000,
    }),
    null,
  );

  state = recordNodePathProbe(state, "TW-1", { ok: false }, 280_000);
  assert.equal(
    recoveryReason(state, 280_000, {
      intermittentFailureThreshold: 3,
      intermittentFailureWindowMs: 5 * 60_000,
    }),
    "intermittent_current_path_failures",
  );
});

test("intermittent failures from before the current selection are ignored", () => {
  let state = newWatchdogState();
  state.current = "JP10-HY2";
  for (const at of [20_000, 220_000, 400_000]) {
    state = recordNodePathProbe(state, state.current, { ok: false }, at);
  }
  state.currentSelectedAt = 500_000;
  state = recordNodePathProbe(state, state.current, { ok: true }, 501_000);

  assert.equal(recoveryReason(state, 501_000), null);
});

test("migrated state without a selection timestamp still rejects recent instability", () => {
  let state = newWatchdogState();
  state.current = "JP10-HY2";
  state.lastRecoveryAt = 500_000;
  for (const at of [300_000, 450_000]) {
    state = recordNodePathProbe(state, state.current, { ok: false }, at);
  }
  state = recordNodePathProbe(state, state.current, { ok: true }, 501_000);

  assert.equal(
    recoveryReason(state, 501_000),
    "intermittent_current_path_failures",
  );
});

test("radar evidence never triggers or clears real-path instability", () => {
  let state = newWatchdogState();
  state.current = "JP10-HY2";
  state.currentSelectedAt = 1_000;
  for (const at of [10_000, 20_000, 30_000, 40_000]) {
    state = recordNodeProbe(state, state.current, { ok: false, delay: null }, at);
  }
  assert.equal(currentPathInstabilityReason(state, 40_000), null);

  for (const at of [50_000, 200_000, 350_000]) {
    state = recordNodePathProbe(state, state.current, { ok: false }, at);
    state = recordNodeProbe(state, state.current, { ok: true, delay: 80 }, at + 1);
  }
  assert.equal(
    currentPathInstabilityReason(state, 350_000, {
      intermittentFailureThreshold: 3,
      intermittentFailureWindowMs: 5 * 60_000,
    }),
    "intermittent_current_path_failures",
  );
  assert.equal(rollingPathStats(state.nodes[state.current], 350_000).failures, 3);
});

test("four slower failures within ten minutes trigger slow-path recovery", () => {
  let state = newWatchdogState();
  state.current = "JP10-HY2";
  state.currentSelectedAt = 1_000;
  for (const at of [10_000, 190_000, 370_000, 550_000]) {
    state = recordNodePathProbe(state, state.current, { ok: false }, at);
  }

  assert.equal(
    currentPathInstabilityReason(state, 550_000, {
      intermittentFailureThreshold: 3,
      intermittentFailureWindowMs: 5 * 60_000,
      slowFailureThreshold: 4,
      slowFailureWindowMs: 10 * 60_000,
    }),
    "slow_current_path_failures",
  );
});

test("a scheduled retry remains visible behind one successful probe", () => {
  let state = newWatchdogState();
  state.current = "JP10-HY2";
  state.currentSelectedAt = 1_000;
  state.nextRecoveryAt = 600_000;
  for (const at of [10_000, 190_000, 370_000, 550_000]) {
    state = recordNodePathProbe(state, state.current, { ok: false }, at);
  }
  state = recordNodePathProbe(state, state.current, { ok: true }, 560_000);

  const options = {
    intermittentFailureThreshold: 3,
    intermittentFailureWindowMs: 5 * 60_000,
    slowFailureThreshold: 4,
    slowFailureWindowMs: 10 * 60_000,
  };
  assert.equal(recoveryReason(state, 560_000, options), null);
  assert.equal(
    currentPathInstabilityReason(state, 560_000, options),
    "slow_current_path_failures",
  );
});

test("an external selection needs two real-path successes before hold", () => {
  let state = newWatchdogState();
  state.current = "SG4-HY2";
  state = beginSelectionValidation(state, "JP-1", "SG4-HY2", "manual", 10_000);
  state = recordSelectionValidation(state, { ok: true }, 11_000, {
    successThreshold: 2,
    holdMs: 300_000,
  });

  assert.equal(state.selectionValidation.consecutiveSuccesses, 1);
  assert.equal(state.holdUntil, 0);

  state = recordSelectionValidation(state, { ok: false }, 12_000, {
    successThreshold: 2,
    holdMs: 300_000,
  });
  assert.equal(state.selectionValidation.consecutiveSuccesses, 0);

  state = recordSelectionValidation(state, { ok: true }, 13_000, {
    successThreshold: 2,
    holdMs: 300_000,
  });
  state = recordSelectionValidation(state, { ok: true }, 14_000, {
    successThreshold: 2,
    holdMs: 300_000,
  });

  assert.equal(state.selectionValidation, null);
  assert.equal(state.holdUntil, 314_000);
});

test("a fast hot-standby switch keeps validating in the background", () => {
  let state = newWatchdogState();
  state.current = "JP4-HY2";
  state = beginSelectionValidation(
    state,
    "JP-2",
    "JP4-HY2",
    "hot_standby",
    10_000,
    {
      consecutiveSuccesses: 1,
      successThreshold: 4,
      failureThreshold: 1,
      failureAgeMs: 0,
      maxAgeMs: 30_000,
    },
  );

  for (const at of [15_000, 20_000]) {
    state = recordSelectionValidation(state, { ok: true }, at, {
      holdMs: 300_000,
    });
  }
  assert.equal(state.selectionValidation.consecutiveSuccesses, 3);
  assert.equal(state.holdUntil, 0);

  state = recordSelectionValidation(state, { ok: true }, 25_000, {
    holdMs: 300_000,
  });
  assert.equal(state.selectionValidation, null);
  assert.equal(state.holdUntil, 325_000);
});

test("one real-path failure rejects a hot standby during background validation", () => {
  let state = newWatchdogState();
  state.current = "JP4-HY2";
  state = beginSelectionValidation(
    state,
    "JP-2",
    "JP4-HY2",
    "hot_standby",
    10_000,
    {
      consecutiveSuccesses: 1,
      successThreshold: 4,
      failureThreshold: 1,
      failureAgeMs: 0,
    },
  );
  state = recordCurrentProbe(state, { ok: false }, 15_000);

  assert.equal(recoveryReason(state, 15_000), "selection_validation_failed");
});

test("an unstable external selection cannot remain pending beyond 30 seconds", () => {
  let state = newWatchdogState();
  state.current = "JP-1";
  state = beginSelectionValidation(state, "JP-2", "JP-1", "manual", 10_000);
  state = recordSelectionValidation(state, { ok: true }, 15_000);
  state = recordSelectionValidation(state, { ok: false }, 20_000);
  state = recordSelectionValidation(state, { ok: true }, 25_000);

  assert.equal(recoveryReason(state, 39_999), null);
  assert.equal(recoveryReason(state, 40_000), "selection_validation_timeout");
});

test("passive transport errors are deduplicated by connection", () => {
  let state = newWatchdogState();
  const first = "[TCP] dial OpenAI 自动选择 127.0.0.1:50001 --> chatgpt.com:443 error: timeout";
  const duplicate = "[TCP] dial OpenAI 自动选择 127.0.0.1:50001 --> chatgpt.com:443 error: reset";
  const second = "[TCP] dial OpenAI 自动选择 127.0.0.1:50002 --> chatgpt.com:443 error: timeout";

  state = addPassiveError(state, first, 20_000);
  state = addPassiveError(state, duplicate, 21_000);
  assert.equal(state.passiveErrors.length, 1);
  state = addPassiveError(state, second, 22_000);

  assert.equal(state.passiveErrors.length, 2);
  state.holdUntil = 100_000;
  assert.equal(recoveryReason(state, 22_000), "passive_transport_errors");
  assert.equal(
    passiveErrorKey(first),
    "127.0.0.1:50001->chatgpt.com:443",
  );
});

test("node ejection grows from 15 to 30 minutes and keeps failure memory after reentry", () => {
  let state = newWatchdogState();
  state = recordNodeProbe(state, "JP1-HY2", { ok: false }, 10_000);
  state = ejectNode(state, "JP1-HY2", 10_000);
  assert.equal(state.nodes["JP1-HY2"].excludedUntil, 910_000);
  assert.equal(state.nodes["JP1-HY2"].ejectionCount, 1);

  state = recordNodeProbe(state, "JP1-HY2", { ok: false }, 911_000);
  state = ejectNode(state, "JP1-HY2", 911_000);
  assert.equal(state.nodes["JP1-HY2"].excludedUntil, 2_711_000);
  assert.equal(state.nodes["JP1-HY2"].ejectionCount, 2);

  state = recordNodeProbe(state, "JP1-HY2", { ok: true }, 2_712_000);
  state = recordNodeProbe(state, "JP1-HY2", { ok: true }, 2_713_000);
  assert.equal(state.nodes["JP1-HY2"].ejectionCount, 2);
  state = recordNodeProbe(state, "JP1-HY2", { ok: true }, 2_714_000);

  assert.equal(state.nodes["JP1-HY2"].successes, 3);
  assert.equal(state.nodes["JP1-HY2"].failures, 2);
  assert.equal(state.nodes["JP1-HY2"].consecutiveFailures, 0);
  assert.equal(state.nodes["JP1-HY2"].excludedUntil, 0);
  assert.equal(state.nodes["JP1-HY2"].ejectionCount, 2);
});

test("repeated recovery does not extend an active node cooldown", () => {
  let state = newWatchdogState();
  state = ejectNodeOnce(state, "JP-A", 10_000, [60_000, 120_000]);
  const firstExcludedUntil = state.nodes["JP-A"].excludedUntil;
  state = ejectNodeOnce(state, "JP-A", 20_000, [60_000, 120_000]);

  assert.equal(state.nodes["JP-A"].excludedUntil, firstExcludedUntil);
  assert.equal(state.nodes["JP-A"].ejectionCount, 1);
});

test("recovery batches keep protocol and region diversity", () => {
  const state = newWatchdogState();
  state.current = "JP-2";
  const batch = pickRecoveryBatch([
    "JP-1",
    "JP-2",
    "JP1-HY2",
    "KR-1",
    "SG-1",
    "SG4-HY2",
    "TW-1",
    "US-1TCP",
  ], state, 200_000, { limit: 6 });

  assert.equal(batch.length, 6);
  assert.equal(batch.includes("JP-2"), false);
  assert.equal(batch.includes("JP-1"), true);
  assert.equal(batch.includes("JP1-HY2"), true);
  assert.equal(batch.includes("KR-1"), true);
  assert.equal(batch.includes("TW-1"), true);
});

test("recovery batches skip cooling nodes and prefer recent healthy evidence", () => {
  let state = newWatchdogState();
  state = recordNodeProbe(state, "JP-1", { ok: true }, 190_000);
  state = ejectNode(state, "JP1-HY2", 200_000, [60_000]);

  const batch = pickRecoveryBatch(
    ["JP-1", "JP1-HY2", "SG-1", "TW-1"],
    state,
    200_000,
    { limit: 2 },
  );

  assert.equal(batch.includes("JP1-HY2"), false);
  assert.equal(batch.includes("JP-1"), true);
  assert.equal(batch.length, 2);
});

test("emergency recovery can strictly requalify cooling provider-alive nodes", () => {
  let state = newWatchdogState();
  state.current = "JP-A";
  state = recordNodeProbe(state, "JP-B-HY2", { ok: true, delay: 180 }, 190_000);
  state = ejectNode(state, "JP-B-HY2", 200_000, [60_000]);
  state = ejectNode(state, "TW-A", 200_000, [60_000]);

  assert.deepEqual(
    pickRecoveryBatch(["JP-B-HY2", "TW-A"], state, 200_000),
    [],
  );
  assert.deepEqual(
    pickEmergencyRecoveryBatch(
      ["JP-A", "JP-B-HY2", "TW-A"],
      state,
      200_000,
      { limit: 2 },
    ),
    ["JP-B-HY2", "TW-A"],
  );
});

test("cooldown reuse is limited to hard recovery reasons", () => {
  assert.equal(allowsEmergencyCoolingReuse("passive_transport_errors"), true);
  assert.equal(allowsEmergencyCoolingReuse("hard_current_probe_failures"), true);
  assert.equal(allowsEmergencyCoolingReuse("intermittent_current_path_failures"), false);
  assert.equal(allowsEmergencyCoolingReuse("active_current_probe_validation"), false);
});

test("rolling health ignores stale success history and stability beats latency", () => {
  let state = newWatchdogState();
  for (let index = 0; index < 8; index += 1) {
    state = recordNodeProbe(state, "SG-1", { ok: true, delay: 80 }, 100_000 + index);
  }
  state = recordNodeProbe(state, "SG-1", { ok: false }, 995_000);
  for (let index = 0; index < 3; index += 1) {
    state = recordNodeProbe(state, "JP4-HY2", { ok: true, delay: 350 }, 997_000 + index);
  }

  const ranked = rankFreshSuccesses([
    { name: "SG-1", ok: true, delay: 80, testedAt: 1_000_000 },
    { name: "JP4-HY2", ok: true, delay: 350, testedAt: 1_000_000 },
    { name: "TW-1", ok: true, delay: 90, testedAt: 900_000 },
  ], state, 1_000_000, 90_000);

  assert.deepEqual(ranked.map((sample) => sample.name), ["JP4-HY2", "SG-1"]);
  assert.equal(rollingNodeStats(state.nodes["SG-1"], 1_000_000).total, 1);
});

test("a globally stable candidate beats a lower-latency regional candidate", () => {
  let state = newWatchdogState();
  for (let index = 0; index < 8; index += 1) {
    state = recordNodeProbe(state, "TW-7", { ok: true, delay: 260 }, 990_000 + index);
  }
  for (const [index, ok] of [true, false, true].entries()) {
    state = recordNodeProbe(state, "JP9-HY2", { ok, delay: 140 }, 995_000 + index);
  }

  const ranked = rankFreshSuccesses([
    { name: "JP9-HY2", ok: true, delay: 140, testedAt: 1_000_000 },
    { name: "TW-7", ok: true, delay: 260, testedAt: 1_000_000 },
  ], state, 1_000_000, 90_000);

  assert.deepEqual(ranked.map((sample) => sample.name), ["TW-7", "JP9-HY2"]);
});

test("proven full-path stability outranks green low-latency radar only", () => {
  let state = newWatchdogState();
  for (let index = 0; index < 8; index += 1) {
    state = recordNodeProbe(state, "JP-1", { ok: true, delay: 45 }, 990_000 + index);
  }
  for (let index = 0; index < 4; index += 1) {
    state = recordNodeProbe(state, "TW-7", { ok: true, delay: 260 }, 990_000 + index);
    state = recordNodePathProbe(state, "TW-7", { ok: true }, 995_000 + index);
  }

  const ranked = rankFreshSuccesses([
    { name: "JP-1", ok: true, delay: 45, testedAt: 1_000_000 },
    { name: "TW-7", ok: true, delay: 260, testedAt: 1_000_000 },
  ], state, 1_000_000, 90_000);

  assert.deepEqual(ranked.map((sample) => sample.name), ["TW-7", "JP-1"]);
});

test("radar mixes proven hot nodes with the stalest untested nodes", () => {
  let state = newWatchdogState();
  for (let index = 0; index < 3; index += 1) {
    state = recordNodeProbe(state, "JP1-HY2", { ok: true, delay: 200 }, 190_000 + index);
  }
  state = recordNodeProbe(state, "SG-1", { ok: true, delay: 100 }, 199_000);

  const batch = pickRadarBatch(
    ["JP1-HY2", "SG-1", "TW-1", "US-1TCP"],
    state,
    200_000,
    { hotLimit: 1, coldLimit: 2 },
  );

  assert.equal(batch[0], "JP1-HY2");
  assert.deepEqual(new Set(batch.slice(1)), new Set(["TW-1", "US-1TCP"]));
});

test("hot standbys require three fresh successes spread across time", () => {
  let state = newWatchdogState();
  state.current = "JP-2";
  for (const at of [100_000, 160_000, 220_000]) {
    state = recordNodeProbe(state, "JP4-HY2", { ok: true, delay: 220 }, at);
  }
  for (const at of [217_000, 218_000, 219_000]) {
    state = recordNodeProbe(state, "SG-1", { ok: true, delay: 80 }, at);
  }
  for (const [at, ok] of [[100_000, true], [160_000, false], [220_000, true]]) {
    state = recordNodeProbe(state, "TW-7", { ok, delay: 180 }, at);
  }

  assert.deepEqual(
    rankHotStandbys(
      ["JP-2", "JP4-HY2", "SG-1", "TW-7"],
      state,
      250_000,
      {
        probeTtlMs: 75_000,
        historyWindowMs: 180_000,
        minSpanMs: 45_000,
      },
    ),
    ["JP4-HY2"],
  );
});

test("radar-only hot standbys need recent clean full-path history for fast handover", () => {
  let state = newWatchdogState();
  state.current = "JP-2";
  for (const at of [100_000, 160_000, 220_000]) {
    state = recordNodeProbe(state, "JP4-HY2", { ok: true, delay: 220 }, at);
  }

  assert.equal(
    hasRecentStablePathEvidence(state, "JP4-HY2", 250_000),
    false,
  );

  for (const at of [160_000, 180_000, 210_000, 240_000]) {
    state = recordNodePathProbe(state, "JP4-HY2", { ok: true }, at);
  }
  assert.equal(
    hasRecentStablePathEvidence(state, "JP4-HY2", 250_000),
    true,
  );

  state = recordNodePathProbe(state, "JP4-HY2", { ok: false }, 245_000);
  assert.equal(
    hasRecentStablePathEvidence(state, "JP4-HY2", 250_000),
    false,
  );
});

test("radar-ready nodes downgraded from fast handover are fully qualified first", () => {
  assert.deepEqual(
    buildRecoveryCandidatePools(
      ["JP-1", "JP5-HY2", "TW-4", "SG-1"],
      ["TW-4"],
      ["JP5-HY2", "TW-4"],
    ),
    [["JP5-HY2"], ["JP-1", "SG-1"]],
  );
});

test("hot-standby radar keeps two healthy candidates and replaces a failing one", () => {
  let state = newWatchdogState();
  state.current = "JP-2";
  for (const [name, ok, delay] of [
    ["JP4-HY2", true, 220],
    ["SG-1", true, 100],
    ["TW-7", false, 80],
  ]) {
    state = recordNodeProbe(state, name, { ok, delay }, 200_000);
  }

  assert.deepEqual(
    pickHotStandbyProbeBatch(
      ["JP-2", "JP4-HY2", "SG-1", "TW-7"],
      state,
      210_000,
      { limit: 2 },
    ),
    ["SG-1", "JP4-HY2"],
  );
});

test("recovery exhaustion uses bounded exponential backoff", () => {
  const schedule = [10_000, 30_000, 60_000, 300_000];
  assert.equal(recoveryBackoffDelay(0, schedule), 10_000);
  assert.equal(recoveryBackoffDelay(1, schedule), 30_000);
  assert.equal(recoveryBackoffDelay(2, schedule), 60_000);
  assert.equal(recoveryBackoffDelay(9, schedule), 300_000);
});

test("passive matching only accepts real OpenAI group traffic", () => {
  assert.equal(
    isOpenAIPathError("[TCP] dial OpenAI 自动选择 (match DomainSuffix/chatgpt.com) error: context deadline exceeded"),
    true,
  );
  assert.equal(
    isOpenAIPathError("[TCP] dial OpenAI 自动选择 127.0.0.1:50001 --> ws.chatgpt.com:443 error: EOF"),
    true,
  );
  assert.equal(
    isOpenAIPathError("[TCP] dial OpenAI 自动选择 127.0.0.1:50001 --> ab.chatgpt.com:443 error: timeout"),
    false,
  );
  assert.equal(isOpenAIPathError("example.com timeout"), false);
  assert.equal(isOpenAIPathError("JP-1 api.openai.com timeout"), false);
});

test("connection draining preserves only established routes on old group nodes", () => {
  const oldConnection = {
    id: "connection-1",
    chains: ["JP5-HY2", "OpenAI 自动选择"],
    metadata: {
      sourceIP: "127.0.0.1",
      sourcePort: "50001",
      host: "chatgpt.com",
      destinationPort: "443",
    },
  };
  const currentConnection = {
    ...oldConnection,
    id: "connection-2",
    chains: ["SG4-HY2", "OpenAI 自动选择"],
    metadata: { ...oldConnection.metadata, sourcePort: "50002" },
  };
  const otherGroupConnection = {
    ...oldConnection,
    id: "connection-3",
    chains: ["JP5-HY2", "主代理"],
    metadata: { ...oldConnection.metadata, sourcePort: "50003" },
  };

  assert.equal(isGroupConnection(oldConnection, "OpenAI 自动选择", "JP5-HY2"), true);
  assert.equal(isGroupConnection(oldConnection, "OpenAI 自动选择", "SG4-HY2"), false);
  assert.equal(isGroupConnection(oldConnection, "主代理", "JP5-HY2"), false);
  assert.equal(isGroupConnection({ chains: oldConnection.chains }, "OpenAI 自动选择"), false);
  assert.equal(
    connectionRouteKey(oldConnection),
    passiveErrorKey("[TCP] dial OpenAI 自动选择 127.0.0.1:50001 --> chatgpt.com:443 error: timeout"),
  );
  assert.deepEqual(
    planConnectionDrain(
      [oldConnection, currentConnection, otherGroupConnection],
      "OpenAI 自动选择",
      "SG4-HY2",
    ),
    [{ id: "connection-1", routeKey: "127.0.0.1:50001->chatgpt.com:443" }],
  );
});

test("old cumulative-health state is not reused", () => {
  const state = normalizeState({ version: 5, current: "JP-1", passiveErrors: [] });
  assert.equal(state.version, 6);
  assert.equal(state.current, null);
  assert.deepEqual(state.nodes, {});
});

test("current-version state preserves bounded recovery backoff progress", () => {
  const state = normalizeState({
    version: 6,
    recoveryExhaustions: 2,
    nodes: {},
  });
  assert.equal(state.recoveryExhaustions, 2);
});
