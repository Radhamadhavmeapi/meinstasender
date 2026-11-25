// Tiny helpers shared by /users and /admin.
window.UI = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const date = (t) => (t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const time = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const money = (minor, cur) => (minor == null ? '—' : (cur === 'USD' ? '$' : cur === 'INR' || !cur ? '₹' : cur + ' ') + (minor / 100).toLocaleString(cur === 'USD' ? 'en-US' : 'en-IN', { maximumFractionDigits: 2 }));

  async function api(method, path, body) {
    const r = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error(j.error || `http_${r.status}`); e.status = r.status; e.data = j; throw e; }
    return j;
  }

  function toast(msg, kind = '') {
    let host = $('#toast');
    if (!host) { host = document.createElement('div'); host.id = 'toast'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = kind;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
  }

  // dialog({ title, body (html), actions: [{label, value, kind}] , onOpen(el, close) }) → Promise<value|null>
  function dialog({ title, body, actions = [{ label: 'OK', value: true, kind: 'primary' }], onOpen }) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.innerHTML = `<div class="dh"><h3></h3><button class="x" aria-label="Close">×</button></div><div class="db"></div><div class="df"></div>`;
      $('h3', d).textContent = title;
      $('.db', d).innerHTML = body;
      const close = (v) => { d.close(); d.remove(); resolve(v); };
      $('.x', d).onclick = () => close(null);
      d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
      for (const a of actions) {
        const b = document.createElement('button');
        b.className = 'btn ' + (a.kind || '');
        b.textContent = a.label;
        b.onclick = async () => {
          if (typeof a.value === 'function') {
            b.disabled = true;
            try { const v = await a.value(d); if (v !== undefined) close(v); } finally { b.disabled = false; }
          } else close(a.value);
        };
        $('.df', d).appendChild(b);
      }
      document.body.appendChild(d);
      d.showModal();
      onOpen?.(d, close);
    });
  }
  const confirm = (title, text, ok = 'Confirm', danger = false) =>
    dialog({ title, body: `<p>${esc(text)}</p>`, actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, kind: danger ? 'danger' : 'primary' }] }).then((v) => v === true);

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); } catch (_) { toast('Copy failed — select and copy it manually', 'err'); }
  }

  return { esc, $, $$, date, time, money, api, toast, dialog, confirm, copy };
})();
