'use strict';
// A single queue per publisher, shared by tide and weather. No retries on a denial.
function createSourceGate({ now = () => Date.now(), gapMs = 10000, enabled = () => true, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const state = { until:0, wait:0, status:null, since:null };
  const queue = [];
  let running = false, lastStart = -Infinity;
  function blocked() {
    return Object.assign(new Error('Centro Maree: fonte in pausa dopo HTTP ' + state.status), { blocked:true, retryAt:state.until });
  }
  async function check(response) {
    const status = response.status;
    const raw = response.headers?.get?.('retry-after');
    if (status === 403 || status === 429 || (status === 503 && raw)) {
      const n = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) * 1000 : Date.parse(raw || '') - now();
      const retry = Number.isFinite(n) ? Math.max(0,n) : 0;
      state.wait = Math.min(30 * 60000, state.wait ? state.wait * 2 : 5 * 60000);
      state.until = now() + Math.max(state.wait,retry);
      state.status = status; state.since = state.since || now();
      try { await response.body?.cancel(); } catch {}
      throw blocked();
    }
    return response;
  }
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        if (now() < state.until) { for(const item of queue.splice(0)) item.reject(blocked()); break; }
        const delay = gapMs - (now() - lastStart);
        if (delay > 0) await sleep(delay);
        queue.sort((a,b) => a.priority-b.priority);
        const item = queue.shift();
        if (now() < state.until) { item.reject(blocked()); continue; }
        lastStart = now();
        try {
          const result = await item.task(check);
          state.until=0; state.wait=0; state.status=null; state.since=null;
          item.resolve(result);
        } catch(error) { item.reject(error); }
      }
    } finally { running=false; }
  }
  function run(task, priority = 1) {
    if (!enabled()) return Promise.reject(Object.assign(new Error('Centro Maree: acquisizione disattivata'),{blocked:true}));
    if (now() < state.until) return Promise.reject(blocked());
    return new Promise((resolve,reject) => { queue.push({task,priority,resolve,reject}); void drain(); });
  }
  return {run,state};
}
// Integration tests use injected responses; production spacing is independent of request volume.
const cpsmGate = createSourceGate({gapMs:process.env.NODE_TEST_CONTEXT ? 0 : 10000, enabled:()=>process.env.CPSM_OPEN_DATA_ENABLED !== 'false'});
module.exports = { createSourceGate, cpsmGate };
