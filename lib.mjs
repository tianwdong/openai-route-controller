export const WATCHDOG_STATE_VERSION = 7;
export const PROBE_BASE_PORT = 17900;

const DEFAULT_ROLLING_WINDOW_MS = 10 * 60_000;
const DEFAULT_PATH_HISTORY_WINDOW_MS = 6 * 60 * 60_000;
const DEFAULT_REENTRY_SUCCESSES = 3;
const PATH_SCORE_HALF_LIFE_MS = 30 * 60_000;
const PENALTY_RECOVERY_MS = 30 * 60_000;
const PENALTY_RECOVERY_MAX_GAP_MS = 2 * 60_000;

function newNodeState() {
  return {
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastProbeAt: 0,
    lastProviderRefreshAt: 0,
    lastHotStandbyProbeAt: 0,
    excludedUntil: 0,
    ejectionCount: 0,
    penaltyRecoveryStartedAt: 0,
    probeEvents: [],
    pathEvents: [],
  };
}

export function newWatchdogState() {
  return {
    version: WATCHDOG_STATE_VERSION,
    current: null,
    currentSelectedAt: 0,
    currentFailures: 0,
    currentFailureStartedAt: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastRecoveryAt: 0,
    lastRecoveryReason: null,
    nextRecoveryAt: 0,
    recoveryExhaustions: 0,
    holdUntil: 0,
    providerAlive: null,
    providerUnhealthyAt: 0,
    lastOpenAITrafficAt: 0,
    selectionValidation: null,
    hotStandbyExploration: null,
    passiveErrors: [],
    nodes: {},
  };
}

export function normalizeState(saved) {
  if (!saved || saved.version !== WATCHDOG_STATE_VERSION) {
    return newWatchdogState();
  }

  const nodes = {};
  for (const [name, node] of Object.entries(saved.nodes || {})) {
    nodes[name] = {
      ...newNodeState(),
      ...node,
      lastHotStandbyProbeAt: Number.isFinite(Number(node.lastHotStandbyProbeAt))
        ? Math.max(0, Number(node.lastHotStandbyProbeAt))
        : 0,
      probeEvents: Array.isArray(node.probeEvents) ? node.probeEvents : [],
      pathEvents: Array.isArray(node.pathEvents) ? node.pathEvents : [],
    };
  }

  return {
    ...newWatchdogState(),
    ...saved,
    recoveryExhaustions: Math.max(0, Number(saved.recoveryExhaustions) || 0),
    selectionValidation: saved.selectionValidation?.to
      ? {
          from: saved.selectionValidation.from || null,
          to: saved.selectionValidation.to,
          source: saved.selectionValidation.source || "manual",
          startedAt: Number(saved.selectionValidation.startedAt) || 0,
          consecutiveSuccesses: Number(saved.selectionValidation.consecutiveSuccesses) || 0,
          successThreshold: Number(saved.selectionValidation.successThreshold) || 2,
          failureThreshold: Number(saved.selectionValidation.failureThreshold) || 2,
          failureAgeMs: Number.isFinite(Number(saved.selectionValidation.failureAgeMs))
            ? Number(saved.selectionValidation.failureAgeMs)
            : 5_000,
          maxAgeMs: Number(saved.selectionValidation.maxAgeMs) || 30_000,
        }
      : null,
    hotStandbyExploration: typeof saved.hotStandbyExploration?.name === "string"
      && typeof saved.hotStandbyExploration.candidateKey === "string"
      && Number.isFinite(Number(saved.hotStandbyExploration.startedAt))
      ? {
          name: saved.hotStandbyExploration.name,
          startedAt: Number(saved.hotStandbyExploration.startedAt),
          candidateKey: saved.hotStandbyExploration.candidateKey,
        }
      : null,
    passiveErrors: Array.isArray(saved.passiveErrors) ? saved.passiveErrors : [],
    nodes,
  };
}

export function parseNetworkSetupProxy(output = "") {
  const enabled = output.match(/^Enabled:\s*(Yes|No)\s*$/im)?.[1];
  const server = output.match(/^Server:\s*(.+?)\s*$/im)?.[1];
  const port = Number(output.match(/^Port:\s*(\d+)\s*$/im)?.[1]);
  if (!enabled || !server || !Number.isInteger(port)) return null;
  return {
    enabled: enabled.toLowerCase() === "yes",
    server,
    port,
  };
}

export function systemProxyNeedsRepair(current, desired) {
  return !current
    || current.enabled !== true
    || current.server !== desired.server
    || current.port !== desired.port;
}

export function parseDefaultNetworkPath(output = "") {
  const interfaceName = output.match(/^\s*interface:\s*(\S+)\s*$/im)?.[1];
  const gateway = output.match(/^\s*gateway:\s*(\S+)\s*$/im)?.[1];
  if (!interfaceName && !gateway) return null;
  return {
    interfaceName: interfaceName || null,
    gateway: gateway || null,
  };
}

export function networkPathChanged(previous, current) {
  if (!previous && !current) return false;
  if (!previous || !current) return true;
  return previous.interfaceName !== current.interfaceName
    || previous.gateway !== current.gateway;
}

export function resetStateForNetworkTransition(state, now = Date.now()) {
  return {
    ...state,
    currentSelectedAt: now,
    currentFailures: 0,
    currentFailureStartedAt: 0,
    lastFailureAt: 0,
    nextRecoveryAt: 0,
    recoveryExhaustions: 0,
    providerAlive: null,
    lastRecoveryReason: null,
    providerUnhealthyAt: 0,
    passiveErrors: [],
    selectionValidation: state.selectionValidation
      ? {
          ...state.selectionValidation,
          startedAt: now,
          consecutiveSuccesses: 0,
        }
      : null,
  };
}

export function recordCurrentProbe(state, result, now = Date.now()) {
  if (result.ok) {
    return {
      ...state,
      currentFailures: 0,
      currentFailureStartedAt: 0,
      lastSuccessAt: now,
    };
  }
  return {
    ...state,
    currentFailures: state.currentFailures + 1,
    currentFailureStartedAt: state.currentFailures === 0
      ? now
      : state.currentFailureStartedAt || now,
    lastFailureAt: now,
  };
}

export function recordProviderHealth(state, alive, now = Date.now()) {
  if (alive === false) {
    return {
      ...state,
      providerAlive: false,
      providerUnhealthyAt: state.providerUnhealthyAt || now,
    };
  }
  if (alive === true) {
    return {
      ...state,
      providerAlive: true,
      providerUnhealthyAt: 0,
    };
  }
  return state;
}

export function restoreRecoveryOrigin(state, origin) {
  return {
    ...state,
    current: origin.current,
    currentSelectedAt: origin.currentSelectedAt,
    currentFailures: origin.currentFailures,
    currentFailureStartedAt: origin.currentFailureStartedAt,
    lastSuccessAt: origin.lastSuccessAt,
    lastFailureAt: origin.lastFailureAt,
    providerAlive: origin.providerAlive,
    providerUnhealthyAt: origin.providerUnhealthyAt,
  };
}

export function beginSelectionValidation(
  state,
  from,
  to,
  source = "manual",
  now = Date.now(),
  options = {},
) {
  const {
    consecutiveSuccesses = 0,
    successThreshold = 2,
    failureThreshold = 2,
    failureAgeMs = 5_000,
    maxAgeMs = 30_000,
  } = options;
  return {
    ...state,
    holdUntil: 0,
    selectionValidation: {
      from: from || null,
      to,
      source,
      startedAt: now,
      consecutiveSuccesses,
      successThreshold,
      failureThreshold,
      failureAgeMs,
      maxAgeMs,
    },
  };
}

export function recordSelectionValidation(state, result, now = Date.now(), options = {}) {
  const validation = state.selectionValidation;
  if (!validation || validation.to !== state.current) return state;
  const successThreshold = options.successThreshold
    ?? validation.successThreshold
    ?? 2;
  const holdMs = options.holdMs ?? 5 * 60_000;

  if (!result.ok) {
    return {
      ...state,
      selectionValidation: {
        ...validation,
        consecutiveSuccesses: 0,
      },
    };
  }

  const consecutiveSuccesses = validation.consecutiveSuccesses + 1;
  if (consecutiveSuccesses < successThreshold) {
    return {
      ...state,
      selectionValidation: {
        ...validation,
        consecutiveSuccesses,
      },
    };
  }

  return {
    ...state,
    holdUntil: now + holdMs,
    selectionValidation: null,
  };
}

function recentProbeEvents(node, now, windowMs) {
  return (node.probeEvents || []).filter((event) => now - event.at <= windowMs);
}

function recentPathEvents(node, now, windowMs) {
  return (node.pathEvents || []).filter((event) => now - event.at <= windowMs);
}

export function rollingNodeStats(
  node,
  now = Date.now(),
  windowMs = DEFAULT_ROLLING_WINDOW_MS,
) {
  const events = recentProbeEvents(node, now, windowMs);
  const successes = events.filter((event) => event.ok).length;
  const failures = events.length - successes;
  const delays = events
    .filter((event) => event.ok && Number.isFinite(event.delay))
    .map((event) => event.delay)
    .sort((left, right) => left - right);
  const middle = Math.floor(delays.length / 2);
  const medianDelay = delays.length === 0
    ? Number.POSITIVE_INFINITY
    : delays.length % 2 === 1
      ? delays[middle]
      : Math.round((delays[middle - 1] + delays[middle]) / 2);

  return {
    total: events.length,
    successes,
    failures,
    reliability: (successes + 1) / (events.length + 2),
    medianDelay,
  };
}

export function rollingPathStats(
  node,
  now = Date.now(),
  windowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
) {
  const events = recentPathEvents(node, now, windowMs);
  const successes = events.filter((event) => event.ok).length;
  const failures = events.length - successes;
  let successWeight = 0;
  let totalWeight = 0;
  for (const event of events) {
    const weight = 2 ** (-Math.max(0, now - event.at) / PATH_SCORE_HALF_LIFE_MS);
    totalWeight += weight;
    if (event.ok) successWeight += weight;
  }
  return {
    total: events.length,
    successes,
    failures,
    reliability: (successes + 1) / (events.length + 2),
    weightedReliability: (successWeight + 1) / (totalWeight + 2),
  };
}

export function nodeProbeProxyUrl(name, candidates, basePort = PROBE_BASE_PORT) {
  const index = [...new Set(candidates)].sort().indexOf(name);
  if (index < 0) throw new Error(`No isolated probe route for ${name}`);
  return `http://127.0.0.1:${basePort + index}`;
}

export function latestPathProbeWasSuccessful(
  state,
  name,
  now = Date.now(),
  windowMs = 60_000,
) {
  const node = state.nodes[name] || newNodeState();
  const latest = recentPathEvents(node, now, windowMs)
    .sort((left, right) => left.at - right.at)
    .at(-1);
  return latest?.ok === true;
}

export function hasRecentStablePathEvidence(
  state,
  name,
  now = Date.now(),
  options = {},
) {
  const {
    requiredPasses = 4,
    historyWindowMs = DEFAULT_ROLLING_WINDOW_MS,
    probeTtlMs = 2 * 60_000,
    minSpanMs = 45_000,
  } = options;
  const node = state.nodes[name] || newNodeState();
  const events = recentPathEvents(node, now, historyWindowMs)
    .sort((left, right) => left.at - right.at);
  if (events.length < requiredPasses || events.some((event) => !event.ok)) {
    return false;
  }
  const oldest = events[0];
  const newest = events.at(-1);
  return now - newest.at <= probeTtlMs
    && newest.at - oldest.at >= minSpanMs;
}

export function hasRecentTraffic(state, now = Date.now(), windowMs = 120_000) {
  return state.lastOpenAITrafficAt > 0
    && now - state.lastOpenAITrafficAt <= windowMs;
}

export function buildRecoveryCandidatePools(
  candidates,
  attempted = [],
  preferredForFullValidation = [],
) {
  const available = new Set(candidates);
  const excluded = new Set(attempted);
  const preferred = [...new Set(preferredForFullValidation)].filter(
    (name) => available.has(name) && !excluded.has(name),
  );
  const preferredNames = new Set(preferred);
  const remaining = [...new Set(candidates)].filter(
    (name) => !excluded.has(name) && !preferredNames.has(name),
  );
  return [preferred, remaining].filter((pool) => pool.length > 0);
}

export function recordNodeProbe(
  state,
  name,
  result,
  now = Date.now(),
  rollingWindowMs = DEFAULT_ROLLING_WINDOW_MS,
) {
  if (!name) return state;
  const previous = { ...newNodeState(), ...(state.nodes[name] || {}) };
  const consecutiveSuccesses = result.ok ? previous.consecutiveSuccesses + 1 : 0;
  const recovered = result.ok
    && previous.excludedUntil <= now
    && consecutiveSuccesses >= DEFAULT_REENTRY_SUCCESSES;
  const probeEvents = [
    ...recentProbeEvents(previous, now, rollingWindowMs),
    {
      at: now,
      ok: Boolean(result.ok),
      delay: Number.isFinite(result.delay) ? result.delay : null,
    },
  ];

  const node = result.ok
    ? {
        ...previous,
        successes: previous.successes + 1,
        consecutiveFailures: 0,
        consecutiveSuccesses,
        lastSuccessAt: now,
        lastProbeAt: now,
        excludedUntil: recovered ? 0 : previous.excludedUntil,
        ejectionCount: previous.ejectionCount,
        probeEvents,
      }
    : {
        ...previous,
        failures: previous.failures + 1,
        consecutiveFailures: previous.consecutiveFailures + 1,
        consecutiveSuccesses: 0,
        lastFailureAt: now,
        lastProbeAt: now,
        probeEvents,
      };

  return {
    ...state,
    nodes: {
      ...state.nodes,
      [name]: node,
    },
  };
}

export function recordNodePathProbe(
  state,
  name,
  result,
  now = Date.now(),
  historyWindowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
) {
  if (!name || !isRealPathProbeResult(result)) return state;
  const previous = { ...newNodeState(), ...(state.nodes[name] || {}) };
  const lastPath = previous.pathEvents.at(-1);
  let penaltyRecoveryStartedAt = result.ok
    ? (lastPath?.ok && now - lastPath.at <= PENALTY_RECOVERY_MAX_GAP_MS
        ? previous.penaltyRecoveryStartedAt || now
        : now)
    : 0;
  let ejectionCount = previous.ejectionCount;
  if (result.ok && ejectionCount > 0
    && now - penaltyRecoveryStartedAt >= PENALTY_RECOVERY_MS) {
    ejectionCount -= 1;
    penaltyRecoveryStartedAt = now;
  }
  const pathEvents = [
    ...recentPathEvents(previous, now, historyWindowMs),
    {
      at: now,
      ok: Boolean(result.ok),
    },
  ];
  return {
    ...state,
    nodes: {
      ...state.nodes,
      [name]: {
        ...previous,
        ejectionCount,
        penaltyRecoveryStartedAt,
        pathEvents,
      },
    },
  };
}

export function isRealPathProbeResult(result) {
  return Boolean(result)
    && !result.infrastructureError
    && result.status !== "provider_unhealthy";
}

export function ejectNode(
  state,
  name,
  now = Date.now(),
  durationsMs = [15 * 60_000, 30 * 60_000, 60 * 60_000],
) {
  if (!name) return state;
  const previous = { ...newNodeState(), ...(state.nodes[name] || {}) };
  const ejectionCount = Math.min(previous.ejectionCount + 1, durationsMs.length);
  const durationMs = durationsMs[ejectionCount - 1];
  return {
    ...state,
    nodes: {
      ...state.nodes,
      [name]: {
        ...previous,
        consecutiveSuccesses: 0,
        penaltyRecoveryStartedAt: 0,
        ejectionCount,
        excludedUntil: Math.max(previous.excludedUntil, now + durationMs),
      },
    },
  };
}

export function ejectNodeOnce(
  state,
  name,
  now = Date.now(),
  durationsMs = [15 * 60_000, 30 * 60_000, 60 * 60_000],
) {
  if (!name || (state.nodes[name]?.excludedUntil || 0) > now) return state;
  return ejectNode(state, name, now, durationsMs);
}

export function passiveErrorKey(message = "") {
  const route = message.match(/(\S+:\d+)\s+-->\s+(\S+:\d+)/);
  if (route) return `${route[1].toLowerCase()}->${route[2].toLowerCase()}`;
  return message.trim().replace(/\s+/g, " ").toLowerCase();
}

export function addPassiveError(state, message = "", now = Date.now(), windowMs = 60_000) {
  const key = passiveErrorKey(message);
  const recent = state.passiveErrors.filter((event) => now - event.at <= windowMs);
  if (!key || recent.some((event) => event.key === key)) {
    return { ...state, passiveErrors: recent };
  }
  return {
    ...state,
    passiveErrors: [...recent, { at: now, key }],
  };
}

export function currentPathInstabilityReason(state, now = Date.now(), options = {}) {
  const {
    intermittentFailureThreshold = 2,
    intermittentFailureWindowMs = DEFAULT_ROLLING_WINDOW_MS,
    slowFailureThreshold = 4,
    slowFailureWindowMs = DEFAULT_ROLLING_WINDOW_MS,
  } = options;
  const currentNode = state.nodes[state.current] || newNodeState();
  const currentTenureStartedAt = state.currentSelectedAt || 0;
  const failuresSince = (windowMs) => {
    const startedAt = Math.max(now - windowMs, currentTenureStartedAt);
    return (currentNode.pathEvents || [])
      .filter((event) => !event.ok && event.at >= startedAt)
      .length;
  };

  if (failuresSince(intermittentFailureWindowMs) >= intermittentFailureThreshold) {
    return "intermittent_current_path_failures";
  }
  if (failuresSince(slowFailureWindowMs) >= slowFailureThreshold) {
    return "slow_current_path_failures";
  }
  return null;
}

function detectRecoveryReason(state, now, options) {
  const {
    failureThreshold = 3,
    minFailureAgeMs = 45_000,
    selectionFailureThreshold = 2,
    selectionFailureAgeMs = 5_000,
    selectionValidationMaxAgeMs = 30_000,
    hardFailureThreshold = 4,
    hardFailureAgeMs = 60_000,
    activeValidationFailureThreshold = 2,
    activeRecoveryFailureThreshold = 3,
    activeFailureAgeMs = 20_000,
    passiveThreshold = 2,
    passiveWindowMs = 60_000,
    activeTrafficGraceMs = 30_000,
    intermittentFailureThreshold = 2,
    intermittentFailureWindowMs = DEFAULT_ROLLING_WINDOW_MS,
    slowFailureThreshold = 4,
    slowFailureWindowMs = DEFAULT_ROLLING_WINDOW_MS,
  } = options;

  if (state.providerAlive === false && state.providerUnhealthyAt > 0) {
    return "provider_health_unavailable";
  }

  const recentPassiveErrors = state.passiveErrors
    .filter((event) => now - event.at <= passiveWindowMs).length;
  if (recentPassiveErrors >= passiveThreshold) {
    return "passive_transport_errors";
  }

  const firstFailureAt = state.currentFailureStartedAt || state.lastFailureAt;
  const validatingCurrent = state.selectionValidation?.to === state.current;
  const validationMaxAgeMs = state.selectionValidation?.maxAgeMs
    ?? selectionValidationMaxAgeMs;
  const validationFailureThreshold = state.selectionValidation?.failureThreshold
    ?? selectionFailureThreshold;
  const validationFailureAgeMs = state.selectionValidation?.failureAgeMs
    ?? selectionFailureAgeMs;
  if (
    validatingCurrent
    && now - state.selectionValidation.startedAt >= validationMaxAgeMs
  ) {
    return "selection_validation_timeout";
  }
  if (
    validatingCurrent
    && state.currentFailures >= validationFailureThreshold
    && firstFailureAt
    && now - firstFailureAt >= validationFailureAgeMs
  ) {
    return "selection_validation_failed";
  }

  if (
    state.currentFailures >= hardFailureThreshold
    && firstFailureAt
    && now - firstFailureAt >= hardFailureAgeMs
  ) {
    return "hard_current_probe_failures";
  }

  const activeTraffic = state.lastOpenAITrafficAt > 0
    && now - state.lastOpenAITrafficAt <= activeTrafficGraceMs;
  const activeFailureOldEnough = firstFailureAt
    && now - firstFailureAt >= activeFailureAgeMs;
  if (
    activeTraffic
    && activeFailureOldEnough
    && state.currentFailures >= activeRecoveryFailureThreshold
  ) {
    return "active_current_probe_failures";
  }
  if (
    activeTraffic
    && activeFailureOldEnough
    && state.currentFailures >= activeValidationFailureThreshold
  ) {
    return "active_current_probe_validation";
  }

  const instabilityReason = currentPathInstabilityReason(state, now, {
    intermittentFailureThreshold,
    intermittentFailureWindowMs,
    slowFailureThreshold,
    slowFailureWindowMs,
  });
  if (instabilityReason) return instabilityReason;

  if (now < state.holdUntil) return null;
  if (activeTraffic) return null;
  if (state.currentFailures < failureThreshold) return null;

  if (!firstFailureAt || now - firstFailureAt < minFailureAgeMs) return null;
  return "current_probe_failures";
}

function isCriticalRecoveryReason(reason) {
  return [
    "provider_health_unavailable",
    "passive_transport_errors",
    "selection_validation_timeout",
    "selection_validation_failed",
    "hard_current_probe_failures",
    "active_current_probe_failures",
  ].includes(reason);
}

export function recoveryReason(state, now = Date.now(), options = {}) {
  const reason = detectRecoveryReason(state, now, options);
  if (now < state.nextRecoveryAt) {
    const escalated = isCriticalRecoveryReason(reason)
      && !isCriticalRecoveryReason(state.lastRecoveryReason)
      && now - state.lastRecoveryAt >= 10_000;
    if (!escalated) return null;
  }
  return reason;
}

function compareNodeHealth(
  left,
  right,
  now,
  rollingWindowMs,
  pathHistoryWindowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
) {
  const leftStats = rollingNodeStats(left.node, now, rollingWindowMs);
  const rightStats = rollingNodeStats(right.node, now, rollingWindowMs);
  const leftPath = rollingPathStats(left.node, now, pathHistoryWindowMs);
  const rightPath = rollingPathStats(right.node, now, pathHistoryWindowMs);
  return rightPath.weightedReliability - leftPath.weightedReliability
    || left.node.ejectionCount - right.node.ejectionCount
    || rightStats.reliability - leftStats.reliability
    || Math.min(rightStats.total, 12) - Math.min(leftStats.total, 12)
    || leftStats.failures - rightStats.failures
    || left.node.consecutiveFailures - right.node.consecutiveFailures
    || right.node.lastSuccessAt - left.node.lastSuccessAt
    || leftStats.medianDelay - rightStats.medianDelay
    || left.name.localeCompare(right.name);
}

function candidateBucket(name) {
  const region = nodeRegion(name);
  const family = /HY2/i.test(name) ? "HY2" : /TCP/i.test(name) ? "TCP" : "STANDARD";
  return `${region}:${family}`;
}

export function nodeRegion(name = "") {
  return name.match(/^(JP|KR|SG|TW|US)/i)?.[1]?.toUpperCase() || "OTHER";
}

export function pickRecoveryBatch(candidates, state, now = Date.now(), options = {}) {
  const {
    limit = 5,
    rollingWindowMs = DEFAULT_ROLLING_WINDOW_MS,
    pathHistoryWindowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
  } = options;

  const ranked = [...new Set(candidates)]
    .filter((name) => name && name !== state.current)
    .map((name) => ({
      name,
      node: { ...newNodeState(), ...(state.nodes[name] || {}) },
    }))
    .filter(({ node }) => node.excludedUntil <= now)
    .sort((left, right) => compareNodeHealth(
      left,
      right,
      now,
      rollingWindowMs,
      pathHistoryWindowMs,
    ));

  const buckets = new Map();
  for (const candidate of ranked) {
    const key = candidateBucket(candidate.name);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(candidate.name);
  }

  const selected = [];
  while (selected.length < limit) {
    let added = false;
    for (const names of buckets.values()) {
      const name = names.shift();
      if (!name) continue;
      selected.push(name);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}

export function allowsEmergencyCoolingReuse(reason) {
  return [
    "provider_health_unavailable",
    "passive_transport_errors",
    "selection_validation_timeout",
    "selection_validation_failed",
    "hard_current_probe_failures",
    "active_current_probe_failures",
    "current_probe_failures",
  ].includes(reason);
}

export function pickEmergencyRecoveryBatch(
  candidates,
  state,
  now = Date.now(),
  options = {},
) {
  const {
    limit = 3,
    rollingWindowMs = DEFAULT_ROLLING_WINDOW_MS,
    pathHistoryWindowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
  } = options;
  const ranked = [...new Set(candidates)]
    .filter((name) => name && name !== state.current)
    .map((name) => ({
      name,
      node: { ...newNodeState(), ...(state.nodes[name] || {}) },
    }))
    .filter(({ node }) => node.excludedUntil > now)
    .sort((left, right) => (
      compareNodeHealth(
        left,
        right,
        now,
        rollingWindowMs,
        pathHistoryWindowMs,
      )
      || left.node.excludedUntil - right.node.excludedUntil
    ));

  const buckets = new Map();
  for (const candidate of ranked) {
    const key = candidateBucket(candidate.name);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(candidate.name);
  }

  const selected = [];
  while (selected.length < limit) {
    let added = false;
    for (const names of buckets.values()) {
      const name = names.shift();
      if (!name) continue;
      selected.push(name);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}

export function recordProviderRefreshAttempts(state, names, now = Date.now()) {
  const nodes = { ...state.nodes };
  for (const name of names) nodes[name] = { ...newNodeState(), ...nodes[name], lastProviderRefreshAt: now };
  return { ...state, nodes };
}

export function pickProviderRefreshBatch(
  candidates,
  proxies,
  state,
  now = Date.now(),
  options = {},
) {
  const {
    limit = 3,
    minProbeAgeMs = 30_000,
    rollingWindowMs = DEFAULT_ROLLING_WINDOW_MS,
    pathHistoryWindowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
  } = options;
  const ranked = [...new Set(candidates)]
    .filter((name) => (
      name
      && name !== state.current
      && proxies?.[name]?.alive !== true
    ))
    .map((name) => ({
      name,
      node: { ...newNodeState(), ...(state.nodes[name] || {}) },
    }))
    .filter(({ node }) => (
      now - Math.max(node.lastProbeAt, node.lastProviderRefreshAt) >= minProbeAgeMs
    ))
    .sort((left, right) => (
      left.node.lastProviderRefreshAt - right.node.lastProviderRefreshAt
      || left.node.lastProbeAt - right.node.lastProbeAt
      || Number(left.node.excludedUntil > now) - Number(right.node.excludedUntil > now)
      || compareNodeHealth(
        left,
        right,
        now,
        rollingWindowMs,
        pathHistoryWindowMs,
      )
      || left.node.lastProbeAt - right.node.lastProbeAt
    ));

  return ranked.slice(0, limit).map(({ name }) => name);
}

export function pickRadarBatch(candidates, state, now = Date.now(), options = {}) {
  const {
    coldLimit = 4,
    hotLimit = 0,
    minHotSamples = 3,
    rollingWindowMs = DEFAULT_ROLLING_WINDOW_MS,
    pathHistoryWindowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
  } = options;
  const eligible = [...new Set(candidates)]
    .filter((name) => name && name !== state.current)
    .map((name) => ({
      name,
      node: { ...newNodeState(), ...(state.nodes[name] || {}) },
    }))
    .filter(({ node }) => node.excludedUntil <= now);
  const ranked = [...eligible].sort(
    (left, right) => compareNodeHealth(
      left,
      right,
      now,
      rollingWindowMs,
      pathHistoryWindowMs,
    ),
  );
  const hot = ranked
    .filter(({ node }) => {
      const stats = rollingNodeStats(node, now, rollingWindowMs);
      return stats.total >= minHotSamples && node.consecutiveFailures === 0;
    })
    .slice(0, hotLimit)
    .map(({ name }) => name);
  const hotNames = new Set(hot);
  const cold = eligible
    .filter(({ name }) => !hotNames.has(name))
    .sort((left, right) => left.node.lastProbeAt - right.node.lastProbeAt
      || left.name.localeCompare(right.name))
    .slice(0, coldLimit)
    .map(({ name }) => name);
  return [...hot, ...cold];
}

function recentPathSuccessfulSeries(node, now, options = {}) {
  const {
    requiredPasses = 3,
    probeTtlMs = 75_000,
    historyWindowMs = 3 * 60_000,
    minSpanMs = 45_000,
  } = options;
  const history = [...(node.pathEvents || [])]
    .filter((event) => now - event.at <= historyWindowMs)
    .sort((left, right) => left.at - right.at);
  const samples = history.slice(history.findLastIndex((event) => !event.ok) + 1);
  if (samples.length < requiredPasses) return false;
  if (!samples.every((sample) => sample.ok)) return false;
  const oldest = samples[0];
  const newest = samples.at(-1);
  return now - newest.at <= probeTtlMs
    && newest.at - oldest.at >= minSpanMs;
}

function hotStandbyPathStats(node, now, windowMs) {
  const events = recentPathEvents(node, now, windowMs)
    .sort((left, right) => left.at - right.at);
  let consecutiveFailures = 0;
  for (let index = events.length - 1; index >= 0 && !events[index].ok; index -= 1) {
    consecutiveFailures += 1;
  }
  return {
    ...rollingPathStats(node, now, windowMs),
    consecutiveFailures,
    lastSuccessAt: events.findLast((event) => event.ok)?.at || 0,
  };
}

function compareHotStandbyHealth(left, right) {
  return left.path.consecutiveFailures - right.path.consecutiveFailures
    || right.path.weightedReliability - left.path.weightedReliability
    || left.node.ejectionCount - right.node.ejectionCount
    || right.path.lastSuccessAt - left.path.lastSuccessAt
    || left.name.localeCompare(right.name);
}

export function rankHotStandbys(
  candidates,
  state,
  now = Date.now(),
  options = {},
) {
  const {
    limit = 2,
    pathHistoryWindowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
  } = options;
  return [...new Set(candidates)]
    .filter((name) => name && name !== state.current)
    .map((name) => {
      const node = { ...newNodeState(), ...(state.nodes[name] || {}) };
      return { name, node, path: hotStandbyPathStats(node, now, pathHistoryWindowMs) };
    })
    .filter(({ node }) => (
      node.excludedUntil <= now
      && recentPathSuccessfulSeries(node, now, options)
    ))
    .sort(compareHotStandbyHealth)
    .slice(0, limit)
    .map(({ name }) => name);
}

export function pickHotStandbyProbeBatch(
  candidates,
  state,
  now = Date.now(),
  options = {},
) {
  const {
    limit = 2,
    pathHistoryWindowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
  } = options;
  const ranked = [...new Set(candidates)]
    .filter((name) => name && name !== state.current)
    .map((name) => {
      const node = { ...newNodeState(), ...(state.nodes[name] || {}) };
      return { name, node, path: hotStandbyPathStats(node, now, pathHistoryWindowMs) };
    })
    .filter(({ node }) => node.excludedUntil <= now)
    .sort(compareHotStandbyHealth);
  return ranked.slice(0, limit).map(({ name }) => name);
}

export function recordHotStandbyProbeAttempts(state, names, now = Date.now()) {
  const nodes = { ...state.nodes };
  for (const name of new Set(names.filter(Boolean))) {
    nodes[name] = { ...newNodeState(), ...nodes[name], lastHotStandbyProbeAt: now };
  }
  return { ...state, nodes };
}

export function planHotStandbyProbes(candidates, state, now = Date.now(), options = {}) {
  const { limit = 2, explorationMaxAgeMs = 120_000 } = options;
  const capacity = Math.max(0, Math.min(2, Math.floor(limit)));
  const pool = [...new Set(candidates)].filter(Boolean);
  const candidateKey = JSON.stringify([...pool].sort());
  const quality = pickHotStandbyProbeBatch(pool, state, now, { ...options, limit: pool.length });
  const readyOptions = {
    requiredPasses: 3,
    probeTtlMs: 45_000,
    historyWindowMs: 90_000,
    minSpanMs: 35_000,
    ...options.readyOptions,
    limit: pool.length,
  };
  const ready = rankHotStandbys(quality, state, now, readyOptions);
  const fastReady = ready.filter((name) => (
    hasRecentStablePathEvidence(state, name, now, options.fastOptions)
  ));
  if (fastReady.length > 0) {
    const fastNames = new Set(fastReady);
    return {
      batch: [...fastReady, ...quality.filter((name) => !fastNames.has(name))].slice(0, capacity),
      exploration: null,
    };
  }
  if (capacity < 2 || quality.length < 2) {
    return { batch: quality.slice(0, capacity), exploration: null };
  }

  const previous = state.hotStandbyExploration;
  let exploration = null;
  if (previous && quality.includes(previous.name) && previous.candidateKey === candidateKey
    && previous.startedAt <= now && now - previous.startedAt < explorationMaxAgeMs) {
    const node = state.nodes[previous.name] || newNodeState();
    const lastAttemptAt = node.lastHotStandbyProbeAt || 0;
    const latestPath = [...(node.pathEvents || [])].sort((left, right) => left.at - right.at).at(-1);
    // The controller plans only after the preceding batch settled. An attempt
    // without a real path result is infrastructure failure, not node failure.
    const attemptFailed = lastAttemptAt >= previous.startedAt
      && (!latestPath || latestPath.at < lastAttemptAt || !latestPath.ok);
    if (!attemptFailed) exploration = { ...previous };
  }
  if (!exploration) {
    const unexplored = quality.filter((name) => name !== previous?.name);
    const lastAttemptAt = (name) => {
      const node = state.nodes[name] || newNodeState();
      return Math.max(node.lastHotStandbyProbeAt || 0,
        ...(node.pathEvents || []).map((event) => event.at));
    };
    unexplored.sort((left, right) => lastAttemptAt(left) - lastAttemptAt(right)
      || left.localeCompare(right));
    if (unexplored.length > 0) {
      exploration = { name: unexplored[0], startedAt: now, candidateKey };
    }
  }
  if (!exploration) return { batch: quality.slice(0, capacity), exploration: null };
  return {
    batch: [...quality.filter((name) => name !== exploration.name).slice(0, 1), exploration.name],
    exploration,
  };
}

export function rankFreshSuccesses(
  samples,
  state,
  now = Date.now(),
  ttlMs = 90_000,
  rollingWindowMs = DEFAULT_ROLLING_WINDOW_MS,
  pathHistoryWindowMs = DEFAULT_PATH_HISTORY_WINDOW_MS,
) {
  return samples
    .filter((sample) => sample.ok && now - sample.testedAt <= ttlMs)
    .sort((left, right) => compareNodeHealth(
      { name: left.name, node: { ...newNodeState(), ...(state.nodes[left.name] || {}) } },
      { name: right.name, node: { ...newNodeState(), ...(state.nodes[right.name] || {}) } },
      now,
      rollingWindowMs,
      pathHistoryWindowMs,
    ));
}

export function filterProviderAliveCandidates(candidates, proxies = {}) {
  return [...new Set(candidates)]
    .filter((name) => name && proxies?.[name]?.alive === true);
}

export function qualifiesProbeSeries(samples, requiredPasses = 3) {
  return Array.isArray(samples)
    && samples.length >= requiredPasses
    && samples.slice(0, requiredPasses).every((sample) => sample?.ok === true);
}

export function recoveryBackoffDelay(
  priorExhaustions,
  scheduleMs = [10_000, 30_000, 60_000, 5 * 60_000],
) {
  if (!Array.isArray(scheduleMs) || scheduleMs.length === 0) return 10_000;
  const index = Math.min(
    Math.max(0, Number(priorExhaustions) || 0),
    scheduleMs.length - 1,
  );
  return scheduleMs[index];
}

export function recoveryBackoffDelayForReason(
  priorExhaustions,
  reason,
  options = {},
) {
  const {
    defaultScheduleMs = [10_000, 30_000, 60_000, 5 * 60_000],
    providerUnavailableScheduleMs = [10_000, 30_000, 30_000],
    activeTraffic = false,
  } = options;
  const delay = recoveryBackoffDelay(
    priorExhaustions,
    reason === "provider_health_unavailable"
      ? providerUnavailableScheduleMs
      : defaultScheduleMs,
  );
  return isCriticalRecoveryReason(reason) || activeTraffic
    ? Math.min(delay, 60_000)
    : delay;
}

export function shouldWakeRecoveryForStandby(
  state,
  readyCandidates,
  now = Date.now(),
) {
  return Array.isArray(readyCandidates)
    && readyCandidates.length > 0
    && state.nextRecoveryAt > now
    && (state.providerAlive === false || state.currentFailures > 0);
}

export function isGroupConnection(connection, groupName, nodeName = null) {
  const chains = Array.isArray(connection?.chains) ? connection.chains : [];
  return Boolean(connection?.id)
    && chains.includes(groupName)
    && (nodeName == null || chains.includes(nodeName));
}

export function connectionRouteKey(connection) {
  const metadata = connection?.metadata || {};
  const sourceIP = String(metadata.sourceIP || "").trim().toLowerCase();
  const sourcePort = String(metadata.sourcePort || "").trim();
  const destination = String(metadata.host || metadata.destinationIP || "")
    .trim()
    .toLowerCase();
  const destinationPort = String(metadata.destinationPort || "").trim();
  if (!sourceIP || !sourcePort || !destination || !destinationPort) return null;
  return `${sourceIP}:${sourcePort}->${destination}:${destinationPort}`;
}

export function planConnectionDrain(connections, groupName, currentNode) {
  return (Array.isArray(connections) ? connections : [])
    .filter((connection) => (
      isGroupConnection(connection, groupName)
      && !isGroupConnection(connection, groupName, currentNode)
    ))
    .map((connection) => ({
      id: connection.id,
      routeKey: connectionRouteKey(connection),
    }));
}

export function isOpenAIPathError(message = "") {
  return /OpenAI 自动选择/i.test(message)
    && /(?:-->\s+|DomainSuffix\/)(?:chatgpt\.com|ws\.chatgpt\.com)(?::443|\b)/i.test(message)
    && /error|timeout|deadline|eof|reset|refused|tls|closed|unreachable|forbidden|403/i.test(message);
}

export function observeNetworkPath(observation, path, now, stableMs = 10_000) {
  const previous = observation || { current: null, initialized: false };
  // Failed reads and sampling gaps cannot confirm a route transition.
  if (!path) return { ...previous, pending: null, since: 0, lastObservedAt: now, changed: false };
  if (!previous.initialized) return { current: path, initialized: true, pending: null, since: 0, lastObservedAt: now, changed: false };
  if (!networkPathChanged(previous.current, path)) return { ...previous, pending: null, since: 0, lastObservedAt: now, changed: false };
  const continuous = previous.pending && !networkPathChanged(previous.pending, path)
    && now - previous.lastObservedAt <= 15_000;
  if (continuous && now - previous.since >= stableMs) {
    return { current: path, initialized: true, pending: null, since: 0, lastObservedAt: now, changed: true };
  }
  return { ...previous, pending: path, since: continuous ? previous.since : now, lastObservedAt: now, changed: false };
}
