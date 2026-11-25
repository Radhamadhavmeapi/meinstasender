const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { open } = require('../src/db');
const { createApp } = require('../src/app');

const SECRET = 'whsec_test';
const ADMIN = 'admin-token-123456789';

function setup({ razorpay, fetchImpl } = {}) {
  const db = open(':memory:');
  let clock = Date.parse('2026-11-25T10:00:00Z');
  const { app } = createApp({
    db, razorpay, fetchImpl,
    config: { razorpayWebhookSecret: SECRET, adminToken: ADMIN, publicUrl: 'https://lic.test', logWebhooks: false, issuePerHour: 1000 },
    now: () => clock,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { key, body, headers = {} } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-License-Key': key } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const hook = (evt, id) => {
    const raw = JSON.stringify(evt);
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return call('POST', '/v1/webhooks/razorpay', { body: raw, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': id } });
  };
  return { db, server, call, hook, tick: (ms) => (clock += ms), close: () => server.close() };
}

test('issue + entitlement + free limit is enforced server-side', async () => {
  const s = setup();
  try {
    const { status, body } = await s.call('POST', '/v1/license/issue');
    assert.equal(status, 201);
    assert.match(body.key, /^mdm_[0-9a-f]{48}$/);
    const key = body.key;

    const bad = await s.call('GET', '/v1/entitlement', { key: 'mdm_nope' });
    assert.equal(bad.status, 401);

    const e = await s.call('GET', '/v1/entitlement', { key });
    assert.equal(e.body.tier, 'free');
    assert.equal(e.body.freeDailyLimit, 10);
    assert.equal(e.body.passOffer.code, 'pass24');

    for (let i = 0; i < 10; i++) assert.equal((await s.call('POST', '/v1/usage/reserve', { key, body: {} })).status, 200);
    const over = await s.call('POST', '/v1/usage/reserve', { key, body: {} });
    assert.equal(over.status, 402);
    assert.equal(over.body.error, 'free_limit');

    const rel = await s.call('POST', '/v1/usage/release', { key, body: {} });
    assert.equal(rel.body.usageToday, 9);
    assert.equal((await s.call('POST', '/v1/usage/reserve', { key, body: {} })).status, 200);

    // Next UTC day resets.
    s.tick(24 * 3600 * 1000);
    assert.equal((await s.call('POST', '/v1/usage/reserve', { key, body: {} })).status, 200);
  } finally { s.close(); }
});

test('webhook: bad signature rejected, subscription grants PRO, duplicates ignored', async () => {
  const s = setup();
  try {
    const key = (await s.call('POST', '/v1/license/issue')).body.key;
    const bad = await s.call('POST', '/v1/webhooks/razorpay', { body: '{}', headers: { 'x-razorpay-signature': 'nope' } });
    assert.equal(bad.status, 400);

    const end = Math.floor(Date.parse('2026-12-25T10:00:00Z') / 1000);
    const evt = { event: 'subscription.charged', payload: {
      subscription: { entity: { id: 'sub_1', status: 'active', current_end: end, notes: { license_key: key, product_code: 'pro_month' } } },
      payment: { entity: { id: 'pay_1', amount: 49900, currency: 'INR' } } } };
    assert.equal((await s.hook(evt, 'evt_1')).body.result, 'subscription_active');
    assert.equal((await s.hook(evt, 'evt_1')).body.result, 'duplicate');

    const e = (await s.call('GET', '/v1/entitlement', { key })).body;
    assert.equal(e.tier, 'paid');
    assert.equal(e.paidBy, 'pro');
    assert.ok(e.paidUntil > end * 1000);
    assert.equal(e.passOffer, null);
    // Paid users are not capped by the free limit.
    for (let i = 0; i < 15; i++) assert.equal((await s.call('POST', '/v1/usage/reserve', { key, body: {} })).status, 200);

    // Renewal extends the same entitlement row.
    const end2 = end + 30 * 86400;
    await s.hook({ ...evt, payload: { ...evt.payload, subscription: { entity: { ...evt.payload.subscription.entity, current_end: end2 } } } }, 'evt_2');
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM entitlements WHERE ref='sub_1'").get().n, 1);
    assert.ok((await s.call('GET', '/v1/entitlement', { key })).body.paidUntil > end2 * 1000);

    await s.hook({ event: 'subscription.cancelled', payload: { subscription: { entity: { id: 'sub_1', status: 'cancelled', current_end: end2 } } } }, 'evt_3');
    const after = (await s.call('GET', '/v1/entitlement', { key })).body;
    assert.equal(after.subscription.status, 'cancelled');
    assert.equal(after.tier, 'paid'); // paid period still runs

    s.tick(70 * 86400 * 1000);
    assert.equal((await s.call('GET', '/v1/entitlement', { key })).body.tier, 'free');
  } finally { s.close(); }
});

test('webhook: payment link grants a stacking 24h pass', async () => {
  const s = setup();
  try {
    const key = (await s.call('POST', '/v1/license/issue')).body.key;
    const paid = (id) => ({ event: 'payment_link.paid', payload: {
      payment_link: { entity: { id, amount: 9900, currency: 'INR', notes: { license_key: key, product_code: 'pass24' } } },
      payment: { entity: { id: 'pay_' + id, amount: 9900, currency: 'INR' } } } });
    assert.equal((await s.hook(paid('plink_1'), 'e1')).body.result, 'pass_granted');
    let e = (await s.call('GET', '/v1/entitlement', { key })).body;
    assert.equal(e.paidBy, 'pass');
    const first = e.paidUntil;
    await s.hook(paid('plink_2'), 'e2');
    e = (await s.call('GET', '/v1/entitlement', { key })).body;
    assert.equal(e.paidUntil - first, 24 * 3600 * 1000);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM payments').get().n, 2);
  } finally { s.close(); }
});

test('checkout creates subscription / payment link through Razorpay', async () => {
  const calls = [];
  const razorpay = {
    async createSubscription(a) { calls.push(['sub', a]); return { id: 'sub_X', short_url: 'https://rzp.io/i/sub', status: 'created' }; },
    async createPaymentLink(a) { calls.push(['link', a]); return { id: 'plink_X', short_url: 'https://rzp.io/i/link' }; },
  };
  const s = setup({ razorpay });
  try {
    const key = (await s.call('POST', '/v1/license/issue')).body.key;
    const noPlan = await s.call('POST', '/v1/checkout', { key, body: { productCode: 'pro_month' } });
    assert.equal(noPlan.status, 503);
    s.db.prepare("UPDATE products SET razorpay_plan_id='plan_ABC' WHERE code='pro_month'").run();
    const sub = await s.call('POST', '/v1/checkout', { key, body: { productCode: 'pro_month' } });
    assert.equal(sub.body.url, 'https://rzp.io/i/sub');
    assert.equal(calls[0][1].planId, 'plan_ABC');
    assert.equal(calls[0][1].notes.license_key, key);
    const link = await s.call('POST', '/v1/checkout', { key, body: { productCode: 'pass24' } });
    assert.equal(link.body.url, 'https://rzp.io/i/link');
    assert.equal(calls[1][1].amount, 9900);
    assert.equal(calls[1][1].callbackUrl, 'https://lic.test/paid');
    const prods = (await s.call('GET', '/v1/products')).body.products;
    assert.equal(prods.find((p) => p.code === 'pro_month').purchasable, true);
    assert.equal(prods.find((p) => p.code === 'pro_year').purchasable, false);
  } finally { s.close(); }
});

test('google login links account and carries purchases across browsers', async () => {
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('googleapis')) {
      const tok = opts.headers.Authorization.split(' ')[1];
      if (tok === 'bad') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ sub: 'g1', email: 'Ankit@Example.com', email_verified: true, name: 'Ankit' }));
    }
    return fetch(url, opts);
  };
  const s = setup({ fetchImpl });
  try {
    const a = (await s.call('POST', '/v1/license/issue')).body.key;
    assert.equal((await s.call('POST', '/v1/account/google', { key: a, body: { accessToken: 'bad' } })).status, 401);
    const first = (await s.call('POST', '/v1/account/google', { key: a, body: { accessToken: 'ok' } })).body;
    assert.equal(first.key, a);
    assert.equal(first.email, 'ankit@example.com');

    // Second browser buys a pass while logged out, then logs in.
    const b = (await s.call('POST', '/v1/license/issue')).body.key;
    await s.hook({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'pl_b', notes: { license_key: b, product_code: 'pass24' } } } } }, 'eb');
    const second = (await s.call('POST', '/v1/account/google', { key: b, body: { accessToken: 'ok' } })).body;
    assert.equal(second.key, a);
    assert.equal((await s.call('GET', '/v1/entitlement', { key: a })).body.paidBy, 'pass');
    assert.equal((await s.call('GET', '/v1/entitlement', { key: a })).body.account.email, 'ankit@example.com');
  } finally { s.close(); }
});

test('notices filter by version and language; admin API is protected', async () => {
  const s = setup();
  try {
    assert.equal((await s.call('GET', '/admin/api/stats')).status, 401);
    const auth = { Authorization: 'Bearer ' + ADMIN };
    await s.call('POST', '/admin/api/notices', { headers: auth, body: { title: 'Update', body: 'Please update', min_version: '1.2.0', level: 'warning' } });
    await s.call('POST', '/admin/api/notices', { headers: auth, body: { title: 'Namaste', body: 'Hindi only', lang: 'hi' } });
    assert.equal((await s.call('GET', '/v1/notice?v=1.0.0&lang=en')).body.notice, null);
    assert.equal((await s.call('GET', '/v1/notice?v=1.3.0&lang=en')).body.notice.title, 'Update');
    assert.equal((await s.call('GET', '/v1/notice?v=1.0.0&lang=hi')).body.notice.title, 'Namaste');

    const key = (await s.call('POST', '/v1/license/issue')).body.key;
    await s.call('POST', `/admin/api/licenses/${key}/grant`, { headers: auth, body: { kind: 'pro', hours: 48 } });
    assert.equal((await s.call('GET', '/v1/entitlement', { key })).body.paidBy, 'pro');
    await s.call('PUT', '/admin/api/settings', { headers: auth, body: { free_daily_limit: '3' } });
    const stats = (await s.call('GET', '/admin/api/stats', { headers: auth })).body;
    assert.equal(stats.paidNow, 1);

    await s.call('POST', `/admin/api/licenses/${key}/ban`, { headers: auth, body: { banned: true } });
    assert.equal((await s.call('POST', '/v1/usage/reserve', { key, body: {} })).status, 403);

    const tr = await s.call('POST', '/v1/track', { key, body: { events: [{ name: 'send_ok', props: { n: 1 } }, { name: 'BAD NAME' }] } });
    assert.equal(tr.body.stored, 1);
  } finally { s.close(); }
});
