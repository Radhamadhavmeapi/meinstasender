// Instagram access from the app page: session cookies, transport bridge, user lookup, follower lists.
// Every failure is an Error with .layer and (when known) .status so policy.classify() can sort it.
(() => {
  const U = MDM.u;
  const APP_ID = '936619743392459';
  const ASBD_ID = '198387';
  const WWW = 'https://www.instagram.com';
  const API = 'https://i.instagram.com/api/v1';

  const err = (layer, message, extra = {}) => Object.assign(new Error(message), { layer }, extra);
  const headers = (csrf) => ({ 'x-ig-app-id': APP_ID, 'x-asbd-id': ASBD_ID, 'x-csrftoken': csrf || '', 'x-requested-with': 'XMLHttpRequest' });

  function bg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, layer: 'bridge', error: chrome.runtime.lastError.message });
        resolve(r || { ok: false, layer: 'bridge', error: 'no_response' });
      });
    });
  }
  const transport = (msg) => bg({ type: 'transport', msg });

  const cookie = (name) => new Promise((resolve) => {
    chrome.cookies.get({ url: WWW + '/', name }, (c) => resolve(chrome.runtime.lastError ? null : c ? c.value : null));
  });

  // ---- session ----
  const ACCOUNTS_KEY = 'igAccounts'; // { [viewerId]: { username, fullName, pic, seenAt } }

  async function knownAccounts() { return (await U.store.get(ACCOUNTS_KEY, {})) || {}; }

  async function getSession({ refreshMe = false } = {}) {
    const [csrf, viewerId, sid] = await Promise.all([cookie('csrftoken'), cookie('ds_user_id'), cookie('sessionid')]);
    if (!csrf || !viewerId || !sid) return { ok: false, reason: 'not_logged_in' };
    const accounts = await knownAccounts();
    let acct = accounts[viewerId];
    if (!acct || refreshMe || Date.now() - (acct.seenAt || 0) > 24 * 3600 * 1000) {
      const r = await transport({ type: 'me' });
      if (r.ok && r.username) {
        acct = { username: r.username, fullName: r.fullName || '', pic: r.profilePicUrl || null, seenAt: Date.now() };
        accounts[viewerId] = acct;
        await U.store.set(ACCOUNTS_KEY, accounts);
      }
    }
    return { ok: true, csrf, viewerId, username: acct?.username || null, fullName: acct?.fullName || '', pic: acct?.pic || null };
  }

  // ---- user lookup ----
  function meta(html, prop) {
    const tag = (html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]*>`, 'i')) || [])[0];
    const c = tag && tag.match(/content="([^"]*)"/i);
    if (!c) return null;
    const ta = document.createElement('textarea');
    ta.innerHTML = c[1];
    return ta.value;
  }

  // Primary: the public profile page. Only trust the id when og:url names the same username,
  // otherwise a redirect could make us message the wrong person.
  async function resolveViaPage(username) {
    let res;
    try { res = await fetch(`${WWW}/${encodeURIComponent(username)}/`, { credentials: 'include' }); } catch (_) { return null; }
    if ([401, 403, 429].includes(res.status)) throw err('lookup', `http_${res.status}`, { status: res.status });
    if (res.redirected && /\/accounts\/login|\/challenge\//.test(res.url || '')) throw err('lookup', 'login_required', { status: 401 });
    if (!res.ok) return null;
    const html = await res.text().catch(() => '');
    if (/<html[^>]*class="[^"]*\bnot-logged-in\b/.test(html.slice(0, 3000))) throw err('lookup', 'login_required', { status: 401 });
    const ids = new Set(Array.from(html.matchAll(/"page_id":"profilePage_(\d+)"/g), (m) => m[1]));
    const hasOg = /<meta[^>]+property="og:/i.test(html);
    if (ids.size !== 1) {
      if (!ids.size && !hasOg && html.includes('PolarisErrorRoot')) throw err('lookup', 'user_not_found', { status: 404 });
      return null;
    }
    const id = [...ids][0];
    const pageUser = (((meta(html, 'og:url') || '').match(/instagram\.com\/([A-Za-z0-9._]+)\/?/) || [])[1] || '').toLowerCase();
    if (pageUser !== username) return null;
    const title = meta(html, 'og:title') || '';
    const nm = title.match(new RegExp(`^([\\s\\S]*?)\\s*\\(@${pageUser.replace(/\./g, '\\.')}\\)`, 'i'));
    return { userId: id, username: pageUser, fullName: nm ? nm[1].trim() : '', pic: meta(html, 'og:image'), via: 'page' };
  }

  async function resolveViaApi(username, csrf) {
    let res;
    try {
      res = await fetch(`${API}/users/web_profile_info/?username=${encodeURIComponent(username)}`, { credentials: 'include', headers: headers(csrf) });
    } catch (e) { throw err('lookup', 'network: ' + e.message); }
    const text = await res.text().catch(() => '');
    let j = null;
    try { j = JSON.parse(text); } catch (_) {}
    if (res.status === 404) throw err('lookup', 'user_not_found', { status: 404 });
    if (!res.ok) throw err('lookup', `http_${res.status}`, { status: res.status, body: text.slice(0, 300) });
    const u = j?.data?.user;
    if (!u || !(u.id || u.pk)) throw err('lookup', 'id_missing', { status: res.status });
    return { userId: String(u.id || u.pk), username: u.username, fullName: u.full_name || '', pic: u.profile_pic_url || null, isPrivate: !!u.is_private, via: 'api' };
  }

  const lookupCache = new Map();
  async function resolveUser(raw, csrf) {
    const username = U.normalizeUsername(raw);
    if (!U.USERNAME_RE.test(username)) throw err('lookup', 'user_not_found', { status: 404 });
    if (lookupCache.has(username)) return lookupCache.get(username);
    const hit = (await resolveViaPage(username)) || (await resolveViaApi(username, csrf));
    lookupCache.set(username, hit);
    return hit;
  }

  // ---- sending ----
  async function createThread(userId) {
    const r = await transport({ type: 'create_thread', userId: String(userId) });
    if (!r.ok) throw err(r.layer || 'thread', r.error || 'thread_failed', { status: r.status, body: r.body });
    return r.threadId;
  }

  async function sendText(viewerId, threadId, text) {
    const r = await transport({ type: 'mqtt_send', viewerId: String(viewerId), threadId: String(threadId), text });
    if (!r.ok) throw err(r.layer || 'mqtt', r.error || 'send_failed', { published: !!r.published, raw: r.raw });
    return r.raw;
  }

  const mqttHandshake = () => transport({ type: 'mqtt_send', viewerId: '0', threadId: '0', text: '', handshakeOnly: true });

  // ---- followers / following ----
  // Pages with a cursor (next_max_id) or, when Instagram omits it on a full page, with an offset.
  // Stops on an empty page so a repeated page can never loop forever.
  async function enumerate({ source, target, max, csrf, signal, onProgress, exclude }) {
    const t = await resolveUser(target, csrf);
    const path = source === 'following' ? 'following' : 'followers';
    const extra = source === 'following' ? '' : '&search_surface=follow_list_page';
    const out = [];
    const seen = new Set();
    let maxId = '';
    let pages = 0;
    let skipped = 0;
    while (out.length < max && !signal?.aborted) {
      const url = `${API}/friendships/${t.userId}/${path}/?count=50${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}${extra}`;
      let res;
      try { res = await fetch(url, { credentials: 'include', headers: headers(csrf) }); } catch (e) {
        throw err('audience', 'network: ' + e.message, { partial: out });
      }
      const text = await res.text().catch(() => '');
      let j = null;
      try { j = JSON.parse(text); } catch (_) {}
      if (res.status === 429) throw err('audience', 'rate_limited', { status: 429, partial: out });
      if (res.status === 401 || res.status === 403) throw err('audience', j?.message === 'Not authorized to view user' ? 'private' : `http_${res.status}`, { status: res.status, partial: out });
      if (!res.ok || !j || !Array.isArray(j.users)) throw err('audience', `blocked_${res.status}`, { status: res.status, partial: out, body: text.slice(0, 200) });
      pages++;
      let fresh = 0;
      for (const u of j.users) {
        const id = String(u.pk || u.pk_id || u.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        fresh++;
        if (exclude && exclude(u)) { skipped++; continue; }
        out.push({ userId: id, username: String(u.username || '').toLowerCase(), fullName: u.full_name || '', pic: u.profile_pic_url || null, isPrivate: !!u.is_private });
        if (out.length >= max) break;
      }
      onProgress?.(out.length, { pages, skipped });
      if (fresh === 0) break;
      if (j.next_max_id) maxId = String(j.next_max_id);
      else if (j.users.length >= 25) maxId = String(seen.size); // offset paging
      else break;
      // Be gentle: ~1.5 s between pages, a longer rest every 10 pages.
      await U.sleep(pages % 10 === 0 ? U.jitter(8000, 15000) : U.jitter(1200, 1900), signal);
    }
    return { target: t, users: out, skipped, limited: out.length < max && pages > 0 };
  }

  // Profile pictures come from Instagram's CDN; turn them into blob: URLs so the CSP can stay tight.
  const picCache = new Map();
  async function picUrl(src) {
    if (!src) return null;
    if (picCache.has(src)) return picCache.get(src);
    const p = fetch(src).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null);
    picCache.set(src, p);
    return p;
  }

  MDM.ig = {
    getSession, knownAccounts, resolveUser, createThread, sendText, mqttHandshake, enumerate, picUrl,
    transportEnsure: () => bg({ type: 'transport_ensure' }),
    transportPeek: () => bg({ type: 'transport_peek' }),
    transportReopen: () => bg({ type: 'transport_reopen' }),
    focusInstagram: () => bg({ type: 'focus_ig' }),
    reloadTransport: () => transport({ type: 'reload' }),
    clearLookupCache: () => lookupCache.clear(),
  };
})();
