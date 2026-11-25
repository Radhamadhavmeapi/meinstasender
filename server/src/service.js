// Business logic: licenses, entitlement, usage, checkout, webhook effects.
const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const SUB_GRACE_MS = 6 * 60 * 60 * 1000; // keep PRO a few hours past current_end while Razorpay retries

function todayUTC(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function newKey() {
  return 'mdm_' + crypto.randomBytes(24).toString('hex');
}

function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function formatPrice(paise, currency) {
  const amount = paise / 100;
  const sym = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency + ' ';
  const opts = Number.isInteger(amount) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return sym + amount.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', opts);
}

function createService(db, { now = () => Date.now() } = {}) {
  const q = {
    getLicense: db.prepare('SELECT * FROM licenses WHERE key = ?'),
    insLicense: db.prepare('INSERT INTO licenses(key, created_at, last_seen_at, created_ip, version) VALUES (?, ?, ?, ?, ?)'),
    touch: db.prepare('UPDATE licenses SET last_seen_at = ?, version = COALESCE(?, version) WHERE key = ?'),
    setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    activeEnts: db.prepare('SELECT * FROM entitlements WHERE license_key = ? AND revoked = 0 AND ends_at > ? AND starts_at <= ? ORDER BY ends_at DESC'),
    usage: db.prepare('SELECT count FROM usage WHERE license_key = ? AND day = ?'),
    usageUpsert: db.prepare(`INSERT INTO usage(license_key, day, count) VALUES (?, ?, ?)
      ON CONFLICT(license_key, day) DO UPDATE SET count = count + excluded.count`),
    usageDec: db.prepare('UPDATE usage SET count = MAX(0, count - ?) WHERE license_key = ? AND day = ?'),
    accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    accountBySub: db.prepare('SELECT * FROM accounts WHERE google_sub = ?'),
    accountByEmail: db.prepare('SELECT * FROM accounts WHERE email = ?'),
    insAccount: db.prepare('INSERT INTO accounts(email, google_sub, name, license_key, created_at) VALUES (?, ?, ?, ?, ?)'),
    linkLicense: db.prepare('UPDATE licenses SET account_id = ? WHERE key = ?'),
    product: db.prepare('SELECT * FROM products WHERE code = ?'),
    products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, code'),
    subByKey: db.prepare("SELECT * FROM subscriptions WHERE license_key = ? ORDER BY updated_at DESC LIMIT 1"),
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
    insPayment: db.prepare('INSERT INTO payments(license_key, product_code, razorpay_id, amount_paise, currency, event, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    insCheckout: db.prepare('INSERT INTO checkouts(license_key, product_code, created_at) VALUES (?, ?, ?)'),
    updCheckout: db.prepare('UPDATE checkouts SET razorpay_id = ?, url = ? WHERE id = ?'),
    seenWebhook: db.prepare('INSERT OR IGNORE INTO webhook_events(id, event, received_at) VALUES (?, ?, ?)'),
    notices: db.prepare(`SELECT * FROM notices WHERE active = 1
      AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY CASE level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC`),
    insEvent: db.prepare('INSERT INTO events(license_key, name, props, version, created_at) VALUES (?, ?, ?, ?, ?)'),
  };

  const setting = (k, dflt) => {
    const r = q.setting.get(k);
    return r ? r.value : dflt;
  };
  const intSetting = (k, dflt) => {
    const n = parseInt(setting(k, String(dflt)), 10);
    return Number.isFinite(n) ? n : dflt;
  };

  function productView(p) {
    let features = [];
    try { features = JSON.parse(p.features || '[]'); } catch (_) {}
    return {
      code: p.code, name: p.name, kind: p.kind,
      price: formatPrice(p.price_paise, p.currency), pricePaise: p.price_paise, currency: p.currency,
      interval: p.interval_label || null, durationHours: p.duration_hours || null, features,
      purchasable: p.kind === 'pass' ? true : !!p.razorpay_plan_id,
    };
  }

  function issue(ip, version) {
    const key = newKey();
    const t = now();
    q.insLicense.run(key, t, t, ip || null, version || null);
    return key;
  }

  // Returns the license row, or null. Updates last_seen.
  function auth(key, version) {
    if (typeof key !== 'string' || !/^mdm_[0-9a-f]{48}$/.test(key)) return null;
    const lic = q.getLicense.get(key);
    if (!lic) return null;
    q.touch.run(now(), version || null, key);
    return lic;
  }

  function usageToday(key) {
    return q.usage.get(key, todayUTC(now()))?.count || 0;
  }

  function entitlement(lic) {
    const t = now();
    const ents = q.activeEnts.all(lic.key, t, t);
    const paid = ents.length > 0;
    const pro = ents.find((e) => e.kind === 'pro');
    const top = pro || ents[0] || null;
    const account = lic.account_id ? q.accountById.get(lic.account_id) : null;
    const sub = q.subByKey.get(lic.key);
    const freeDailyLimit = intSetting('free_daily_limit', 10);
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
      freeDailyLimit,
      dailyCap: intSetting('pro_daily_cap', 100),
      banned: !!lic.banned,
      account: account ? { email: account.email, name: account.name || null } : null,
      subscription: sub ? { id: sub.id, status: sub.status, currentEnd: sub.current_end, product: sub.product_code } : null,
      passOffer,
      serverTime: t,
    };
  }

  // Reserve n sends before they go out. Free tier is capped server-side.
  function reserve(lic, n = 1) {
    n = Math.max(1, Math.min(10, parseInt(n, 10) || 1));
    if (lic.banned) return { ok: false, error: 'banned' };
    const ent = entitlement(lic);
    if (ent.tier === 'free' && ent.usageToday + n > ent.freeDailyLimit) {
      return { ok: false, error: 'free_limit', usageToday: ent.usageToday, freeDailyLimit: ent.freeDailyLimit };
    }
    q.usageUpsert.run(lic.key, todayUTC(now()), n);
    return { ok: true, usageToday: ent.usageToday + n, tier: ent.tier };
  }

  // Give back a reservation whose DM never left (lookup failed, network down, etc.).
  function release(lic, n = 1) {
    n = Math.max(1, Math.min(10, parseInt(n, 10) || 1));
    q.usageDec.run(n, lic.key, todayUTC(now()));
    return { ok: true, usageToday: usageToday(lic.key) };
  }

  function listProducts() {
    return q.products.all().map(productView);
  }

  async function checkout(lic, productCode, rz, publicUrl) {
    const p = q.product.get(String(productCode || ''));
    if (!p || !p.active) throw Object.assign(new Error('unknown_product'), { status: 404 });
    if (!rz) throw Object.assign(new Error('payments_not_configured'), { status: 503 });
    const t = now();
    const chk = q.insCheckout.run(lic.key, p.code, t).lastInsertRowid;
    const notes = { license_key: lic.key, product_code: p.code, checkout_id: String(chk) };
    let rzId, url;
    if (p.kind === 'subscription') {
      if (!p.razorpay_plan_id) throw Object.assign(new Error('plan_not_configured'), { status: 503 });
      const totalCount = p.interval_label === 'year' ? 10 : 120;
      const sub = await rz.createSubscription({ planId: p.razorpay_plan_id, totalCount, notes });
      rzId = sub.id; url = sub.short_url;
      q.upsertSub.run({ id: sub.id, license_key: lic.key, product_code: p.code, status: sub.status || 'created', current_end: null, t });
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

  function grant(key, kind, source, ref, productCode, durationMs, { endsAt } = {}) {
    const t = now();
    if (ref) {
      const existing = q.entByRef.get(source, ref);
      if (existing) {
        const target = endsAt || Math.max(existing.ends_at, t) + durationMs;
        q.extendEnt.run(target, existing.id);
        return existing.id;
      }
    }
    // A new pass stacks on top of an unexpired one of the same kind.
    let start = t;
    if (!endsAt) {
      const live = q.activeEnts.all(key, t, t).filter((e) => e.kind === kind);
      if (live.length) start = Math.max(...live.map((e) => e.ends_at));
    }
    const end = endsAt || start + durationMs;
    return q.insEnt.run(key, kind, source, ref || null, productCode || null, t, end, t).lastInsertRowid;
  }

  // Returns a short string describing what happened (for logs/tests).
  function applyWebhook(evt, eventId) {
    const t = now();
    if (eventId) {
      const r = q.seenWebhook.run(eventId, evt.event, t);
      if (r.changes === 0) return 'duplicate';
    }
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
        if (evt.event === 'subscription.charged' || (evt.event === 'subscription.activated' && currentEnd)) {
          if (currentEnd) grant(key, 'pro', 'razorpay_sub', sub.id, productCode, 0, { endsAt: currentEnd + SUB_GRACE_MS });
        }
        const pay = p.payment?.entity;
        if (evt.event === 'subscription.charged' && pay) {
          q.insPayment.run(key, productCode, pay.id, pay.amount, pay.currency, evt.event, t);
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
        // PRO stays until the already-paid period ends; nothing to revoke here.
        return 'subscription_' + (sub.status || 'updated');
      }
      case 'payment_link.paid': {
        const link = p.payment_link?.entity;
        if (!link) return 'ignored';
        const key = link.notes?.license_key;
        const product = q.product.get(link.notes?.product_code || '');
        if (!key || !q.getLicense.get(key)) return 'unknown_license';
        if (!product) return 'unknown_product';
        const hours = product.duration_hours || 24;
        grant(key, product.kind === 'subscription' ? 'pro' : 'pass', 'razorpay_link', link.id, product.code, hours * 3600 * 1000);
        const pay = p.payment?.entity;
        q.insPayment.run(key, product.code, pay?.id || link.id, pay?.amount || link.amount_paid || link.amount, pay?.currency || link.currency, evt.event, t);
        return 'pass_granted';
      }
      default:
        return 'ignored';
    }
  }

  // Google login. Returns the license key this browser should use from now on.
  function linkGoogle(lic, { sub, email, name }) {
    const t = now();
    let acct = q.accountBySub.get(sub) || q.accountByEmail.get(email);
    if (!acct) {
      const id = q.insAccount.run(email, sub, name || null, lic.key, t).lastInsertRowid;
      q.linkLicense.run(id, lic.key);
      return { key: lic.key, email, created: true };
    }
    if (acct.license_key !== lic.key) {
      // Carry anything this browser bought while logged out over to the account.
      const tx = db.transaction(() => {
        q.moveEnts.run(acct.license_key, lic.key, t);
        q.moveSubs.run(acct.license_key, lic.key);
      });
      tx();
    }
    return { key: acct.license_key, email: acct.email, created: false };
  }

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
    const tx = db.transaction(() => {
      for (const e of (Array.isArray(events) ? events : []).slice(0, 25)) {
        if (!e || !EVENT_NAME.test(e.name)) continue;
        let props = null;
        try { props = e.props ? JSON.stringify(e.props).slice(0, 2000) : null; } catch (_) {}
        q.insEvent.run(key || null, e.name, props, version || null, t);
        n++;
      }
    });
    tx();
    return n;
  }

  return { issue, auth, entitlement, reserve, release, listProducts, checkout, applyWebhook, linkGoogle, notice, track, grant, setting, productView };
}

module.exports = { createService, todayUTC, cmpVersion, formatPrice, DAY_MS };
