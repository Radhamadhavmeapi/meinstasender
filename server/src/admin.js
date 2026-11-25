// Admin panel: /admin (static page) + /admin/api/* (Bearer ADMIN_TOKEN).
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { todayUTC } = require('./service');

const HOUR = 3600 * 1000;

function adminRouter({ db, svc, config }) {
  const r = express.Router();
  r.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'admin', 'index.html')));

  const api = express.Router();
  api.use((req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const want = config.adminToken || '';
    const ok = want.length >= 16 && token.length === want.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want));
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  const now = () => Date.now();

  api.get('/stats', (_req, res) => {
    const t = now();
    const day = todayUTC(t);
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    res.json({
      licenses: one('SELECT COUNT(*) n FROM licenses').n,
      newToday: one('SELECT COUNT(*) n FROM licenses WHERE created_at >= ?', Date.parse(day)).n,
      active7d: one('SELECT COUNT(*) n FROM licenses WHERE last_seen_at >= ?', t - 7 * 24 * HOUR).n,
      accounts: one('SELECT COUNT(*) n FROM accounts').n,
      paidNow: one('SELECT COUNT(DISTINCT license_key) n FROM entitlements WHERE revoked = 0 AND ends_at > ?', t).n,
      sendsToday: one('SELECT COALESCE(SUM(count),0) n FROM usage WHERE day = ?', day).n,
      revenue30dPaise: one('SELECT COALESCE(SUM(amount_paise),0) n FROM payments WHERE created_at >= ?', t - 30 * 24 * HOUR).n,
      events7d: db.prepare('SELECT name, COUNT(*) n FROM events WHERE created_at >= ? GROUP BY name ORDER BY n DESC LIMIT 30').all(t - 7 * 24 * HOUR),
      sendsByDay: db.prepare('SELECT day, SUM(count) n FROM usage GROUP BY day ORDER BY day DESC LIMIT 14').all(),
    });
  });

  api.get('/licenses', (req, res) => {
    const qs = String(req.query.q || '').trim().toLowerCase();
    const t = now();
    const rows = db.prepare(`
      SELECT l.key, l.created_at, l.last_seen_at, l.version, l.banned, l.note, a.email,
        (SELECT MAX(ends_at) FROM entitlements e WHERE e.license_key = l.key AND e.revoked = 0 AND e.ends_at > ?) AS paid_until,
        (SELECT count FROM usage u WHERE u.license_key = l.key AND u.day = ?) AS today
      FROM licenses l LEFT JOIN accounts a ON a.id = l.account_id
      WHERE (? = '' OR l.key LIKE ? OR a.email LIKE ?)
      ORDER BY l.last_seen_at DESC LIMIT 200`).all(t, todayUTC(t), qs, `%${qs}%`, `%${qs}%`);
    res.json({ licenses: rows });
  });

  api.get('/licenses/:key', (req, res) => {
    const lic = db.prepare('SELECT * FROM licenses WHERE key = ?').get(req.params.key);
    if (!lic) return res.status(404).json({ error: 'not_found' });
    res.json({
      license: lic,
      entitlement: svc.entitlement(lic),
      entitlements: db.prepare('SELECT * FROM entitlements WHERE license_key = ? ORDER BY created_at DESC').all(lic.key),
      subscriptions: db.prepare('SELECT * FROM subscriptions WHERE license_key = ? ORDER BY updated_at DESC').all(lic.key),
      payments: db.prepare('SELECT * FROM payments WHERE license_key = ? ORDER BY created_at DESC LIMIT 50').all(lic.key),
      usage: db.prepare('SELECT day, count FROM usage WHERE license_key = ? ORDER BY day DESC LIMIT 30').all(lic.key),
    });
  });

  api.post('/licenses/:key/grant', (req, res) => {
    const lic = db.prepare('SELECT * FROM licenses WHERE key = ?').get(req.params.key);
    if (!lic) return res.status(404).json({ error: 'not_found' });
    const kind = req.body?.kind === 'pass' ? 'pass' : 'pro';
    const hours = Math.max(1, Math.min(24 * 3650, parseInt(req.body?.hours, 10) || 24 * 30));
    const id = svc.grant(lic.key, kind, 'admin', null, null, hours * HOUR);
    res.json({ ok: true, id });
  });

  api.post('/entitlements/:id/revoke', (req, res) => {
    const r = db.prepare('UPDATE entitlements SET revoked = 1 WHERE id = ?').run(req.params.id);
    res.json({ ok: r.changes > 0 });
  });

  api.post('/licenses/:key/ban', (req, res) => {
    const r = db.prepare('UPDATE licenses SET banned = ?, note = COALESCE(?, note) WHERE key = ?')
      .run(req.body?.banned ? 1 : 0, req.body?.note ?? null, req.params.key);
    res.json({ ok: r.changes > 0 });
  });

  api.post('/licenses/:key/reset-usage', (req, res) => {
    db.prepare('DELETE FROM usage WHERE license_key = ? AND day = ?').run(req.params.key, todayUTC(now()));
    res.json({ ok: true });
  });

  // ---- products ----
  api.get('/products', (_req, res) => res.json({ products: db.prepare('SELECT * FROM products ORDER BY sort, code').all() }));
  api.put('/products/:code', (req, res) => {
    const b = req.body || {};
    if (!/^[a-z0-9_]{2,32}$/.test(req.params.code)) return res.status(400).json({ error: 'bad_code' });
    if (!['subscription', 'pass'].includes(b.kind)) return res.status(400).json({ error: 'bad_kind' });
    let features = '[]';
    try { features = JSON.stringify(Array.isArray(b.features) ? b.features.map(String) : JSON.parse(b.features || '[]')); } catch (_) {}
    db.prepare(`INSERT INTO products(code, name, kind, price_paise, currency, interval_label, duration_hours, razorpay_plan_id, features, active, sort)
      VALUES (@code, @name, @kind, @price_paise, @currency, @interval_label, @duration_hours, @razorpay_plan_id, @features, @active, @sort)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, kind=excluded.kind, price_paise=excluded.price_paise, currency=excluded.currency,
        interval_label=excluded.interval_label, duration_hours=excluded.duration_hours, razorpay_plan_id=excluded.razorpay_plan_id,
        features=excluded.features, active=excluded.active, sort=excluded.sort`).run({
      code: req.params.code, name: String(b.name || req.params.code), kind: b.kind,
      price_paise: parseInt(b.price_paise, 10) || 0, currency: String(b.currency || 'INR').toUpperCase(),
      interval_label: b.interval_label || null, duration_hours: b.duration_hours ? parseInt(b.duration_hours, 10) : null,
      razorpay_plan_id: b.razorpay_plan_id || null, features, active: b.active === false || b.active === 0 ? 0 : 1,
      sort: parseInt(b.sort, 10) || 0,
    });
    res.json({ ok: true });
  });

  // ---- notices ----
  api.get('/notices', (_req, res) => res.json({ notices: db.prepare('SELECT * FROM notices ORDER BY created_at DESC').all() }));
  const noticeRow = (b) => ({
    title: String(b.title || ''), body: String(b.body || ''), link_url: b.link_url || null, link_label: b.link_label || null,
    level: ['info', 'warning', 'critical'].includes(b.level) ? b.level : 'info', lang: b.lang || null,
    min_version: b.min_version || null, max_version: b.max_version || null, active: b.active === false || b.active === 0 ? 0 : 1,
    starts_at: b.starts_at ? Number(b.starts_at) : null, ends_at: b.ends_at ? Number(b.ends_at) : null,
  });
  api.post('/notices', (req, res) => {
    const row = noticeRow(req.body || {});
    if (!row.title || !row.body) return res.status(400).json({ error: 'title_body_required' });
    const id = db.prepare(`INSERT INTO notices(title, body, link_url, link_label, level, lang, min_version, max_version, active, starts_at, ends_at, created_at)
      VALUES (@title, @body, @link_url, @link_label, @level, @lang, @min_version, @max_version, @active, @starts_at, @ends_at, @created_at)`)
      .run({ ...row, created_at: now() }).lastInsertRowid;
    res.json({ ok: true, id });
  });
  api.put('/notices/:id', (req, res) => {
    const row = noticeRow(req.body || {});
    const r = db.prepare(`UPDATE notices SET title=@title, body=@body, link_url=@link_url, link_label=@link_label, level=@level, lang=@lang,
      min_version=@min_version, max_version=@max_version, active=@active, starts_at=@starts_at, ends_at=@ends_at WHERE id=@id`)
      .run({ ...row, id: req.params.id });
    res.json({ ok: r.changes > 0 });
  });
  api.delete('/notices/:id', (req, res) => {
    res.json({ ok: db.prepare('DELETE FROM notices WHERE id = ?').run(req.params.id).changes > 0 });
  });

  // ---- settings / payments ----
  api.get('/settings', (_req, res) => res.json({ settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((s) => [s.key, s.value])) }));
  api.put('/settings', (req, res) => {
    const allowedKeys = ['free_daily_limit', 'pro_daily_cap', 'pass_offer_code'];
    const up = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of allowedKeys) if (req.body && k in req.body) up.run(k, String(req.body[k]));
    res.json({ ok: true });
  });
  api.get('/payments', (_req, res) => res.json({ payments: db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 200').all() }));

  r.use('/api', express.json({ limit: '64kb' }), api);
  return r;
}

module.exports = { adminRouter };
