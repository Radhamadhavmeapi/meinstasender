// HTTP wiring. createApp() is used by index.js and by the tests.
//   /            landing page (web/site)
//   /users       user & reseller portal (web/users)  + /api/u/*
//   /admin       admin panel (web/admin)              + /admin/api/*
//   /v1/*        extension API (license key in X-License-Key)
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { createService, AppError } = require('./service');
const { verifyWebhook } = require('./razorpay');
const { adminRouter } = require('./admin');
const { portalRouter } = require('./portal');
const { createSessions } = require('./auth');
const { createMailer } = require('./mailer');

const WEB = path.join(__dirname, '..', 'web');

function createApp({ db, config, razorpay = null, fetchImpl = fetch, now, mailer }) {
  const svc = createService(db, { now });
  const sessions = createSessions(db, { secureCookies: (config.publicUrl || '').startsWith('https://'), now });
  mailer = mailer || createMailer(config.smtp || {});
  config = { uploadDir: path.join(process.cwd(), 'data', 'uploads'), ...config };

  const app = express();
  app.set('trust proxy', config.trustProxy ?? 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    });
    if (!req.path.startsWith('/v1/')) {
      res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    }
    next();
  });

  // Extension pages call /v1 from chrome-extension://<id>. Lock to your published id(s) via EXTENSION_IDS.
  const allowed = (config.extensionIds || []).map((id) => `chrome-extension://${id}`);
  const corsMw = cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowed.length === 0 && origin.startsWith('chrome-extension://')) return cb(null, true);
      cb(null, allowed.includes(origin));
    },
    allowedHeaders: ['Content-Type', 'X-License-Key', 'X-Client-Version'],
    maxAge: 86400,
  });

  // ---- Razorpay webhook (raw body for the signature) ----
  app.post('/v1/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!verifyWebhook(raw, req.get('x-razorpay-signature'), config.razorpayWebhookSecret)) return res.status(400).json({ error: 'bad_signature' });
    let evt;
    try { evt = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'bad_json' }); }
    const eventId = req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex');
    try {
      const result = svc.applyWebhook(evt, eventId);
      if (config.logWebhooks !== false) console.log(`[webhook] ${evt.event} -> ${result}`);
      res.json({ ok: true, result });
    } catch (e) {
      console.error('[webhook] failed', e);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ---------------- extension API ----------------
  const v1 = express.Router();
  v1.use(corsMw);
  v1.use(express.json({ limit: '64kb' }));
  const issueLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: config.issuePerHour ?? 10, standardHeaders: true, legacyHeaders: false });
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.perMinute ?? 120, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.get('x-license-key') || ipKeyGenerator(req.ip) });
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.loginPer15Min ?? 20, standardHeaders: true, legacyHeaders: false });
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req, res)); } catch (e) {
      if (e instanceof AppError) return res.status(e.status).json({ error: e.code });
      console.error('[v1]', e);
      res.status(e.status || 500).json({ error: e.message || 'internal' });
    }
  };

  v1.post('/license/issue', issueLimiter, (req, res) => res.status(201).json({ key: svc.issue(req.ip, req.get('x-client-version')) }));

  const needLicense = (req, res, next) => {
    const lic = svc.auth(req.get('x-license-key'), req.get('x-client-version'));
    if (!lic) return res.status(401).json({ error: 'invalid_license' });
    req.lic = lic;
    next();
  };
  const portalUrl = config.publicUrl ? `${config.publicUrl}/users/` : null;

  v1.get('/entitlement', apiLimiter, needLicense, (req, res) => res.json({ ...svc.entitlement(req.lic), portalUrl }));
  v1.post('/usage/reserve', apiLimiter, needLicense, (req, res) => {
    const r = svc.reserve(req.lic, req.body?.n);
    if (r.ok) return res.json(r);
    res.status(r.error === 'banned' ? 403 : 402).json(r);
  });
  v1.post('/usage/release', apiLimiter, needLicense, (req, res) => res.json(svc.release(req.lic, req.body?.n)));
  v1.get('/products', apiLimiter, (_req, res) => res.json({ products: svc.listProducts(), methods: svc.paymentMethods(), portalUrl }));
  v1.post('/checkout', apiLimiter, needLicense, wrap(async (req) => {
    const user = req.lic.user_id ? svc.getUser(req.lic.user_id) : null;
    return svc.checkout({ lic: req.lic, user }, req.body?.productCode, razorpay, config.publicUrl);
  }));

  // Email + password from the extension. Same account as the website.
  v1.post('/account/login', loginLimiter, needLicense, wrap((req) => svc.attachBrowser(req.lic, svc.login(req.body?.email, req.body?.password))));
  v1.post('/account/register', loginLimiter, needLicense, wrap((req) => {
    const b = req.body || {};
    const u = svc.createUser({ email: b.email, password: b.password, name: b.name, phone: b.phone, licenseKey: req.lic.key, ip: req.ip });
    return { key: u.license_key, email: u.email, name: u.name || null, created: true };
  }));
  v1.post('/account/google', apiLimiter, needLicense, wrap(async (req) => {
    const token = String(req.body?.accessToken || '');
    if (!token) throw new AppError('missing_token');
    let info;
    try {
      const r = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new AppError('google_rejected', 401);
      info = await r.json();
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('google_unreachable', 502);
    }
    if (!info.sub || !info.email || info.email_verified === false) throw new AppError('google_unverified', 401);
    return svc.linkGoogle(req.lic, { sub: info.sub, email: info.email, name: info.name });
  }));

  v1.get('/notice', apiLimiter, (req, res) => res.json({ notice: svc.notice({ version: req.query.v, lang: req.query.lang }) }));
  v1.post('/track', apiLimiter, (req, res) => {
    const lic = svc.auth(req.get('x-license-key'), req.get('x-client-version'));
    res.json({ stored: svc.track(lic?.key, req.body?.events, req.get('x-client-version')) });
  });
  app.use('/v1', v1);

  // ---------------- website ----------------
  app.use('/shared', express.static(path.join(WEB, 'shared'), { maxAge: '7d' }));
  app.use('/api/u', portalRouter({ db, svc, sessions, config, mailer, razorpay, now }));
  app.use('/admin', adminRouter({ db, svc, sessions, config, now }));
  app.use((req, res, next) => (req.path === '/users' || req.path === '/admin' ? res.redirect(301, req.path + '/') : next()));
  app.use('/users', express.static(path.join(WEB, 'users'), { index: 'index.html' }));
  app.use('/', express.static(path.join(WEB, 'site'), { index: 'index.html', extensions: ['html'] }));
  app.get('/paid', (_req, res) => res.sendFile(path.join(WEB, 'site', 'paid.html')));

  app.use((req, res) => {
    if (req.accepts('html') && !req.path.startsWith('/v1/') && !req.path.includes('/api/')) return res.status(404).sendFile(path.join(WEB, 'site', '404.html'));
    res.status(404).json({ error: 'not_found' });
  });
  return { app, svc, sessions, mailer };
}

module.exports = { createApp };
