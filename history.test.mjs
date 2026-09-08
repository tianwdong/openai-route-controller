import test from 'node:test';
import assert from 'node:assert/strict';
import * as lib from './lib.mjs';

const start = 1_800_000_000_000;
const failure = {ok:false,status:'000',totalMs:7000};
const success = {ok:true,status:'405/403',totalMs:300};
const production = {intermittentFailureThreshold:3,intermittentFailureWindowMs:300000,slowFailureThreshold:4,slowFailureWindowMs:600000};
const candidateNames = Array.from({length:45},(_,i)=>`${['JP','TW','US','SG','KR'][i%5]}-${i+1}`);

test('45-node independent scanning covers unseen nodes even if attempts return infrastructure errors',()=>{
  for(let seed=0;seed<20;seed++) {
    const names=[...candidateNames.slice(seed),...candidateNames.slice(0,seed)];
    let state=lib.newWatchdogState();state.current='CURRENT';
    const proxies=Object.fromEntries(names.map(name=>[name,{alive:false}]));
    const seen=new Set();
    for(let round=0;round<15;round++) {
      const now=start+round*(30000+seed*100);
      const batch=lib.pickProviderRefreshBatch(names,proxies,state,now,{limit:3});
      assert.equal(batch.length,3);
      for(const name of batch) {assert.equal(seen.has(name),false);seen.add(name);}
      // Record dispatch, deliberately no probe history: a listener/API failed.
      state=lib.recordProviderRefreshAttempts(state,batch,now);
    }
    assert.equal(seen.size,45);
  }
});

test('continuous activity cold radar covers the eligible pool while preserving cooldown',()=>{
  for(let seed=0;seed<20;seed++) {
    let state=lib.newWatchdogState();state.current='CURRENT';
    state=lib.ejectNodeOnce(state,candidateNames[0],start,[7200000]);
    const seen=new Set();
    for(let round=0;round<44;round++) {
      const now=start+round*60000;state.lastOpenAITrafficAt=now;
      const batch=lib.pickRadarBatch([...candidateNames,'CURRENT'],state,now,{coldLimit:1,hotLimit:0});
      assert.equal(batch.length,1);assert.notEqual(batch[0],candidateNames[0]);
      assert.equal(seen.has(batch[0]),false);seen.add(batch[0]);
      state=lib.recordNodeProbe(state,batch[0],(round+seed)%3 ? failure:success,now);
    }
    assert.equal(seen.size,44);
  }
});

test('green requests between three real failures cannot erase five-minute instability',()=>{
  for(let seed=0;seed<20;seed++) {
    let state=lib.newWatchdogState();state.current='CURRENT';state.currentSelectedAt=start;
    for(let index=0;index<5;index++) {
      const now=start+1000+index*(20000+seed*100);
      const result=index%2===0?failure:success;
      state=lib.recordCurrentProbe(state,result,now);
      state=lib.recordNodePathProbe(state,'CURRENT',result,now);
    }
    const now=start+110000;
    state=lib.recordCurrentProbe(state,success,now);
    state=lib.recordNodePathProbe(state,'CURRENT',success,now);
    assert.equal(lib.recoveryReason(state,now,production),'intermittent_current_path_failures');
    assert.equal(lib.recoveryReason(state,start+800000,production),null);
  }
});

test('120 cached unavailability events never become real path failure evidence',()=>{
  let state=lib.newWatchdogState();state.current='CURRENT';
  for(let i=0;i<120;i++) state=lib.recordNodePathProbe(state,'CURRENT',{...failure,status:'provider_unhealthy'},start+i*1000);
  assert.equal(state.nodes.CURRENT?.pathEvents?.length||0,0);
  state=lib.recordNodePathProbe(state,'CURRENT',failure,start+120000);
  assert.equal(state.nodes.CURRENT.pathEvents.length,1);
});

test('repeated ejection requests preserve cooldown; 30-minute clean evidence lowers a penalty once',()=>{
  for(let seed=0;seed<20;seed++) {
    let state=lib.newWatchdogState();state.current='CURRENT';
    state=lib.ejectNodeOnce(state,'CURRENT',start);
    const deadline=state.nodes.CURRENT.excludedUntil;
    for(let i=1;i<45;i++) state=lib.ejectNodeOnce(state,'CURRENT',start+i*19000);
    assert.equal(state.nodes.CURRENT.excludedUntil,deadline);
    assert.equal(state.nodes.CURRENT.ejectionCount,1);
    for(let i=0;i<=60;i++) state=lib.recordNodePathProbe(state,'CURRENT',success,start+1000+i*30000);
    assert.equal(state.nodes.CURRENT.ejectionCount,0);
    assert.equal(state.nodes.CURRENT.excludedUntil,deadline);
  }
});

test('exhaustion schedules stay bounded and a new critical event respects the ten-second floor',()=>{
  for(let exhaustion=0;exhaustion<20;exhaustion++) {
    assert.ok(lib.recoveryBackoffDelayForReason(exhaustion,'provider_health_unavailable')<=30000);
    assert.ok(lib.recoveryBackoffDelayForReason(exhaustion,'passive_transport_errors')<=60000);
    let state=lib.newWatchdogState();state.current='CURRENT';
    state.lastRecoveryReason='intermittent_current_path_failures';state.lastRecoveryAt=start;
    state.nextRecoveryAt=start+300000;
    state=lib.recordProviderHealth(state,false,start+1000);
    assert.equal(lib.recoveryReason(state,start+9999,production),null);
    assert.equal(lib.recoveryReason(state,start+10000,production),'provider_health_unavailable');
    state.lastRecoveryReason='provider_health_unavailable';
    assert.equal(lib.recoveryReason(state,start+20000,production),null);
  }
});

test('old connections are drained without including the current node or another selector',()=>{
  const group='OpenAI 自动选择';
  const connections=Array.from({length:120},(_,i)=>({id:`connection-${i}`,chains:[i%3===0?'OLD':'CURRENT',i%5===0?'OTHER':group],metadata:{sourceIP:'127.0.0.1',sourcePort:String(40000+i),host:'chatgpt.com',destinationPort:'443'}}));
  const drained=lib.planConnectionDrain(connections,group,'CURRENT');
  assert.equal(drained.length,32);
  assert.ok(drained.every(c=>connections.find(x=>x.id===c.id).chains.includes('OLD')));
  assert.equal(connections.length,120);
});
