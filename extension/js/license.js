// Client for the MeAPI DM license server (server/ in this repo).
// Keys: licenseKey (current), licenseKeyAnon (this browser's own key, used when logged out),
//       licenseKeyHistory (last 5 replaced keys), tierCache, accountEmail.
(() => {
  const U = MDM.u;
  const C = MDM.config;
  const KEY = 'licenseKey', ANON = 'licenseKeyAnon', HIST = 'licenseKeyHistory', CACHE = 'tierCache';
  const KEY_RE = /^mdm_[0-9a-f]{48}$/;
  const TIMEOUT_MS = 10000;

  async function api(method, path, { body, key, auth = true } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const hdrs = { 'Content-Type': 'application/json', 'X-Client-Version': C.VERSION };
    if (auth) hdrs['X-License-Key'] = key || (await getKey()) || '';
    try {
      const r = await fetch(C.API_BASE + path, { method, headers: hdrs, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      let j = null;
      try { j = await r.json(); } catch (_) {}
      return { status: r.status, ok: r.ok, body: j || {} };
    } catch (e) {
      return { status: 0, ok: false, body: { error: 'network' }, network: true };
    } finally {
      clearTimeout(timer);
    }
  }

  const getKey = () => U.store.get(KEY, null);

  async function setKey(k) {
    const prev = await getKey();
    if (prev && prev !== k) {
      const hist = ((await U.store.get(HIST, [])) || []).filter((h) => h.key !== prev && h.key !== k);
      hist.unshift({ key: prev, at: Date.now() });
      await U.store.set(HIST, hist.slice(0, 5));
    }
    await U.store.set(KEY, k);
    await U.store.remove(CACHE);
  }

  // Makes sure this browser has a key. Called at boot.
  async function ensureKey() {
    let k = await getKey();
    if (k) return k;
    const r = await api('POST', '/v1/license/issue', { auth: false });
    if (r.ok && KEY_RE.test(r.body.key)) {
      await U.store.set(KEY, r.body.key);
      await U.store.set(ANON, r.body.key);
      MDM.track?.('license_issued');
      return r.body.key;
    }
    return null;
  }

  function offlineInfo(cache) {
    // Server unreachable: keep a recent cache for paid users, otherwise behave as free with a conservative limit.
    if (cache && Date.now() - cache.cachedAt < 6 * 3600 * 1000) return { ...cache, offline: true };
    return { tier: 'free', paidBy: null, paidUntil: null, usageToday: 0, freeDailyLimit: null, dailyCap: 100, account: null, passOffer: null, subscription: null, offline: true };
  }

  async function entitlement({ force = false } = {}) {
    const cache = await U.store.get(CACHE, null);
    if (!force && cache && Date.now() - cache.cachedAt < 60 * 1000) return cache;
    const r = await api('GET', '/v1/entitlement');
    if (r.status === 401) {
      // Key unknown on the server (e.g. DB reset) — drop it and get a new one.
      await U.store.remove([KEY, CACHE]);
      await ensureKey();
      const r2 = await api('GET', '/v1/entitlement');
      if (r2.ok) return save(r2.body);
      return offlineInfo(null);
    }
    if (!r.ok) return offlineInfo(cache);
    return save(r.body);
  }
  async function save(info) {
    const v = { ...info, cachedAt: Date.now() };
    await U.store.set(CACHE, v);
    return v;
  }

  // Before each DM: reserve 1 send. Returns {ok} or {ok:false, error:'free_limit'|'banned'|'network'}.
  async function reserve() {
    const r = await api('POST', '/v1/usage/reserve', { body: { n: 1 } });
    if (r.ok) {
      const c = await U.store.get(CACHE, null);
      if (c) await U.store.set(CACHE, { ...c, usageToday: r.body.usageToday });
      return { ok: true, usageToday: r.body.usageToday };
    }
    if (r.network) return { ok: false, error: 'network' };
    return { ok: false, error: r.body.error || `http_${r.status}`, ...r.body };
  }
  // After a failed send that never left Instagram's side.
  async function release() {
    const r = await api('POST', '/v1/usage/release', { body: { n: 1 } });
    if (r.ok) {
      const c = await U.store.get(CACHE, null);
      if (c) await U.store.set(CACHE, { ...c, usageToday: r.body.usageToday });
    }
  }

  async function products() {
    const r = await api('GET', '/v1/products', { auth: false });
    if (!r.ok) throw new Error(r.network ? 'network' : r.body.error || 'load_failed');
    return r.body.products || [];
  }

  async function checkout(productCode) {
    const r = await api('POST', '/v1/checkout', { body: { productCode } });
    if (!r.ok || !r.body.url) throw new Error(r.body.error || 'checkout_failed');
    MDM.track?.('checkout_open', { product: productCode });
    chrome.tabs.create({ url: r.body.url });
    return r.body.url;
  }

  // Paste a key from another device.
  async function applyKey(k) {
    k = String(k || '').trim();
    if (!KEY_RE.test(k)) throw new Error('invalid_format');
    const r = await api('GET', '/v1/entitlement', { key: k });
    if (r.status === 401) throw new Error('not_found');
    if (!r.ok) throw new Error('network');
    await setKey(k);
    return save(r.body);
  }

  async function history() { return (await U.store.get(HIST, [])) || []; }

  // ---- Google sign-in (optional) ----
  async function signInWithGoogle() {
    const granted = await chrome.permissions.request({ permissions: ['identity'] });
    if (!granted) throw new Error('permission_denied');
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (t) => {
        if (chrome.runtime.lastError || !t) return reject(new Error(chrome.runtime.lastError?.message || 'no_token'));
        resolve(typeof t === 'string' ? t : t.token);
      });
    });
    const r = await api('POST', '/v1/account/google', { body: { accessToken: token } });
    if (!r.ok) throw new Error(r.body.error || 'signin_failed');
    MDM.track?.('google_signin');
    return afterSignIn(r.body);
  }

  // ---- email + password (same account as the website) ----
  async function signInWithEmail(email, password) {
    const r = await api('POST', '/v1/account/login', { body: { email, password } });
    if (!r.ok) throw new Error(r.network ? 'network' : r.status === 429 ? 'too_many' : r.body.error || 'signin_failed');
    MDM.track?.('email_signin');
    return afterSignIn(r.body);
  }
  async function registerWithEmail({ name, email, password }) {
    const r = await api('POST', '/v1/account/register', { body: { name, email, password } });
    if (!r.ok) throw new Error(r.network ? 'network' : r.status === 429 ? 'too_many' : r.body.error || 'signup_failed');
    MDM.track?.('email_signup');
    return afterSignIn(r.body);
  }

  async function afterSignIn(body) {
    const cur = await getKey();
    const anon = await U.store.get(ANON, null);
    if (!anon && cur) await U.store.set(ANON, cur);
    if (body.key && body.key !== cur) await setKey(body.key);
    await U.store.set('accountEmail', body.email);
    return entitlement({ force: true });
  }

  async function signOut() {
    const anon = await U.store.get(ANON, null);
    await U.store.remove('accountEmail');
    try {
      const t = await new Promise((res) => chrome.identity?.getAuthToken?.({ interactive: false }, (x) => res(x)));
      const tok = typeof t === 'string' ? t : t?.token;
      if (tok) chrome.identity.removeCachedAuthToken({ token: tok }, () => {});
    } catch (_) {}
    const cur = await getKey();
    // If this browser's own key became the account key (signed up here), start a fresh browser key.
    if (anon && anon !== cur) await setKey(anon);
    else { await U.store.remove([KEY, ANON, CACHE]); await ensureKey(); }
    return entitlement({ force: true });
  }

  // ---- notices ----
  async function notice() {
    const r = await api('GET', `/v1/notice?v=${encodeURIComponent(C.VERSION)}&lang=${encodeURIComponent(MDM.i18n.lang())}`, { auth: false });
    return r.ok ? r.body.notice : null;
  }

  // ---- telemetry (batched, fire-and-forget) ----
  const queue = [];
  let timer = null;
  function track(name, props) {
    queue.push({ name, props: props || undefined });
    if (queue.length >= 20) flush();
    else if (!timer) timer = setTimeout(flush, 15000);
  }
  async function flush() {
    clearTimeout(timer); timer = null;
    if (!queue.length) return;
    const events = queue.splice(0, 25);
    const k = await getKey();
    try {
      fetch(C.API_BASE + '/v1/track', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Client-Version': C.VERSION, ...(k ? { 'X-License-Key': k } : {}) },
        body: JSON.stringify({ events }),
      }).catch(() => {});
    } catch (_) {}
  }
  addEventListener('pagehide', flush);

  async function serverReachable() {
    const r = await api('GET', '/health', { auth: false });
    return r.ok;
  }

  MDM.track = track;
  MDM.license = { getKey, ensureKey, entitlement, reserve, release, products, checkout, applyKey, history, signInWithGoogle, signInWithEmail, registerWithEmail, signOut, notice, serverReachable, KEY_RE };
})();
