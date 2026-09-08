import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as lib from './lib.mjs';

const source = fs.readFileSync(new URL('./controller.mjs', import.meta.url), 'utf8');
const controllerDefinitions = source.slice(source.indexOf('const args ='), source.indexOf('process.on("SIGTERM"'));
const O = 'JP-ORIGIN', C = 'TW-CANDIDATE', M = 'US-MANUAL';
const Z1 = 'ZZ-PLACEHOLDER-1', Z2 = 'ZZ-PLACEHOLDER-2';

function createFixture(scenario) {
  const trace = [];
  const fixture = { scenario, selector: O, candidates: [O, C, M, Z1, Z2], phase: 'qualification', switched: false };
  const context = vm.createContext({
    ...lib, os, path, Buffer, URL, URLSearchParams, Date,
    process: { argv: ['node', 'controller.mjs'], env: {}, platform: 'linux', stdout: { write(line) { trace.push(JSON.parse(line)); } } },
    fixture,
    async fakeRequest(method, requestPath, body) {
      if (method === 'PUT') {
        trace.push({ event: 'fixture.put', from: fixture.selector, to: body.name });
        fixture.selector = body.name;
        if (scenario === 'write_response_lost') throw new Error('Truncated response after accepted write');
        return null;
      }
      if (requestPath === '/connections') return { connections: [] };
      if (requestPath === '/proxies') return { proxies: { [O]: { alive: false }, [C]: { alive: true }, [M]: { alive: false }, [Z1]: { alive: true }, [Z2]: { alive: true } } };
      if (requestPath.includes(encodeURIComponent('OpenAI 自动选择'))) {
        const result = { type: 'Selector', now: fixture.selector, all: [...fixture.candidates] };
        trace.push({ event: 'fixture.group_read', now: fixture.selector });
        if (scenario === 'manual_between_rollback_read_and_put' && !fixture.switched) {
          fixture.switched = true;
          queueMicrotask(() => {
            fixture.selector = M;
            trace.push({ event: 'fixture.manual_selection', now: M });
          });
        }
        return result;
      }
      return { alive: true };
    },
    async fakeCurl(endpoint, proxyUrl = 'http://127.0.0.1:7897') {
      if (!fixture.switched && (
        (scenario === 'manual_during_qualification' && proxyUrl.includes(':17901'))
        || (['manual_during_post_switch', 'manual_during_current'].includes(scenario) && proxyUrl.includes(':7897'))
      )) {
        fixture.switched = true;
        fixture.selector = M;
        trace.push({ event: 'fixture.manual_selection', now: M });
      }
      if (scenario === 'candidate_map_changes' && !fixture.switched) {
        fixture.switched = true;
        fixture.candidates = [O, C];
      }
      trace.push({ event: 'fixture.path_probe', proxyUrl, actualSelector: fixture.selector });
      return { ok: true, status: Array.isArray(endpoint.expected) ? endpoint.expected[0] : endpoint.expected, bytes: 4000, totalMs: 10, error: '' };
    },
  });
  vm.runInContext(controllerDefinitions, context);
  vm.runInContext(`
    mihomoRequest = fakeRequest;
    curlProbe = fakeCurl;
    sleep = async () => {};
    state.current = ${JSON.stringify(O)};
    state.currentSelectedAt = Date.now() - 120000;
    state.currentFailures = 4;
    state.currentFailureStartedAt = Date.now() - 70000;
    state.lastFailureAt = Date.now() - 1000;
    state.providerAlive = false;
    state.providerUnhealthyAt = Date.now() - 70000;
    globalThis.audit = {
      maybeRecover, rollbackRejectedCandidate, probeNodePath, checkCurrent, qualifyCandidates,
      getState: () => state,
    };
  `, context);
  return { context, fixture, trace, evaluate: code => vm.runInContext(code, context) };
}

for (const scenario of ['manual_during_qualification', 'manual_during_post_switch']) {
  test(`${scenario}: abort recovery and preserve the external choice`, async () => {
    const {context, fixture, trace} = createFixture(scenario);
    assert.equal(await context.audit.maybeRecover(), false);
    assert.equal(fixture.selector, M);
    assert.equal(context.audit.getState().current, M);
    assert.equal(context.audit.getState().nextRecoveryAt, 0);
    assert.ok(trace.some(e => e.event === 'recovery_aborted'));
    assert.equal(trace.some(e => e.event === 'recovery_complete'), false);
    assert.equal(trace.filter(e => e.event === 'post_switch_probe').length, 0);
    const puts = trace.filter(e => e.event === 'fixture.put');
    assert.equal(puts.length, scenario === 'manual_during_qualification' ? 0 : 1);
    assert.equal(context.audit.getState().selectionValidation.source, 'manual');
  });
}

test('an external choice already present before rollback is preserved', async () => {
  const {context, fixture, trace} = createFixture('manual_before_rollback_read');
  fixture.selector = M;
  assert.equal(await context.audit.rollbackRejectedCandidate({current:O}, C, 'test'), false);
  assert.equal(fixture.selector, M);
  assert.equal(trace.filter(e => e.event === 'fixture.put').length, 0);
});

test('a manual change between rollback inspection and guarded write cancels rollback', async () => {
  const {context, fixture, trace} = createFixture('manual_between_rollback_read_and_put');
  fixture.selector = C;
  await assert.rejects(context.audit.rollbackRejectedCandidate({current:O}, C, 'test'), {code:'RECOVERY_ABORTED'});
  assert.equal(fixture.selector, M);
  assert.equal(context.audit.getState().current, M);
  assert.equal(trace.filter(e => e.event === 'fixture.put').length, 0);
});

test('candidate mapping changes remain an infrastructure failure', async () => {
  const {context} = createFixture('candidate_map_changes');
  const result = await context.audit.probeNodePath(C);
  assert.equal(result.ok, false);
  assert.equal(result.infrastructureError, true);
  assert.equal(result.status, 'probe_route_changed');
});

test('an accepted selector write with a lost response starts validation without claiming recovery', async () => {
  const {context, fixture, trace} = createFixture('write_response_lost');
  assert.equal(await context.audit.maybeRecover(), false);
  assert.equal(fixture.selector, C);
  const state = context.audit.getState();
  assert.equal(state.current, C);
  assert.equal(state.selectionValidation.source, 'controller_unconfirmed');
  assert.equal(state.selectionValidation.consecutiveSuccesses, 0);
  assert.equal(state.selectionValidation.successThreshold, 4);
  assert.equal(state.selectionValidation.failureThreshold, 1);
  assert.equal(state.nextRecoveryAt, 0);
  assert.equal(trace.filter(e => e.event === 'fixture.put').length, 1);
  assert.equal(trace.some(e => e.event === 'recovery_complete'), false);
  await context.audit.checkCurrent();
  await context.audit.checkCurrent();
  assert.equal(context.audit.getState().selectionValidation.consecutiveSuccesses, 2);
  assert.equal(trace.some(e => e.event === 'selection_verified'), false);
  await context.audit.checkCurrent();
  await context.audit.checkCurrent();
  assert.equal(context.audit.getState().selectionValidation, null);
  assert.ok(trace.some(e => e.event === 'selection_verified' && e.source === 'controller_unconfirmed'));
});

test('a live current probe crossing an external selection is discarded and immediately rescheduled', async () => {
  const {context, fixture, trace, evaluate} = createFixture('manual_during_current');
  assert.equal(await context.audit.checkCurrent(), false);
  assert.equal(fixture.selector, M);
  assert.equal(context.audit.getState().current, M);
  assert.equal(context.audit.getState().nodes[O]?.pathEvents?.length || 0, 0);
  assert.ok(trace.some(e => e.event === 'current_probe_discarded'));
  assert.ok(evaluate('nextCurrentProbeAt') <= Date.now());
});

test('an active confirmation interrupted by manual selection does not eject the new node', async () => {
  const {context, fixture, trace, evaluate} = createFixture('manual_during_current');
  evaluate(`
    state.providerAlive = true;
    state.providerUnhealthyAt = 0;
    state.currentFailures = 2;
    state.lastOpenAITrafficAt = Date.now();
  `);
  assert.equal(await context.audit.maybeRecover(), false);
  assert.equal(fixture.selector, M);
  assert.equal(context.audit.getState().current, M);
  assert.equal(context.audit.getState().nodes[M]?.excludedUntil || 0, 0);
  assert.equal(trace.some(e => e.event === 'current_node_ejected' && e.node === M), false);
  assert.equal(trace.filter(e => e.event === 'fixture.put').length, 0);
});

test('qualification waits for its siblings before returning an infrastructure rejection', async () => {
  const {context, evaluate} = createFixture('qualification_settlement');
  evaluate(`
    let releaseSibling;
    let completedSibling = false;
    probeNodePath = async (name) => {
      if (name === 'BROKEN') throw new Error('fixture API failure');
      await new Promise(resolve => { releaseSibling = resolve; });
      completedSibling = true;
      return {name, ok:false, status:'000', testedAt:Date.now()};
    };
  `);
  let settled = false;
  const pending = context.audit.qualifyCandidates(['BROKEN', 'SLOW']).finally(() => { settled = true; });
  const expectedFailure = assert.rejects(pending, /fixture API failure/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  evaluate('releaseSibling()');
  await expectedFailure;
  assert.equal(evaluate('completedSibling'), true);
});

test('manual cancellation wins over a sibling API failure without scheduling old retry on the new node', async () => {
  const {context, fixture, trace, evaluate} = createFixture('mixed_qualification_errors');
  evaluate(`
    probeNodePath = async (name) => {
      if (name === 'TW-CANDIDATE') throw new Error('fixture API failure');
      fixture.selector = 'US-MANUAL';
      await refreshGroup();
      throw recoveryAborted('selection_or_network_changed');
    };
  `);
  assert.equal(await context.audit.maybeRecover(), false);
  assert.equal(fixture.selector, M);
  assert.equal(context.audit.getState().nextRecoveryAt, 0);
  assert.equal(context.audit.getState().recoveryExhaustions, 0);
  assert.equal(context.audit.getState().nodes[M]?.excludedUntil || 0, 0);
  assert.equal(trace.some(e => e.event === 'recovery_failed'), false);
});

test('rollback restores only still-recent passive evidence from the recovery origin', async () => {
  const {context, fixture, evaluate} = createFixture('passive_rollback');
  fixture.selector = C;
  evaluate(`state.current='TW-CANDIDATE';state.currentSelectedAt=Date.now();`);
  const recent = {at:Date.now()-1000,key:'old-route-disconnect'};
  const expired = {at:Date.now()-120000,key:'expired-disconnect'};
  assert.equal(await context.audit.rollbackRejectedCandidate({
    current:O, currentSelectedAt:Date.now()-90000, currentFailures:0,
    passiveErrors:[recent,expired],
  }, C, 'passive_transport_errors'), true);
  assert.equal(fixture.selector, O);
  assert.equal(context.audit.getState().passiveErrors.length, 1);
  assert.equal(context.audit.getState().passiveErrors[0].key, recent.key);
});
