// Message templates + saved campaigns.
(() => {
  const U = MDM.u;

  // ---------- templates ----------
  // {{column}}            value from the recipient row (case-insensitive)
  // {{column|fallback}}   fallback when empty
  // {Hi|Hello|Hey}        spintax: one option picked at random per recipient
  // Built-ins: username, name, first_name
  function vars(r) {
    const v = {};
    for (const [k, val] of Object.entries(r.fields || {})) v[k.toLowerCase()] = val == null ? '' : String(val);
    const name = v.name || r.fullName || '';
    v.username = r.username || '';
    v.name = name;
    v.full_name = v.full_name || r.fullName || name;
    v.first_name = v.first_name || String(name).trim().split(/\s+/)[0] || '';
    return v;
  }
  function render(tpl, r, rng = Math.random) {
    const v = vars(r);
    let out = String(tpl || '').replace(/\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g, (_, key, fb) => {
      const val = v[key.toLowerCase()];
      return val && String(val).trim() ? val : fb || '';
    });
    // Spintax after variables, innermost first, so nested {a|{b|c}} works.
    for (let i = 0; i < 10 && /\{[^{}]*\|[^{}]*\}/.test(out); i++) {
      out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, body) => {
        const opts = body.split('|');
        return opts[Math.floor(rng() * opts.length)];
      });
    }
    return out.replace(/[ \t]+\n/g, '\n').trim();
  }
  function usedVars(tpl) {
    return Array.from(String(tpl || '').matchAll(/\{\{\s*([^{}|]+?)\s*(?:\|[^{}]*)?\}\}/g), (m) => m[1].toLowerCase());
  }

  // ---------- campaigns ----------
  const KEY = 'campaigns';
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  async function list() { return (await U.store.get(KEY, [])) || []; }
  async function get(id) { return (await list()).find((c) => c.id === id) || null; }

  function stats(c) {
    const s = { total: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
    for (const r of c.recipients || []) { s.total++; s[r.state] = (s[r.state] || 0) + 1; }
    return s;
  }
  function displayState(c) {
    if (c.status === 'closed') return 'closed';
    const s = stats(c);
    if (s.total > 0 && s.pending === 0) return 'done';
    if (s.sent + s.failed + s.skipped === 0) return 'notStarted';
    return 'active';
  }

  function mutate(id, fn) {
    return serial(async () => {
      const all = await list();
      const c = all.find((x) => x.id === id);
      if (!c) return null;
      fn(c);
      c.updatedAt = Date.now();
      await U.store.set(KEY, all);
      return c;
    });
  }

  function normRecipient(r) {
    return {
      rid: r.rid || U.uuid(),
      username: U.normalizeUsername(r.username),
      userId: r.userId ? String(r.userId) : null,
      fullName: r.fullName || '',
      pic: r.pic || null,
      fields: { ...(r.fields || {}) },
      state: r.state || 'pending',
      attempts: r.attempts || 0,
      error: r.error || null,
      sentAt: r.sentAt || null,
      sentBy: r.sentBy || null,
    };
  }

  function create({ name, source, message, columns, recipients }) {
    return serial(async () => {
      const all = await list();
      const c = {
        id: U.uuid(), name: name || defaultName(source), createdAt: Date.now(), updatedAt: Date.now(),
        status: 'active', source: source || { type: 'manual' }, message: message || '', columns: columns || [],
        recipients: (recipients || []).map(normRecipient),
      };
      all.unshift(c);
      await U.store.set(KEY, all);
      return c;
    });
  }
  function defaultName(source) {
    if (source?.target) return `@${source.target} · ${MDM.t('aud.' + source.type)}`;
    if (source?.fileName) return source.fileName.replace(/\.(xlsx|xls|csv|tsv|txt)$/i, '');
    return `${MDM.t('campaign.untitled')} · ${new Date().toLocaleDateString()}`;
  }

  // Replace the recipient list while keeping progress for people already in it.
  const setRecipients = (id, rows, columns) => mutate(id, (c) => {
    const prev = new Map(c.recipients.map((r) => [r.rid, r]));
    c.recipients = rows.map((r) => {
      const old = prev.get(r.rid);
      const n = normRecipient({ ...old, ...r, state: old?.state, attempts: old?.attempts, sentAt: old?.sentAt, sentBy: old?.sentBy, error: old?.error });
      if (old && U.normalizeUsername(old.username) !== n.username) { n.userId = r.userId || null; n.state = 'pending'; n.attempts = 0; n.error = null; }
      return n;
    });
    if (columns) c.columns = columns;
  });
  const setMessage = (id, message) => mutate(id, (c) => { c.message = message; });
  const rename = (id, name) => mutate(id, (c) => { c.name = name; });
  const close = (id) => mutate(id, (c) => { c.status = 'closed'; });
  const reopen = (id) => mutate(id, (c) => { c.status = 'active'; });
  const remove = (id) => serial(async () => U.store.set(KEY, (await list()).filter((c) => c.id !== id)));

  // Per-recipient result written by the queue. A failure only becomes final for terminal errors
  // or after 3 attempts; otherwise the person stays pending for the next run.
  const MAX_ATTEMPTS = 3;
  const mark = (id, rid, patch) => mutate(id, (c) => {
    const r = c.recipients.find((x) => x.rid === rid);
    if (!r) return;
    if (patch.userId) r.userId = String(patch.userId);
    if (patch.fullName && !r.fullName) r.fullName = patch.fullName;
    if (patch.state === 'sent') Object.assign(r, { state: 'sent', sentAt: Date.now(), sentBy: patch.sentBy || null, error: null });
    else if (patch.state === 'skipped') Object.assign(r, { state: 'skipped', error: patch.error || null });
    else if (patch.state === 'failed') {
      r.attempts = (r.attempts || 0) + 1;
      r.error = patch.error || null;
      r.state = patch.terminal || r.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    }
  });
  // Put failed/skipped people back in the queue.
  const retryFailed = (id) => mutate(id, (c) => {
    for (const r of c.recipients) if (r.state === 'failed') Object.assign(r, { state: 'pending', attempts: 0, error: null });
  });

  MDM.template = { render, vars, usedVars };
  MDM.campaigns = { list, get, create, stats, displayState, setRecipients, setMessage, rename, close, reopen, remove, mark, retryFailed, MAX_ATTEMPTS };
})();
