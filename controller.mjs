#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import {
  addPassiveError,
  allowsEmergencyCoolingReuse,
  beginSelectionValidation,
  buildRecoveryCandidatePools,
  currentPathInstabilityReason,
  ejectNodeOnce,
  filterProviderAliveCandidates,
  hasRecentStablePathEvidence,
  hasRecentTraffic,
  isGroupConnection,
  isOpenAIPathError,
  isRealPathProbeResult,
  latestPathProbeWasSuccessful,
  newWatchdogState,
  nodeProbeProxyUrl,
  nodeRegion,
  normalizeState,
  networkPathChanged,
  parseDefaultNetworkPath,
  parseNetworkSetupProxy,
  passiveErrorKey,
  pickEmergencyRecoveryBatch,
  pickHotStandbyProbeBatch,
  pickProviderRefreshBatch,
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
  recoveryBackoffDelayForReason,
  recoveryReason,
  resetStateForNetworkTransition,
  restoreRecoveryOrigin,
  shouldWakeRecoveryForStandby,
  systemProxyNeedsRepair,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shadowMode = args.has("--shadow") || args.has("--dry-run") || args.has("--once");
const onceMode = args.has("--once");

function envEnabled(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || "");
}

const defaultStatePath = process.platform === "win32"
  ? path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "OpenAI Route Controller/state.json",
    )
  : process.platform === "darwin"
    ? path.join(
        os.homedir(),
        "Library/Application Support/OpenAI Route Controller/state.json",
      )
    : path.join(
        process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
        "openai-route-controller/state.json",
      );

const config = {
  socketPath: process.env.MIHOMO_SOCKET
    || (process.platform === "darwin" ? "/tmp/verge/verge-mihomo.sock" : ""),
  apiUrl: process.env.MIHOMO_API || "",
  apiSecret: process.env.MIHOMO_SECRET || "",
  groupName: process.env.OPENAI_GROUP || "OpenAI 自动选择",
  statePath: process.env.STATE_PATH || defaultStatePath,
  proxyUrl: process.env.MIHOMO_PROXY || "http://127.0.0.1:7897",
  curlPath: process.env.CURL_PATH
    || (process.platform === "win32" ? "curl.exe" : "curl"),
  macosSystemProxySync: process.platform === "darwin"
    && envEnabled("MACOS_SYSTEM_PROXY_SYNC"),
  macosProxyServices: (process.env.MACOS_PROXY_SERVICES || "Wi-Fi")
    .split(",")
    .map((service) => service.trim())
    .filter(Boolean),
  networkSetupPath: process.env.NETWORKSETUP_PATH || "/usr/sbin/networksetup",
  routePath: process.env.ROUTE_PATH || "/sbin/route",
  systemProxyCheckIntervalMs: 30_000,
  networkEnvironmentIntervalMs: 5_000,
  networkTransitionGraceMs: Math.max(
    5_000,
    Number(process.env.NETWORK_TRANSITION_GRACE_MS) || 20_000,
  ),
  networkTransitionProbeIntervalMs: 3_000,
  currentIntervalMs: 20_000,
  activeCurrentIntervalMs: 30_000,
  selectionValidationIntervalMs: 5_000,
  activityIntervalMs: 10_000,
  radarIntervalMs: 60_000,
  hotStandbyIntervalMs: 20_000,
  loopIntervalMs: 1_000,
  passiveWindowMs: 60_000,
  retryDelayMs: 10_000,
  failureThreshold: 3,
  minFailureAgeMs: 45_000,
  selectionFailureThreshold: 2,
  selectionFailureAgeMs: 5_000,
  selectionValidationMaxAgeMs: 30_000,
  hardFailureThreshold: 4,
  hardFailureAgeMs: 60_000,
  activeValidationFailureThreshold: 2,
  activeRecoveryFailureThreshold: 3,
  activeFailureAgeMs: 20_000,
  passiveThreshold: 2,
  activeTrafficGraceMs: 30_000,
  activeRadarQuietMs: 2 * 60_000,
  intermittentFailureThreshold: 3,
  intermittentFailureWindowMs: 5 * 60_000,
  slowFailureThreshold: 4,
  slowFailureWindowMs: 10 * 60_000,
  drainingErrorGraceMs: 60_000,
  holdAfterSwitchMs: 5 * 60_000,
  curlTimeoutSeconds: 7,
  nodeTestTimeoutMs: 3_000,
  qualificationBatchSize: 3,
  emergencyBatchSize: 3,
  providerRefreshAliveFloor: 3,
  providerRefreshBatchSize: 3,
  providerRefreshMinProbeAgeMs: 30_000,
  qualificationPasses: 3,
  qualificationSpacingMs: 800,
  qualificationWindowMs: 90_000,
  postSwitchProbeCount: 4,
  postSwitchSpacingMs: 1_500,
  radarColdBatchSize: 2,
  activeRadarColdBatchSize: 1,
  hotStandbyCount: 2,
  hotStandbyRequiredPasses: 3,
  hotStandbyProbeTtlMs: 45_000,
  hotStandbyHistoryWindowMs: 90_000,
  hotStandbyMinSpanMs: 35_000,
  hotStandbyFastPathRequiredPasses: 4,
  hotStandbyFastPathHistoryWindowMs: 10 * 60_000,
  hotStandbyFastPathProbeTtlMs: 2 * 60_000,
  hotStandbyFastPathMinSpanMs: 45_000,
  providerFalseConfirmationWindowMs: 60_000,
  rollingWindowMs: 10 * 60_000,
  pathHistoryWindowMs: 6 * 60 * 60_000,
  ejectionDurationsMs: [15 * 60_000, 30 * 60_000, 60 * 60_000],
  recoveryBackoffMs: [10_000, 30_000, 60_000, 5 * 60_000],
  providerUnavailableBackoffMs: [10_000, 30_000, 30_000],
  endpoint: {
    url: "https://chatgpt.com/backend-api/codex/responses",
    expected: "405",
    minBytes: 0,
  },
  traceEndpoint: {
    url: "https://chatgpt.com/cdn-cgi/trace",
    expected: "200",
    minBytes: 100,
  },
  bodyEndpoint: {
    url: "https://chatgpt.com/codex/settings/usage",
    expected: ["200", "403"],
    minBytes: 3_000,
  },
};

let state = newWatchdogState();
let stopped = false;
let urgentRecovery = false;
let logRequest = null;
let openAIConnectionBytes = new Map();
let drainingConnectionRoutes = new Map();
let hotStandbyProbeRound = 0;
let recoveryStartedWithActiveTraffic = false;
let networkPathInitialized = false;
let currentNetworkPath = null;
let networkTransitionUntil = 0;
let lastNetworkEnvironmentCheckAt = 0;
let lastSystemProxyCheckAt = 0;

function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  })}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runLocalCommand(command, commandArgs, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout, stderr, error: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, stdout, stderr, error: error.message }));
    child.on("close", (code) => finish({
      ok: code === 0,
      code,
      stdout,
      stderr,
      error: code === 0 ? "" : stderr.trim() || `Exited with status ${code}`,
    }));
  });
}

function networkTransitionActive(now = Date.now()) {
  return now < networkTransitionUntil;
}

function desiredSystemProxy() {
  const target = new URL(config.proxyUrl);
  if (target.protocol !== "http:" || target.username || target.password) {
    throw new Error("macOS system proxy sync requires an unauthenticated http:// proxy URL");
  }
  const port = Number(target.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid proxy port in ${config.proxyUrl}`);
  }
  return { server: target.hostname, port };
}

const macosProxyKinds = [
  { name: "http", get: "-getwebproxy", set: "-setwebproxy" },
  { name: "https", get: "-getsecurewebproxy", set: "-setsecurewebproxy" },
  { name: "socks", get: "-getsocksfirewallproxy", set: "-setsocksfirewallproxy" },
];

async function ensureMacosSystemProxy({ force = false } = {}) {
  if (!config.macosSystemProxySync) return { checked: 0, repaired: 0 };
  const now = Date.now();
  if (!force && now - lastSystemProxyCheckAt < config.systemProxyCheckIntervalMs) {
    return { checked: 0, repaired: 0 };
  }
  lastSystemProxyCheckAt = now;

  let desired;
  try {
    desired = desiredSystemProxy();
  } catch (error) {
    log("error", "system_proxy_config_invalid", { error: error.message });
    return { checked: 0, repaired: 0 };
  }

  let checked = 0;
  let repaired = 0;
  for (const service of config.macosProxyServices) {
    const needed = [];
    for (const kind of macosProxyKinds) {
      const result = await runLocalCommand(
        config.networkSetupPath,
        [kind.get, service],
      );
      if (!result.ok) {
        log("warning", "system_proxy_check_failed", {
          service,
          kind: kind.name,
          error: result.error,
        });
        continue;
      }
      checked += 1;
      if (systemProxyNeedsRepair(parseNetworkSetupProxy(result.stdout), desired)) {
        needed.push(kind);
      }
    }
    if (needed.length === 0) continue;
    if (shadowMode) {
      log("warning", "shadow_system_proxy_repair_needed", {
        service,
        kinds: needed.map((kind) => kind.name),
        server: desired.server,
        port: desired.port,
      });
      continue;
    }

    const repairedKinds = [];
    for (const kind of needed) {
      const result = await runLocalCommand(
        config.networkSetupPath,
        [kind.set, service, desired.server, String(desired.port)],
      );
      if (!result.ok) {
        log("warning", "system_proxy_repair_failed", {
          service,
          kind: kind.name,
          error: result.error,
        });
        continue;
      }
      const verification = await runLocalCommand(
        config.networkSetupPath,
        [kind.get, service],
      );
      const verified = verification.ok
        && !systemProxyNeedsRepair(
          parseNetworkSetupProxy(verification.stdout),
          desired,
        );
      if (verified) {
        repaired += 1;
        repairedKinds.push(kind.name);
      } else {
        log("warning", "system_proxy_repair_failed", {
          service,
          kind: kind.name,
          error: verification.error || "verification mismatch",
        });
      }
    }
    if (repairedKinds.length > 0) {
      log("warning", "system_proxy_repaired", {
        service,
        kinds: repairedKinds,
        server: desired.server,
        port: desired.port,
      });
    }
  }
  return { checked, repaired };
}

async function refreshNetworkEnvironment({ force = false } = {}) {
  if (process.platform !== "darwin") return false;
  const now = Date.now();
  if (!force
    && now - lastNetworkEnvironmentCheckAt < config.networkEnvironmentIntervalMs) {
    return false;
  }
  lastNetworkEnvironmentCheckAt = now;

  const route = await runLocalCommand(config.routePath, ["-n", "get", "default"]);
  const nextPath = route.ok ? parseDefaultNetworkPath(route.stdout) : null;
  let changed = false;
  if (!networkPathInitialized) {
    networkPathInitialized = true;
    currentNetworkPath = nextPath;
    log("info", "network_path_observed", { path: nextPath });
  } else if (networkPathChanged(currentNetworkPath, nextPath)) {
    const previousPath = currentNetworkPath;
    currentNetworkPath = nextPath;
    changed = true;
    networkTransitionUntil = now + config.networkTransitionGraceMs;
    state = resetStateForNetworkTransition(state, now);
    urgentRecovery = true;
    log("warning", "network_path_changed", {
      from: previousPath,
      to: nextPath,
      graceUntil: networkTransitionUntil,
    });
  }

  await ensureMacosSystemProxy({ force: force || changed });
  return changed;
}

async function loadState() {
  try {
    state = normalizeState(JSON.parse(await fs.readFile(config.statePath, "utf8")));
  } catch (error) {
    state = newWatchdogState();
    if (error.code !== "ENOENT") {
      log("warning", "state_load_failed", { error: error.message });
    }
  }
}

async function saveState() {
  const directory = path.dirname(config.statePath);
  const temporary = `${config.statePath}.tmp-${process.pid}`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, config.statePath);
}

function createMihomoRequest(method, requestPath, encodedBody = null) {
  const headers = {};
  if (encodedBody != null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(encodedBody);
  }
  if (config.apiSecret) headers.authorization = `Bearer ${config.apiSecret}`;

  if (config.apiUrl) {
    const base = `${config.apiUrl.replace(/\/+$/, "")}/`;
    const target = new URL(requestPath.replace(/^\/+/, ""), base);
    if (!["http:", "https:"].includes(target.protocol)) {
      throw new Error(`Unsupported MIHOMO_API protocol: ${target.protocol}`);
    }
    const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      throw new Error(`Refusing non-loopback MIHOMO_API host: ${target.hostname}`);
    }
    const client = target.protocol === "https:" ? https : http;
    return client.request(target, { method, headers });
  }

  if (!config.socketPath) {
    throw new Error("Set MIHOMO_SOCKET or MIHOMO_API before starting the controller");
  }
  return http.request({
    socketPath: config.socketPath,
    path: requestPath,
    method,
    headers,
  });
}

function mihomoRequest(method, requestPath, body, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const encodedBody = body == null ? null : JSON.stringify(body);
    let request;
    try {
      request = createMihomoRequest(method, requestPath, encodedBody);
    } catch (error) {
      reject(error);
      return;
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Mihomo request timed out: ${method} ${requestPath}`));
    });

    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Mihomo ${response.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        if (!text) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      });
    });

    request.on("error", reject);
    if (encodedBody) request.write(encodedBody);
    request.end();
  });
}

async function refreshGroup(source = "mihomo") {
  const group = await mihomoRequest(
    "GET",
    `/proxies/${encodeURIComponent(config.groupName)}`,
  );
  const candidates = Array.isArray(group?.all) ? group.all : [];
  if (!group?.now || candidates.length === 0) {
    throw new Error(`Group ${config.groupName} has no current node or candidates`);
  }
  if (!shadowMode && group.type !== "Selector") {
    throw new Error(
      `Group ${config.groupName} must be Selector before live controller; got ${group.type}`,
    );
  }

  if (state.current !== group.now) {
    const previous = state.current;
    const changedAt = Date.now();
    state.current = group.now;
    state.currentSelectedAt = changedAt;
    state.currentFailures = 0;
    state.currentFailureStartedAt = 0;
    state.nextRecoveryAt = 0;
    state.recoveryExhaustions = 0;
    state.passiveErrors = [];
    state.holdUntil = 0;
    state.providerAlive = null;
    state.providerUnhealthyAt = 0;
    state.selectionValidation = null;
    let drainingConnections = 0;
    if (source === "mihomo") {
      state = beginSelectionValidation(
        state,
        previous,
        group.now,
        previous ? "manual" : "startup",
        changedAt,
      );
      urgentRecovery = true;
      if (previous) {
        try {
          const drain = await beginOpenAIConnectionDrain(group.now);
          drainingConnections = drain.matched;
        } catch (error) {
          log("warning", "manual_selection_drain_failed", {
            from: previous,
            to: group.now,
            error: error.message,
          });
        }
      }
    }
    log("info", "group_selection_changed", {
      from: previous,
      to: group.now,
      source,
      validation: state.selectionValidation?.source || null,
      drainingConnections,
    });
  }
  return { group, candidates };
}

function currentProbeDelay() {
  if (networkTransitionActive()) return config.networkTransitionProbeIntervalMs;
  if (state.selectionValidation) return config.selectionValidationIntervalMs;
  return hasRecentTraffic(state, Date.now(), config.activeRadarQuietMs)
    ? config.activeCurrentIntervalMs
    : config.currentIntervalMs;
}

async function readProxyAlive(name) {
  const proxy = await mihomoRequest(
    "GET",
    `/proxies/${encodeURIComponent(name)}`,
  );
  return typeof proxy?.alive === "boolean" ? proxy.alive : null;
}

function curlProbe(endpoint, proxyUrl = config.proxyUrl) {
  return new Promise((resolve) => {
    const child = spawn(config.curlPath, [
      "--silent",
      "--show-error",
      "--location",
      "--compressed",
      "--connect-timeout",
      "4",
      "--max-time",
      String(config.curlTimeoutSeconds),
      "--proxy",
      proxyUrl,
      "--noproxy",
      "",
      "--output",
      os.devNull,
      "--write-out",
      "%{http_code}\t%{size_download}\t%{time_total}",
      endpoint.url,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let finished = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      resolve({ ok: false, status: "000", bytes: 0, totalMs: null, error: error.message });
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      const [status = "000", bytesText = "0", totalText = "0"] = stdout.trim().split("\t");
      const bytes = Number(bytesText);
      const totalMs = Math.round(Number(totalText) * 1_000);
      const expectedStatuses = Array.isArray(endpoint.expected)
        ? endpoint.expected
        : [endpoint.expected];
      resolve({
        ok: code === 0
          && expectedStatuses.includes(status)
          && bytes >= endpoint.minBytes,
        status,
        bytes,
        totalMs: Number.isFinite(totalMs) ? totalMs : null,
        error: stderr.trim().slice(0, 300),
        infrastructureError: code === 7,
      });
    });
  });
}

async function curlOpenAIPathProbe(proxyUrl = config.proxyUrl) {
  const entry = await curlProbe(config.endpoint, proxyUrl);
  if (!entry.ok) return entry;
  const body = await curlProbe(config.bodyEndpoint, proxyUrl);
  return {
    ok: body.ok,
    status: `${entry.status}/${body.status}`,
    bytes: entry.bytes + body.bytes,
    totalMs: (entry.totalMs ?? 0) + (body.totalMs ?? 0),
    error: body.error,
    infrastructureError: body.infrastructureError,
  };
}

async function probeNodePath(name) {
  const requestPath = `/proxies/${encodeURIComponent(config.groupName)}`;
  const before = await mihomoRequest("GET", requestPath);
  const candidates = [...new Set(before.all || [])].sort();
  const proxyUrl = nodeProbeProxyUrl(name, candidates);
  const result = await curlOpenAIPathProbe(proxyUrl);
  const after = await mihomoRequest("GET", requestPath);
  const currentCandidates = [...new Set(after.all || [])].sort();
  if (JSON.stringify(candidates) !== JSON.stringify(currentCandidates)) {
    return {
      name,
      ok: false,
      status: "probe_route_changed",
      infrastructureError: true,
      error: "Candidate routes changed during the isolated probe",
      testedAt: Date.now(),
    };
  }
  return {
    ...result,
    name,
    delay: result.totalMs,
    testedAt: Date.now(),
    pathProbe: true,
  };
}

function recordCandidateProbe(result) {
  if (result.infrastructureError) {
    log("warning", "candidate_probe_unavailable", {
      node: result.name,
      error: result.error,
    });
    return;
  }
  state = recordNodeProbe(
    state, result.name, result, result.testedAt, config.rollingWindowMs,
  );
  if (result.pathProbe) {
    state = recordNodePathProbe(
      state, result.name, result, result.testedAt, config.pathHistoryWindowMs,
    );
  }
}

async function preflightCandidate(name, reason) {
  const result = await probeNodePath(name);
  recordCandidateProbe(result);
  if (!result.ok && !result.infrastructureError) {
    state = ejectNodeOnce(state, name, Date.now(), config.ejectionDurationsMs);
  }
  log(result.ok ? "info" : "warning", "candidate_preflight", {
    node: name,
    reason,
    ok: result.ok,
    status: result.status,
    totalMs: result.totalMs,
    infrastructureError: result.infrastructureError || undefined,
    error: result.error || undefined,
  });
  return result.ok;
}

async function checkCurrent() {
  const node = state.current;
  const transitionProbe = networkTransitionActive();
  let reportedProviderAlive = null;
  try {
    reportedProviderAlive = await readProxyAlive(node);
  } catch (error) {
    log("warning", "provider_health_query_failed", {
      node,
      error: error.message,
    });
  }
  let providerAlive = reportedProviderAlive;
  let result;
  if (
    reportedProviderAlive === false
    && (transitionProbe || latestPathProbeWasSuccessful(
      state,
      node,
      Date.now(),
      config.providerFalseConfirmationWindowMs,
    ))
  ) {
    log("warning", "provider_health_confirmation_started", {
      node,
      reportedAlive: false,
    });
    result = await curlOpenAIPathProbe();
    if (result.ok) {
      providerAlive = true;
      log("warning", "provider_health_false_overridden", {
        node,
        status: result.status,
        bytes: result.bytes,
        totalMs: result.totalMs,
      });
    } else {
      log("warning", "provider_health_confirmed_unavailable", {
        node,
        status: result.status,
        totalMs: result.totalMs,
        error: result.error || undefined,
      });
    }
  } else if (reportedProviderAlive === false) {
    result = {
        ok: false,
        status: "provider_unhealthy",
        bytes: 0,
        totalMs: 0,
        error: "Mihomo reports this proxy as unavailable",
      };
  } else {
    result = await curlOpenAIPathProbe();
  }
  const now = Date.now();
  if (!result.ok && networkTransitionActive(now)) {
    log("warning", "network_transition_probe_suppressed", {
      node,
      status: result.status,
      providerAlive,
      reportedProviderAlive,
      graceUntil: networkTransitionUntil,
      error: result.error || undefined,
    });
    return false;
  }
  if (result.ok && networkTransitionActive(now)) {
    networkTransitionUntil = 0;
    log("info", "network_transition_recovered", {
      node,
      path: currentNetworkPath,
      status: result.status,
      totalMs: result.totalMs,
    });
  }
  state = recordProviderHealth(state, providerAlive);
  const validation = state.selectionValidation;
  state = recordCurrentProbe(state, result, now);
  if (isRealPathProbeResult(result)) {
    state = recordNodePathProbe(
      state,
      node,
      result,
      now,
      config.pathHistoryWindowMs,
    );
  }
  state = recordSelectionValidation(state, result, now, {
    holdMs: config.holdAfterSwitchMs,
  });
  const instabilityReason = currentPathInstabilityReason(state, now, {
    intermittentFailureThreshold: config.intermittentFailureThreshold,
    intermittentFailureWindowMs: config.intermittentFailureWindowMs,
    slowFailureThreshold: config.slowFailureThreshold,
    slowFailureWindowMs: config.slowFailureWindowMs,
  });
  if (result.ok) {
    state.passiveErrors = state.passiveErrors.filter(
      (event) => now - event.at <= config.passiveWindowMs,
    );
    if (!instabilityReason) {
      state.nextRecoveryAt = 0;
      state.recoveryExhaustions = 0;
    } else if (state.nextRecoveryAt > 0 || state.recoveryExhaustions > 0) {
      log("warning", "recovery_backoff_preserved", {
        node,
        reason: instabilityReason,
        nextRecoveryAt: state.nextRecoveryAt,
        recoveryExhaustions: state.recoveryExhaustions,
      });
    }
  }
  log(result.ok ? "info" : "warning", "current_probe", {
    node,
    ok: result.ok,
    failures: state.currentFailures,
    status: result.status,
    bytes: result.bytes,
    totalMs: result.totalMs,
    providerAlive,
    reportedProviderAlive,
    error: result.error || undefined,
    instabilityReason,
    selectionValidation: state.selectionValidation?.consecutiveSuccesses ?? null,
  });

  if (validation && !state.selectionValidation && result.ok) {
    let drain = { matched: 0, protected: 0 };
    try {
      drain = await beginOpenAIConnectionDrain(node);
    } catch (error) {
      log("warning", "connection_drain_failed", {
        current: node,
        error: error.message,
      });
    }
    log("info", "selection_verified", {
      source: validation.source,
      from: validation.from,
      to: node,
      holdUntil: state.holdUntil,
      drainingConnections: drain.matched,
      protectedConnections: drain.protected,
    });
  }
  return result.ok;
}

async function probeNode(name, endpoint = config.endpoint) {
  if (!endpoint?.url || !endpoint.expected) {
    throw new Error("Invalid node probe endpoint");
  }
  const query = new URLSearchParams({
    url: endpoint.url,
    timeout: String(config.nodeTestTimeoutMs),
    expected: endpoint.expected,
  });
  try {
    const result = await mihomoRequest(
      "GET",
      `/proxies/${encodeURIComponent(name)}/delay?${query}`,
      null,
      config.nodeTestTimeoutMs + 3_000,
    );
    const delay = Number(result?.delay);
    return {
      name,
      ok: Number.isFinite(delay) && delay > 0,
      delay: Number.isFinite(delay) ? delay : null,
      testedAt: Date.now(),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      delay: null,
      testedAt: Date.now(),
      error: error.message,
    };
  }
}

function currentRecoveryReason() {
  if (networkTransitionActive()) return null;
  return recoveryReason(state, Date.now(), {
    failureThreshold: config.failureThreshold,
    minFailureAgeMs: config.minFailureAgeMs,
    selectionFailureThreshold: config.selectionFailureThreshold,
    selectionFailureAgeMs: config.selectionFailureAgeMs,
    selectionValidationMaxAgeMs: config.selectionValidationMaxAgeMs,
    hardFailureThreshold: config.hardFailureThreshold,
    hardFailureAgeMs: config.hardFailureAgeMs,
    activeValidationFailureThreshold: config.activeValidationFailureThreshold,
    activeRecoveryFailureThreshold: config.activeRecoveryFailureThreshold,
    activeFailureAgeMs: config.activeFailureAgeMs,
    passiveThreshold: config.passiveThreshold,
    passiveWindowMs: config.passiveWindowMs,
    activeTrafficGraceMs: config.activeTrafficGraceMs,
    intermittentFailureThreshold: config.intermittentFailureThreshold,
    intermittentFailureWindowMs: config.intermittentFailureWindowMs,
    slowFailureThreshold: config.slowFailureThreshold,
    slowFailureWindowMs: config.slowFailureWindowMs,
  });
}

async function selectCandidate(name) {
  await mihomoRequest(
    "PUT",
    `/proxies/${encodeURIComponent(config.groupName)}`,
    { name },
  );
  const { group } = await refreshGroup("controller");
  if (group.now !== name) {
    throw new Error(`Selector kept ${group.now} after requesting ${name}`);
  }
  try {
    await beginOpenAIConnectionDrain(name);
  } catch (error) {
    log("warning", "connection_drain_failed", { current: name, error: error.message });
  }
}

async function listOpenAIConnections(nodeName = null) {
  const payload = await mihomoRequest("GET", "/connections");
  const connections = Array.isArray(payload?.connections) ? payload.connections : [];
  return connections.filter((connection) => isGroupConnection(
    connection,
    config.groupName,
    nodeName,
  ));
}

async function observeOpenAIActivity() {
  try {
    const groupConnections = await listOpenAIConnections();
    refreshDrainingConnections(groupConnections, state.current);
    const connections = groupConnections.filter((connection) => (
      isGroupConnection(connection, config.groupName, state.current)
    ));
    const nextBytes = new Map();
    let progressed = false;
    for (const connection of connections) {
      const bytes = Number(connection.download || 0) + Number(connection.upload || 0);
      const previous = openAIConnectionBytes.get(connection.id);
      if ((previous == null && bytes > 0) || (previous != null && bytes > previous)) {
        progressed = true;
      }
      nextBytes.set(connection.id, bytes);
    }
    openAIConnectionBytes = nextBytes;
    if (progressed) state.lastOpenAITrafficAt = Date.now();
    return { count: connections.length, progressed };
  } catch (error) {
    log("warning", "connection_activity_failed", { error: error.message });
    return { count: 0, progressed: false };
  }
}

function refreshDrainingConnections(connections, currentNode, now = Date.now()) {
  const draining = planConnectionDrain(connections, config.groupName, currentNode);
  const liveRouteKeys = new Set();
  for (const connection of draining) {
    if (!connection.routeKey) continue;
    liveRouteKeys.add(connection.routeKey);
    drainingConnectionRoutes.set(connection.routeKey, {
      id: connection.id,
      lastSeenAt: now,
    });
  }
  for (const [routeKey, connection] of drainingConnectionRoutes) {
    if (!liveRouteKeys.has(routeKey)
      && now - connection.lastSeenAt > config.drainingErrorGraceMs) {
      drainingConnectionRoutes.delete(routeKey);
    }
  }
  return draining;
}

async function beginOpenAIConnectionDrain(currentNode) {
  const connections = await listOpenAIConnections();
  const draining = refreshDrainingConnections(connections, currentNode);
  const protectedCount = draining.filter((connection) => connection.routeKey).length;
  log("info", "stale_connections_draining", {
    current: currentNode,
    matched: draining.length,
    protected: protectedCount,
    untracked: draining.length - protectedCount,
  });
  return { matched: draining.length, protected: protectedCount };
}

async function qualifyCandidates(names) {
  const results = await Promise.all(names.map(async (name) => {
    const samples = [];
    const endpoints = [config.endpoint, config.traceEndpoint, config.endpoint];
    for (let attempt = 0; attempt < config.qualificationPasses; attempt += 1) {
      const shortProbe = await probeNode(name, endpoints[attempt % endpoints.length]);
      const result = shortProbe.ok ? await probeNodePath(name) : shortProbe;
      samples.push(result);
      recordCandidateProbe(result);
      if (!result.ok) break;
      if (attempt + 1 < config.qualificationPasses) {
        await sleep(config.qualificationSpacingMs);
      }
    }
    const last = samples.at(-1);
    const delays = samples
      .map((sample) => sample.delay)
      .filter(Number.isFinite);
    return {
      name,
      ok: qualifiesProbeSeries(samples, config.qualificationPasses),
      delay: delays.length > 0
        ? Math.round(delays.reduce((sum, delay) => sum + delay, 0) / delays.length)
        : null,
      testedAt: last?.testedAt || Date.now(),
      error: last?.error,
      sampleCount: samples.length,
    };
  }));
  const sampleCounts = Object.fromEntries(results.map((result) => [
    result.name,
    result.sampleCount,
  ]));
  const successful = results.filter((result) => result.ok);
  log(successful.length > 0 ? "info" : "warning", "qualification_round", {
    round: 1,
    tested: names,
    successful: successful.map((result) => result.name),
    sampleCounts,
  });

  return successful;
}

async function verifySelectedCandidate(name, probeCount = config.postSwitchProbeCount) {
  let lastResult = null;
  for (let attempt = 1; attempt <= probeCount; attempt += 1) {
    let providerAlive = null;
    try {
      providerAlive = await readProxyAlive(name);
    } catch (error) {
      log("warning", "provider_health_query_failed", {
        node: name,
        error: error.message,
      });
    }
    state = recordProviderHealth(state, providerAlive);
    const result = providerAlive === false
      ? {
          ok: false,
          status: "provider_unhealthy",
          bytes: 0,
          totalMs: 0,
          error: "Mihomo reports this proxy as unavailable",
        }
      : await curlOpenAIPathProbe();
    const testedAt = Date.now();
    state = recordCurrentProbe(state, result, testedAt);
    if (isRealPathProbeResult(result)) {
      state = recordNodePathProbe(
        state,
        name,
        result,
        testedAt,
        config.pathHistoryWindowMs,
      );
    }
    log(result.ok ? "info" : "warning", "post_switch_probe", {
      node: name,
      attempt,
      ok: result.ok,
      status: result.status,
      totalMs: result.totalMs,
      providerAlive,
      error: result.error || undefined,
    });
    lastResult = result;
    if (!result.ok) return { ok: false, result, attempt };
    if (attempt < probeCount) {
      await sleep(config.postSwitchSpacingMs);
    }
  }
  return { ok: true, result: lastResult, attempt: probeCount };
}

async function rollbackRejectedCandidate(origin, candidate, reason) {
  const group = await mihomoRequest(
    "GET",
    `/proxies/${encodeURIComponent(config.groupName)}`,
  );
  if (group.now !== candidate) {
    await refreshGroup();
    log("warning", "recovery_aborted_external_selection", {
      reason,
      attempted: candidate,
      current: group.now,
    });
    return false;
  }

  try {
    await selectCandidate(origin.current);
    state = restoreRecoveryOrigin(state, origin);
    log("warning", "recovery_candidate_rolled_back", {
      reason,
      from: candidate,
      to: origin.current,
      preservedFailures: state.currentFailures,
    });
    return true;
  } catch (error) {
    log("error", "recovery_rollback_failed", {
      reason,
      from: candidate,
      to: origin.current,
      error: error.message,
    });
    throw error;
  }
}

function scheduleRecoveryRetry(reason) {
  const delayMs = recoveryBackoffDelayForReason(
    state.recoveryExhaustions,
    reason,
    {
      defaultScheduleMs: config.recoveryBackoffMs,
      providerUnavailableScheduleMs: config.providerUnavailableBackoffMs,
      activeTraffic: recoveryStartedWithActiveTraffic
        || hasRecentTraffic(state, Date.now(), config.activeTrafficGraceMs),
    },
  );
  state.recoveryExhaustions += 1;
  state.lastRecoveryReason = reason;
  state.nextRecoveryAt = Date.now() + delayMs;
  return delayMs;
}

async function completeRecovery(
  before,
  candidate,
  reason,
  verification,
  options = {},
) {
  const { backgroundValidation = false } = options;
  const verifiedAt = Date.now();
  state.passiveErrors = [];
  state.nextRecoveryAt = 0;
  state.recoveryExhaustions = 0;
  if (backgroundValidation) {
    state = beginSelectionValidation(
      state,
      before,
      candidate,
      "hot_standby",
      verifiedAt,
      {
        consecutiveSuccesses: 1,
        successThreshold: config.postSwitchProbeCount,
        failureThreshold: 1,
        failureAgeMs: 0,
        maxAgeMs: config.selectionValidationMaxAgeMs,
      },
    );
  } else {
    state.holdUntil = verifiedAt + config.holdAfterSwitchMs;
    state.selectionValidation = null;
  }
  let drain = { matched: 0, protected: 0 };
  try {
    drain = await beginOpenAIConnectionDrain(candidate);
  } catch (error) {
    log("warning", "connection_drain_failed", {
      current: candidate,
      error: error.message,
    });
  }
  log("warning", "recovery_complete", {
    reason,
    from: before,
    to: candidate,
    status: verification.result.status,
    totalMs: verification.result.totalMs,
    verificationMode: backgroundValidation ? "hot_standby_fast" : "full",
    pendingValidationProbes: backgroundValidation
      ? config.postSwitchProbeCount - 1
      : 0,
    holdUntil: state.holdUntil,
    drainingConnections: drain.matched,
    protectedConnections: drain.protected,
  });
  return true;
}

async function recover(reason) {
  const before = state.current;
  const origin = {
    current: before,
    currentSelectedAt: state.currentSelectedAt,
    currentFailures: state.currentFailures,
    currentFailureStartedAt: state.currentFailureStartedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    providerAlive: state.providerAlive,
    providerUnhealthyAt: state.providerUnhealthyAt,
  };
  const recoveryAt = Date.now();
  recoveryStartedWithActiveTraffic = hasRecentTraffic(
    state, recoveryAt, config.activeTrafficGraceMs,
  );
  state.lastRecoveryAt = recoveryAt;
  state.lastRecoveryReason = reason;
  state.nextRecoveryAt = 0;
  state.holdUntil = 0;
  state.passiveErrors = [];

  if (shadowMode) {
    log("warning", "shadow_recovery", { reason, current: before });
    return false;
  }

  const alreadyCooling = (state.nodes[before]?.excludedUntil || 0) > recoveryAt;
  state = ejectNodeOnce(state, before, recoveryAt, config.ejectionDurationsMs);
  log("warning", "current_node_ejected", {
    reason,
    node: before,
    alreadyCooling,
    ejectionCount: state.nodes[before]?.ejectionCount,
    excludedUntil: state.nodes[before]?.excludedUntil,
  });

  const { candidates } = await refreshGroup();
  let proxySnapshot = await mihomoRequest("GET", "/proxies");
  let providerAliveCandidates = filterProviderAliveCandidates(
    candidates,
    proxySnapshot?.proxies,
  );
  const providerAliveBeforeRefresh = providerAliveCandidates.length;
  let refreshBatch = [];
  let refreshedQualified = [];
  if (providerAliveCandidates.length < config.providerRefreshAliveFloor) {
    refreshBatch = pickProviderRefreshBatch(
      candidates,
      proxySnapshot?.proxies,
      state,
      Date.now(),
      {
        limit: config.providerRefreshBatchSize,
        minProbeAgeMs: config.providerRefreshMinProbeAgeMs,
        rollingWindowMs: config.rollingWindowMs,
        pathHistoryWindowMs: config.pathHistoryWindowMs,
      },
    );
    if (refreshBatch.length > 0) {
      log("warning", "provider_cache_refresh_started", {
        reason,
        alive: providerAliveCandidates.length,
        candidates: refreshBatch,
      });
      refreshedQualified = await qualifyCandidates(refreshBatch);
      proxySnapshot = await mihomoRequest("GET", "/proxies");
      providerAliveCandidates = filterProviderAliveCandidates(
        candidates,
        proxySnapshot?.proxies,
      );
      log(
        providerAliveCandidates.length > providerAliveBeforeRefresh
          ? "info"
          : "warning",
        "provider_cache_refresh_complete",
        {
          reason,
          tested: refreshBatch,
          qualified: refreshedQualified.map((candidate) => candidate.name),
          aliveBefore: providerAliveBeforeRefresh,
          aliveAfter: providerAliveCandidates.length,
        },
      );
    }
  }
  log("info", "provider_candidate_filter", {
    candidates: candidates.length,
    alive: providerAliveCandidates.length,
    rejected: candidates.length - providerAliveCandidates.length,
    refreshAttempted: refreshBatch.length,
    refreshQualified: refreshedQualified.length,
  });
  const tested = [];
  const radarReadyStandbys = rankHotStandbys(
    providerAliveCandidates,
    state,
    Date.now(),
    {
      limit: config.hotStandbyCount,
      requiredPasses: config.hotStandbyRequiredPasses,
      probeTtlMs: config.hotStandbyProbeTtlMs,
      historyWindowMs: config.hotStandbyHistoryWindowMs,
      minSpanMs: config.hotStandbyMinSpanMs,
      rollingWindowMs: config.rollingWindowMs,
      pathHistoryWindowMs: config.pathHistoryWindowMs,
    },
  );
  const hotStandbys = radarReadyStandbys.filter((name) => (
    hasRecentStablePathEvidence(state, name, Date.now(), {
      requiredPasses: config.hotStandbyFastPathRequiredPasses,
      historyWindowMs: config.hotStandbyFastPathHistoryWindowMs,
      probeTtlMs: config.hotStandbyFastPathProbeTtlMs,
      minSpanMs: config.hotStandbyFastPathMinSpanMs,
    })
  ));
  const downgradedStandbys = radarReadyStandbys.filter(
    (name) => !hotStandbys.includes(name),
  );
  log("info", "hot_standby_recovery_candidates", {
    reason,
    candidates: hotStandbys,
    radarReady: radarReadyStandbys,
    downgraded: downgradedStandbys,
  });

  for (const candidateName of hotStandbys) {
    tested.push(candidateName);
    if (!await preflightCandidate(candidateName, reason)) continue;
    await selectCandidate(candidateName);
    let verification;
    try {
      verification = await verifySelectedCandidate(candidateName, 1);
    } catch (error) {
      await rollbackRejectedCandidate(origin, candidateName, reason);
      throw error;
    }
    const verifiedAt = Date.now();
    if (verification.ok) {
      return completeRecovery(
        before,
        candidateName,
        reason,
        verification,
        { backgroundValidation: true },
      );
    }

    state = ejectNodeOnce(
      state,
      candidateName,
      verifiedAt,
      config.ejectionDurationsMs,
    );
    log("warning", "recovery_candidate_rejected", {
      reason,
      from: before,
      node: candidateName,
      attempt: verification.attempt,
      status: verification.result.status,
      verificationMode: "hot_standby_fast",
      error: verification.result.error || undefined,
    });
    if (!await rollbackRejectedCandidate(origin, candidateName, reason)) {
      state.nextRecoveryAt = Date.now() + config.retryDelayMs;
      return false;
    }
  }

  const attemptedHotStandbys = new Set(hotStandbys);
  const candidatePools = buildRecoveryCandidatePools(
    providerAliveCandidates,
    attemptedHotStandbys,
    downgradedStandbys,
  );

  for (const pool of candidatePools) {
    let remaining = [...new Set(pool)];
    while (remaining.length > 0) {
      const batch = pickRecoveryBatch(
        remaining,
        state,
        Date.now(),
        {
          limit: config.qualificationBatchSize,
          rollingWindowMs: config.rollingWindowMs,
          pathHistoryWindowMs: config.pathHistoryWindowMs,
        },
      );
      if (batch.length === 0) break;
      const batchNames = new Set(batch);
      remaining = remaining.filter((name) => !batchNames.has(name));
      tested.push(...batch);

      const qualified = await qualifyCandidates(batch);
      const ranked = rankFreshSuccesses(
        qualified,
        state,
        Date.now(),
        config.qualificationWindowMs,
        config.rollingWindowMs,
        config.pathHistoryWindowMs,
      );
      log(ranked.length > 0 ? "info" : "warning", "recovery_candidates", {
        reason,
        tested: batch,
        qualified: ranked.map((result) => result.name),
        regions: [...new Set(batch.map((name) => nodeRegion(name)))],
      });

      for (const candidate of ranked) {
        if (!await preflightCandidate(candidate.name, reason)) continue;
        await selectCandidate(candidate.name);
        let verification;
        try {
          verification = await verifySelectedCandidate(candidate.name);
        } catch (error) {
          await rollbackRejectedCandidate(origin, candidate.name, reason);
          throw error;
        }
        if (verification.ok) {
          return completeRecovery(before, candidate.name, reason, verification);
        }

        const verifiedAt = Date.now();
        state = ejectNodeOnce(
          state,
          candidate.name,
          verifiedAt,
          config.ejectionDurationsMs,
        );
        log("warning", "recovery_candidate_rejected", {
          reason,
          from: before,
          node: candidate.name,
          attempt: verification.attempt,
          status: verification.result.status,
          error: verification.result.error || undefined,
        });
        if (!await rollbackRejectedCandidate(origin, candidate.name, reason)) {
          state.nextRecoveryAt = Date.now() + config.retryDelayMs;
          return false;
        }
      }
    }
  }

  if (allowsEmergencyCoolingReuse(reason)) {
    const testedNames = new Set(tested);
    const emergencyBatch = pickEmergencyRecoveryBatch(
      providerAliveCandidates.filter((name) => !testedNames.has(name)),
      state,
      Date.now(),
      {
        limit: config.emergencyBatchSize,
        rollingWindowMs: config.rollingWindowMs,
        pathHistoryWindowMs: config.pathHistoryWindowMs,
      },
    );
    if (emergencyBatch.length > 0) {
      tested.push(...emergencyBatch);
      log("warning", "emergency_cooling_reuse", {
        reason,
        candidates: emergencyBatch,
      });
      const qualified = await qualifyCandidates(emergencyBatch);
      const ranked = rankFreshSuccesses(
        qualified,
        state,
        Date.now(),
        config.qualificationWindowMs,
        config.rollingWindowMs,
        config.pathHistoryWindowMs,
      );

      for (const candidate of ranked) {
        if (!await preflightCandidate(candidate.name, reason)) continue;
        await selectCandidate(candidate.name);
        let verification;
        try {
          verification = await verifySelectedCandidate(candidate.name);
        } catch (error) {
          await rollbackRejectedCandidate(origin, candidate.name, reason);
          throw error;
        }
        if (verification.ok) {
          return completeRecovery(before, candidate.name, reason, verification);
        }

        const verifiedAt = Date.now();
        state = ejectNodeOnce(
          state,
          candidate.name,
          verifiedAt,
          config.ejectionDurationsMs,
        );
        log("warning", "emergency_candidate_rejected", {
          reason,
          from: before,
          node: candidate.name,
          attempt: verification.attempt,
          status: verification.result.status,
          error: verification.result.error || undefined,
        });
        if (!await rollbackRejectedCandidate(origin, candidate.name, reason)) {
          state.nextRecoveryAt = Date.now() + config.retryDelayMs;
          return false;
        }
      }
    }
  }

  const retryInMs = scheduleRecoveryRetry(reason);
  log("error", "recovery_exhausted", {
    reason,
    from: before,
    current: state.current,
    tested,
    recoveryExhaustions: state.recoveryExhaustions,
    retryInMs,
  });
  return false;
}

async function maybeRecover() {
  let reason = currentRecoveryReason();
  if (!reason) return false;
  if (reason === "active_current_probe_validation") {
    log("warning", "active_failure_confirmation", {
      node: state.current,
      failures: state.currentFailures,
      firstFailureAt: state.currentFailureStartedAt,
    });
    if (await checkCurrent()) {
      log("info", "active_failure_cleared", { node: state.current });
      return false;
    }
    reason = "active_current_probe_failures";
  }
  try {
    return await recover(reason);
  } catch (error) {
    const retryInMs = scheduleRecoveryRetry(reason);
    log("error", "recovery_failed", {
      reason,
      current: state.current,
      error: error.message,
      recoveryExhaustions: state.recoveryExhaustions,
      retryInMs,
    });
    return false;
  }
}

async function runRadar(candidates) {
  const activeTraffic = hasRecentTraffic(state, Date.now(), config.activeRadarQuietMs);
  const batch = pickRadarBatch(candidates, state, Date.now(), {
    coldLimit: activeTraffic ? config.activeRadarColdBatchSize : config.radarColdBatchSize,
    hotLimit: 0,
    rollingWindowMs: config.rollingWindowMs,
    pathHistoryWindowMs: config.pathHistoryWindowMs,
  });
  if (batch.length === 0) return;

  const results = await Promise.all(batch.map((name) => probeNode(name)));
  for (const result of results) {
    state = recordNodeProbe(
      state,
      result.name,
      result,
      result.testedAt,
      config.rollingWindowMs,
    );
  }
  log("info", "radar_batch", {
    activeTraffic,
    tested: batch,
    successful: results.filter((result) => result.ok).map((result) => result.name),
  });
}

async function runHotStandbyRadar(candidates) {
  const proxySnapshot = await mihomoRequest("GET", "/proxies");
  const providerAliveCandidates = filterProviderAliveCandidates(
    candidates,
    proxySnapshot?.proxies,
  );
  const batch = pickHotStandbyProbeBatch(
    providerAliveCandidates,
    state,
    Date.now(),
    {
      limit: config.hotStandbyCount,
      rollingWindowMs: config.rollingWindowMs,
      pathHistoryWindowMs: config.pathHistoryWindowMs,
    },
  );
  if (batch.length === 0) {
    log("warning", "hot_standby_unavailable", {
      providerAliveCandidates: providerAliveCandidates.length,
    });
    return;
  }

  const endpoints = [config.endpoint, config.traceEndpoint, config.endpoint];
  const endpoint = endpoints[hotStandbyProbeRound % endpoints.length];
  hotStandbyProbeRound += 1;
  const results = await Promise.all(batch.map(async (name) => {
    const shortProbe = await probeNode(name, endpoint);
    return shortProbe.ok ? probeNodePath(name) : shortProbe;
  }));
  for (const result of results) {
    recordCandidateProbe(result);
  }
  const ready = rankHotStandbys(
    providerAliveCandidates,
    state,
    Date.now(),
    {
      limit: config.hotStandbyCount,
      requiredPasses: config.hotStandbyRequiredPasses,
      probeTtlMs: config.hotStandbyProbeTtlMs,
      historyWindowMs: config.hotStandbyHistoryWindowMs,
      minSpanMs: config.hotStandbyMinSpanMs,
      rollingWindowMs: config.rollingWindowMs,
      pathHistoryWindowMs: config.pathHistoryWindowMs,
    },
  );
  const fastReady = ready.filter((name) => (
    hasRecentStablePathEvidence(state, name, Date.now(), {
      requiredPasses: config.hotStandbyFastPathRequiredPasses,
      historyWindowMs: config.hotStandbyFastPathHistoryWindowMs,
      probeTtlMs: config.hotStandbyFastPathProbeTtlMs,
      minSpanMs: config.hotStandbyFastPathMinSpanMs,
    })
  ));
  log(ready.length > 0 ? "info" : "warning", "hot_standby_radar", {
    tested: batch,
    successful: results.filter((result) => result.ok).map((result) => result.name),
    ready,
    fastReady,
    target: config.hotStandbyCount,
    endpoint: endpoint.url,
  });
  const wakeAt = Date.now();
  if (shouldWakeRecoveryForStandby(state, ready, wakeAt)) {
    const previousRecoveryAt = state.nextRecoveryAt;
    state.nextRecoveryAt = wakeAt;
    urgentRecovery = true;
    log("warning", "recovery_woken_by_hot_standby", {
      ready,
      previousRecoveryAt,
      wakeAt,
    });
  }
}

function notePassiveError(sourceMessage) {
  if (networkTransitionActive()) {
    log("info", "network_transition_passive_error_suppressed", {
      sourceMessage,
      graceUntil: networkTransitionUntil,
    });
    return;
  }
  const routeKey = passiveErrorKey(sourceMessage);
  const drainingConnection = drainingConnectionRoutes.get(routeKey);
  if (drainingConnection) {
    drainingConnectionRoutes.delete(routeKey);
    log("info", "draining_connection_error_ignored", {
      connectionId: drainingConnection.id,
      routeKey,
    });
    return;
  }
  const before = state.passiveErrors.length;
  state = addPassiveError(
    state,
    sourceMessage,
    Date.now(),
    config.passiveWindowMs,
  );
  if (state.passiveErrors.length >= config.passiveThreshold && !urgentRecovery) {
    urgentRecovery = true;
    log("warning", "passive_error_threshold", {
      node: state.current,
      count: state.passiveErrors.length,
      deduplicated: state.passiveErrors.length === before,
      sourceMessage,
    });
  }
}

function startLogMonitor() {
  if (stopped || onceMode) return;
  let request;
  try {
    request = createMihomoRequest(
      "GET",
      "/logs?level=warning&format=structured",
    );
  } catch (error) {
    log("warning", "log_stream_error", { error: error.message });
    if (!stopped) setTimeout(startLogMonitor, 2_000);
    return;
  }
  logRequest = request;

  request.on("response", (response) => {
    let pending = "";
    response.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (isOpenAIPathError(event.message)) notePassiveError(event.message);
        } catch {
          // Ignore partial or non-JSON log lines.
        }
      }
    });
    response.on("end", () => {
      if (!stopped) setTimeout(startLogMonitor, 2_000);
    });
  });
  request.on("error", (error) => {
    log("warning", "log_stream_error", { error: error.message });
    if (!stopped) setTimeout(startLogMonitor, 2_000);
  });
  request.end();
}

async function run() {
  await loadState();
  const { group, candidates } = await refreshGroup();
  await refreshNetworkEnvironment({ force: true });
  log("info", "controller_started", {
    mode: shadowMode ? "shadow" : "live",
    group: config.groupName,
    type: group.type,
    current: group.now,
    candidates: candidates.length,
    endpoint: config.endpoint.url,
    macosSystemProxySync: config.macosSystemProxySync,
    macosProxyServices: config.macosSystemProxySync
      ? config.macosProxyServices
      : [],
  });

  await observeOpenAIActivity();
  await checkCurrent();
  await maybeRecover();
  urgentRecovery = false;
  if (onceMode) {
    await runRadar(candidates);
    await runHotStandbyRadar(candidates);
  }
  await saveState();
  if (onceMode) return;

  startLogMonitor();
  let nextCurrentProbeAt = Date.now() + currentProbeDelay();
  let nextActivityAt = Date.now() + config.activityIntervalMs;
  let nextRadarAt = Date.now();
  let nextHotStandbyAt = Date.now();

  while (!stopped) {
    try {
      await refreshNetworkEnvironment({
        force: urgentRecovery || currentRecoveryReason() !== null,
      });
      const { candidates: latestCandidates } = await refreshGroup();
      const now = Date.now();
      if (now >= nextActivityAt) {
        await observeOpenAIActivity();
        nextActivityAt = Date.now() + config.activityIntervalMs;
      }

      let recovered = false;
      if (urgentRecovery) {
        urgentRecovery = false;
        await observeOpenAIActivity();
        if (currentRecoveryReason() === "passive_transport_errors") {
          recovered = await maybeRecover();
        } else {
          await checkCurrent();
          recovered = await maybeRecover();
        }
        nextCurrentProbeAt = Date.now() + currentProbeDelay();
      } else if (state.nextRecoveryAt > 0 && now >= state.nextRecoveryAt) {
        state.nextRecoveryAt = 0;
        await checkCurrent();
        recovered = await maybeRecover();
        nextCurrentProbeAt = Date.now() + currentProbeDelay();
      } else if (currentRecoveryReason()) {
        recovered = await maybeRecover();
      } else if (now >= nextCurrentProbeAt) {
        await checkCurrent();
        recovered = await maybeRecover();
        nextCurrentProbeAt = Date.now() + currentProbeDelay();
      }

      if (recovered) {
        nextCurrentProbeAt = Date.now() + currentProbeDelay();
      }

      if (!recovered
        && !networkTransitionActive()
        && Date.now() >= nextHotStandbyAt) {
        await runHotStandbyRadar(latestCandidates);
        nextHotStandbyAt = Date.now() + config.hotStandbyIntervalMs;
      }

      if (!recovered
        && !networkTransitionActive()
        && Date.now() >= nextRadarAt) {
        await runRadar(latestCandidates);
        nextRadarAt = Date.now() + config.radarIntervalMs;
      }
      await saveState();
    } catch (error) {
      log("error", "controller_cycle_failed", { error: error.message });
    }
    await sleep(config.loopIntervalMs);
  }
}

async function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  logRequest?.destroy();
  try {
    await saveState();
  } catch (error) {
    log("warning", "state_save_failed", { error: error.message });
  }
  log("info", "controller_stopped", { signal });
}

function stopAndExit(signal) {
  void shutdown(signal).finally(() => process.exit(0));
}

process.on("SIGTERM", () => stopAndExit("SIGTERM"));
process.on("SIGINT", () => stopAndExit("SIGINT"));

run().catch((error) => {
  log("error", "controller_failed", { error: error.stack || error.message });
  process.exitCode = 1;
});
