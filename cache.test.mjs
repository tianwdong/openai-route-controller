import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The override permits replaying this same regression against a frozen runtime.
const controllerPath = process.env.CACHE_CONTROLLER_SOURCE
  || fileURLToPath(new URL("./controller.mjs", import.meta.url));
const libPath = process.env.CACHE_LIB_SOURCE || path.join(path.dirname(controllerPath), "lib.mjs");
const source = fs.readFileSync(controllerPath, "utf8");
const libSource = fs.readFileSync(libPath, "utf8");
const start = source.indexOf("const args =");
const end = source.indexOf('process.on("SIGTERM"');
assert.ok(start >= 0 && end > start, "controller definitions must be present");

const origin = "KR-ORIGIN";
const greens = ["JP-GREEN-1", "JP-GREEN-2", "JP-GREEN-3"];
const falseFailures = ["TW-COLD-1", "TW-COLD-2", "TW-COLD-3"];
const healthy = "TW-ZHEALTHY-FALSE";

function fixture() {
  const candidates = [origin, ...greens, ...falseFailures, healthy];
  const sortedCandidates = [...candidates].sort();
  const nativeProxies = Object.fromEntries(candidates.map(name => [name, { alive: greens.includes(name) }]));
  let selected = origin;
  let inFlight = 0;
  let maxInFlight = 0;
  const events = [];
  const apiCalls = [];
  const probes = [];
  const context = vm.createContext({
    os, path, Buffer, URL, URLSearchParams, Date,
    process: {
      argv: ["node", "controller.mjs"], env: {}, platform: "linux",
      stdout: { write(line) { events.push(JSON.parse(line)); } },
    },
    async fakeRequest(method, requestPath, body) {
      apiCalls.push({ method, path: requestPath, body });
      if (method === "PUT") { selected = body.name; return null; }
      if (requestPath === "/connections") return { connections: [] };
      if (requestPath === "/proxies") return { proxies: nativeProxies };
      if (requestPath.includes("/delay?")) throw new Error("Native delay stays unavailable");
      if (requestPath === `/proxies/${encodeURIComponent("OpenAI 自动选择")}`) {
        return { type: "Selector", now: selected, all: [...candidates] };
      }
      const name = decodeURIComponent(requestPath.slice("/proxies/".length));
      assert.ok(nativeProxies[name], `Unexpected API path ${requestPath}`);
      return nativeProxies[name];
    },
    async fakeCurl(endpoint, proxyUrl = "http://127.0.0.1:7897") {
      const port = Number(new URL(proxyUrl).port);
      const isolated = port !== 7897;
      const name = isolated ? sortedCandidates[port - 17900] : selected;
      assert.ok(name, `Unknown isolated route ${proxyUrl}`);
      probes.push({ name, isolated, url: endpoint.url });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(setImmediate);
      inFlight -= 1;
      const ok = name === healthy;
      return {
        ok,
        status: ok ? (Array.isArray(endpoint.expected) ? endpoint.expected[0] : endpoint.expected) : "000",
        bytes: ok ? 4000 : 0, totalMs: 10,
        error: ok ? "" : "Fixture full path failed", infrastructureError: false,
      };
    },
  });
  vm.runInContext(libSource.replace(/^export /gm, ""), context, { filename: libPath });
  vm.runInContext(source.slice(start, end), context, { filename: controllerPath });
  const evaluate = code => vm.runInContext(code, context);
  evaluate(`
    mihomoRequest = fakeRequest;
    curlProbe = fakeCurl;
    sleep = async () => {};
    state.current = ${JSON.stringify(origin)};
    state.currentSelectedAt = Date.now() - 120000;
    state.currentFailures = 4;
    state.currentFailureStartedAt = Date.now() - 70000;
    state.lastFailureAt = Date.now() - 1000;
    state.providerAlive = false;
    state.providerUnhealthyAt = Date.now() - 70000;
  `);
  return { evaluate, events, apiCalls, probes, nativeProxies, candidates,
    selected: () => selected, maxInFlight: () => maxInFlight };
}

test("first recovery independently finds a false-but-healthy node behind three false failures despite a green pool", async () => {
  const f = fixture();
  assert.equal(f.evaluate("state.recoveryExhaustions"), 0);
  assert.equal(Object.values(f.nativeProxies).filter(proxy => proxy.alive).length, 3);
  assert.equal(await f.evaluate('recover("provider_health_unavailable")'), true);
  assert.equal(f.selected(), healthy);
  assert.equal(f.nativeProxies[healthy].alive, false, "success must not require changing native health");
  assert.equal(f.events.find(event => event.event === "provider_candidate_filter")?.refreshAttempted, 0);
  const qualification = f.events.find(event => event.event === "qualification_round" && event.successful.includes(healthy));
  assert.equal(qualification?.sampleCounts[healthy], 3);
  assert.equal(f.events.filter(event => event.event === "post_switch_probe" && event.node === healthy && event.ok).length, 4);
  assert.equal(f.apiCalls.filter(call => call.method === "PUT").length, 1);
  assert.equal(f.apiCalls.filter(call => call.path.includes("/delay?")).length, 0);
  assert.equal(f.maxInFlight(), 3, "full-pool traversal retains three concurrent qualification requests");
});

test("standby independently probes native-false candidates without requiring native delay and retains two-way concurrency", async () => {
  const f = fixture();
  f.evaluate(`
    state = recordNodePathProbe(state, ${JSON.stringify(healthy)}, {
      ok: true, status: "405/200", bytes: 4000, totalMs: 10,
    }, Date.now() - 1000);
  `);
  await f.evaluate(`runHotStandbyRadar(${JSON.stringify(f.candidates)})`);
  assert.equal(f.probes.filter(probe => probe.name === healthy && probe.isolated).length, 3);
  assert.equal(f.apiCalls.filter(call => call.path.includes("/delay?")).length, 0);
  assert.equal(f.apiCalls.filter(call => call.path === "/proxies").length, 0);
  assert.equal(f.maxInFlight(), 2);
  assert.equal(f.nativeProxies[healthy].alive, false);
  assert.equal(f.apiCalls.filter(call => call.method === "PUT").length, 0);
});

test("native-false cooling nodes stay outside normal qualification when emergency reuse is ineligible", async () => {
  const f = fixture();
  const excludedUntil = Date.now() + 60000;
  f.evaluate(`state.nodes[${JSON.stringify(healthy)}] = { excludedUntil: ${excludedUntil} };`);
  assert.equal(await f.evaluate('recover("intermittent_current_path_failures")'), false);
  assert.equal(f.selected(), origin);
  assert.equal(f.probes.some(probe => probe.name === healthy), false);
  assert.equal(f.events.some(event => event.event === "qualification_round" && event.tested.includes(healthy)), false);
  assert.equal(f.evaluate(`state.nodes[${JSON.stringify(healthy)}].excludedUntil`), excludedUntil);
  assert.equal(f.apiCalls.filter(call => call.method === "PUT").length, 0);
  assert.ok(f.maxInFlight() <= 3);
});
