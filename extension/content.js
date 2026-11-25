// Runs on www.instagram.com. Acts only on messages from this extension (the background relays them to the
// dedicated transport tab). Three jobs that Instagram only allows from its own origin:
//   - mdm_ping       readiness + login check
//   - me             current account's username / avatar
//   - create_thread  open (or reuse) the DM thread with a user  (needs the page's fb_dtsg token)
//   - mqtt_send      publish a text message over Instagram's chat WebSocket (edge-chat MQTT)
(() => {
  if (window.__mdmContentInit) return;
  window.__mdmContentInit = true;

  const APP_ID = '936619743392459';
  const ASBD_ID = '198387';

  const rand53 = () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2))), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
  const deviceId = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
  const cookie = (name) => (document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')) || [])[1] || null;

  function igHeaders(extra = {}) {
    return {
      'x-ig-app-id': APP_ID,
      'x-asbd-id': ASBD_ID,
      'x-csrftoken': cookie('csrftoken') || '',
      'x-requested-with': 'XMLHttpRequest',
      ...extra,
    };
  }

  // ---------- fb_dtsg token (needed by create_group_thread) ----------
  const Dtsg = (() => {
    const RE = /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/;
    const MAX_AGE = 12 * 3600 * 1000;
    let cached = null;
    const parse = (s) => (String(s || '').match(RE) || [])[1] || null;
    function fromDom() {
      for (const s of document.querySelectorAll('script[type="application/json"]')) {
        const t = parse(s.textContent);
        if (t) return t;
      }
      return null;
    }
    async function fromNetwork() {
      try {
        const r = await fetch('/', { credentials: 'include' });
        return r.ok ? parse(await r.text()) : null;
      } catch (_) { return null; }
    }
    async function get(fresh = false) {
      if (!fresh && !cached) {
        const t = fromDom();
        if (t) cached = { t, at: performance.timeOrigin || Date.now() };
      }
      if (!fresh && cached && Date.now() - cached.at < MAX_AGE) return cached.t;
      const t = await fromNetwork();
      if (t) cached = { t, at: Date.now() };
      return t || (cached && cached.t) || null;
    }
    const jazoest = (t) => '2' + Array.from(t).reduce((n, c) => n + c.charCodeAt(0), 0);
    return { get, jazoest };
  })();

  async function createThread(userId) {
    if (!/^\d+$/.test(String(userId || ''))) return { ok: false, error: 'id_missing' };
    const post = async (tok) => {
      const body = new URLSearchParams({ recipient_users: `["${userId}"]`, fb_dtsg: tok, jazoest: Dtsg.jazoest(tok) });
      const r = await fetch('/api/v1/direct_v2/create_group_thread/', {
        method: 'POST', credentials: 'include',
        headers: igHeaders({ 'content-type': 'application/x-www-form-urlencoded', 'x-instagram-ajax': '1' }),
        body: body.toString(),
      });
      return { status: r.status, text: await r.text().catch(() => '') };
    };
    try {
      let tok = await Dtsg.get();
      if (!tok) return { ok: false, error: 'dtsg_missing' };
      let r = await post(tok);
      // 2170001 = token rejected → fetch a fresh one once.
      if (r.status === 400 && /"error_code":\s*2170001/.test(r.text)) {
        const fresh = await Dtsg.get(true);
        if (fresh && fresh !== tok) { tok = fresh; r = await post(tok); }
      }
      let json = null;
      try { json = JSON.parse(r.text); } catch (_) {}
      const threadId = json && (json.thread_id || (json.thread && json.thread.thread_id));
      if (r.status >= 200 && r.status < 300 && threadId) return { ok: true, threadId: String(threadId), status: r.status };
      return { ok: false, status: r.status, error: (json && (json.message || json.error_type)) || `http_${r.status}`, body: r.text.slice(0, 400) };
    } catch (e) {
      return { ok: false, error: 'network: ' + (e.message || e) };
    }
  }

  // ---------- MQTT over WebSocket ----------
  // Instagram's edge-chat rejects a Sec-WebSocket-Protocol header, which Paho always sets; we strip it while connecting.
  function withPlainWebSocket(fn) {
    const Orig = window.WebSocket;
    function Plain(url) { return new Orig(url); }
    Plain.prototype = Orig.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { Plain[k] = Orig[k]; });
    window.WebSocket = Plain;
    const restore = () => { if (window.WebSocket === Plain) window.WebSocket = Orig; };
    try { return fn(restore); } catch (e) { restore(); throw e; }
  }

  function mqttSend({ viewerId, threadId, text, handshakeOnly = false, timeoutMs = 15000 }) {
    return new Promise((resolve) => {
      const P = window.Paho;
      if (!P || !P.Client) return resolve({ ok: false, layer: 'mqtt_lib', error: 'paho_missing', published: false });
      const client = new P.Client('edge-chat.instagram.com', 443, '/chat', 'mqttwsclient');
      const ctx = rand53();
      const payload = {
        action: 'send_item', item_type: 'text', text,
        thread_id: String(threadId), client_context: ctx, mutation_token: ctx - 100000,
        device_id: deviceId().toUpperCase(),
      };
      const userName = JSON.stringify({
        u: viewerId, s: rand53(), cp: 1, ecp: 0, chat_on: true, fg: true, d: deviceId(), ct: 'cookie_auth',
        mqtt_sid: '', aid: Number(APP_ID), st: [], pm: [], dc: '', no_auto_fg: true,
        asi: { 'Accept-Language': navigator.language || 'en' }, a: navigator.userAgent,
      });
      let settled = false, published = false, restoreWs = () => {};
      const finish = (out) => {
        if (settled) return;
        settled = true;
        try { restoreWs(); } catch (_) {}
        try { client.disconnect(); } catch (_) {}
        resolve({ published, ...out });
      };
      client.onMessageArrived = (m) => {
        let j = null;
        try { j = JSON.parse(m.payloadString); } catch (_) {}
        if (!j) return finish({ ok: false, layer: 'mqtt_publish', error: 'unparseable_reply' });
        const ok = j.status_code === 200 || j.status_code === '200' || j.status === 'ok';
        const msg = (j.payload && (j.payload.client_facing_error_message || j.payload.message)) || j.message || '';
        finish(ok ? { ok: true, raw: j } : { ok: false, layer: 'mqtt_publish', error: msg || `status_${j.status_code}`, raw: j });
      };
      client.onConnectionLost = () => finish({ ok: false, layer: 'mqtt_lost', error: 'connection_lost' });
      try {
        withPlainWebSocket((restore) => {
          restoreWs = restore;
          client.connect({
            mqttVersion: 3, useSSL: true, keepAliveInterval: 10, userName, timeout: Math.ceil(timeoutMs / 1000),
            onSuccess: () => {
              restore();
              if (handshakeOnly) return finish({ ok: true, raw: { handshake: true } });
              const msg = new P.Message(JSON.stringify(payload));
              msg.destinationName = '/ig_send_message';
              msg.qos = 1;
              client.send(msg);
              published = true;
            },
            onFailure: (e) => finish({ ok: false, layer: 'mqtt_handshake', error: (e && e.errorMessage) || 'handshake_failed' }),
          });
        });
      } catch (e) {
        finish({ ok: false, layer: 'mqtt_handshake', error: String(e.message || e) });
      }
      setTimeout(() => finish({ ok: false, layer: 'mqtt_timeout', error: 'timeout' }), timeoutMs);
    });
  }

  // ---------- current account ----------
  async function me() {
    const id = cookie('ds_user_id');
    if (!id) return { ok: false, error: 'not_logged_in' };
    const tryJson = async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include', headers: igHeaders() });
        return r.ok ? await r.json() : null;
      } catch (_) { return null; }
    };
    let u = (await tryJson('/api/v1/accounts/current_user/?edit=true'))?.user;
    if (!u) u = (await tryJson(`/api/v1/users/${id}/info/`))?.user;
    if (!u) return { ok: false, error: 'me_unavailable', viewerId: id };
    return { ok: true, viewerId: String(u.pk || u.pk_id || id), username: u.username, fullName: u.full_name || '', profilePicUrl: u.profile_pic_url || null };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const handle = async () => {
      switch (msg && msg.type) {
        case 'mdm_ping': return { ok: true, loggedIn: !!cookie('ds_user_id'), viewerId: cookie('ds_user_id'), url: location.href };
        case 'me': return me();
        case 'create_thread': return createThread(msg.userId);
        case 'mqtt_send': return mqttSend(msg);
        case 'reload': setTimeout(() => location.reload(), 50); return { ok: true };
        default: return { ok: false, error: 'unknown' };
      }
    };
    handle().then(sendResponse, (e) => sendResponse({ ok: false, layer: 'bridge', error: String(e && e.message || e) }));
    return true;
  });
})();
