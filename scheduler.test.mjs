import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const controllerSource = await readFile(new URL("./controller.mjs", import.meta.url), "utf8");
const libSource = await readFile(new URL("./lib.mjs", import.meta.url), "utf8");
const startedAt = 1_000_000;

function schedulerHarness(durationMs = 100_000) {
  const clock = { now: startedAt };
  const events = [];
  class TestDate extends Date {
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    Date: TestDate,
    os,
    path,
    URL,
    Buffer,
    clock,
    events,
    endAt: startedAt + durationMs,
    process: {
      argv: ["node", "controller.mjs"],
      platform: "darwin",
      env: {},
      pid: 1,
      stdout: { write() {} },
    },
    setTimeout() { throw new Error("Unexpected real timer in scheduler test"); },
    clearTimeout() {},
  });
  // Keep production state helpers, scheduling, and the run loop; omit imports
  // and process startup so only the fake boundaries below can execute.
  vm.runInContext(libSource.replace(/^export /gm, ""), context, { filename: "lib.mjs" });
  const start = controllerSource.indexOf("const args = ");
  const end = controllerSource.indexOf('\nprocess.on("SIGTERM"');
  assert.ok(start >= 0 && end > start, "controller entry point was not found");
  vm.runInContext(controllerSource.slice(start, end), context, { filename: "controller.mjs" });
  const evaluate = (source) => vm.runInContext(source, context);
  evaluate(`
    log = (level, event, fields = {}) => events.push({ at: Date.now(), level, event, ...fields });
    loadState = async () => {};
    saveState = async () => {};
    startLogMonitor = () => {};
    beginOpenAIConnectionDrain = async () => ({ matched: 0, protected: 0 });
    runRadar = async () => {};
    runHotStandbyRadar = async () => {};
    observeOpenAIActivity = async () => { state.lastOpenAITrafficAt = Date.now(); };
    recover = async (reason) => {
      log("error", "unexpected_recovery", { reason });
      stopped = true;
      return false;
    };
    sleep = async (ms) => {
      clock.now += ms;
      if (clock.now > endAt) stopped = true;
    };
  `);
  return { events, evaluate };
}

function assertNoRecoveryOrCycleError(events) {
  assert.deepEqual(events.filter((event) => (
    event.event === "unexpected_recovery" || event.event === "controller_cycle_failed"
  )), []);
}

test("a healthy manual selection advances the old active deadline and completes validation", async () => {
  const { events, evaluate } = schedulerHarness();
  evaluate(`
    state.current = "JP-OLD";
    state.currentSelectedAt = Date.now() - 60_000;
    refreshNetworkEnvironment = async () => false;
    mihomoRequest = async (method, requestPath) => {
      if (method !== "GET") throw new Error("Unexpected selector write");
      if (decodeURIComponent(requestPath) === "/proxies/" + config.groupName) {
        return {
          type: "Selector",
          now: Date.now() >= 1_001_000 ? "TW-HEALTHY" : "JP-OLD",
          all: ["JP-OLD", "TW-HEALTHY"],
        };
      }
      return { alive: true };
    };
    curlOpenAIPathProbe = async () => ({ ok: true, status: "403", bytes: 4000, totalMs: 20 });
  `);

  await evaluate("run()");

  const selected = events.find((event) => event.event === "group_selection_changed");
  const probes = events.filter((event) => (
    event.event === "current_probe" && event.node === "TW-HEALTHY"
  ));
  const verified = events.find((event) => event.event === "selection_verified");
  assert.equal(selected?.at, startedAt + 1_000);
  assert.equal(probes[0]?.at, selected.at);
  assert.equal(probes[1]?.at, selected.at + 5_000);
  assert.ok(probes.every((probe) => probe.ok));
  assert.equal(verified?.at, selected.at + 5_000);
  assert.equal(evaluate("state.selectionValidation"), null);
  assertNoRecoveryOrCycleError(events);
});

test("a confirmed network transition checks immediately and every three seconds until recovery", async () => {
  const { events, evaluate } = schedulerHarness(61_000);
  evaluate(`
    state.current = "JP-CURRENT";
    state.currentSelectedAt = Date.now() - 60_000;
    mihomoRequest = async (method, requestPath) => {
      if (method !== "GET") throw new Error("Unexpected selector write");
      if (decodeURIComponent(requestPath) === "/proxies/" + config.groupName) {
        return { type: "Selector", now: "JP-CURRENT", all: ["JP-CURRENT"] };
      }
      return { alive: true };
    };
    runLocalCommand = async () => ({
      ok: true,
      stdout: Date.now() >= 1_021_000
        ? "gateway: 192.0.2.2\\ninterface: en0\\n"
        : "gateway: 192.0.2.1\\ninterface: en8\\n",
    });
    curlOpenAIPathProbe = async () => {
      const ok = Date.now() < 1_036_000 || Date.now() >= 1_045_000;
      log("info", "fake_path_probe", { ok });
      return { ok, status: ok ? "403" : "000", bytes: ok ? 4000 : 0, totalMs: 20 };
    };
  `);

  await evaluate("run()");

  const transition = events.find((event) => event.event === "network_path_changed");
  const recovered = events.find((event) => event.event === "network_transition_recovered");
  assert.equal(transition?.at, startedAt + 36_000);
  assert.equal(transition.graceUntil, transition.at + 20_000);
  assert.deepEqual(events.filter((event) => (
    event.event === "fake_path_probe" && event.at >= transition.at
  )).map((event) => event.at - transition.at), [0, 3_000, 6_000, 9_000]);
  assert.equal(events.filter((event) => event.event === "network_transition_probe_suppressed").length, 3);
  assert.equal(recovered?.at, transition.at + 9_000);
  assert.equal(evaluate("state.currentFailures"), 0);
  assert.equal(evaluate("networkTransitionActive()"), false);
  assertNoRecoveryOrCycleError(events);
});

test("concurrent current checks share one path probe and one state update", async () => {
  const { events, evaluate } = schedulerHarness();
  evaluate(`
    state.current = "JP-CURRENT";
    mihomoRequest = async (method, requestPath) => {
      if (method !== "GET") throw new Error("Unexpected selector write");
      if (decodeURIComponent(requestPath) === "/proxies/" + config.groupName) {
        return { type: "Selector", now: "JP-CURRENT", all: ["JP-CURRENT"] };
      }
      return { alive: true };
    };
    let releaseProbe;
    const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
    let probeCalls = 0;
    curlOpenAIPathProbe = async () => {
      probeCalls += 1;
      await probeGate;
      return { ok: true, status: "403", bytes: 4000, totalMs: 20 };
    };
    globalThis.checks = [checkCurrent(), checkCurrent(), checkCurrent()];
    releaseProbe();
  `);

  const results = await Promise.all(evaluate("checks"));

  assert.deepEqual(results, [true, true, true]);
  assert.equal(evaluate("probeCalls"), 1);
  assert.equal(evaluate('state.nodes["JP-CURRENT"].pathEvents.length'), 1);
  assert.equal(events.filter((event) => event.event === "current_probe").length, 1);
});
