// /admin (static panel) + /admin/api/* (admin email+password session).
const express = require('express');
const fs = require('fs');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const { todayUTC, AppError } = require('./service');
const { verifyPassword, hashPassword, DUMMY_HASH, normEmail, EMAIL_RE, validPassword, sameOrigin } = require('./auth');
const { SETTING_KEYS } = require('./db');

const HOUR = 3600 * 1000;

function adminRouter({ db, svc, sessions, config, now = () => Date.now() }) {
  const r = express.Router();
  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));
  api.use(sameOrigin(config.publicUrl));

  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof AppError) return res.status(e.status).json({ error: e.code });
      console.error('[admin]', e);
      res.status(500).json({ error: 'internal' });
    }
  };
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);

  // ---------- auth ----------
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
  api.post('/login', loginLimiter, wrap((req, res) => {
    const a = one('SELECT * FROM admins WHERE email = ?', normEmail(req.body?.email));
    const ok = verifyPassword(req.body?.password, a?.password_hash || DUMMY_HASH);
    if (!a || !ok) throw new AppError('bad_credentials', 401);
    db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(now(), a.id);
    sessions.start(res, req, 'admin', a.id);
    return { admin: { id: a.id, email: a.email, name: a.name } };
  }));
  api.post('/logout', wrap((req, res) => { sessions.end(req, res, 'admin'); }));
  api.use((req, res, next) => {
    const s = sessions.read(req, 'admin');
    const a = s && one('SELECT id, email, name FROM admins WHERE id = ?', s.subject_id);
    if (!a) return res.status(401).json({ error: 'unauthorized' });
    req.admin = a;
    next();
  });
  api.get('/me', wrap((req) => ({ admin: req.admin })));
  api.post('/me/password', wrap((req, res) => {
    const a = one('SELECT * FROM admins WHERE id = ?', req.admin.id);
    if (!verifyPassword(req.body?.current, a.password_hash)) throw new AppError('bad_credentials', 401);
    if (!validPassword(req.body?.password)) throw new AppError('weak_password');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), a.id);
    sessions.endAll('admin', a.id);
    sessions.start(res, req, 'admin', a.id);
  }));
  api.get('/admins', wrap(() => ({ admins: all('SELECT id, email, name, created_at, last_login_at FROM admins ORDER BY id') })));
  api.post('/admins', wrap((req) => {
    const email = normEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) throw new AppError('invalid_email');
    if (!validPassword(req.body?.password)) throw new AppError('weak_password');
    if (one('SELECT id FROM admins WHERE email = ?', email)) throw new AppError('email_taken', 409);
    db.prepare('INSERT INTO admins(email, password_hash, name, created_at) VALUES (?, ?, ?, ?)').run(email, hashPassword(req.body.password), req.body?.name || null, now());
  }));

  // ---------- dashboard ----------
  api.get('/stats', wrap(() => {
    const t = now();
    const day = todayUTC(t);
    return {
      licenses: one('SELECT COUNT(*) n FROM licenses').n,
      newToday: one('SELECT COUNT(*) n FROM licenses WHERE created_at >= ?', Date.parse(day)).n,
      active7d: one('SELECT COUNT(*) n FROM licenses WHERE last_seen_at >= ?', t - 7 * 24 * HOUR).n,
      users: one("SELECT COUNT(*) n FROM users WHERE role = 'user'").n,
      resellers: one("SELECT COUNT(*) n FROM users WHERE role = 'reseller'").n,
      resellerApplications: one("SELECT COUNT(*) n FROM users WHERE reseller_status = 'pending'").n,
      pendingPayments: one("SELECT COUNT(*) n FROM manual_payments WHERE status = 'pending'").n,
      paidNow: one('SELECT COUNT(DISTINCT license_key) n FROM entitlements WHERE revoked = 0 AND ends_at > ?', t).n,
      sendsToday: one('SELECT COALESCE(SUM(count),0) n FROM usage WHERE day = ?', day).n,
      revenue30dPaise: one("SELECT COALESCE(SUM(amount_paise),0) n FROM payments WHERE created_at >= ? AND (currency = 'INR' OR currency IS NULL)", t - 30 * 24 * HOUR).n,
      events7d: all('SELECT name, COUNT(*) n FROM events WHERE created_at >= ? GROUP BY name ORDER BY n DESC LIMIT 30', t - 7 * 24 * HOUR),
      sendsByDay: all('SELECT day, SUM(count) n FROM usage GROUP BY day ORDER BY day DESC LIMIT 14'),
    };
  }));

  // ---------- users & resellers ----------
  api.get('/users', wrap((req) => {
    const qs = String(req.query.q || '').trim().toLowerCase();
    const role = ['user', 'reseller', 'pending'].includes(req.query.role) ? req.query.role : '';
    const t = now();
    const rows = all(`
      SELECT u.id, u.email, u.name, u.phone, u.role, u.reseller_status, u.credits, u.status, u.created_at, u.last_login_at, u.license_key,
        r.email AS reseller_email,
        (SELECT MAX(ends_at) FROM entitlements e WHERE e.license_key = u.license_key AND e.revoked = 0 AND e.ends_at > ?) AS paid_until,
        (SELECT COUNT(*) FROM users c WHERE c.reseller_id = u.id) AS customers
      FROM users u LEFT JOIN users r ON r.id = u.reseller_id
      WHERE (? = '' OR u.email LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)
        AND (? = '' OR (? = 'pending' AND u.reseller_status = 'pending') OR u.role = ?)
      ORDER BY u.id DESC LIMIT 300`, t, qs, `%${qs}%`, `%${qs}%`, `%${qs}%`, role, role, role);
    return { users: rows };
  }));

  function userOr404(id) {
    const u = one('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw new AppError('not_found', 404);
    return u;
  }
  api.get('/users/:id', wrap((req) => {
    const u = userOr404(req.params.id);
    return {
      user: { ...svc.userView(u), resellerNote: u.reseller_note, lastLoginAt: u.last_login_at,
        reseller: u.reseller_id ? one('SELECT id, email FROM users WHERE id = ?', u.reseller_id) : null },
      entitlement: svc.entitlementForKey(u.license_key),
      entitlements: all('SELECT * FROM entitlements WHERE license_key = ? ORDER BY created_at DESC', u.license_key),
      payments: all('SELECT * FROM payments WHERE user_id = ? OR license_key = ? ORDER BY created_at DESC LIMIT 50', u.id, u.license_key),
      manualPayments: all('SELECT * FROM manual_payments WHERE user_id = ? ORDER BY id DESC LIMIT 50', u.id),
      customers: u.role === 'reseller' ? all('SELECT id, email, name, status, created_at FROM users WHERE reseller_id = ? ORDER BY id DESC LIMIT 500', u.id) : [],
      ledger: all('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100', u.id),
      usage: all('SELECT day, count FROM usage WHERE license_key = ? ORDER BY day DESC LIMIT 30', u.license_key),
    };
  }));
  api.post('/users/:id/grant', wrap((req) => {
    const u = userOr404(req.params.id);
    const kind = req.body?.kind === 'pass' ? 'pass' : 'pro';
    const hours = Math.max(1, Math.min(24 * 3650, parseInt(req.body?.hours, 10) || 24 * 30));
    return { id: svc.grant(u.license_key, kind, 'admin', null, null, hours * HOUR) };
  }));
  api.post('/users/:id/credits', wrap((req) => {
    const u = userOr404(req.params.id);
    const delta = parseInt(req.body?.delta, 10);
    if (!delta || Math.abs(delta) > 100000) throw new AppError('bad_amount');
    return { balance: svc.addCredits(u.id, delta, 'admin', String(req.body?.note || `admin:${req.admin.email}`).slice(0, 120)) };
  }));
  api.post('/users/:id/reseller', wrap((req) => {
    const u = userOr404(req.params.id);
    const approve = !!req.body?.approve;
    if (approve && u.reseller_id) throw new AppError('customer_of_reseller', 409);
    db.prepare('UPDATE users SET role = ?, reseller_status = ? WHERE id = ?').run(approve ? 'reseller' : 'user', approve ? 'approved' : (u.reseller_status === 'pending' ? 'rejected' : 'none'), u.id);
  }));
  api.post('/users/:id/status', wrap((req) => {
    const u = userOr404(req.params.id);
    const status = req.body?.status === 'disabled' ? 'disabled' : 'active';
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, u.id);
    if (status === 'disabled') sessions.endAll('user', u.id);
  }));
  api.post('/users/:id/password', wrap((req) => {
    const u = userOr404(req.params.id);
    svc.setPassword(u.id, req.body?.password);
    sessions.endAll('user', u.id);
  }));
  api.post('/users/:id/reset-usage', wrap((req) => {
    const u = userOr404(req.params.id);
    db.prepare('DELETE FROM usage WHERE license_key = ? AND day = ?').run(u.license_key, todayUTC(now()));
  }));

  // ---------- browser licences (installs without an account) ----------
  api.get('/licenses', wrap((req) => {
    const qs = String(req.query.q || '').trim().toLowerCase();
    const t = now();
    return { licenses: all(`
      SELECT l.key, l.created_at, l.last_seen_at, l.version, l.banned, l.note, u.email,
        (SELECT MAX(ends_at) FROM entitlements e WHERE e.license_key = l.key AND e.revoked = 0 AND e.ends_at > ?) AS paid_until,
        (SELECT count FROM usage x WHERE x.license_key = l.key AND x.day = ?) AS today
      FROM licenses l LEFT JOIN users u ON u.license_key = l.key
      WHERE (? = '' OR l.key LIKE ? OR u.email LIKE ?)
      ORDER BY l.last_seen_at DESC LIMIT 200`, t, todayUTC(t), qs, `%${qs}%`, `%${qs}%`) };
  }));
  api.get('/licenses/:key', wrap((req) => {
    const lic = one('SELECT * FROM licenses WHERE key = ?', req.params.key);
    if (!lic) throw new AppError('not_found', 404);
    return {
      license: lic, entitlement: svc.entitlement(lic),
      entitlements: all('SELECT * FROM entitlements WHERE license_key = ? ORDER BY created_at DESC', lic.key),
      usage: all('SELECT day, count FROM usage WHERE license_key = ? ORDER BY day DESC LIMIT 30', lic.key),
    };
  }));
  api.post('/licenses/:key/grant', wrap((req) => {
    if (!one('SELECT key FROM licenses WHERE key = ?', req.params.key)) throw new AppError('not_found', 404);
    const kind = req.body?.kind === 'pass' ? 'pass' : 'pro';
    const hours = Math.max(1, Math.min(24 * 3650, parseInt(req.body?.hours, 10) || 24 * 30));
    return { id: svc.grant(req.params.key, kind, 'admin', null, null, hours * HOUR) };
  }));
  api.post('/licenses/:key/ban', wrap((req) => {
    db.prepare('UPDATE licenses SET banned = ?, note = COALESCE(?, note) WHERE key = ?').run(req.body?.banned ? 1 : 0, req.body?.note ?? null, req.params.key);
  }));
  api.post('/licenses/:key/reset-usage', wrap((req) => {
    db.prepare('DELETE FROM usage WHERE license_key = ? AND day = ?').run(req.params.key, todayUTC(now()));
  }));
  api.post('/entitlements/:id/revoke', wrap((req) => ({ ok: db.prepare('UPDATE entitlements SET revoked = 1 WHERE id = ?').run(req.params.id).changes > 0 })));

  // ---------- manual payments ----------
  api.get('/manual-payments', wrap((req) => {
    const status = ['pending', 'approved', 'rejected', 'awaiting'].includes(req.query.status) ? req.query.status : 'pending';
    return { payments: all(`SELECT m.*, u.email, u.name FROM manual_payments m JOIN users u ON u.id = m.user_id
      WHERE m.status = ? ORDER BY COALESCE(m.submitted_at, m.created_at) DESC LIMIT 300`, status) };
  }));
  api.post('/manual-payments/:id/approve', wrap((req) => svc.decideManualPayment(req.admin.id, Number(req.params.id), true, req.body?.note)));
  api.post('/manual-payments/:id/reject', wrap((req) => svc.decideManualPayment(req.admin.id, Number(req.params.id), false, req.body?.note)));
  api.get('/manual-payments/:id/proof', (req, res) => {
    const mp = one('SELECT proof_file FROM manual_payments WHERE id = ?', req.params.id);
    if (!mp?.proof_file || !/^mp\d+-[0-9a-f]{16}\.(png|jpg|webp|pdf)$/.test(mp.proof_file)) return res.status(404).end();
    const file = path.join(config.uploadDir, mp.proof_file);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.resolve(file));
  });

  // ---------- products ----------
  api.get('/products', wrap(() => ({ products: all('SELECT * FROM products ORDER BY sort, code') })));
  api.put('/products/:code', wrap((req) => {
    const b = req.body || {};
    if (!/^[a-z0-9_]{2,32}$/.test(req.params.code)) throw new AppError('bad_code');
    if (!['subscription', 'pass', 'credits'].includes(b.kind)) throw new AppError('bad_kind');
    let features = '[]';
    try { features = JSON.stringify(Array.isArray(b.features) ? b.features.map(String) : JSON.parse(b.features || '[]')); } catch (_) {}
    const int = (v) => (v === '' || v == null ? null : parseInt(v, 10));
    db.prepare(`INSERT INTO products(code, name, kind, price_paise, price_usd_cents, credits, currency, interval_label, duration_hours, razorpay_plan_id, features, active, sort)
      VALUES (@code, @name, @kind, @price_paise, @price_usd_cents, @credits, @currency, @interval_label, @duration_hours, @razorpay_plan_id, @features, @active, @sort)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, kind=excluded.kind, price_paise=excluded.price_paise, price_usd_cents=excluded.price_usd_cents,
        credits=excluded.credits, currency=excluded.currency, interval_label=excluded.interval_label, duration_hours=excluded.duration_hours,
        razorpay_plan_id=excluded.razorpay_plan_id, features=excluded.features, active=excluded.active, sort=excluded.sort`).run({
      code: req.params.code, name: String(b.name || req.params.code), kind: b.kind,
      price_paise: int(b.price_paise) || 0, price_usd_cents: int(b.price_usd_cents), credits: b.kind === 'credits' ? int(b.credits) || 0 : null,
      currency: 'INR', interval_label: b.interval_label || null, duration_hours: int(b.duration_hours),
      razorpay_plan_id: b.razorpay_plan_id || null, features, active: b.active === false || b.active === 0 ? 0 : 1, sort: int(b.sort) || 0,
    });
  }));

  // ---------- notices ----------
  api.get('/notices', wrap(() => ({ notices: all('SELECT * FROM notices ORDER BY created_at DESC') })));
  const noticeRow = (b) => ({
    title: String(b.title || ''), body: String(b.body || ''), link_url: b.link_url || null, link_label: b.link_label || null,
    level: ['info', 'warning', 'critical'].includes(b.level) ? b.level : 'info', lang: b.lang || null,
    min_version: b.min_version || null, max_version: b.max_version || null, active: b.active === false || b.active === 0 ? 0 : 1,
    starts_at: b.starts_at ? Number(b.starts_at) : null, ends_at: b.ends_at ? Number(b.ends_at) : null,
  });
  api.post('/notices', wrap((req) => {
    const row = noticeRow(req.body || {});
    if (!row.title || !row.body) throw new AppError('title_body_required');
    return { id: db.prepare(`INSERT INTO notices(title, body, link_url, link_label, level, lang, min_version, max_version, active, starts_at, ends_at, created_at)
      VALUES (@title, @body, @link_url, @link_label, @level, @lang, @min_version, @max_version, @active, @starts_at, @ends_at, @created_at)`).run({ ...row, created_at: now() }).lastInsertRowid };
  }));
  api.put('/notices/:id', wrap((req) => {
    db.prepare(`UPDATE notices SET title=@title, body=@body, link_url=@link_url, link_label=@link_label, level=@level, lang=@lang,
      min_version=@min_version, max_version=@max_version, active=@active, starts_at=@starts_at, ends_at=@ends_at WHERE id=@id`).run({ ...noticeRow(req.body || {}), id: req.params.id });
  }));
  api.delete('/notices/:id', wrap((req) => { db.prepare('DELETE FROM notices WHERE id = ?').run(req.params.id); }));

  // ---------- settings / payments ----------
  api.get('/settings', wrap(() => ({ settings: Object.fromEntries(all('SELECT key, value FROM settings').map((s) => [s.key, s.value])) })));
  api.put('/settings', wrap((req) => {
    const up = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of SETTING_KEYS) if (req.body && k in req.body) up.run(k, String(req.body[k] ?? '').slice(0, 2000));
  }));
  api.get('/payments', wrap(() => ({ payments: all('SELECT p.*, u.email FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 300') })));

  r.use('/api', api);
  r.use(express.static(path.join(__dirname, '..', 'web', 'admin'), { index: 'index.html' }));
  return r;
}

module.exports = { adminRouter };
