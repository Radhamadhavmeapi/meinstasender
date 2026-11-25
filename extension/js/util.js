// Small shared helpers + chrome.storage wrapper + toasts.
(() => {
  const U = {};

  U.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  U.$ = (sel, root = document) => root.querySelector(sel);
  U.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  U.h = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  // Abortable sleep: resolves early when the signal aborts.
  U.sleep = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const id = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener?.('abort', () => { clearTimeout(id); resolve(); }, { once: true });
  });

  U.jitter = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min));
  U.uuid = () => crypto.randomUUID();
  U.todayUTC = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
  U.rand53 = () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  U.fmtDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
  };
  U.fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—');
  U.fmtDate = (t) => (t ? new Date(t).toLocaleDateString() : '—');

  U.download = (filename, text, type = 'application/json') => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  U.copy = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
  };

  // Instagram usernames: letters, digits, dot, underscore; up to 30 chars.
  U.USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
  U.normalizeUsername = (raw) => {
    let s = String(raw == null ? '' : raw).replace(/[​-‍⁠﻿]/g, '').trim();
    const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#\s]+)/i);
    if (m) s = m[1];
    return s.replace(/^@+/, '').toLowerCase();
  };

  // ---- storage ----
  const area = chrome.storage.local;
  U.store = {
    async get(key, dflt = null) {
      const r = await area.get(key);
      return r[key] === undefined ? dflt : r[key];
    },
    set(key, value) { return area.set({ [key]: value }); },
    remove(keys) { return area.remove(keys); },
    async all() { return area.get(null); },
  };

  // ---- toasts ----
  function host() {
    let el = document.getElementById('toasts');
    if (!el) { el = document.createElement('div'); el.id = 'toasts'; document.body.appendChild(el); }
    return el;
  }
  function toast(kind, msg, ms = 3800) {
    const el = U.h(`<div class="toast ${kind}" role="status"><span></span><button aria-label="Close">×</button></div>`);
    el.firstChild.textContent = msg;
    el.lastChild.onclick = () => el.remove();
    host().appendChild(el);
    if (ms) setTimeout(() => el.remove(), ms);
  }
  U.toast = { ok: (m, ms) => toast('ok', m, ms), error: (m, ms) => toast('err', m, ms ?? 6000), info: (m, ms) => toast('info', m, ms) };

  // ---- modal ----
  // U.modal({ title, body (html|Node), actions:[{label, kind, value}] }) → Promise<value|null>
  U.modal = ({ title, body, actions = [{ label: 'OK', kind: 'primary', value: true }], wide = false, onMount }) =>
    new Promise((resolve) => {
      const wrap = U.h(`<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head"><h3></h3><button class="icon-btn x" aria-label="Close">×</button></div>
        <div class="modal-body"></div><div class="modal-foot"></div></div></div>`);
      wrap.querySelector('h3').textContent = title || '';
      const b = wrap.querySelector('.modal-body');
      if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
      const done = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      document.addEventListener('keydown', onKey);
      wrap.querySelector('.x').onclick = () => done(null);
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
      const foot = wrap.querySelector('.modal-foot');
      for (const a of actions) {
        const btn = U.h(`<button class="btn ${a.kind || ''}"></button>`);
        btn.textContent = a.label;
        btn.onclick = () => done(typeof a.value === 'function' ? a.value(wrap) : a.value);
        foot.appendChild(btn);
      }
      document.body.appendChild(wrap);
      onMount?.(wrap, done);
    });

  U.confirm = (title, text, okLabel, danger = false) =>
    U.modal({ title, body: `<p>${U.esc(text)}</p>`, actions: [
      { label: MDM.t('common.cancel'), value: false },
      { label: okLabel || MDM.t('common.ok'), kind: danger ? 'danger' : 'primary', value: true },
    ] }).then((v) => v === true);

  window.MDM = window.MDM || {};
  MDM.u = U;
})();
