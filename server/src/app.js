// HTTP layer. createApp() is used by index.js and by the tests.
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createService } = require('./service');
const { verifyWebhook } = require('./razorpay');
const { adminRouter } = require('./admin');

function createApp({ db, config, razorpay = null, fetchImpl = fetch, now }) {
  const svc = createService(db, { now });
  const app = express();
  app.set('trust proxy', config.trustProxy ?? 1);
  app.disable('x-powered-by');

  // Extension pages call us from chrome-extension://<id>. Lock to your published id(s) via EXTENSION_IDS.
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

  // ---- Razorpay webhook needs the raw body, so it goes before express.json ----
  app.post('/v1/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!verifyWebhook(raw, req.get('x-razorpay-signature'), config.razorpayWebhookSecret)) {
      return res.status(400).json({ error: 'bad_signature' });
    }
    let evt;
    try { evt = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'bad_json' }); }
    const eventId = req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex');
    try {
      const result = svc.applyWebhook(evt, eventId);
      if (config.logWebhooks !== false) console.log(`[webhook] ${evt.event} -> ${result}`);
      res.json({ ok: true, result });
    } catch (e) {
      console.error('[webhook] failed', e);
      res.status(500).json({ error: 'internal' }); // Razorpay retries on non-2xx
    }
  });

  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/paid', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'paid.html')));
  app.use('/admin', adminRouter({ db, svc, config }));

  const v1 = express.Router();
  v1.use(corsMw); // also answers OPTIONS preflight

  const issueLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: config.issuePerHour ?? 10, standardHeaders: true, legacyHeaders: false });
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.perMinute ?? 120, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.get('x-license-key') || req.ip });

  v1.post('/license/issue', issueLimiter, (req, res) => {
    const key = svc.issue(req.ip, req.get('x-client-version'));
    res.status(201).json({ key });
  });

  // Everything below needs a license key.
  const needLicense = (req, res, next) => {
    const lic = svc.auth(req.get('x-license-key'), req.get('x-client-version'));
    if (!lic) return res.status(401).json({ error: 'invalid_license' });
    req.lic = lic;
    next();
  };

  v1.get('/entitlement', apiLimiter, needLicense, (req, res) => res.json(svc.entitlement(req.lic)));

  v1.post('/usage/reserve', apiLimiter, needLicense, (req, res) => {
    const r = svc.reserve(req.lic, req.body?.n);
    if (r.ok) return res.json(r);
    res.status(r.error === 'banned' ? 403 : 402).json(r);
  });
  v1.post('/usage/release', apiLimiter, needLicense, (req, res) => res.json(svc.release(req.lic, req.body?.n)));

  v1.get('/products', apiLimiter, (_req, res) => res.json({ products: svc.listProducts() }));

  v1.post('/checkout', apiLimiter, needLicense, async (req, res) => {
    try {
      res.json(await svc.checkout(req.lic, req.body?.productCode, razorpay, config.publicUrl));
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // Google sign-in (optional): the extension sends a chrome.identity access token, we verify it with Google.
  v1.post('/account/google', apiLimiter, needLicense, async (req, res) => {
    const token = String(req.body?.accessToken || '');
    if (!token) return res.status(400).json({ error: 'missing_token' });
    let info;
    try {
      const r = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return res.status(401).json({ error: 'google_rejected' });
      info = await r.json();
    } catch (_) {
      return res.status(502).json({ error: 'google_unreachable' });
    }
    if (!info.sub || !info.email || info.email_verified === false) return res.status(401).json({ error: 'google_unverified' });
    res.json(svc.linkGoogle(req.lic, { sub: info.sub, email: String(info.email).toLowerCase(), name: info.name }));
  });

  v1.get('/notice', apiLimiter, (req, res) => {
    res.json({ notice: svc.notice({ version: req.query.v, lang: req.query.lang }) });
  });

  v1.post('/track', apiLimiter, (req, res) => {
    const lic = svc.auth(req.get('x-license-key'), req.get('x-client-version'));
    res.json({ stored: svc.track(lic?.key, req.body?.events, req.get('x-client-version')) });
  });

  app.use('/v1', v1);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return { app, svc };
}

module.exports = { createApp };
