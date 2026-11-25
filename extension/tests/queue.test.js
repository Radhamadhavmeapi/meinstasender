// Runs the real policy/campaign/template/queue code in a VM with fake chrome.storage, fake Instagram and a fake license server.
// node --test extension/tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function load({ ig = {}, license = {} } = {}) {
  const mem = {};
  let clock = Date.parse('2026-11-25T06:00:00Z');
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  const ctx = {
    Date: FakeDate,
    console, setTimeout, clearTimeout, setInterval, clearInterval, crypto: require('crypto').webcrypto,
    navigator: { onLine: true }, AbortController, setImmediate,
    addEventListener() {}, removeEventListener() {},
    chrome: {
      runtime: { getManifest: () => ({ version: '1.0.0' }) },
      i18n: { getUILanguage: () => 'en' },
      storage: { local: {
        async get(k) { if (k == null) return { ...mem }; const ks = Array.isArray(k) ? k : [k]; return Object.fromEntries(ks.filter((x) => x in mem).map((x) => [x, structuredClone(mem[x])])); },
        async set(o) { for (const [k, v] of Object.entries(o)) mem[k] = structuredClone(v); },
        async remove(k) { for (const x of [].concat(k)) delete mem[x]; },
      } },
    },
    structuredClone,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['js/config.js', 'js/util.js', 'js/i18n.js', 'js/policy.js', 'js/campaigns.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  const M = ctx.MDM;
  M.u.sleep = async (ms) => { clock += Math.max(1, ms || 0); await new Promise((r) => setImmediate(r)); }; // fake time
  M.track = () => {};
  M.ig = { getSession: async () => ({ ok: true, viewerId: '111', csrf: 'c', username: 'me' }), resolveUser: async (u) => ({ userId: 'id_' + u, fullName: u.toUpperCase() }),
    createThread: async (id) => 'th_' + id, sendText: async () => ({ status: 'ok' }), ...ig };
  let reserved = 0;
  M.license = { entitlement: async () => ({ tier: 'free', dailyCap: 100, freeDailyLimit: 1000 }), reserve: async () => { reserved++; return { ok: true }; },
    release: async () => { reserved--; }, serverReachable: async () => true, ...license };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/queue.js'), 'utf8'), ctx, { filename: 'queue.js' });
  return { M, mem, reserved: () => reserved };
}

function runToEnd(M, campaignId) {
  return new Promise((resolve, reject) => {
    const off = M.queue.on((type, d) => { if (type === 'done') { off(); resolve(d); } });
    M.queue.start({ campaignId }).catch(reject);
  });
}

async function makeCampaign(M, names, message = 'Hi {{first_name|there}} from {city|town}') {
  return M.campaigns.create({ message, recipients: names.map((n) => ({ username: n, fields: { name: n === 'b' ? '' : 'Ravi Kumar' } })) });
}

test('template: variables, fallbacks, spintax', () => {
  const { M } = load();
  const r = { username: 'ravi', fields: { Name: 'Ravi Kumar', City: 'Pune' } };
  assert.equal(M.template.render('Hi {{first_name}} from {{city}} (@{{username}})', r), 'Hi Ravi from Pune (@ravi)');
  assert.equal(M.template.render('Hi {{company|friend}}', r), 'Hi friend');
  const out = M.template.render('{Hi|Hello} {{name}}', r, () => 0.99);
  assert.equal(out, 'Hello Ravi Kumar');
});

test('queue sends everyone, records history, de-dups across campaigns', async () => {
  const sent = [];
  const { M, mem } = load({ ig: { sendText: async (v, th, text) => { sent.push([th, text]); return {}; } } });
  const c = await makeCampaign(M, ['a', 'b', 'c']);
  const d = await runToEnd(M, c.id);
  assert.equal(d.reason, 'complete');
  assert.equal(d.sent, 3);
  assert.equal(sent.length, 3);
  assert.equal(sent[0][0], 'th_id_a');
  assert.match(sent[0][1], /^Hi Ravi from (city|town)$/);
  assert.match(sent[1][1], /^Hi B from/); // empty name column → Instagram display name
  const { M: M2 } = load();
  assert.equal(M2.template.render('Hi {{first_name|there}}', { username: 'q', fields: {} }), 'Hi there');
  assert.equal(mem.history.length, 3);
  assert.equal(mem['acct:111'].count, 3);
  // A second campaign with an overlapping person skips them.
  const c2 = await makeCampaign(M, ['c', 'd']);
  const d2 = await runToEnd(M, c2.id);
  assert.equal(d2.sent, 1);
  assert.equal(d2.skipped, 1);
});

test('batch break after 10 attempts and daily limit stop', async () => {
  const { M, mem } = load();
  await M.policy.saveSettings({ dailyLimit: 12 });
  const names = Array.from({ length: 15 }, (_, i) => 'u' + i);
  const c = await makeCampaign(M, names);
  // Break is wall-clock based; clear it whenever it's set so the run can proceed.
  const off = M.queue.on((type, p) => { if (type === 'progress' && p && p.phase === 'break') M.policy.clearBreak('111'); });
  const d = await runToEnd(M, c.id);
  off();
  assert.equal(d.reason, 'daily_limit');
  assert.equal(d.sent, 12);
  assert.equal(d.left, 3);
  assert.equal(mem['acct:111'].count, 12);
});

test('free limit stops with remaining count; failed reservation is released', async () => {
  let n = 0;
  const { M } = load({ license: { reserve: async () => (++n > 2 ? { ok: false, error: 'free_limit', freeDailyLimit: 2 } : { ok: true }) } });
  const c = await makeCampaign(M, ['a', 'b', 'c', 'd']);
  const d = await runToEnd(M, c.id);
  assert.equal(d.reason, 'free_limit');
  assert.equal(d.sent, 2);
  assert.equal(d.left, 2);
});

test('not-found is terminal and skipped; Instagram block stops with cooldown', async () => {
  const { M, mem, reserved } = load({ ig: {
    resolveUser: async (u) => { if (u === 'ghost') throw Object.assign(new Error('user_not_found'), { status: 404, layer: 'lookup' }); return { userId: 'id_' + u }; },
    sendText: async (v, th) => { if (th === 'th_id_x') throw Object.assign(new Error('feedback_required'), { layer: 'mqtt_publish', published: true }); return {}; },
  } });
  const c = await makeCampaign(M, ['ghost', 'a', 'x', 'z']);
  const d = await runToEnd(M, c.id);
  assert.equal(d.reason, 'ig_block');
  assert.equal(d.sent, 1);
  assert.equal(d.failed, 2);
  const camp = await M.campaigns.get(c.id);
  assert.equal(camp.recipients.find((r) => r.username === 'ghost').state, 'failed');
  assert.ok(mem['acct:111'].igCooldownUntil > Date.parse('2026-11-25T06:00:00Z') + 23 * 3600e3);
  // ghost was released (never reached IG send), x was published → not released.
  assert.equal(reserved(), 2);
});

test('three generic failures → one probe → second streak stops; person stays pending until 3 attempts', async () => {
  let probes = 0;
  const { M } = load({ ig: { createThread: async () => { throw Object.assign(new Error('http_500'), { status: 500, layer: 'thread' }); } } });
  const c = await makeCampaign(M, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  M.queue.on((type, p) => { if (type === 'progress' && p && p.phase === 'probe') probes++; });
  const d = await runToEnd(M, c.id);
  assert.equal(d.reason, 'fail_streak');
  assert.equal(probes, 1);
  const camp = await M.campaigns.get(c.id);
  assert.ok(camp.recipients.filter((r) => r.state === 'pending' && r.attempts === 1).length >= 6);
});

test('pause / account switch while paused / resume continues with new account', async () => {
  let viewer = '111';
  const { M } = load({ ig: { getSession: async () => ({ ok: true, viewerId: viewer, csrf: 'c', username: 'acct' + viewer }) } });
  const c = await makeCampaign(M, ['a', 'b', 'c']);
  let switched = null;
  const done = new Promise((resolve) => {
    let paused = false;
    M.queue.on((type, d) => {
      if (type === 'row' && d.status === 'sent' && !paused) { paused = true; M.queue.pause(); setTimeout(() => { viewer = '222'; M.queue.resume(); }, 20); }
      if (type === 'switched') switched = d.username;
      if (type === 'done') resolve(d);
    });
  });
  await M.queue.start({ campaignId: c.id });
  const d = await done;
  assert.equal(d.reason, 'complete');
  assert.equal(d.sent, 3);
  assert.equal(switched, 'acct222');
});

test('account switch without pausing stops the run', async () => {
  let calls = 0;
  const { M } = load({ ig: { getSession: async () => ({ ok: true, viewerId: ++calls > 2 ? '999' : '111', csrf: 'c' }) } });
  const c = await makeCampaign(M, ['a', 'b', 'c']);
  const d = await runToEnd(M, c.id);
  assert.equal(d.reason, 'acct_switch');
});

test('transport loss pauses and the same person is retried after resume', async () => {
  let fail = true;
  const { M } = load({ ig: { sendText: async () => { if (fail) { fail = false; throw Object.assign(new Error('no tab'), { layer: 'no_ig_tab' }); } return {}; } } });
  const c = await makeCampaign(M, ['a', 'b']);
  const d = await new Promise((resolve) => {
    M.queue.on((type, x) => {
      if (type === 'state' && x.state === 'paused') { assert.equal(x.reason, 'transport'); setTimeout(() => M.queue.resume(), 10); }
      if (type === 'done') resolve(x);
    });
    M.queue.start({ campaignId: c.id });
  });
  assert.equal(d.reason, 'complete');
  assert.equal(d.sent, 2);
});

test('cancel stops and leaves the rest pending', async () => {
  const { M } = load();
  const c = await makeCampaign(M, ['a', 'b', 'c', 'd']);
  const d = await new Promise((resolve) => {
    M.queue.on((type, x) => {
      if (type === 'row' && x.status === 'sent') M.queue.cancel();
      if (type === 'done') resolve(x);
    });
    M.queue.start({ campaignId: c.id });
  });
  assert.equal(d.reason, 'cancelled');
  assert.equal(d.sent, 1);
  assert.equal(d.left, 3);
});

test('error classification', () => {
  const { M } = load();
  const c = (m, o = {}) => M.policy.classify(Object.assign(new Error(m), o));
  assert.equal(c('user_not_found', { status: 404 }), 'not_found');
  assert.equal(c('login_required', { status: 401 }), 'session');
  assert.equal(c('feedback_required'), 'ig_block');
  assert.equal(c('x', { status: 429 }), 'ig_block');
  assert.equal(c('no tab', { layer: 'no_ig_tab' }), 'transport');
  assert.equal(c('network: failed to fetch'), 'network');
  assert.equal(c('timeout', { layer: 'mqtt_timeout' }), 'connection');
  assert.equal(c("You can't message this account"), 'cant_message');
  assert.equal(c('http_500', { status: 500 }), 'instagram');
});
