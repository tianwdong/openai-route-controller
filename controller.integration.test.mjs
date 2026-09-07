import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const controllerPath = fileURLToPath(new URL("./controller.mjs", import.meta.url));
const unixCurlOnly = { skip: process.platform === "win32" && "fake curl executable uses a Unix shebang" };

function runController(env, stopEvent = null, stopCount = 1) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      stopEvent ? [controllerPath] : [controllerPath, "--once", "--shadow"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stopEvent && stdout.split(`"event":"${stopEvent}"`).length - 1 >= stopCount) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: Date.now()-started });
    });
  });
}

test(
  "loopback HTTP API transport authenticates and completes a shadow probe",
  { skip: process.platform === "win32" && "fake curl executable uses a Unix shebang" },
  async (context) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "openai-route-controller-test-"));
    context.after(() => rm(temporary, { recursive: true, force: true }));

    const fakeCurl = path.join(temporary, "fake-curl");
    await writeFile(
      fakeCurl,
      [
        "#!/usr/bin/env node",
        "const target = process.argv.at(-1) || '';",
        "process.stdout.write(target.includes('/codex/settings/usage')",
        "  ? '403\\t4000\\t0.010'",
        "  : '405\\t0\\t0.010');",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(fakeCurl, 0o700);

    const groupName = "OpenAI Test Selector";
    const nodeName = "JP-TEST";
    const secret = "integration-test-secret";
    const statePath = path.join(temporary, "state.json");
    await writeFile(statePath, JSON.stringify({
      version: 7,
      current: nodeName,
      currentSelectedAt: Date.now() - 10_000,
      selectionValidation: {
        from: "JP-OLD",
        to: nodeName,
        source: "manual",
        startedAt: Date.now() - 5_000,
        consecutiveSuccesses: 1,
        successThreshold: 2,
        failureThreshold: 2,
        failureAgeMs: 5_000,
        maxAgeMs: 30_000,
      },
      nodes: {},
    }));
    let authenticatedRequests = 0;
    let deleteRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${secret}`) {
        response.writeHead(401).end("unauthorized");
        return;
      }
      authenticatedRequests += 1;
      const requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      response.setHeader("content-type", "application/json");
      if (requestPath === "/proxies") {
        response.end(JSON.stringify({ proxies: { [nodeName]: { alive: true } } }));
        return;
      }
      if (requestPath === `/proxies/${groupName}`) {
        response.end(JSON.stringify({
          type: "Selector",
          now: nodeName,
          all: [nodeName],
        }));
        return;
      }
      if (requestPath === `/proxies/${nodeName}`) {
        response.end(JSON.stringify({ alive: true }));
        return;
      }
      if (requestPath === "/connections") {
        response.end(JSON.stringify({
          connections: [{
            id: "stale-connection",
            chains: ["JP-OLD", groupName],
            metadata: {
              sourceIP: "127.0.0.1",
              sourcePort: "50001",
              host: "chatgpt.com",
              destinationPort: "443",
            },
          }],
        }));
        return;
      }
      if (request.method === "DELETE" && requestPath === "/connections/stale-connection") {
        deleteRequests += 1;
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();

    const result = await runController({
      ...process.env,
      MIHOMO_API: `http://127.0.0.1:${address.port}`,
      MIHOMO_SECRET: secret,
      MIHOMO_SOCKET: "",
      MIHOMO_PROXY: "http://127.0.0.1:1",
      OPENAI_GROUP: groupName,
      STATE_PATH: statePath,
      CURL_PATH: fakeCurl,
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.find((event) => event.event === "controller_started")?.type, "Selector");
    assert.equal(events.find((event) => event.event === "current_probe")?.ok, true);
    assert.equal(
      events.find((event) => event.event === "stale_connections_draining")?.matched,
      1,
    );
    assert.equal(deleteRequests, 0);
    assert.ok(authenticatedRequests >= 3);
  },
);

test("HTTP API transport refuses a non-loopback controller", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openai-route-controller-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));

  const result = await runController({
    ...process.env,
    MIHOMO_API: "http://192.0.2.1:9097",
    MIHOMO_SOCKET: "",
    STATE_PATH: path.join(temporary, "state.json"),
  });

  assert.equal(result.code, 1, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.match(
    events.find((event) => event.event === "controller_failed")?.error || "",
    /Refusing non-loopback MIHOMO_API host/,
  );
});

async function probeScenario(context, { currentAlive = true, candidateBodyBytes = 4000, warm = false, activeTraffic = false, coldCandidate = false, main = false, failCurrentPath = false, candidateAlive = true, greenExtras = false } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "openai-route-probe-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const fakeCurl = path.join(temporary, "fake-curl");
  const requestLog = path.join(temporary, "curl.jsonl");
  const selectionFile = path.join(temporary, "selection.txt");
  const groupName = main ? "主代理自动选择" : "OpenAI 自动选择";
  await writeFile(selectionFile, "JP-CURRENT");
  const statePath = path.join(temporary, "state.json");
  await writeFile(requestLog, "");
  await writeFile(fakeCurl, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const proxy = args[args.indexOf('--proxy') + 1];",
    "const url = args.at(-1);",
    "fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify({ proxy, url }) + '\\n');",
    ...(main ? [
      "const selected = fs.readFileSync(process.env.FAKE_SELECTION_FILE, 'utf8');",
      `if (${failCurrentPath} && selected === 'JP-CURRENT' && proxy.endsWith(':18100')) { process.stdout.write('000\\t0\\t0.01'); process.exit(28); }`,
      `const mainBytes = proxy.endsWith(':18001') ? ${candidateBodyBytes} : 4000;`,
      "process.stdout.write(url.includes('/cdn-cgi/trace') ? `200\\t${mainBytes}\\t0.010` : '204\\t0\\t0.010');",
      "process.exit(0);",
    ] : []),
    "const isBody = url.includes('/codex/settings/usage');",
    "if (url.includes('/cdn-cgi/trace')) { process.stdout.write('200\\t300\\t0.010'); process.exit(0); }",
    `const bytes = proxy.includes(':17901') ? ${candidateBodyBytes} : 4000;`,
    "process.stdout.write(isBody ? `403\\t${bytes}\\t0.010` : '405\\t0\\t0.010');",
  ].join("\n"), { mode: 0o700 });
  const now = Date.now();
  const ages = warm === 4 ? [80_000, 60_000, 40_000, 20_000] : [60_000, 40_000, 20_000];
  const events = ages.map((age) => ({ at: now - age, ok: true, delay: 20 }));
  await writeFile(statePath, JSON.stringify({
    version: 7,
    current: "JP-CURRENT",
    currentSelectedAt: now - 300_000,
    ...(failCurrentPath ? { currentFailures: 3, currentFailureStartedAt: now - 60_000 } : {}),
    nodes: warm ? {
      "TW-CANDIDATE": {
        consecutiveSuccesses: events.length,
        lastProbeAt: now - 20_000,
        lastSuccessAt: now - 20_000,
        probeEvents: events,
        pathEvents: events,
      },
    } : {},
  }));
  let current = "JP-CURRENT";
  const selections = [];
  const delays = [];
  let deletes = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const requestPath = decodeURIComponent(url.pathname);
    response.setHeader("content-type", "application/json");
    if (request.method === "DELETE") {
      deletes += 1;
      response.writeHead(204).end();
    } else if (requestPath === "/connections") {
      response.end(JSON.stringify({ connections: [{
        id: "ongoing-stream",
        download: activeTraffic ? 1000 : 0,
        chains: ["JP-CURRENT", groupName],
        metadata: { sourceIP: "127.0.0.1", sourcePort: "51000", host: "chatgpt.com", destinationPort: "443" },
      }] }));
    } else if (requestPath === `/proxies/${groupName}` && request.method === "PUT") {
      let body = "";
      for await (const chunk of request) body += chunk;
      current = JSON.parse(body).name;
      await writeFile(selectionFile, current);
      const curlRequests = (await readFile(requestLog, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      selections.push({ name: current, curlRequests });
      response.writeHead(204).end();
    } else if (requestPath === `/proxies/${groupName}`) {
      response.end(JSON.stringify({ type: "Selector", now: current, all: ["TW-CANDIDATE", "JP-CURRENT", ...(coldCandidate ? ["US-COLD"] : []), ...(greenExtras ? ["KR-GREEN1", "KR-GREEN2", "KR-GREEN3"] : [])] }));
    } else if (requestPath === "/proxies") {
      response.end(JSON.stringify({ proxies: {
        "JP-CURRENT": { alive: currentAlive },
        "TW-CANDIDATE": { alive: candidateAlive },
        ...(coldCandidate ? { "US-COLD": { alive: false } } : {}),
        ...(greenExtras ? {"KR-GREEN1":{alive:true},"KR-GREEN2":{alive:true},"KR-GREEN3":{alive:true}} : {}),
      } }));
    } else if (requestPath.endsWith("/delay")) {
      delays.push(Object.fromEntries(url.searchParams));
      if (!/^https:\/\/chatgpt\.com\//.test(url.searchParams.get("url"))
        || !["200", "405"].includes(url.searchParams.get("expected"))) {
        response.writeHead(400).end(JSON.stringify({ error: "invalid delay parameters" }));
      } else {
        response.end(JSON.stringify({ delay: 20 }));
      }
    } else if (requestPath.startsWith("/proxies/")) {
      response.end(JSON.stringify({ alive: requestPath.endsWith("JP-CURRENT") ? currentAlive : candidateAlive }));
    } else {
      response.writeHead(404).end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    selections,
    delays,
    get deletes() { return deletes; },
    statePath,
    requestLog,
    env: {
      ...process.env,
      MIHOMO_API: `http://127.0.0.1:${server.address().port}`,
      MIHOMO_SOCKET: "",
      MIHOMO_SECRET: "",
      MIHOMO_PROXY: main ? "http://127.0.0.1:18100" : "http://127.0.0.1:7897",
      ROUTE_PROFILE: main ? "main" : "openai",
      OPENAI_GROUP: groupName,
      STATE_PATH: statePath,
      CURL_PATH: fakeCurl,
      FAKE_CURL_LOG: requestLog,
      FAKE_SELECTION_FILE: selectionFile,
      MACOS_SYSTEM_PROXY_SYNC: "0",
    },
  };
}

test("shadow scanning uses valid delay URLs and builds full-path hot-standby evidence", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { warm: true });
  const result = await runController(scenario.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.find((event) => event.event === "radar_batch")?.successful, ["TW-CANDIDATE"]);
  assert.deepEqual(events.find((event) => event.event === "hot_standby_radar")?.fastReady, ["TW-CANDIDATE"]);
  const saved = JSON.parse(await readFile(scenario.statePath, "utf8"));
  assert.equal(saved.nodes["TW-CANDIDATE"].pathEvents.length, 4);
  assert.equal(scenario.delays.length, 2);
  assert.equal(scenario.selections.length, 0);
});

test("active live traffic still refreshes one stale unavailable candidate without switching", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { warm: true, activeTraffic: true, coldCandidate: true });
  const result = await runController(scenario.env, "radar_batch");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  const radar = events.find((event) => event.event === "radar_batch");
  assert.deepEqual(radar?.tested, ["US-COLD"]);
  assert.equal(radar?.activeTraffic, true);
  assert.deepEqual(radar?.successful, ["US-COLD"]);
  assert.equal(scenario.selections.length, 0);
  assert.equal(scenario.deletes, 0);
});

test("a successful probe preserves recent transport failures and triggers recovery", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context);
  const saved = JSON.parse(await readFile(scenario.statePath, "utf8"));
  const now = Date.now();
  saved.passiveErrors = [
    { at: now - 45_000, key: "127.0.0.1:51001->chatgpt.com:443" },
    { at: now - 5_000, key: "127.0.0.1:51002->chatgpt.com:443" },
  ];
  await writeFile(scenario.statePath, JSON.stringify(saved));
  const result = await runController(scenario.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(events.find((event) => event.event === "current_probe")?.ok, true);
  assert.equal(
    events.find((event) => event.event === "shadow_recovery")?.reason,
    "passive_transport_errors",
  );
  assert.equal(scenario.selections.length, 0);
  assert.equal(scenario.deletes, 0);
});

test("expired transport failures do not trigger recovery after a successful probe", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context);
  const saved = JSON.parse(await readFile(scenario.statePath, "utf8"));
  const now = Date.now();
  saved.passiveErrors = [
    { at: now - 90_000, key: "127.0.0.1:51001->chatgpt.com:443" },
    { at: now - 70_000, key: "127.0.0.1:51002->chatgpt.com:443" },
  ];
  await writeFile(scenario.statePath, JSON.stringify(saved));
  const result = await runController(scenario.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(events.find((event) => event.event === "current_probe")?.ok, true);
  assert.equal(events.some((event) => event.event === "shadow_recovery"), false);
  assert.deepEqual(JSON.parse(await readFile(scenario.statePath, "utf8")).passiveErrors, []);
  assert.equal(scenario.selections.length, 0);
});

test("a candidate with green HEAD but a bad body never enters the live selector", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { currentAlive: false, candidateBodyBytes: 100 });
  const result = await runController(scenario.env, "recovery_exhausted");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(scenario.selections.length, 0);
  assert.equal(scenario.deletes, 0);
  assert.match(result.stdout, /"event":"recovery_exhausted"/);
});

test("a warm standby that fails isolated preflight never receives live traffic", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { currentAlive: false, candidateBodyBytes: 100, warm: 4 });
  const result = await runController(scenario.env, "recovery_exhausted");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.find((event) => event.event === "hot_standby_recovery_candidates")?.candidates, ["TW-CANDIDATE"]);
  assert.equal(events.find((event) => event.event === "candidate_preflight")?.ok, false);
  assert.equal(scenario.selections.length, 0);
  assert.equal(scenario.deletes, 0);
});

test("full candidate qualification finishes before one live switch and preserves streams", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { currentAlive: false });
  const result = await runController(scenario.env, "recovery_complete");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(scenario.selections.length, 1);
  assert.equal(scenario.selections[0].name, "TW-CANDIDATE");
  const preSwitchBodies = scenario.selections[0].curlRequests.filter((request) => (
    request.proxy === "http://127.0.0.1:17901" && request.url.includes("/codex/settings/usage")
  ));
  assert.equal(preSwitchBodies.length, 4);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(events.filter((event) => event.event === "post_switch_probe" && event.ok).length, 4);
  assert.equal(scenario.deletes, 0);
});


test("main profile ignores shared alive and uses isolated general HTTPS probes", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { main: true, currentAlive: false, warm: true });
  const result = await runController(scenario.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(events.find(e => e.event === "current_probe")?.ok, true);
  assert.equal(scenario.delays.length, 0);
  assert.equal(scenario.selections.length, 0);
  const requests = (await readFile(scenario.requestLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(requests.some(r => r.proxy.endsWith(":18001")));
  assert.ok(requests.every(r => !r.url.includes("chatgpt.com") && !r.proxy.includes(":179")));
});

test("main profile rejects a short-success candidate with a truncated body", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { main: true, failCurrentPath: true, candidateBodyBytes: 50 });
  const result = await runController(scenario.env, "recovery_exhausted");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"event":"recovery_exhausted"/);
  assert.equal(scenario.selections.length, 0);
  assert.equal(scenario.deletes, 0);
  const saved = JSON.parse(await readFile(scenario.statePath, "utf8"));
  assert.ok(saved.nextRecoveryAt > 0);
  assert.ok(saved.nodes["JP-CURRENT"].excludedUntil > 0);
});

test("main profile qualifies real requests before switching and validates four times afterward", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { main: true, failCurrentPath: true });
  const result = await runController(scenario.env, "recovery_complete");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(scenario.selections.length, 1);
  const bodies = scenario.selections[0].curlRequests.filter(r => r.proxy.endsWith(":18001") && r.url.includes("/cdn-cgi/trace"));
  assert.ok(bodies.length >= 4);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.event === "post_switch_probe" && e.ok).length, 4);
  assert.equal(scenario.delays.length, 0);
  assert.equal(scenario.deletes, 0);
});


test("independent qualification can recover a provider-false candidate without rewriting shared health", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, {currentAlive:false, candidateAlive:false});
  const result = await runController(scenario.env, "recovery_complete");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(scenario.selections.length, 1);
  assert.equal(scenario.selections[0].name, "TW-CANDIDATE");
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.event === "post_switch_probe" && e.ok).length, 4);
  assert.equal(scenario.delays.length, 0);
  assert.equal(scenario.deletes, 0);
});


test("exhausted recovery scans provider-false candidates even with a large green pool", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { currentAlive:false, coldCandidate:true, greenExtras:true });
  const saved = JSON.parse(await readFile(scenario.statePath, "utf8"));
  saved.recoveryExhaustions = 1;
  await writeFile(scenario.statePath, JSON.stringify(saved));
  const result = await runController(scenario.env, "recovery_complete");
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(events.some(e => e.event === "provider_cache_refresh_started" && e.alive >= 3 && e.candidates.includes("US-COLD")));
});

test("long-lived provider failure receives a real current-path confirmation", unixCurlOnly, async (context) => {
  const scenario = await probeScenario(context, { currentAlive:false });
  const saved = JSON.parse(await readFile(scenario.statePath, "utf8"));
  saved.providerAlive = false; saved.providerUnhealthyAt = Date.now()-60000;
  await writeFile(scenario.statePath, JSON.stringify(saved));
  const result = await runController(scenario.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  assert.ok(events.some(e => e.event === "provider_health_false_overridden"));
  assert.equal(events.find(e => e.event === "current_probe")?.ok, true);
});


test("slow system proxy checks do not block current-path monitoring", {skip:process.platform !== "darwin"}, async (context) => {
  const scenario=await probeScenario(context);
  const dir=await mkdtemp(path.join(os.tmpdir(),"slow-system-proxy-"));
  context.after(()=>rm(dir,{recursive:true,force:true}));
  const command=path.join(dir,"networksetup");
  await writeFile(command, "#!/usr/bin/env node\nsetTimeout(()=>process.stdout.write('Enabled: Yes\\nServer: 127.0.0.1\\nPort: 7897\\n'),4000);\n",{mode:0o700});
  const result=await runController({...scenario.env,MACOS_SYSTEM_PROXY_SYNC:"1",NETWORKSETUP_PATH:command},"current_probe",2);
  assert.equal(result.code,0,result.stderr||result.stdout);
  const probes=result.stdout.trim().split("\n").map(JSON.parse).filter(e=>e.event==="current_probe");
  assert.ok(probes.length>=2);
  assert.ok(result.elapsedMs<25000,`monitor delayed ${result.elapsedMs}ms`);
  assert.equal(scenario.selections.length,0);
});
