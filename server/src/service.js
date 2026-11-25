// Business logic: licenses, entitlement, usage, accounts, resellers & credits, checkout, manual payments, webhooks.
const crypto = require('crypto');
const { hashPassword, verifyPassword, DUMMY_HASH, normEmail, EMAIL_RE, validPassword } = require('./auth');

const HOUR = 3600 * 1000;
const DAY_MS = 24 * HOUR;
const SUB_GRACE_MS = 6 * HOUR;

const todayUTC = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const newKey = () => 'mdm_' + crypto.randomBytes(24).toString('hex');
const KEY_RE = /^mdm_[0-9a-f]{48}$/;

function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function formatPrice(minor, currency) {
  const amount = minor / 100;
  const sym = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency + ' ';
  const opts = Number.isInteger(amount) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return sym + amount.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', opts);
}

class AppError extends Error {
  constructor(code, status = 400, extra = {}) { super(code); this.code = code; this.status = status; Object.assign(this, extra); }
}

function createService(db, { now = () => Date.now() } = {}) {
  const q = {
    getLicense: db.prepare('SELECT * FROM licenses WHERE key = ?'),
    insLicense: db.prepare('INSERT INTO licenses(key, user_id, created_at, last_seen_at, created_ip, version) VALUES (?, ?, ?, ?, ?, ?)'),
    touch: db.prepare('UPDATE licenses SET last_seen_at = ?, version = COALESCE(?, version) WHERE key = ?'),
    setLicenseUser: db.prepare('UPDATE licenses SET user_id = ? WHERE key = ?'),
    setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    activeEnts: db.prepare('SELECT * FROM entitlements WHERE license_key = ? AND revoked = 0 AND ends_at > ? AND starts_at <= ? ORDER BY ends_at DESC'),
    liveEnts: db.prepare('SELECT * FROM entitlements WHERE license_key = ? AND revoked = 0 AND ends_at > ? ORDER BY ends_at DESC'),
    usage: db.prepare('SELECT count FROM usage WHERE license_key = ? AND day = ?'),
    usageUpsert: db.prepare(`INSERT INTO usage(license_key, day, count) VALUES (?, ?, ?)
      ON CONFLICT(license_key, day) DO UPDATE SET count = count + excluded.count`),
    usageDec: db.prepare('UPDATE usage SET count = MAX(0, count - ?) WHERE license_key = ? AND day = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userBySub: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
    userByKey: db.prepare('SELECT * FROM users WHERE license_key = ?'),
    insUser: db.prepare(`INSERT INTO users(email, password_hash, google_sub, name, phone, role, reseller_id, license_key, created_at)
      VALUES (@email, @password_hash, @google_sub, @name, @phone, 'user', @reseller_id, @license_key, @created_at)`),
    setGoogleSub: db.prepare('UPDATE users SET google_sub = ? WHERE id = ?'),
    userLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    setCredits: db.prepare('UPDATE users SET credits = ? WHERE id = ?'),
    insLedger: db.prepare('INSERT INTO credit_ledger(user_id, delta, balance, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    product: db.prepare('SELECT * FROM products WHERE code = ?'),
    products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, code'),
    subByKey: db.prepare('SELECT * FROM subscriptions WHERE license_key = ? ORDER BY updated_at DESC LIMIT 1'),
    subById: db.prepare('SELECT * FROM subscriptions WHERE id = ?'),
    upsertSub: db.prepare(`INSERT INTO subscriptions(id, license_key, product_code, status, current_end, created_at, updated_at)
      VALUES (@id, @license_key, @product_code, @status, @current_end, @t, @t)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, current_end = COALESCE(excluded.current_end, current_end), updated_at = excluded.updated_at`),
    entByRef: db.prepare('SELECT * FROM entitlements WHERE source = ? AND ref = ?'),
    insEnt: db.prepare(`INSERT INTO entitlements(license_key, kind, source, ref, product_code, starts_at, ends_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    extendEnt: db.prepare('UPDATE entitlements SET ends_at = MAX(ends_at, ?), revoked = 0 WHERE id = ?'),
    moveEnts: db.prepare('UPDATE entitlements SET license_key = ? WHERE license_key = ? AND revoked = 0 AND ends_at > ?'),
    moveSubs: db.prepare('UPDATE subscriptions SET license_key = ? WHERE license_key = ?'),
    insPayment: db.prepare('INSERT INTO payments(license_key, user_id, product_code, method, razorpay_id, amount_paise, currency, event, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    insCheckout: db.prepare('INSERT INTO checkouts(license_key, user_id, product_code, created_at) VALUES (?, ?, ?, ?)'),
    updCheckout: db.prepare('UPDATE checkouts SET razorpay_id = ?, url = ? WHERE id = ?'),
    seenWebhook: db.prepare('INSERT OR IGNORE INTO webhook_events(id, event, received_at) VALUES (?, ?, ?)'),
    notices: db.prepare(`SELECT * FROM notices WHERE active = 1
      AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY CASE level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC`),
    insEvent: db.prepare('INSERT INTO events(license_key, name, props, version, created_at) VALUES (?, ?, ?, ?, ?)'),
    mpById: db.prepare('SELECT * FROM manual_payments WHERE id = ?'),
    insMp: db.prepare(`INSERT INTO manual_payments(user_id, product_code, method, amount, currency, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'awaiting', ?)`),
  };

  const setting = (k, dflt = '') => q.setting.get(k)?.value ?? dflt;
  const intSetting = (k, dflt) => {
    const n = parseInt(setting(k, String(dflt)), 10);
    return Number.isFinite(n) ? n : dflt;
  };
  const tx = (fn) => db.transaction(fn)();

  // ---------------- products ----------------
  function productView(p) {
    let features = [];
    try { features = JSON.parse(p.features || '[]'); } catch (_) {}
    return {
      code: p.code, name: p.name, kind: p.kind,
      price: formatPrice(p.price_paise, p.currency), pricePaise: p.price_paise, currency: p.currency,
      priceUsd: p.price_usd_cents ? formatPrice(p.price_usd_cents, 'USD') : null, priceUsdCents: p.price_usd_cents || null,
      credits: p.credits || null,
      interval: p.interval_label || null, durationHours: p.duration_hours || null, features,
      purchasable: p.kind === 'subscription' ? !!p.razorpay_plan_id : true, // Razorpay availability (passes/credits use payment links)
    };
  }
  function listProducts({ includeCredits = false } = {}) {
    return q.products.all().filter((p) => includeCredits || p.kind !== 'credits').map(productView);
  }
  function getProduct(code) {
    const p = q.product.get(String(code || ''));
    if (!p || !p.active) throw new AppError('unknown_product', 404);
    return p;
  }

  // ---------------- licenses ----------------
  function issue(ip, version, userId = null) {
    const key = newKey();
    const t = now();
    q.insLicense.run(key, userId, t, t, ip || null, version || null);
    return key;
  }
  function auth(key, version) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
    const lic = q.getLicense.get(key);
    if (!lic) return null;
    q.touch.run(now(), version || null, key);
    return lic;
  }
  const usageToday = (key) => q.usage.get(key, todayUTC(now()))?.count || 0;

  function entitlementForKey(key) {
    const lic = q.getLicense.get(key);
    return lic ? entitlement(lic) : null;
  }

  function entitlement(lic) {
    const t = now();
    const ents = q.activeEnts.all(lic.key, t, t);
    const paid = ents.length > 0;
    const pro = ents.find((e) => e.kind === 'pro');
    const top = pro || ents[0] || null;
    const user = lic.user_id ? q.userById.get(lic.user_id) : q.userByKey.get(lic.key);
    const sub = q.subByKey.get(lic.key);
    let passOffer = null;
    const passCode = setting('pass_offer_code', '');
    if (!paid && passCode) {
      const p = q.product.get(passCode);
      if (p && p.active && p.kind === 'pass') passOffer = productView(p);
    }
    return {
      tier: paid ? 'paid' : 'free',
      paidBy: top ? top.kind : null,
      paidUntil: top ? Math.max(...ents.filter((e) => e.kind === top.kind).map((e) => e.ends_at)) : null,
      usageToday: usageToday(lic.key),
      freeDailyLimit: intSetting('free_daily_limit', 10),
      dailyCap: intSetting('pro_daily_cap', 100),
      banned: !!lic.banned || user?.status === 'disabled',
      account: user ? { email: user.email, name: user.name || null } : null,
      subscription: sub ? { id: sub.id, status: sub.status, currentEnd: sub.current_end, product: sub.product_code } : null,
      passOffer,
      portalUrl: null,
      serverTime: t,
    };
  }

  function reserve(lic, n = 1) {
    n = Math.max(1, Math.min(10, parseInt(n, 10) || 1));
    const ent = entitlement(lic);
    if (ent.banned) return { ok: false, error: 'banned' };
    if (ent.tier === 'free' && ent.usageToday + n > ent.freeDailyLimit) {
      return { ok: false, error: 'free_limit', usageToday: ent.usageToday, freeDailyLimit: ent.freeDailyLimit };
    }
    q.usageUpsert.run(lic.key, todayUTC(now()), n);
    return { ok: true, usageToday: ent.usageToday + n, tier: ent.tier };
  }
  function release(lic, n = 1) {
    n = Math.max(1, Math.min(10, parseInt(n, 10) || 1));
    q.usageDec.run(n, lic.key, todayUTC(now()));
    return { ok: true, usageToday: usageToday(lic.key) };
  }

  // Adds paid time. A new grant stacks on top of unexpired time of the same kind.
  function grant(key, kind, source, ref, productCode, durationMs, { endsAt } = {}) {
    const t = now();
    if (ref) {
      const existing = q.entByRef.get(source, ref);
      if (existing) {
        q.extendEnt.run(endsAt || Math.max(existing.ends_at, t) + durationMs, existing.id);
        return existing.id;
      }
    }
    let start = t;
    if (!endsAt) {
      const live = q.liveEnts.all(key, t).filter((e) => e.kind === kind);
      if (live.length) start = Math.max(...live.map((e) => e.ends_at));
    }
    return q.insEnt.run(key, kind, source, ref || null, productCode || null, t, endsAt || start + durationMs, t).lastInsertRowid;
  }

  // ---------------- accounts ----------------
  function userView(u) {
    if (!u) return null;
    return {
      id: u.id, email: u.email, name: u.name || '', phone: u.phone || '', role: u.role, resellerStatus: u.reseller_status,
      credits: u.credits, licenseKey: u.license_key, status: u.status, createdAt: u.created_at, hasPassword: !!u.password_hash,
      resellerId: u.reseller_id || null,
    };
  }
  const getUser = (id) => q.userById.get(id) || null;

  // Creates an account. If licenseKey is given (extension sign-up) that browser's key becomes the account's key.
  function createUser({ email, password, name, phone, resellerId = null, licenseKey = null, googleSub = null, ip = null }) {
    email = normEmail(email);
    if (!EMAIL_RE.test(email)) throw new AppError('invalid_email');
    if (password != null && !validPassword(password)) throw new AppError('weak_password');
    if (q.userByEmail.get(email)) throw new AppError('email_taken', 409);
    return tx(() => {
      let key = licenseKey;
      if (key) {
        const lic = q.getLicense.get(key);
        if (!lic || lic.user_id || q.userByKey.get(key)) key = null; // already someone else's: give a fresh one
      }
      if (!key) key = issue(ip, null);
      const id = q.insUser.run({
        email, password_hash: password != null ? hashPassword(password) : null, google_sub: googleSub,
        name: String(name || '').trim().slice(0, 80) || null, phone: String(phone || '').trim().slice(0, 20) || null,
        reseller_id: resellerId, license_key: key, created_at: now(),
      }).lastInsertRowid;
      if (password != null || googleSub) q.userLogin.run(now(), id);
      q.setLicenseUser.run(id, key);
      return q.userById.get(id);
    });
  }

  function login(email, password) {
    const u = q.userByEmail.get(normEmail(email));
    const ok = verifyPassword(password, u?.password_hash || DUMMY_HASH);
    if (!u || !ok) throw new AppError('bad_credentials', 401);
    if (u.status === 'disabled') throw new AppError('account_disabled', 403);
    q.userLogin.run(now(), u.id);
    return u;
  }

  // Extension: this browser (lic) signs in as user u → the browser switches to the account's key,
  // carrying over anything bought on the browser key while logged out.
  function attachBrowser(lic, u) {
    if (lic && lic.key !== u.license_key && !q.userByKey.get(lic.key)) {
      tx(() => {
        q.moveEnts.run(u.license_key, lic.key, now());
        q.moveSubs.run(u.license_key, lic.key);
      });
    }
    return { key: u.license_key, email: u.email, name: u.name || null };
  }

  function linkGoogle(lic, { sub, email, name }) {
    let u = q.userBySub.get(sub) || q.userByEmail.get(normEmail(email));
    if (!u) {
      u = createUser({ email, password: null, name, licenseKey: lic.key, googleSub: sub });
      return { key: u.license_key, email: u.email, created: true };
    }
    if (u.status === 'disabled') throw new AppError('account_disabled', 403);
    if (!u.google_sub) q.setGoogleSub.run(sub, u.id);
    q.userLogin.run(now(), u.id);
    return { ...attachBrowser(lic, u), created: false };
  }

  function changePassword(userId, current, next) {
    const u = q.userById.get(userId);
    if (u.password_hash && !verifyPassword(current, u.password_hash)) throw new AppError('bad_credentials', 401);
    if (!validPassword(next)) throw new AppError('weak_password');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), userId);
  }
  function setPassword(userId, next) {
    if (!validPassword(next)) throw new AppError('weak_password');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), userId);
  }
  function updateProfile(userId, { name, phone }) {
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?')
      .run(String(name || '').trim().slice(0, 80) || null, String(phone || '').trim().slice(0, 20) || null, userId);
  }

  // ---------------- credits (resellers) ----------------
  function addCredits(userId, delta, reason, ref = null) {
    return tx(() => {
      const u = q.userById.get(userId);
      if (!u) throw new AppError('user_not_found', 404);
      const balance = u.credits + delta;
      if (balance < 0) throw new AppError('not_enough_credits', 402, { credits: u.credits });
      q.setCredits.run(balance, userId);
      q.insLedger.run(userId, delta, balance, reason, ref, now());
      return balance;
    });
  }

  function requireReseller(u) {
    if (!u || u.role !== 'reseller' || u.status !== 'active') throw new AppError('not_reseller', 403);
  }
  function ownCustomer(reseller, customerId) {
    const c = q.userById.get(customerId);
    if (!c || c.reseller_id !== reseller.id) throw new AppError('not_your_customer', 404);
    return c;
  }
  function resellerCreateCustomer(reseller, { email, password, name, phone }) {
    requireReseller(reseller);
    return createUser({ email, password, name, phone, resellerId: reseller.id });
  }
  // Spend credits to give a customer PRO. 1 month = 30 days = credits_per_month credits.
  function resellerActivate(reseller, customerId, months) {
    requireReseller(reseller);
    months = parseInt(months, 10);
    if (![1, 3, 6, 12].includes(months)) throw new AppError('bad_months');
    const c = ownCustomer(reseller, customerId);
    const cost = months * Math.max(1, intSetting('credits_per_month', 1));
    return tx(() => {
      const balance = addCredits(reseller.id, -cost, 'activate', `user:${c.id}:${months}m`);
      grant(c.license_key, 'pro', 'reseller', null, `reseller_${months}m`, months * 30 * DAY_MS);
      return { balance, cost, entitlement: entitlementForKey(c.license_key) };
    });
  }

  // ---------------- fulfilment (any payment path) ----------------
  function fulfil({ user, licenseKey, product, source, ref }) {
    const key = licenseKey || user?.license_key;
    if (product.kind === 'credits') {
      if (!user) throw new AppError('credits_need_account');
      return { credits: addCredits(user.id, product.credits || 0, 'purchase', `${source}:${ref}`) };
    }
    if (product.kind === 'pass') return { entitlementId: grant(key, 'pass', source, ref, product.code, (product.duration_hours || 24) * HOUR) };
    const days = product.interval_label === 'year' ? 365 : 30;
    return { entitlementId: grant(key, 'pro', source, ref, product.code, days * DAY_MS) };
  }

  // ---------------- Razorpay checkout ----------------
  async function checkout({ lic, user }, productCode, rz, publicUrl) {
    const p = getProduct(productCode);
    if (!rz || setting('pay_razorpay', '1') !== '1') throw new AppError('payments_not_configured', 503);
    if (p.kind === 'credits') {
      if (!user) throw new AppError('credits_need_account', 401);
      requireReseller(user);
    }
    const key = user ? user.license_key : lic.key;
    const t = now();
    const chk = q.insCheckout.run(key, user?.id || null, p.code, t).lastInsertRowid;
    const notes = { license_key: key, product_code: p.code, checkout_id: String(chk), user_id: user ? String(user.id) : '' };
    let rzId, url;
    if (p.kind === 'subscription') {
      if (!p.razorpay_plan_id) throw new AppError('plan_not_configured', 503);
      const sub = await rz.createSubscription({ planId: p.razorpay_plan_id, totalCount: p.interval_label === 'year' ? 10 : 120, notes });
      rzId = sub.id; url = sub.short_url;
      q.upsertSub.run({ id: sub.id, license_key: key, product_code: p.code, status: sub.status || 'created', current_end: null, t });
    } else {
      const link = await rz.createPaymentLink({
        amount: p.price_paise, currency: p.currency, description: `MeAPI DM – ${p.name}`,
        notes, referenceId: `chk_${chk}_${t}`, callbackUrl: publicUrl ? `${publicUrl}/paid` : null,
      });
      rzId = link.id; url = link.short_url;
    }
    q.updCheckout.run(rzId, url, chk);
    return { url, id: rzId };
  }

  function applyWebhook(evt, eventId) {
    const t = now();
    if (eventId && q.seenWebhook.run(eventId, evt.event, t).changes === 0) return 'duplicate';
    const p = evt.payload || {};
    switch (evt.event) {
      case 'subscription.authenticated':
      case 'subscription.activated':
      case 'subscription.charged':
      case 'subscription.resumed': {
        const sub = p.subscription?.entity;
        if (!sub) return 'ignored';
        const known = q.subById.get(sub.id);
        const key = sub.notes?.license_key || known?.license_key;
        if (!key || !q.getLicense.get(key)) return 'unknown_license';
        const productCode = sub.notes?.product_code || known?.product_code || null;
        const currentEnd = sub.current_end ? sub.current_end * 1000 : null;
        q.upsertSub.run({ id: sub.id, license_key: key, product_code: productCode, status: sub.status || evt.event.split('.')[1], current_end: currentEnd, t });
        if ((evt.event === 'subscription.charged' || evt.event === 'subscription.activated') && currentEnd) {
          grant(key, 'pro', 'razorpay_sub', sub.id, productCode, 0, { endsAt: currentEnd + SUB_GRACE_MS });
        }
        const pay = p.payment?.entity;
        if (evt.event === 'subscription.charged' && pay) {
          const u = q.userByKey.get(key);
          q.insPayment.run(key, u?.id || null, productCode, 'razorpay', pay.id, pay.amount, pay.currency, evt.event, t);
        }
        return 'subscription_' + (sub.status || 'updated');
      }
      case 'subscription.pending':
      case 'subscription.halted':
      case 'subscription.cancelled':
      case 'subscription.completed':
      case 'subscription.paused': {
        const sub = p.subscription?.entity;
        if (!sub) return 'ignored';
        const known = q.subById.get(sub.id);
        if (!known) return 'unknown_subscription';
        q.upsertSub.run({ id: sub.id, license_key: known.license_key, product_code: known.product_code, status: sub.status || evt.event.split('.')[1], current_end: sub.current_end ? sub.current_end * 1000 : null, t });
        return 'subscription_' + (sub.status || 'updated');
      }
      case 'payment_link.paid': {
        const link = p.payment_link?.entity;
        if (!link) return 'ignored';
        const key = link.notes?.license_key;
        const product = q.product.get(link.notes?.product_code || '');
        if (!key || !q.getLicense.get(key)) return 'unknown_license';
        if (!product) return 'unknown_product';
        const user = link.notes?.user_id ? q.userById.get(Number(link.notes.user_id)) : q.userByKey.get(key);
        fulfil({ user, licenseKey: key, product, source: 'razorpay_link', ref: link.id });
        const pay = p.payment?.entity;
        q.insPayment.run(key, user?.id || null, product.code, 'razorpay', pay?.id || link.id, pay?.amount || link.amount_paid || link.amount, pay?.currency || link.currency, evt.event, t);
        return product.kind === 'credits' ? 'credits_added' : 'pass_granted';
      }
      default:
        return 'ignored';
    }
  }

  // ---------------- manual payments (UPI / PayPal / bank) ----------------
  const METHODS = ['upi', 'paypal', 'bank'];
  function paymentMethods() {
    const m = [];
    if (setting('pay_razorpay') === '1') m.push('razorpay');
    if (setting('pay_upi') === '1' && setting('upi_id')) m.push('upi');
    if (setting('pay_paypal') === '1' && (setting('paypal_link') || setting('paypal_email'))) m.push('paypal');
    if (setting('pay_bank') === '1' && setting('bank_details')) m.push('bank');
    return m;
  }

  function createManualPayment(user, productCode, method) {
    if (!METHODS.includes(method) || !paymentMethods().includes(method)) throw new AppError('method_unavailable');
    const p = getProduct(productCode);
    if (p.kind === 'credits') requireReseller(user);
    let amount = p.price_paise, currency = p.currency;
    if (method === 'paypal') {
      if (!p.price_usd_cents) throw new AppError('paypal_not_for_product');
      amount = p.price_usd_cents; currency = 'USD';
    }
    // Reuse an unfinished one for the same product+method instead of piling up rows.
    const open = db.prepare("SELECT * FROM manual_payments WHERE user_id = ? AND product_code = ? AND method = ? AND status = 'awaiting' ORDER BY id DESC LIMIT 1").get(user.id, p.code, method);
    const id = open ? open.id : q.insMp.run(user.id, p.code, method, amount, currency, now()).lastInsertRowid;
    if (open && (open.amount !== amount || open.currency !== currency)) db.prepare('UPDATE manual_payments SET amount = ?, currency = ? WHERE id = ?').run(amount, currency, id);
    return manualInstructions(q.mpById.get(id), p);
  }

  function manualInstructions(mp, p = q.product.get(mp.product_code)) {
    const base = { id: mp.id, method: mp.method, status: mp.status, amount: formatPrice(mp.amount, mp.currency), amountMinor: mp.amount, currency: mp.currency,
      product: p ? { code: p.code, name: p.name } : { code: mp.product_code, name: mp.product_code }, note: `MDM${mp.id}` };
    if (mp.method === 'upi') {
      const upi = setting('upi_id'), pn = setting('upi_name') || 'MeAPI';
      const uri = `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(pn)}&am=${(mp.amount / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent('MDM' + mp.id)}`;
      return { ...base, upiId: upi, upiName: pn, upiUri: uri };
    }
    if (mp.method === 'paypal') {
      let link = setting('paypal_link');
      if (link && /paypal\.me\//i.test(link)) link = `${link.replace(/\/+$/, '')}/${(mp.amount / 100).toFixed(2)}USD`;
      return { ...base, paypalLink: link || null, paypalEmail: setting('paypal_email') || null };
    }
    return { ...base, bankDetails: setting('bank_details') };
  }

  function submitManualPayment(user, id, { reference, note, proofFile }) {
    const mp = q.mpById.get(id);
    if (!mp || mp.user_id !== user.id) throw new AppError('not_found', 404);
    if (!['awaiting', 'rejected'].includes(mp.status)) throw new AppError('already_submitted', 409);
    reference = String(reference || '').trim().replace(/\s+/g, '');
    if (reference.length < 6 || reference.length > 64) throw new AppError('bad_reference');
    try {
      db.prepare("UPDATE manual_payments SET reference = ?, user_note = ?, proof_file = COALESCE(?, proof_file), status = 'pending', submitted_at = ?, admin_note = NULL WHERE id = ?")
        .run(reference, String(note || '').slice(0, 500) || null, proofFile || null, now(), id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new AppError('reference_used', 409);
      throw e;
    }
    return q.mpById.get(id);
  }

  function cancelManualPayment(user, id) {
    const mp = q.mpById.get(id);
    if (!mp || mp.user_id !== user.id) throw new AppError('not_found', 404);
    if (mp.status !== 'awaiting') throw new AppError('cannot_cancel', 409);
    db.prepare("UPDATE manual_payments SET status = 'cancelled' WHERE id = ?").run(id);
  }

  function decideManualPayment(adminId, id, approve, adminNote) {
    return tx(() => {
      const mp = q.mpById.get(id);
      if (!mp) throw new AppError('not_found', 404);
      if (mp.status !== 'pending') throw new AppError('not_pending', 409);
      const t = now();
      if (!approve) {
        db.prepare("UPDATE manual_payments SET status = 'rejected', admin_note = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(String(adminNote || '').slice(0, 300) || null, adminId, t, id);
        return { status: 'rejected' };
      }
      const user = q.userById.get(mp.user_id);
      const product = q.product.get(mp.product_code);
      if (!user || !product) throw new AppError('missing_user_or_product', 409);
      const result = fulfil({ user, product, source: 'manual', ref: `mp${mp.id}` });
      db.prepare("UPDATE manual_payments SET status = 'approved', admin_note = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(String(adminNote || '').slice(0, 300) || null, adminId, t, id);
      q.insPayment.run(user.license_key, user.id, product.code, mp.method, `${mp.method}:${mp.reference}`, mp.currency === 'INR' ? mp.amount : null, mp.currency, 'manual.approved', t);
      return { status: 'approved', ...result };
    });
  }

  // ---------------- notices / telemetry ----------------
  function notice({ version, lang }) {
    const t = now();
    for (const n of q.notices.all(t, t)) {
      if (n.lang && lang && n.lang !== lang) continue;
      if (n.min_version && version && cmpVersion(version, n.min_version) < 0) continue;
      if (n.max_version && version && cmpVersion(version, n.max_version) > 0) continue;
      return { id: n.id, title: n.title, body: n.body, linkUrl: n.link_url, linkLabel: n.link_label, level: n.level };
    }
    return null;
  }
  const EVENT_NAME = /^[a-z][a-z0-9_]{1,48}$/;
  function track(key, events, version) {
    const t = now();
    let n = 0;
    tx(() => {
      for (const e of (Array.isArray(events) ? events : []).slice(0, 25)) {
        if (!e || !EVENT_NAME.test(e.name)) continue;
        let props = null;
        try { props = e.props ? JSON.stringify(e.props).slice(0, 2000) : null; } catch (_) {}
        q.insEvent.run(key || null, e.name, props, version || null, t);
        n++;
      }
    });
    return n;
  }

  return {
    issue, auth, entitlement, entitlementForKey, reserve, release, grant, listProducts, getProduct, productView, setting, intSetting,
    userView, getUser, createUser, login, attachBrowser, linkGoogle, changePassword, setPassword, updateProfile,
    addCredits, resellerCreateCustomer, resellerActivate, ownCustomer, requireReseller, fulfil,
    checkout, applyWebhook, paymentMethods, createManualPayment, manualInstructions, submitManualPayment, cancelManualPayment, decideManualPayment,
    notice, track,
  };
}

module.exports = { createService, todayUTC, cmpVersion, formatPrice, AppError, DAY_MS, KEY_RE };
