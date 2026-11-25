// /api/u/* — website accounts for users and resellers (cookie session).
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { rateLimit } = require('express-rate-limit');
const { sha256, randomToken, normEmail, sameOrigin } = require('./auth');
const { AppError } = require('./service');

const PROOF_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const PROOF_MAX = 3 * 1024 * 1024;

function portalRouter({ db, svc, sessions, config, mailer, razorpay, now = () => Date.now() }) {
  const r = express.Router();
  r.use(express.json({ limit: '5mb' }));
  r.use(sameOrigin(config.publicUrl));

  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof AppError) return res.status(e.status).json({ error: e.code, ...(e.credits != null ? { credits: e.credits } : {}) });
      console.error('[portal]', e);
      res.status(500).json({ error: 'internal' });
    }
  };
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.loginPer15Min ?? 20, standardHeaders: true, legacyHeaders: false });

  const needUser = (req, res, next) => {
    const s = sessions.read(req, 'user');
    const u = s && svc.getUser(s.subject_id);
    if (!u || u.status !== 'active') return res.status(401).json({ error: 'not_signed_in' });
    req.user = u;
    next();
  };
  const needReseller = (req, res, next) => {
    if (req.user.role !== 'reseller') return res.status(403).json({ error: 'not_reseller' });
    next();
  };

  // ---------- auth ----------
  r.post('/register', authLimiter, wrap((req, res) => {
    const b = req.body || {};
    const u = svc.createUser({ email: b.email, password: b.password, name: b.name, phone: b.phone, ip: req.ip });
    sessions.start(res, req, 'user', u.id);
    return { user: svc.userView(u) };
  }));
  r.post('/login', authLimiter, wrap((req, res) => {
    const u = svc.login(req.body?.email, req.body?.password);
    sessions.start(res, req, 'user', u.id);
    return { user: svc.userView(u) };
  }));
  r.post('/logout', wrap((req, res) => { sessions.end(req, res, 'user'); }));

  r.post('/forgot', authLimiter, wrap(async (req) => {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail(req.body?.email));
    if (u && u.status === 'active') {
      const token = randomToken();
      db.prepare('INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), u.id, now() + 3600 * 1000);
      const link = `${config.publicUrl}/users/#reset=${token}`;
      await mailer.send({ to: u.email, subject: 'Reset your MeAPI DM password',
        text: `Hi${u.name ? ' ' + u.name : ''},\n\nOpen this link within 1 hour to set a new password:\n${link}\n\nIf you didn't ask for this, ignore this email.\n\n— MeAPI DM` });
    }
    return { ok: true, mail: mailer.enabled }; // same answer whether the email exists or not
  }));
  r.post('/reset', authLimiter, wrap((req, res) => {
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(String(req.body?.token || '')));
    if (!row || row.used || row.expires_at < now()) throw new AppError('reset_expired');
    svc.setPassword(row.user_id, req.body?.password);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(row.token_hash);
    sessions.endAll('user', row.user_id);
    sessions.start(res, req, 'user', row.user_id);
  }));

  // ---------- account ----------
  function publicConfig() {
    return {
      methods: svc.paymentMethods(),
      extensionUrl: svc.setting('extension_url') || null,
      supportEmail: svc.setting('support_email') || null,
      supportWhatsapp: svc.setting('support_whatsapp') || null,
      creditsPerMonth: svc.intSetting('credits_per_month', 1),
      freeDailyLimit: svc.intSetting('free_daily_limit', 10),
      mailEnabled: mailer.enabled,
    };
  }
  r.get('/config', wrap(() => publicConfig()));
  r.get('/me', needUser, wrap((req) => ({ user: svc.userView(req.user), entitlement: svc.entitlementForKey(req.user.license_key), config: publicConfig() })));
  r.put('/profile', needUser, wrap((req) => { svc.updateProfile(req.user.id, req.body || {}); }));
  r.post('/password', needUser, wrap((req, res) => {
    svc.changePassword(req.user.id, req.body?.current, req.body?.password);
    sessions.endAll('user', req.user.id);
    sessions.start(res, req, 'user', req.user.id);
  }));

  // ---------- buying ----------
  r.get('/products', needUser, wrap((req) => ({ products: svc.listProducts({ includeCredits: req.user.role === 'reseller' }) })));
  r.post('/checkout', needUser, wrap(async (req) => svc.checkout({ user: req.user }, req.body?.productCode, razorpay, config.publicUrl)));

  async function withQr(instr) {
    if (instr.upiUri) instr.upiQr = await QRCode.toDataURL(instr.upiUri, { margin: 1, width: 280 });
    return instr;
  }
  r.post('/payments/manual', needUser, wrap(async (req) => withQr(svc.createManualPayment(req.user, req.body?.productCode, req.body?.method))));
  r.get('/payments/manual/:id', needUser, wrap(async (req) => {
    const mp = db.prepare('SELECT * FROM manual_payments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!mp) throw new AppError('not_found', 404);
    return withQr(svc.manualInstructions(mp));
  }));
  r.post('/payments/manual/:id/submit', needUser, wrap(async (req) => {
    const b = req.body || {};
    let proofFile = null;
    if (b.proof) {
      const m = String(b.proof).match(/^data:([a-z/+.-]+);base64,(.+)$/i);
      if (!m || !PROOF_TYPES[m[1].toLowerCase()]) throw new AppError('bad_proof_type');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > PROOF_MAX) throw new AppError('proof_too_large');
      fs.mkdirSync(config.uploadDir, { recursive: true });
      proofFile = `mp${Number(req.params.id)}-${crypto.randomBytes(8).toString('hex')}.${PROOF_TYPES[m[1].toLowerCase()]}`;
      fs.writeFileSync(path.join(config.uploadDir, proofFile), buf, { mode: 0o600 });
    }
    const mp = svc.submitManualPayment(req.user, Number(req.params.id), { reference: b.reference, note: b.note, proofFile });
    if (config.notifyEmail) {
      mailer.send({ to: config.notifyEmail, subject: `[MeAPI DM] Payment to approve: ${mp.method.toUpperCase()} #${mp.id}`,
        text: `${req.user.email} submitted ${mp.method} payment #${mp.id} for ${mp.product_code}.\nReference: ${mp.reference}\n\nApprove it at ${config.publicUrl}/admin` });
    }
    return { ok: true, status: mp.status };
  }));
  r.post('/payments/manual/:id/cancel', needUser, wrap((req) => { svc.cancelManualPayment(req.user, Number(req.params.id)); }));
  r.get('/payments', needUser, wrap((req) => ({
    manual: db.prepare("SELECT id, product_code, method, amount, currency, reference, status, admin_note, created_at, submitted_at, decided_at FROM manual_payments WHERE user_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 100").all(req.user.id),
    online: db.prepare("SELECT product_code, method, razorpay_id, amount_paise, currency, created_at FROM payments WHERE (user_id = ? OR license_key = ?) AND method = 'razorpay' ORDER BY id DESC LIMIT 100").all(req.user.id, req.user.license_key),
  })));

  // ---------- resellers ----------
  r.post('/reseller/apply', needUser, wrap((req) => {
    if (req.user.role === 'reseller') throw new AppError('already_reseller', 409);
    if (req.user.reseller_id) throw new AppError('customer_of_reseller', 409);
    db.prepare("UPDATE users SET reseller_status = 'pending', reseller_note = ? WHERE id = ?").run(String(req.body?.note || '').slice(0, 1000), req.user.id);
    if (config.notifyEmail) mailer.send({ to: config.notifyEmail, subject: '[MeAPI DM] New reseller application', text: `${req.user.email} applied to become a reseller.\n\n${req.body?.note || ''}` });
  }));
  r.get('/reseller/customers', needUser, needReseller, wrap((req) => {
    const rows = db.prepare('SELECT * FROM users WHERE reseller_id = ? ORDER BY id DESC').all(req.user.id);
    return { customers: rows.map((c) => {
      const e = svc.entitlementForKey(c.license_key);
      return { id: c.id, email: c.email, name: c.name || '', phone: c.phone || '', status: c.status, createdAt: c.created_at, lastLoginAt: c.last_login_at,
        tier: e?.tier, paidBy: e?.paidBy, paidUntil: e?.paidUntil, usageToday: e?.usageToday };
    }) };
  }));
  r.post('/reseller/customers', needUser, needReseller, wrap((req) => ({ customer: svc.userView(svc.resellerCreateCustomer(req.user, req.body || {})) })));
  r.post('/reseller/customers/:id/activate', needUser, needReseller, wrap((req) => svc.resellerActivate(req.user, Number(req.params.id), req.body?.months)));
  r.post('/reseller/customers/:id/password', needUser, needReseller, wrap((req) => {
    const c = svc.ownCustomer(req.user, Number(req.params.id));
    svc.setPassword(c.id, req.body?.password);
    sessions.endAll('user', c.id);
  }));
  r.post('/reseller/customers/:id/status', needUser, needReseller, wrap((req) => {
    const c = svc.ownCustomer(req.user, Number(req.params.id));
    const status = req.body?.status === 'disabled' ? 'disabled' : 'active';
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, c.id);
    if (status === 'disabled') sessions.endAll('user', c.id);
  }));
  r.get('/reseller/ledger', needUser, needReseller, wrap((req) => ({
    ledger: db.prepare('SELECT delta, balance, reason, ref, created_at FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id),
  })));

  return r;
}

module.exports = { portalRouter };
