import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const sourceDirectory = process.env.STANDBY_SOURCE_DIR
  || path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(sourceDirectory, "controller.mjs"), "utf8");
const libSource = fs.readFileSync(path.join(sourceDirectory, "lib.mjs"), "utf8");
const start = source.indexOf("const args =");
const end = source.indexOf('process.on("SIGTERM"');
assert.ok(start >= 0 && end > start, "controller definitions must be present");

const baseTime = 1_000_000;
const current = "JP-CURRENT";
const incumbentA = "JP-INCUMBENT";
const incumbentB = "TW-INCUMBENT";
const explorer = "SG-STALE";
const nextExplorer = "US-NEXT";

function harness(options = {}) {
  const profile = options.profile || "openai";
  const groupName = profile === "main" ? "主代理自动选择" : "OpenAI 自动选择";
  const basePort = profile === "main" ? 18000 : 17900;
  const statePath = `/fixture/${profile}/state.json`;
  const storage = options.storage || new Map();
  const clock = { now: options.now ?? baseTime };
  const events = [];
  const apiCalls = [];
  const probes = [];
  const fixture = {
    current,
    candidates: [current, incumbentA, incumbentB, explorer, ...(options.extraExplorer ? [nextExplorer] : [])],
    phase: "hot",
    round: 0,
    behavior: () => "success",
    onProbe: null,
    beforeProbe: null,
    onRequest: null,
    inFlight: 0,
    maxInFlight: 0,
    portMap: [],
  };
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    os, path, Buffer, URL, URLSearchParams, Date: FixtureDate,
    fs: {
      async readFile(file) {
        if (!storage.has(file)) throw Object.assign(new Error("missing fixture state"), { code: "ENOENT" });
        return storage.get(file);
      },
      async mkdir() {},
      async writeFile(file, content) { storage.set(file, content); },
      async rename(from, to) { storage.set(to, storage.get(from)); storage.delete(from); },
    },
    process: {
      argv: ["node", "controller.mjs"], platform: "linux", pid: 1,
      env: { ROUTE_PROFILE: profile, STATE_PATH: statePath },
      stdout: { write(line) { events.push(JSON.parse(line)); } },
    },
    async fakeRequest(method, requestPath) {
      apiCalls.push({ method, path: requestPath });
      assert.equal(method, "GET", "standby and cold radar must not mutate the selector");
      if (fixture.onRequest) await fixture.onRequest({ method, path: requestPath });
      if (requestPath === `/proxies/${encodeURIComponent(groupName)}`) {
        return { type: "Selector", now: fixture.current, all: [...fixture.candidates] };
      }
      if (requestPath === "/connections") return { connections: [] };
      if (requestPath.includes("/delay?")) return { delay: 20 };
      throw new Error(`Unexpected fixture API path ${requestPath}`);
    },
    async fakeCurl(endpoint, proxyUrl) {
      const port = Number(new URL(proxyUrl).port);
      const name = fixture.portMap[port - basePort];
      assert.ok(name, `Probe crossed ${profile} port map: ${proxyUrl}`);
      const call = { name, endpoint: endpoint.url, proxyUrl, phase: fixture.phase, round: fixture.round, at: clock.now };
      probes.push(call);
      fixture.onProbe?.(call);
      fixture.inFlight += 1;
      fixture.maxInFlight = Math.max(fixture.maxInFlight, fixture.inFlight);
      if (fixture.beforeProbe) await fixture.beforeProbe(call);
      await new Promise(setImmediate);
      fixture.inFlight -= 1;
      const outcome = fixture.phase === "cold" ? "success" : fixture.behavior(call);
      const ok = outcome === "success";
      return {
        ok,
        status: ok ? (Array.isArray(endpoint.expected) ? endpoint.expected[0] : endpoint.expected) : "000",
        bytes: ok ? 4000 : 0,
        totalMs: 20,
        error: ok ? "" : outcome === "infrastructure" ? "Fixture listener unavailable" : "Fixture path failed",
        infrastructureError: outcome === "infrastructure",
      };
    },
  });
  vm.runInContext(libSource.replace(/^export /gm, ""), context, { filename: "lib.mjs" });
  vm.runInContext(source.slice(start, end), context, { filename: "controller.mjs" });
  const evaluate = code => vm.runInContext(code, context);
  evaluate(`
    mihomoRequest = fakeRequest;
    curlProbe = fakeCurl;
    sleep = async () => {};
    state.current = ${JSON.stringify(current)};
    state.currentSelectedAt = Date.now() - 120000;
  `);
  const state = () => JSON.parse(evaluate("JSON.stringify(state)"));
  const seedFull = (name, ok, at) => {
    evaluate(`recordCandidateProbe(${JSON.stringify({
      name, ok, status: ok ? "405/403" : "000", bytes: ok ? 4000 : 0,
      delay: 20, totalMs: 20, pathProbe: true, testedAt: at,
    })});`);
    evaluate(`state.nodes[${JSON.stringify(name)}].lastHotStandbyProbeAt = ${at};`);
  };
  async function hot(round, elapsedMs = round * 20000) {
    fixture.round = round;
    fixture.phase = "hot";
    fixture.portMap = [...new Set(fixture.candidates)].sort();
    clock.now = baseTime + elapsedMs;
    const count = events.length;
    await evaluate(`runHotStandbyRadar(${JSON.stringify(fixture.candidates)})`);
    const event = events.slice(count).find(item => item.event === "hot_standby_radar");
    if (event) assert.ok(event.tested.length <= 2, "standby round must use at most two candidates");
    assert.ok(fixture.maxInFlight <= 2, "standby HTTP concurrency must stay at most two");
    return event;
  }
  async function cold(names) {
    fixture.phase = "cold";
    fixture.portMap = [...new Set(fixture.candidates)].sort();
    await evaluate(`runRadar(${JSON.stringify(names)})`);
  }
  return { profile, groupName, basePort, statePath, storage, clock, fixture, events, apiCalls, probes,
    evaluate, state, seedFull, hot, cold };
}

function seedExploration(f) {
  for (const name of [incumbentA, incumbentB]) {
    for (let index = 0; index < 10; index += 1) f.seedFull(name, true, baseTime - 220000 + index * 20000);
    f.seedFull(name, false, baseTime - 1);
  }
  f.seedFull(explorer, false, baseTime - 700000);
  if (f.fixture.candidates.includes(nextExplorer)) f.seedFull(nextExplorer, false, baseTime - 650000);
  f.fixture.behavior = ({ name, round }) => (
    [incumbentA, incumbentB].includes(name) && round % 3 === 2 ? "failure" : "success"
  );
}

for (const profile of ["openai", "main"]) {
  test(`${profile} standby uses only its own endpoint and isolated port map`, async () => {
    const f = harness({ profile });
    await f.hot(0);
    const allowedHosts = profile === "main" ? ["www.gstatic.com", "www.cloudflare.com"] : ["chatgpt.com"];
    assert.ok(f.probes.length > 0);
    for (const probe of f.probes) {
      assert.ok(allowedHosts.includes(new URL(probe.endpoint).hostname));
      const index = [...f.fixture.candidates].sort().indexOf(probe.name);
      assert.equal(probe.proxyUrl, `http://127.0.0.1:${f.basePort + index}`);
    }
    assert.ok(f.apiCalls.some(call => call.path === `/proxies/${encodeURIComponent(f.groupName)}`));
    assert.equal(f.apiCalls.some(call => call.path === "/proxies" || call.path.includes("/delay?")), false);
    assert.equal(f.fixture.maxInFlight, 2);
    assert.equal(f.fixture.current, current);
  });
}

test("native cold success cannot replace the maintained full-path candidate with a path-bad node", async () => {
  const control = harness();
  const withShortSuccess = harness();
  for (const f of [control, withShortSuccess]) {
    for (let index = 0; index < 4; index += 1) f.seedFull(incumbentA, false, baseTime - 100000 + index * 20000);
    for (let index = 0; index < 12; index += 1) f.seedFull(incumbentB, true, baseTime - 300000 + index * 20000);
    f.seedFull(incumbentB, false, baseTime - 30000);
    f.seedFull(explorer, false, baseTime - 700000);
  }
  const pathsBefore = withShortSuccess.state().nodes[incumbentA].pathEvents;
  await withShortSuccess.cold([current, incumbentA]);
  assert.equal(withShortSuccess.apiCalls.filter(call => call.path.includes("/delay?")).length, 1);
  assert.deepEqual(withShortSuccess.state().nodes[incumbentA].pathEvents, pathsBefore);
  const baseline = await control.hot(0);
  const afterShort = await withShortSuccess.hot(0);
  assert.deepEqual(afterShort.tested, baseline.tested);
  assert.ok(afterShort.tested.includes(incumbentB));
  assert.equal(afterShort.tested.includes(incumbentA), false);
});

test("an exploration survives ready-but-not-fast rounds until four full passes spanning at least 45 seconds", async () => {
  const f = harness();
  seedExploration(f);
  const rounds = [];
  for (let round = 0; round < 4; round += 1) {
    const result = await f.hot(round);
    rounds.push(result);
    assert.ok(result.tested.includes(explorer));
    if (round < 3) assert.equal(result.fastReady.includes(explorer), false);
  }
  assert.ok(rounds[2].ready.includes(explorer), "third pass reaches ordinary readiness");
  assert.equal(rounds[2].explorationPending, explorer, "ordinary readiness must not release the fourth-pass slot");
  assert.ok(rounds[3].fastReady.includes(explorer));
  const samples = f.state().nodes[explorer].pathEvents.filter(event => event.at >= baseTime);
  assert.equal(samples.length, 4);
  assert.ok(samples.every(event => event.ok));
  assert.ok(samples.at(-1).at - samples[0].at >= 45000);
  assert.equal(f.state().hotStandbyExploration, null);
});

test("four successful controller probes spanning only 30 seconds cannot grant fast readiness", async () => {
  const f = harness();
  seedExploration(f);
  for (let round = 0; round < 4; round += 1) {
    const result = await f.hot(round, round * 10000);
    assert.ok(result.tested.includes(explorer));
    assert.equal(result.fastReady.includes(explorer), false);
  }
  assert.equal(f.state().nodes[explorer].pathEvents.filter(event => event.at >= baseTime).length, 4);
  assert.equal(f.state().hotStandbyExploration?.name, explorer);
  assert.ok((await f.hot(4, 45000)).fastReady.includes(explorer));
});

for (const outcome of ["failure", "infrastructure"]) {
  test(`${outcome} releases exploration and lets another stale candidate receive the next slot`, async () => {
    const f = harness({ extraExplorer: true });
    seedExploration(f);
    await f.hot(0);
    assert.equal(f.state().hotStandbyExploration?.name, explorer);
    const before = f.state().nodes[explorer].pathEvents;
    f.fixture.behavior = ({ name }) => name === explorer ? outcome : "success";
    await f.hot(1);
    assert.equal(f.state().hotStandbyExploration, null);
    assert.equal(f.state().nodes[explorer].lastHotStandbyProbeAt, baseTime + 20000);
    const after = f.state().nodes[explorer].pathEvents;
    if (outcome === "infrastructure") assert.deepEqual(after, before, "local failure must not penalize the node path");
    else assert.equal(after.at(-1).ok, false);
    const following = await f.hot(2);
    assert.equal(following.exploration, nextExplorer);
    assert.equal(f.state().hotStandbyExploration?.name, nextExplorer);
  });
}

test("candidate deletion during a probe releases the reservation without writing path failure", async () => {
  const f = harness({ extraExplorer: true });
  seedExploration(f);
  await f.hot(0);
  const pathsBefore = f.state().nodes[explorer].pathEvents;
  f.fixture.onProbe = call => {
    if (call.name === explorer) f.fixture.candidates = f.fixture.candidates.filter(name => name !== explorer);
  };
  await f.hot(1);
  assert.equal(f.state().hotStandbyExploration, null);
  assert.deepEqual(f.state().nodes[explorer].pathEvents, pathsBefore);
  f.fixture.onProbe = null;
  const following = await f.hot(2);
  assert.equal(following.tested.includes(explorer), false);
  assert.equal(following.exploration, nextExplorer);
});

test("manual selection of the explorer during probing releases its reservation and excludes the new current", async () => {
  const f = harness({ extraExplorer: true });
  seedExploration(f);
  await f.hot(0);
  f.fixture.onProbe = call => {
    if (call.name === explorer) f.fixture.current = explorer;
  };
  await f.hot(1);
  assert.equal(f.state().current, explorer);
  assert.equal(f.state().hotStandbyExploration, null);
  assert.ok(f.events.some(event => event.event === "hot_standby_exploration_finished" && event.reason === "selection_changed"));
  f.fixture.onProbe = null;
  const following = await f.hot(2);
  assert.equal(following.tested.includes(explorer), false);
  assert.notEqual(f.state().hotStandbyExploration?.name, explorer);
});

test("save and load preserve exploration and full history through restart before the fourth pass", async () => {
  const first = harness();
  seedExploration(first);
  first.evaluate(`state.nodes[${JSON.stringify(explorer)}].ejectionCount = 2;`);
  await first.hot(0);
  await first.hot(1);
  await first.evaluate("saveState()");
  const saved = JSON.parse(first.storage.get(first.statePath));
  assert.equal(saved.version, 7);
  assert.equal(saved.hotStandbyExploration?.name, explorer);
  const restarted = harness({ storage: first.storage, now: baseTime + 40000 });
  await restarted.evaluate("loadState()");
  assert.deepEqual(restarted.state().nodes[explorer].pathEvents, saved.nodes[explorer].pathEvents);
  assert.deepEqual(restarted.state().nodes[explorer].probeEvents, saved.nodes[explorer].probeEvents);
  assert.equal(restarted.state().nodes[explorer].ejectionCount, 2);
  assert.equal(restarted.state().nodes[explorer].lastHotStandbyProbeAt, baseTime + 20000);
  assert.deepEqual(restarted.state().hotStandbyExploration, saved.hotStandbyExploration);
  restarted.fixture.behavior = ({ name, round }) => (
    [incumbentA, incumbentB].includes(name) && round % 3 === 2 ? "failure" : "success"
  );
  assert.ok((await restarted.hot(2)).tested.includes(explorer));
  assert.ok((await restarted.hot(3)).fastReady.includes(explorer));
});

test("legacy version-seven state gains defaults without losing route, penalties or path history", async () => {
  const original = harness();
  seedExploration(original);
  const legacy = original.state();
  delete legacy.hotStandbyExploration;
  for (const node of Object.values(legacy.nodes)) delete node.lastHotStandbyProbeAt;
  legacy.nodes[explorer].ejectionCount = 3;
  original.storage.set(original.statePath, JSON.stringify(legacy));
  const loaded = harness({ storage: original.storage });
  await loaded.evaluate("loadState()");
  const state = loaded.state();
  assert.equal(state.version, 7);
  assert.equal(state.current, legacy.current);
  assert.equal(state.currentSelectedAt, legacy.currentSelectedAt);
  assert.deepEqual(state.nodes[explorer].pathEvents, legacy.nodes[explorer].pathEvents);
  assert.deepEqual(state.nodes[explorer].probeEvents, legacy.nodes[explorer].probeEvents);
  assert.equal(state.nodes[explorer].ejectionCount, 3);
  assert.equal(state.nodes[explorer].lastHotStandbyProbeAt, 0);
  assert.equal(state.hotStandbyExploration, null);
});

test("one candidate API rejection waits for its sibling and retains the sibling's real path success", async () => {
  const f = harness();
  seedExploration(f);
  const before = f.state();
  let groupReads = 0;
  let releaseSibling;
  const siblingGate = new Promise(resolve => { releaseSibling = resolve; });
  f.fixture.beforeProbe = () => siblingGate;
  f.fixture.onRequest = ({ path: requestPath }) => {
    if (requestPath === `/proxies/${encodeURIComponent(f.groupName)}` && ++groupReads === 2) {
      throw new Error("Fixture candidate API rejected");
    }
  };
  let settled = false;
  const pending = f.hot(0);
  pending.then(() => { settled = true; }, () => { settled = true; });
  const expectedRejection = assert.rejects(pending, /Fixture candidate API rejected/);
  await new Promise(setImmediate);
  const returnedBeforeSibling = settled;
  const goodName = f.probes[0]?.name;
  releaseSibling();
  await expectedRejection;
  assert.equal(returnedBeforeSibling, false, "the batch cannot return while its sibling still probes");
  assert.ok(goodName, "one candidate must have reached the independent probe");
  assert.equal(f.fixture.inFlight, 0);
  assert.ok(f.fixture.maxInFlight <= 2);
  const after = f.state();
  assert.equal(after.nodes[goodName].pathEvents.length, before.nodes[goodName].pathEvents.length + 1);
  assert.equal(after.nodes[goodName].pathEvents.at(-1).ok, true);
  const rejectedName = Object.keys(after.nodes).find(name => (
    name !== goodName && after.nodes[name].lastHotStandbyProbeAt === baseTime
  ));
  assert.ok(rejectedName);
  assert.deepEqual(after.nodes[rejectedName].pathEvents, before.nodes[rejectedName].pathEvents);
  assert.equal(after.hotStandbyExploration, null);
});

test("a final group refresh failure preserves completed independent path results", async () => {
  const f = harness();
  seedExploration(f);
  const before = f.state();
  let groupReads = 0;
  f.fixture.onRequest = ({ path: requestPath }) => {
    if (requestPath !== `/proxies/${encodeURIComponent(f.groupName)}`) return;
    groupReads += 1;
    // Two successful independent probes each read their map before and after;
    // the following read belongs to the final controller refresh.
    if (groupReads === 5) throw new Error("Fixture final group refresh failed");
  };
  await assert.rejects(f.hot(0), /Fixture final group refresh failed/);
  assert.equal(groupReads, 5);
  assert.equal(f.fixture.inFlight, 0);
  const after = f.state();
  const completedNames = [...new Set(f.probes.map(probe => probe.name))];
  assert.equal(completedNames.length, 2);
  for (const name of completedNames) {
    assert.equal(after.nodes[name].pathEvents.length, before.nodes[name].pathEvents.length + 1);
    assert.equal(after.nodes[name].pathEvents.at(-1).ok, true);
  }
  assert.equal(after.hotStandbyExploration, null);
});
