const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

const SECRET = 'whsec_test';

function setup({ razorpay, fetchImpl } = {}) {
  const db = open(':memory:');
  let clock = Date.parse('2026-11-25T10:00:00Z');
  const mails = [];
  const mailer = { enabled: true, async send(m) { mails.push(m); return true; } };
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-up-'));
  const { app } = createApp({
    db, razorpay, fetchImpl, mailer,
    config: { razorpayWebhookSecret: SECRET, publicUrl: 'https://lic.test', logWebhooks: false, issuePerHour: 1000, loginPer15Min: 1000, uploadDir, notifyEmail: 'owner@test' },
    now: () => clock,
  });
  db.prepare('INSERT INTO admins(email, password_hash, name, created_at) VALUES (?, ?, ?, ?)').run('admin@test', hashPassword('adminpass1'), 'Admin', clock);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  // A tiny cookie jar per "browser".
  const agent = () => {
    const jar = {};
    return async (method, p, { key, body, headers = {} } = {}) => {
      const r = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(key ? { 'X-License-Key': key } : {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jar[k] = v; else delete jar[k]; }
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch (_) { json = text; }
      return { status: r.status, body: json };
    };
  };
  const call = agent();
  const hook = (evt, id) => {
    const raw = JSON.stringify(evt);
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return call('POST', '/v1/webhooks/razorpay', { body: raw, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': id } });
  };
  const admin = async () => { const a = agent(); assert.equal((await a('POST', '/admin/api/login', { body: { email: 'admin@test', password: 'adminpass1' } })).status, 200); return a; };
  return { db, call, agent, hook, admin, mails, uploadDir, tick: (ms) => (clock += ms), close: () => server.close() };
}

test('license issue, entitlement and server-side free limit', async () => {
  const s = setup();
  try {
    const key = (await s.call('POST', '/v1/license/issue')).body.key;
    assert.match(key, /^mdm_[0-9a-f]{48}$/);
    assert.equal((await s.call('GET', '/v1/entitlement', { key: 'mdm_nope' })).status, 401);
    const e = (await s.call('GET', '/v1/entitlement', { key })).body;
    assert.equal(e.tier, 'free');
    assert.equal(e.portalUrl, 'https://lic.test/users/');
    for (let i = 0; i < 10; i++) assert.equal((await s.call('POST', '/v1/usage/reserve', { key, body: {} })).status, 200);
    assert.equal((await s.call('POST', '/v1/usage/reserve', { key, body: {} })).body.error, 'free_limit');
    assert.equal((await s.call('POST', '/v1/usage/release', { key, body: {} })).body.usageToday, 9);
    s.tick(24 * 3600 * 1000);
    assert.equal((await s.call('POST', '/v1/usage/reserve', { key, body: {} })).status, 200);
  } finally { s.close(); }
});

test('razorpay webhooks: subscription, duplicate, pass stacking, bad signature', async () => {
  const s = setup();
  try {
    const key = (await s.call('POST', '/v1/license/issue')).body.key;
    assert.equal((await s.call('POST', '/v1/webhooks/razorpay', { body: '{}', headers: { 'x-razorpay-signature': 'x' } })).status, 400);
    const end = Math.floor(Date.parse('2026-12-25T10:00:00Z') / 1000);
    const evt = { event: 'subscription.charged', payload: {
      subscription: { entity: { id: 'sub_1', status: 'active', current_end: end, notes: { license_key: key, product_code: 'pro_month' } } },
      payment: { entity: { id: 'pay_1', amount: 49900, currency: 'INR' } } } };
    assert.equal((await s.hook(evt, 'e1')).body.result, 'subscription_active');
    assert.equal((await s.hook(evt, 'e1')).body.result, 'duplicate');
    assert.equal((await s.call('GET', '/v1/entitlement', { key })).body.paidBy, 'pro');
    const k2 = (await s.call('POST', '/v1/license/issue')).body.key;
    const paid = (id) => ({ event: 'payment_link.paid', payload: { payment_link: { entity: { id, notes: { license_key: k2, product_code: 'pass24' } } } } });
    await s.hook(paid('pl1'), 'p1');
    const first = (await s.call('GET', '/v1/entitlement', { key: k2 })).body.paidUntil;
    await s.hook(paid('pl2'), 'p2');
    assert.equal((await s.call('GET', '/v1/entitlement', { key: k2 })).body.paidUntil - first, 24 * 3600 * 1000);
  } finally { s.close(); }
});

test('portal: register, login, profile, password change, forgot/reset', async () => {
  const s = setup();
  try {
    const u = s.agent();
    assert.equal((await u('POST', '/api/u/register', { body: { email: 'a@b.co', password: 'short' } })).body.error, 'weak_password');
    const reg = await u('POST', '/api/u/register', { body: { email: 'Priya@Example.com', password: 'secret123', name: 'Priya' } });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.user.email, 'priya@example.com');
    assert.equal((await u('POST', '/api/u/register', { body: { email: 'priya@example.com', password: 'secret123' } })).body.error, 'email_taken');
    const me = (await u('GET', '/api/u/me')).body;
    assert.equal(me.entitlement.tier, 'free');
    assert.match(me.user.licenseKey, /^mdm_/);
    await u('PUT', '/api/u/profile', { body: { name: 'Priya S', phone: '9999' } });
    assert.equal((await u('GET', '/api/u/me')).body.user.phone, '9999');
    await u('POST', '/api/u/logout');
    assert.equal((await u('GET', '/api/u/me')).status, 401);
    assert.equal((await u('POST', '/api/u/login', { body: { email: 'priya@example.com', password: 'wrongpass' } })).status, 401);
    assert.equal((await u('POST', '/api/u/login', { body: { email: 'priya@example.com', password: 'secret123' } })).status, 200);
    assert.equal((await u('POST', '/api/u/password', { body: { current: 'secret123', password: 'newsecret1' } })).status, 200);
    // forgot → mail with token → reset
    await s.call('POST', '/api/u/forgot', { body: { email: 'priya@example.com' } });
    const token = s.mails.at(-1).text.match(/#reset=([\w-]+)/)[1];
    const r = s.agent();
    assert.equal((await r('POST', '/api/u/reset', { body: { token, password: 'reset12345' } })).status, 200);
    assert.equal((await r('GET', '/api/u/me')).status, 200);
    assert.equal((await r('POST', '/api/u/reset', { body: { token, password: 'again12345' } })).body.error, 'reset_expired');
    assert.equal((await u('GET', '/api/u/me')).status, 401); // old sessions signed out by the reset
    // cross-site POST is refused
    assert.equal((await r('POST', '/api/u/logout', { headers: { Origin: 'https://evil.example' } })).status, 403);
  } finally { s.close(); }
});

test('extension login/register shares the website account and carries purchases', async () => {
  const s = setup();
  try {
    const k1 = (await s.call('POST', '/v1/license/issue')).body.key;
    const reg = (await s.call('POST', '/v1/account/register', { key: k1, body: { email: 'ext@test.com', password: 'password1' } })).body;
    assert.equal(reg.key, k1); // the browser's key became the account key
    const web = s.agent();
    assert.equal((await web('POST', '/api/u/login', { body: { email: 'ext@test.com', password: 'password1' } })).body.user.licenseKey, k1);
    // second browser buys a pass while logged out, then signs in
    const k2 = (await s.call('POST', '/v1/license/issue')).body.key;
    await s.hook({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plx', notes: { license_key: k2, product_code: 'pass24' } } } } }, 'x');
    const login = (await s.call('POST', '/v1/account/login', { key: k2, body: { email: 'ext@test.com', password: 'password1' } })).body;
    assert.equal(login.key, k1);
    assert.equal((await s.call('GET', '/v1/entitlement', { key: k1 })).body.paidBy, 'pass');
    assert.equal((await s.call('GET', '/v1/entitlement', { key: k1 })).body.account.email, 'ext@test.com');
    assert.equal((await s.call('POST', '/v1/account/login', { key: k2, body: { email: 'ext@test.com', password: 'nope1234' } })).status, 401);
  } finally { s.close(); }
});

test('manual UPI payment: instructions + QR, submit with proof, admin approves → PRO', async () => {
  const s = setup();
  try {
    const a = await s.admin();
    await a('PUT', '/admin/api/settings', { body: { pay_upi: '1', upi_id: 'meapi@okicici', upi_name: 'MeAPI', pay_bank: '1', bank_details: 'A/c 123' } });
    const u = s.agent();
    await u('POST', '/api/u/register', { body: { email: 'buyer@test.com', password: 'password1' } });
    const cfg = (await u('GET', '/api/u/me')).body.config;
    assert.deepEqual(cfg.methods, ['razorpay', 'upi', 'bank']);
    assert.equal((await u('POST', '/api/u/payments/manual', { body: { productCode: 'pro_month', method: 'paypal' } })).body.error, 'method_unavailable');
    const ins = (await u('POST', '/api/u/payments/manual', { body: { productCode: 'pro_month', method: 'upi' } })).body;
    assert.equal(ins.amount, '₹499');
    assert.match(ins.upiUri, /^upi:\/\/pay\?pa=meapi%40okicici&pn=MeAPI&am=499\.00&cu=INR&tn=MDM\d+$/);
    assert.match(ins.upiQr, /^data:image\/png;base64,/);
    const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
    assert.equal((await u('POST', `/api/u/payments/manual/${ins.id}/submit`, { body: { reference: '12' } })).body.error, 'bad_reference');
    assert.equal((await u('POST', `/api/u/payments/manual/${ins.id}/submit`, { body: { reference: '412345678901', proof: png } })).body.status, 'pending');
    // the same UTR can't be used twice
    const ins2 = (await u('POST', '/api/u/payments/manual', { body: { productCode: 'pass24', method: 'upi' } })).body;
    assert.equal((await u('POST', `/api/u/payments/manual/${ins2.id}/submit`, { body: { reference: '412345678901' } })).body.error, 'reference_used');
    assert.ok(s.mails.some((m) => m.to === 'owner@test' && /Payment to approve/.test(m.subject)));

    const pend = (await a('GET', '/admin/api/manual-payments?status=pending')).body.payments;
    assert.equal(pend.length, 1);
    const proof = await a('GET', `/admin/api/manual-payments/${pend[0].id}/proof`);
    assert.equal(proof.status, 200);
    assert.equal((await a('POST', `/admin/api/manual-payments/${pend[0].id}/approve`, { body: {} })).body.status, 'approved');
    assert.equal((await a('POST', `/admin/api/manual-payments/${pend[0].id}/approve`, { body: {} })).body.error, 'not_pending');
    const me = (await u('GET', '/api/u/me')).body;
    assert.equal(me.entitlement.paidBy, 'pro');
    assert.ok(me.entitlement.paidUntil - Date.parse('2026-11-25T10:00:00Z') === 30 * 86400000);
    assert.equal((await u('GET', '/api/u/payments')).body.manual.find((m) => m.id === ins.id).status, 'approved');
  } finally { s.close(); }
});

test('reseller: apply, admin approves, credits, create customer, activate, isolation', async () => {
  const s = setup();
  try {
    const a = await s.admin();
    const r = s.agent();
    await r('POST', '/api/u/register', { body: { email: 'reseller@test.com', password: 'password1', name: 'Shop' } });
    assert.equal((await r('GET', '/api/u/reseller/customers')).status, 403);
    await r('POST', '/api/u/reseller/apply', { body: { note: 'I sell to 50 agencies' } });
    const pending = (await a('GET', '/admin/api/users?role=pending')).body.users;
    assert.equal(pending.length, 1);
    await a('POST', `/admin/api/users/${pending[0].id}/reseller`, { body: { approve: true } });
    assert.equal((await r('GET', '/api/u/me')).body.user.role, 'reseller');
    // credit packs visible only to resellers
    assert.ok((await r('GET', '/api/u/products')).body.products.some((p) => p.kind === 'credits'));
    const c = (await r('POST', '/api/u/reseller/customers', { body: { email: 'cust@test.com', password: 'custpass1', name: 'Cust' } })).body.customer;
    assert.equal((await r('POST', `/api/u/reseller/customers/${c.id}/activate`, { body: { months: 3 } })).body.error, 'not_enough_credits');
    await a('POST', `/admin/api/users/${pending[0].id}/credits`, { body: { delta: 5 } });
    const act = (await r('POST', `/api/u/reseller/customers/${c.id}/activate`, { body: { months: 3 } })).body;
    assert.equal(act.balance, 2);
    assert.equal(act.entitlement.paidBy, 'pro');
    const list = (await r('GET', '/api/u/reseller/customers')).body.customers;
    assert.equal(list[0].tier, 'paid');
    assert.equal((await r('GET', '/api/u/reseller/ledger')).body.ledger.length, 2);
    // customer can sign in on the website and in the extension
    const cu = s.agent();
    assert.equal((await cu('POST', '/api/u/login', { body: { email: 'cust@test.com', password: 'custpass1' } })).status, 200);
    assert.equal((await cu('GET', '/api/u/me')).body.entitlement.paidBy, 'pro');
    // another reseller can't touch this customer
    const r2 = s.agent();
    await r2('POST', '/api/u/register', { body: { email: 'r2@test.com', password: 'password1' } });
    const r2id = (await a('GET', '/admin/api/users?q=r2@')).body.users[0].id;
    await a('POST', `/admin/api/users/${r2id}/reseller`, { body: { approve: true } });
    await a('POST', `/admin/api/users/${r2id}/credits`, { body: { delta: 5 } });
    assert.equal((await r2('POST', `/api/u/reseller/customers/${c.id}/activate`, { body: { months: 1 } })).body.error, 'not_your_customer');
    // reseller credit pack bought via manual bank transfer
    await a('PUT', '/admin/api/settings', { body: { pay_bank: '1', bank_details: 'HDFC 123' } });
    const ins = (await r('POST', '/api/u/payments/manual', { body: { productCode: 'credits10', method: 'bank' } })).body;
    assert.equal(ins.bankDetails, 'HDFC 123');
    await r('POST', `/api/u/payments/manual/${ins.id}/submit`, { body: { reference: 'NEFT998877' } });
    assert.equal((await a('POST', `/admin/api/manual-payments/${ins.id}/approve`, { body: {} })).body.credits, 12);
    // a normal user can't buy credits
    assert.equal((await s.agent()('POST', '/api/u/payments/manual', { body: { productCode: 'credits10', method: 'bank' } })).status, 401);
  } finally { s.close(); }
});

test('admin auth, users, notices, settings, checkout', async () => {
  const calls = [];
  const razorpay = {
    async createSubscription(x) { calls.push(['sub', x]); return { id: 'sub_X', short_url: 'https://rzp.io/i/sub', status: 'created' }; },
    async createPaymentLink(x) { calls.push(['link', x]); return { id: 'plink_X', short_url: 'https://rzp.io/i/link' }; },
  };
  const s = setup({ razorpay });
  try {
    assert.equal((await s.call('GET', '/admin/api/stats')).status, 401);
    assert.equal((await s.agent()('POST', '/admin/api/login', { body: { email: 'admin@test', password: 'bad' } })).status, 401);
    const a = await s.admin();
    await a('POST', '/admin/api/notices', { body: { title: 'Update', body: 'Please update', min_version: '1.2.0' } });
    assert.equal((await s.call('GET', '/v1/notice?v=1.0.0&lang=en')).body.notice, null);
    assert.equal((await s.call('GET', '/v1/notice?v=1.3.0&lang=en')).body.notice.title, 'Update');

    const key = (await s.call('POST', '/v1/license/issue')).body.key;
    assert.equal((await s.call('POST', '/v1/checkout', { key, body: { productCode: 'pro_month' } })).status, 503);
    s.db.prepare("UPDATE products SET razorpay_plan_id='plan_ABC' WHERE code='pro_month'").run();
    assert.equal((await s.call('POST', '/v1/checkout', { key, body: { productCode: 'pro_month' } })).body.url, 'https://rzp.io/i/sub');
    assert.equal((await s.call('POST', '/v1/checkout', { key, body: { productCode: 'pass24' } })).body.url, 'https://rzp.io/i/link');
    assert.equal(calls[1][1].callbackUrl, 'https://lic.test/paid');
    // credits can't be bought anonymously
    assert.equal((await s.call('POST', '/v1/checkout', { key, body: { productCode: 'credits10' } })).body.error, 'credits_need_account');
    // admin grants, bans and disables
    await a('POST', `/admin/api/licenses/${key}/grant`, { body: { kind: 'pro', hours: 48 } });
    assert.equal((await s.call('GET', '/v1/entitlement', { key })).body.paidBy, 'pro');
    await a('POST', `/admin/api/licenses/${key}/ban`, { body: { banned: true } });
    assert.equal((await s.call('POST', '/v1/usage/reserve', { key, body: {} })).status, 403);
    const u = s.agent();
    await u('POST', '/api/u/register', { body: { email: 'bad@test.com', password: 'password1' } });
    const id = (await a('GET', '/admin/api/users?q=bad@')).body.users[0].id;
    await a('POST', `/admin/api/users/${id}/status`, { body: { status: 'disabled' } });
    assert.equal((await u('GET', '/api/u/me')).status, 401);
    const stats = (await a('GET', '/admin/api/stats')).body;
    assert.equal(stats.users, 1);
    // products: PayPal price + credits pack edit
    await a('PUT', '/admin/api/products/credits10', { body: { name: '10 credits', kind: 'credits', price_paise: 199900, price_usd_cents: 2999, credits: 10, features: ['x'] } });
    assert.equal(s.db.prepare("SELECT price_paise FROM products WHERE code='credits10'").get().price_paise, 199900);
    // pages are served
    for (const p of ['/', '/users/', '/admin/', '/privacy', '/terms', '/refund']) assert.equal((await s.call('GET', p, { headers: { Accept: 'text/html' } })).status, 200, p);
  } finally { s.close(); }
});
