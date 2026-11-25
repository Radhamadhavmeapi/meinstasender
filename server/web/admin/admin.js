// Admin panel. Hash routes: #dash #approvals #users #user=ID #resellers #licenses #license=KEY #products #notices #settings #log #admins
(() => {
  const { esc, $, $$, date, time, money, api, toast, dialog, confirm } = UI;
  const root = $('#root');
  let admin = null;
  let stats = null;

  const A = (method, path, body) => api(method, '/admin/api' + path, body).catch((e) => {
    if (e.status === 401 && path !== '/login') { admin = null; renderLogin(); }
    throw e;
  });
  const fail = (e) => toast({ not_pending: 'Already decided.', not_enough_credits: 'Not enough credits.', weak_password: 'Use at least 8 characters.',
    email_taken: 'Email already used.', invalid_email: 'Invalid email.', bad_amount: 'Enter a number.', customer_of_reseller: 'This user belongs to a reseller.' }[e.message] || `Error: ${e.message}`, 'err');

  function route() { const [n, a] = location.hash.slice(1).split('='); return { name: n || 'dash', arg: a ? decodeURIComponent(a) : null }; }
  addEventListener('hashchange', () => admin && renderShell());

  // ---------- login ----------
  function renderLogin() {
    root.innerHTML = `<div class="authwrap"><div class="auth"><a class="brand" href="/"><img src="/shared/logo.png" alt="" width="30" height="30" />MeAPI DM admin</a>
      <h1>Sign in</h1><form class="f" id="fm"><label><span>Email</span><input type="email" name="email" autocomplete="username" required /></label>
      <label><span>Password</span><input type="password" name="password" autocomplete="current-password" required /></label>
      <div class="err" id="er"></div><button class="btn primary">Sign in</button></form></div></div>`;
    $('#fm').onsubmit = async (ev) => {
      ev.preventDefault();
      try { admin = (await A('POST', '/login', Object.fromEntries(new FormData(ev.target)))).admin; renderShell(); }
      catch (e) { $('#er').textContent = e.status === 429 ? 'Too many attempts. Wait 15 minutes.' : 'Email or password is wrong.'; }
    };
  }

  async function renderShell() {
    const r = route();
    stats = await A('GET', '/stats');
    const nav = [['dash', 'Dashboard'], ['approvals', 'Payments to approve', stats.pendingPayments], ['users', 'Users'], ['resellers', 'Resellers', stats.resellerApplications],
      ['licenses', 'Browser licences'], ['products', 'Plans & prices'], ['notices', 'Notices'], ['settings', 'Settings'], ['log', 'Payment log'], ['admins', 'Admins']];
    const on = { user: 'users', license: 'licenses' }[r.name] || r.name;
    root.innerHTML = `<div class="shell"><aside class="side"><a class="brand" href="#dash"><img src="/shared/logo.png" alt="" width="30" height="30" /><span>MeAPI DM<small>Admin</small></span></a>
      ${nav.map(([k, l, n]) => `<a class="nav ${on === k ? 'on' : ''}" href="#${k}">${esc(l)}${n ? `<span class="count">${n}</span>` : ''}</a>`).join('')}
      <a class="nav" href="#" id="out">Sign out</a><div class="foot">${esc(admin.email)}</div></aside><main class="main" id="main"></main></div>`;
    $('#out').onclick = async (e) => { e.preventDefault(); await A('POST', '/logout').catch(() => {}); admin = null; renderLogin(); };
    const views = { dash, approvals, users, user, resellers, licenses, license, products, notices, settings, log, admins };
    try { await (views[r.name] || dash)($('#main'), r.arg); } catch (e) { if (e.status !== 401) fail(e); }
  }

  // ---------- dashboard ----------
  async function dash(m) {
    const s = stats;
    const st = (n, l, href) => `<a class="stat" ${href ? `href="${href}" style="text-decoration:none;color:inherit"` : ''}><b>${n}</b><span>${esc(l)}</span></a>`;
    m.innerHTML = `<h1>Dashboard</h1>
      ${s.pendingPayments ? `<div class="notice warn">${s.pendingPayments} payment${s.pendingPayments > 1 ? 's' : ''} waiting for approval. <a href="#approvals">Review now</a></div>` : ''}
      ${s.resellerApplications ? `<div class="notice info">${s.resellerApplications} reseller application${s.resellerApplications > 1 ? 's' : ''}. <a href="#resellers">Review</a></div>` : ''}
      <div class="stats">${st(s.licenses, 'Installs')}${st(s.newToday, 'New installs today')}${st(s.active7d, 'Active in 7 days')}${st(s.users, 'User accounts', '#users')}
        ${st(s.resellers, 'Resellers', '#resellers')}${st(s.paidNow, 'Paying now')}${st(s.sendsToday, 'DMs today')}${st(money(s.revenue30dPaise, 'INR'), 'Revenue, 30 days (INR)')}</div>
      <div class="grid2" style="margin-top:20px"><div><h2>DMs per day</h2><table class="t"><tr><th>Day</th><th>DMs</th></tr>
        ${s.sendsByDay.map((d) => `<tr><td>${esc(d.day)}</td><td>${d.n}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No sends yet</td></tr>'}</table></div>
      <div><h2>Extension events, 7 days</h2><table class="t"><tr><th>Event</th><th>Count</th></tr>
        ${s.events7d.map((e) => `<tr><td class="mono">${esc(e.name)}</td><td>${e.n}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No events yet</td></tr>'}</table></div></div>`;
  }

  // ---------- approvals ----------
  async function approvals(m, status = 'pending') {
    const { payments } = await A('GET', '/manual-payments?status=' + status);
    m.innerHTML = `<div class="head"><h1>Manual payments</h1><select class="in" id="st" style="width:auto">${['pending', 'approved', 'rejected', 'awaiting'].map((s) =>
      `<option value="${s}" ${s === status ? 'selected' : ''}>${{ pending: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected', awaiting: 'Started, not submitted' }[s]}</option>`).join('')}</select></div>
      <p class="muted" style="margin-top:-8px">Check the money arrived in your UPI / bank / PayPal before approving. Approving switches on the plan or adds the credits immediately.</p>
      ${payments.length ? `<div class="tablewrap"><table class="t"><tr><th>Submitted</th><th>User</th><th>Plan</th><th>Method</th><th>Amount</th><th>Reference</th><th></th></tr>
        ${payments.map((p) => `<tr><td>${time(p.submitted_at || p.created_at)}</td><td><a href="#user=${p.user_id}">${esc(p.email)}</a>${p.user_note ? `<div class="small muted">“${esc(p.user_note)}”</div>` : ''}</td>
          <td>${esc(p.product_code)}</td><td>${esc(p.method.toUpperCase())}</td><td><b>${money(p.amount, p.currency)}</b><div class="small muted">note MDM${p.id}</div></td>
          <td class="mono">${esc(p.reference || '—')}${p.proof_file ? `<div><a href="/admin/api/manual-payments/${p.id}/proof" target="_blank" rel="noopener">View screenshot</a></div>` : ''}${p.admin_note ? `<div class="small muted">${esc(p.admin_note)}</div>` : ''}</td>
          <td>${p.status === 'pending' ? `<div class="row"><button class="btn small primary" data-ok="${p.id}">Approve</button><button class="btn small danger" data-no="${p.id}">Reject</button></div>` : ''}</td></tr>`).join('')}</table></div>`
      : '<div class="box muted">Nothing here.</div>'}`;
    $('#st').onchange = (e) => approvals(m, e.target.value);
    $$('[data-ok]', m).forEach((b) => (b.onclick = async () => {
      const p = payments.find((x) => String(x.id) === b.dataset.ok);
      if (!(await confirm('Approve payment', `Approve ${money(p.amount, p.currency)} from ${p.email} (ref ${p.reference}) for ${p.product_code}?`, 'Approve'))) return;
      try { await A('POST', `/manual-payments/${p.id}/approve`, {}); toast('Approved — plan switched on', 'ok'); renderShell(); } catch (e) { fail(e); }
    }));
    $$('[data-no]', m).forEach((b) => (b.onclick = async () => {
      const note = await dialog({ title: 'Reject payment', body: '<form class="f"><label><span>Reason the user will see</span><input type="text" class="in" id="rn" value="We could not find this payment. Check the reference number." /></label></form>',
        actions: [{ label: 'Cancel', value: null }, { label: 'Reject', kind: 'danger', value: (d) => $('#rn', d).value }] });
      if (note == null) return;
      try { await A('POST', `/manual-payments/${b.dataset.no}/reject`, { note }); toast('Rejected'); renderShell(); } catch (e) { fail(e); }
    }));
  }

  // ---------- users ----------
  async function users(m, q = '', role = '') {
    const { users: rows } = await A('GET', `/users?q=${encodeURIComponent(q)}&role=${role}`);
    m.innerHTML = `<div class="head"><h1>Users</h1></div>
      <div class="row" style="margin-bottom:14px"><input class="in" id="q" placeholder="Search email, name or phone" value="${esc(q)}" style="max-width:320px" />
        <select class="in" id="rl" style="width:auto"><option value="">Everyone</option><option value="user" ${role === 'user' ? 'selected' : ''}>Users</option><option value="reseller" ${role === 'reseller' ? 'selected' : ''}>Resellers</option><option value="pending" ${role === 'pending' ? 'selected' : ''}>Reseller applications</option></select></div>
      ${userTable(rows)}`;
    const go = () => users(m, $('#q').value, $('#rl').value);
    $('#q').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $('#rl').onchange = go;
  }
  function userTable(rows) {
    if (!rows.length) return '<div class="box muted">No users found.</div>';
    return `<div class="tablewrap"><table class="t"><tr><th>User</th><th>Type</th><th>Plan</th><th>Joined</th><th>Last sign-in</th></tr>
      ${rows.map((u) => `<tr class="click" data-u="${u.id}"><td><b>${esc(u.name || u.email)}</b><div class="small muted">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''}</div></td>
        <td>${u.role === 'reseller' ? `<span class="tag vio">Reseller</span><div class="small muted">${u.credits} credits · ${u.customers} customers</div>` : u.reseller_status === 'pending' ? '<span class="tag warn">Applied as reseller</span>' : u.reseller_email ? `<span class="tag">Customer</span><div class="small muted">of ${esc(u.reseller_email)}</div>` : '<span class="tag">User</span>'}
          ${u.status === 'disabled' ? '<span class="tag bad">Disabled</span>' : ''}</td>
        <td>${u.paid_until ? `<span class="tag ok">Paid</span><div class="small muted">until ${date(u.paid_until)}</div>` : '<span class="tag">Free</span>'}</td>
        <td>${date(u.created_at)}</td><td>${time(u.last_login_at)}</td></tr>`).join('')}</table></div>`;
  }
  document.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-u]'); if (tr) location.hash = '#user=' + tr.dataset.u; });

  async function user(m, id) {
    const d = await A('GET', '/users/' + id);
    const u = d.user, e = d.entitlement;
    m.innerHTML = `<div class="head"><h1>${esc(u.name || u.email)}</h1><a class="btn small" href="#users">All users</a></div>
      <div class="stats"><div class="stat"><b>${e.tier === 'paid' ? (e.paidBy === 'pass' ? 'Pass' : 'PRO') : 'Free'}</b><span>${e.tier === 'paid' ? 'until ' + date(e.paidUntil) : 'plan'}</span></div>
        <div class="stat"><b>${e.usageToday}</b><span>DMs today</span></div><div class="stat"><b>${u.role === 'reseller' ? u.credits : '—'}</b><span>credits</span></div>
        <div class="stat"><b>${u.status === 'active' ? 'Active' : 'Disabled'}</b><span>account</span></div></div>
      <div class="grid2" style="margin-top:16px"><div class="box"><h2 style="margin-top:0">Details</h2>
        <p>${esc(u.email)}<br />${esc(u.phone || 'No phone')}<br /><span class="muted small">Joined ${date(u.createdAt)} · last sign-in ${time(u.lastLoginAt)}</span></p>
        ${u.reseller ? `<p>Customer of reseller <a href="#user=${u.reseller.id}">${esc(u.reseller.email)}</a></p>` : ''}
        <p class="small muted">Licence key <code class="mono">${esc(u.licenseKey)}</code></p>
        ${u.resellerStatus === 'pending' ? `<div class="notice info"><b>Reseller application:</b><br />${esc(u.resellerNote || '')}</div>` : ''}
        <div class="row">
          ${u.role === 'reseller' ? '<button class="btn small" id="unres">Remove reseller</button>' : u.resellerId ? '' : `<button class="btn small ${u.resellerStatus === 'pending' ? 'primary' : ''}" id="res">Make reseller</button>`}
          ${u.resellerStatus === 'pending' ? '<button class="btn small danger" id="rej">Reject application</button>' : ''}
          <button class="btn small" id="pw">Set password</button>
          <button class="btn small" id="rs">Reset today's usage</button>
          <button class="btn small danger" id="dis">${u.status === 'active' ? 'Disable' : 'Enable'}</button></div></div>
      <div class="box"><h2 style="margin-top:0">Give access</h2>
        <div class="row"><select class="in" id="gk" style="width:auto"><option value="pro">PRO</option><option value="pass">Pass</option></select>
          <select class="in" id="gh" style="width:auto"><option value="24">1 day</option><option value="168">7 days</option><option value="720" selected>30 days</option><option value="2160">90 days</option><option value="8760">1 year</option></select>
          <button class="btn primary small" id="grant">Grant</button></div>
        ${u.role === 'reseller' ? `<h2>Credits</h2><div class="row"><input class="in" id="cd" type="number" placeholder="+10 or -2" style="width:130px" /><input class="in" id="cn" placeholder="Note (e.g. paid cash)" style="max-width:220px" /><button class="btn small" id="cr">Update credits</button></div>` : ''}</div></div>
      <h2>Paid time</h2>${table(['Kind', 'Source', 'Ends', ''], d.entitlements.map((x) => [x.kind, x.source + (x.product_code ? ' · ' + x.product_code : ''), time(x.ends_at) + (x.revoked ? ' (revoked)' : ''),
        x.revoked || x.ends_at < Date.now() ? '' : `<button class="btn small danger" data-rv="${x.id}">Revoke</button>`]), true)}
      <h2>Manual payments</h2>${table(['Date', 'Plan', 'Method', 'Amount', 'Reference', 'Status'], d.manualPayments.map((p) => [time(p.created_at), esc(p.product_code), p.method, money(p.amount, p.currency), esc(p.reference || ''), p.status]), true)}
      <h2>Online payments</h2>${table(['Date', 'Plan', 'Amount', 'ID'], d.payments.map((p) => [time(p.created_at), esc(p.product_code), money(p.amount_paise, p.currency), `<span class="mono">${esc(p.razorpay_id || '')}</span>`]), true)}
      ${u.role === 'reseller' ? `<h2>Customers (${d.customers.length})</h2>${table(['Customer', 'Status', 'Added'], d.customers.map((c) => [`<a href="#user=${c.id}">${esc(c.name || c.email)}</a> <span class="small muted">${esc(c.email)}</span>`, c.status, date(c.created_at)]), true)}
        <h2>Credit history</h2>${table(['Date', 'Change', 'Balance', 'Reason'], d.ledger.map((l) => [time(l.created_at), (l.delta > 0 ? '+' : '') + l.delta, l.balance, esc(l.reason + (l.ref ? ' · ' + l.ref : ''))]), true)}` : ''}
      <h2>Usage, last 30 days</h2>${table(['Day', 'DMs'], d.usage.map((x) => [x.day, x.count]))}`;
    const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg, 'ok'); user(m, id); } catch (er) { fail(er); } };
    $('#grant').onclick = () => act(() => A('POST', `/users/${id}/grant`, { kind: $('#gk').value, hours: $('#gh').value }), 'Access granted');
    $('#res') && ($('#res').onclick = () => act(() => A('POST', `/users/${id}/reseller`, { approve: true }), 'Now a reseller'));
    $('#rej') && ($('#rej').onclick = () => act(() => A('POST', `/users/${id}/reseller`, { approve: false }), 'Application rejected'));
    $('#unres') && ($('#unres').onclick = async () => { if (await confirm('Remove reseller', 'They keep their customers and credits but can no longer manage them.', 'Remove', true)) act(() => A('POST', `/users/${id}/reseller`, { approve: false })); });
    $('#rs').onclick = () => act(() => A('POST', `/users/${id}/reset-usage`), 'Usage reset');
    $('#dis').onclick = () => act(() => A('POST', `/users/${id}/status`, { status: u.status === 'active' ? 'disabled' : 'active' }));
    $('#pw').onclick = async () => {
      const p = await dialog({ title: 'Set password', body: '<form class="f"><label><span>New password (min 8)</span><input class="in" id="np" type="text" minlength="8" /></label></form>',
        actions: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', value: (dl) => $('#np', dl).value }] });
      if (p) act(() => A('POST', `/users/${id}/password`, { password: p }), 'Password set — user signed out everywhere');
    };
    $('#cr') && ($('#cr').onclick = () => act(() => A('POST', `/users/${id}/credits`, { delta: $('#cd').value, note: $('#cn').value }), 'Credits updated'));
    $$('[data-rv]', m).forEach((b) => (b.onclick = async () => { if (await confirm('Revoke', 'Remove this paid time now?', 'Revoke', true)) act(() => A('POST', `/entitlements/${b.dataset.rv}/revoke`)); }));
  }
  function table(head, rows, raw = false) {
    if (!rows.length) return '<div class="box muted small">None</div>';
    return `<div class="tablewrap"><table class="t"><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${raw ? c : esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`;
  }

  async function resellers(m) {
    const [{ users: pend }, { users: list }, { settings: s }] = await Promise.all([A('GET', '/users?role=pending'), A('GET', '/users?role=reseller'), A('GET', '/settings')]);
    m.innerHTML = `<h1>Resellers</h1>
      <p class="muted" style="margin-top:-8px">1 month of PRO for one customer costs <b>${esc(s.credits_per_month)}</b> credit(s). Change it in Settings; credit pack prices are in Plans & prices.</p>
      <h2>Applications</h2>${pend.length ? userTable(pend) : '<div class="box muted">No applications waiting.</div>'}
      <h2>Active resellers</h2>${userTable(list)}`;
  }

  // ---------- browser licences ----------
  async function licenses(m, q = '') {
    const { licenses: rows } = await A('GET', '/licenses?q=' + encodeURIComponent(q));
    m.innerHTML = `<h1>Browser licences</h1><p class="muted" style="margin-top:-8px">Every installed browser has a key, with or without an account.</p>
      <input class="in" id="q" placeholder="Search key or email" value="${esc(q)}" style="max-width:320px;margin-bottom:14px" />
      <div class="tablewrap"><table class="t"><tr><th>Key</th><th>Account</th><th>Plan</th><th>Today</th><th>Version</th><th>Last seen</th></tr>
      ${rows.map((l) => `<tr class="click" data-k="${esc(l.key)}"><td class="mono">${esc(l.key.slice(0, 18))}…</td><td>${esc(l.email || '—')}</td>
        <td>${l.banned ? '<span class="tag bad">Banned</span>' : l.paid_until ? `<span class="tag ok">until ${date(l.paid_until)}</span>` : '<span class="tag">Free</span>'}</td>
        <td>${l.today || 0}</td><td>${esc(l.version || '—')}</td><td>${time(l.last_seen_at)}</td></tr>`).join('')}</table></div>`;
    $('#q').onkeydown = (e) => { if (e.key === 'Enter') licenses(m, e.target.value); };
    $$('tr[data-k]', m).forEach((tr) => (tr.onclick = () => { location.hash = '#license=' + tr.dataset.k; }));
  }
  async function license(m, key) {
    const d = await A('GET', '/licenses/' + encodeURIComponent(key));
    m.innerHTML = `<div class="head"><h1 class="mono" style="font-size:16px">${esc(key)}</h1><a class="btn small" href="#licenses">All licences</a></div>
      <div class="stats"><div class="stat"><b>${d.entitlement.tier === 'paid' ? d.entitlement.paidBy : 'free'}</b><span>plan</span></div><div class="stat"><b>${d.entitlement.usageToday}</b><span>DMs today</span></div>
        <div class="stat"><b>${esc(d.entitlement.account?.email || '—')}</b><span>account</span></div></div>
      <div class="row" style="margin:16px 0"><select class="in" id="gk" style="width:auto"><option value="pro">PRO</option><option value="pass">Pass</option></select>
        <select class="in" id="gh" style="width:auto"><option value="24">1 day</option><option value="720" selected>30 days</option><option value="8760">1 year</option></select>
        <button class="btn small primary" id="g">Grant</button><button class="btn small" id="rs">Reset today's usage</button><button class="btn small danger" id="ban">${d.license.banned ? 'Unban' : 'Ban'}</button></div>
      <h2>Paid time</h2>${table(['Kind', 'Source', 'Ends'], d.entitlements.map((x) => [x.kind, x.source, time(x.ends_at) + (x.revoked ? ' (revoked)' : '')]))}
      <h2>Usage</h2>${table(['Day', 'DMs'], d.usage.map((x) => [x.day, x.count]))}`;
    const k = encodeURIComponent(key);
    $('#g').onclick = async () => { await A('POST', `/licenses/${k}/grant`, { kind: $('#gk').value, hours: $('#gh').value }); toast('Granted', 'ok'); license(m, key); };
    $('#rs').onclick = async () => { await A('POST', `/licenses/${k}/reset-usage`); license(m, key); };
    $('#ban').onclick = async () => { await A('POST', `/licenses/${k}/ban`, { banned: !d.license.banned }); license(m, key); };
  }

  // ---------- products ----------
  async function products(m) {
    const { products: rows } = await A('GET', '/products');
    const rupee = (p) => (p == null ? '' : p / 100);
    const form = (p = {}) => `<form class="box f" data-code="${esc(p.code || '')}" style="margin-bottom:14px">
      <div class="row"><b class="grow">${esc(p.name || 'New plan')}</b>${p.code ? `<span class="tag">${esc(p.code)}</span>` : ''}</div>
      <div class="grid2">
        ${p.code ? '' : '<label><span>Code (letters, numbers, _)</span><input type="text" name="code" required pattern="[a-z0-9_]{2,32}" /></label>'}
        <label><span>Name</span><input type="text" name="name" value="${esc(p.name || '')}" required /></label>
        <label><span>Type</span><select name="kind">${['subscription', 'pass', 'credits'].map((k) => `<option ${p.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label><span>Price in ₹</span><input type="number" step="0.01" name="price_inr" value="${rupee(p.price_paise)}" required /></label>
        <label><span>PayPal price in $ (empty = no PayPal)</span><input type="number" step="0.01" name="price_usd" value="${rupee(p.price_usd_cents)}" /></label>
        <label><span>Subscription period</span><select name="interval_label"><option value="">—</option><option ${p.interval_label === 'month' ? 'selected' : ''}>month</option><option ${p.interval_label === 'year' ? 'selected' : ''}>year</option></select></label>
        <label><span>Pass length in hours</span><input type="number" name="duration_hours" value="${p.duration_hours ?? ''}" /></label>
        <label><span>Credits in pack</span><input type="number" name="credits" value="${p.credits ?? ''}" /></label>
        <label><span>Razorpay plan ID (subscriptions)</span><input type="text" name="razorpay_plan_id" value="${esc(p.razorpay_plan_id || '')}" placeholder="plan_…" /></label>
        <label><span>Order on page</span><input type="number" name="sort" value="${p.sort ?? 0}" /></label>
      </div>
      <label><span>Features, one per line</span><textarea name="features" rows="3">${esc(JSON.parse(p.features || '[]').join('\n'))}</textarea></label>
      <div class="row"><label class="check"><input type="checkbox" name="active" ${p.active === 0 ? '' : 'checked'} /> On sale</label><span class="grow"></span><button class="btn primary small">Save</button></div></form>`;
    m.innerHTML = `<h1>Plans & prices</h1>
      <p class="muted" style="margin-top:-8px">Subscriptions renew through Razorpay only when a Razorpay plan ID is set; manual payments give 30 days (month) or 365 days (year). Credit packs are only shown to resellers.</p>
      ${rows.map(form).join('')}<h2>Add a plan</h2>${form()}`;
    $$('form[data-code]', m).forEach((f) => (f.onsubmit = async (ev) => {
      ev.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      const code = f.dataset.code || v.code;
      try {
        await A('PUT', '/products/' + encodeURIComponent(code), {
          name: v.name, kind: v.kind, price_paise: Math.round(Number(v.price_inr) * 100), price_usd_cents: v.price_usd ? Math.round(Number(v.price_usd) * 100) : null,
          interval_label: v.interval_label || null, duration_hours: v.duration_hours || null, credits: v.credits || null, razorpay_plan_id: v.razorpay_plan_id || null,
          sort: v.sort, features: String(v.features || '').split('\n').map((s) => s.trim()).filter(Boolean), active: f.active.checked,
        });
        toast('Saved', 'ok');
        products(m);
      } catch (e) { fail(e); }
    }));
  }

  // ---------- notices ----------
  async function notices(m) {
    const { notices: rows } = await A('GET', '/notices');
    m.innerHTML = `<h1>Notices</h1><p class="muted" style="margin-top:-8px">Pop-up messages inside the extension. The newest active one matching the user's version and language is shown once.</p>
      <form class="box f" id="nf"><div class="grid2"><label><span>Title</span><input type="text" name="title" required /></label>
        <label><span>Level</span><select name="level"><option>info</option><option>warning</option><option>critical</option></select></label>
        <label><span>Button link (https)</span><input type="text" name="link_url" /></label><label><span>Button text</span><input type="text" name="link_label" /></label>
        <label><span>Language</span><select name="lang"><option value="">All</option><option value="en">English</option><option value="hi">Hindi</option></select></label>
        <label><span>Only from version</span><input type="text" name="min_version" placeholder="1.0.0" /></label></div>
        <label><span>Message</span><textarea name="body" rows="3" required></textarea></label><div><button class="btn primary">Publish</button></div></form>
      <h2>All notices</h2>${rows.length ? `<table class="t"><tr><th>Created</th><th>Title</th><th>Level</th><th>Language</th><th></th></tr>
        ${rows.map((n) => `<tr><td>${time(n.created_at)}</td><td>${esc(n.title)}</td><td>${esc(n.level)}</td><td>${esc(n.lang || 'all')}</td>
          <td class="row"><button class="btn small" data-tg="${n.id}">${n.active ? 'Turn off' : 'Turn on'}</button><button class="btn small danger" data-del="${n.id}">Delete</button></td></tr>`).join('')}</table>` : '<div class="box muted">No notices yet.</div>'}`;
    $('#nf').onsubmit = async (ev) => { ev.preventDefault(); await A('POST', '/notices', Object.fromEntries(new FormData(ev.target))); toast('Published', 'ok'); notices(m); };
    $$('[data-tg]', m).forEach((b) => (b.onclick = async () => { const n = rows.find((x) => String(x.id) === b.dataset.tg); await A('PUT', '/notices/' + n.id, { ...n, active: !n.active }); notices(m); }));
    $$('[data-del]', m).forEach((b) => (b.onclick = async () => { if (await confirm('Delete notice', 'Delete this notice?', 'Delete', true)) { await A('DELETE', '/notices/' + b.dataset.del); notices(m); } }));
  }

  // ---------- settings ----------
  async function settings(m) {
    const { settings: s } = await A('GET', '/settings');
    const chk = (k, label) => `<label class="check"><input type="checkbox" name="${k}" ${s[k] === '1' ? 'checked' : ''} /> ${esc(label)}</label>`;
    const txt = (k, label, hint = '', type = 'text') => `<label><span>${esc(label)}</span><input type="${type}" name="${k}" value="${esc(s[k] || '')}" />${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</label>`;
    m.innerHTML = `<h1>Settings</h1><form class="f" id="sf">
      <div class="box f"><h2 style="margin:0">Limits</h2><div class="grid2">
        ${txt('free_daily_limit', 'Free messages per day', 'Per browser/account, counted on the server.', 'number')}
        ${txt('pro_daily_cap', 'Most messages per Instagram account per day', 'Paid plans. The extension never goes above 100.', 'number')}
        ${txt('pass_offer_code', 'Plan offered when the free limit is reached', 'A pass code from Plans & prices; empty = none.')}
        ${txt('credits_per_month', 'Reseller credits per customer-month', '', 'number')}</div></div>
      <div class="box f"><h2 style="margin:0">Payment methods</h2>
        <div class="row" style="gap:22px">${chk('pay_razorpay', 'Razorpay (cards, UPI, net banking)')}${chk('pay_upi', 'UPI QR')}${chk('pay_paypal', 'PayPal')}${chk('pay_bank', 'Bank transfer')}</div>
        <p class="small muted" style="margin:0">A manual method only shows when it's switched on and its details below are filled in. Razorpay keys live in the server's .env.</p>
        <div class="grid2">${txt('upi_id', 'UPI ID', 'e.g. meapi@okicici')}${txt('upi_name', 'Name shown in UPI apps')}
          ${txt('paypal_link', 'PayPal.me link', 'e.g. https://paypal.me/meapi')}${txt('paypal_email', 'PayPal email')}</div>
        <label><span>Bank details shown to customers</span><textarea name="bank_details" rows="5" placeholder="Account name&#10;Account number&#10;IFSC&#10;Bank and branch">${esc(s.bank_details || '')}</textarea></label></div>
      <div class="box f"><h2 style="margin:0">Website</h2><div class="grid2">
        ${txt('extension_url', 'Extension install link', 'Chrome Web Store page or a download link.')}${txt('support_email', 'Support email')}${txt('support_whatsapp', 'Support WhatsApp number', 'With country code, e.g. +91 98…')}</div></div>
      <div><button class="btn primary">Save settings</button></div></form>`;
    $('#sf').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const v = Object.fromEntries(new FormData(f));
      for (const k of ['pay_razorpay', 'pay_upi', 'pay_paypal', 'pay_bank']) v[k] = f[k].checked ? '1' : '0';
      try { await A('PUT', '/settings', v); toast('Settings saved', 'ok'); } catch (e) { fail(e); }
    };
  }

  async function log(m) {
    const { payments } = await A('GET', '/payments');
    m.innerHTML = `<h1>Payment log</h1>${table(['Date', 'User', 'Plan', 'Method', 'Amount', 'ID', 'Event'], payments.map((p) => [time(p.created_at), esc(p.email || (p.license_key || '').slice(0, 14) + '…'), esc(p.product_code),
      esc(p.method), money(p.amount_paise, p.currency), `<span class="mono">${esc(p.razorpay_id || '')}</span>`, esc(p.event)]), true)}`;
  }

  async function admins(m) {
    const { admins: rows } = await A('GET', '/admins');
    m.innerHTML = `<h1>Admins</h1>${table(['Email', 'Name', 'Added', 'Last sign-in'], rows.map((a) => [a.email, a.name || '', date(a.created_at), time(a.last_login_at)]))}
      <div class="grid2" style="margin-top:20px"><form class="box f" id="na"><h2 style="margin:0">Add an admin</h2>
        <label><span>Email</span><input type="email" name="email" required /></label><label><span>Name</span><input type="text" name="name" /></label>
        <label><span>Password</span><input type="password" name="password" minlength="8" autocomplete="new-password" required /></label><button class="btn primary">Add admin</button></form>
      <form class="box f" id="cp"><h2 style="margin:0">Change my password</h2>
        <label><span>Current password</span><input type="password" name="current" autocomplete="current-password" required /></label>
        <label><span>New password</span><input type="password" name="password" minlength="8" autocomplete="new-password" required /></label><button class="btn primary">Change password</button></form></div>`;
    $('#na').onsubmit = async (ev) => { ev.preventDefault(); try { await A('POST', '/admins', Object.fromEntries(new FormData(ev.target))); toast('Admin added', 'ok'); admins(m); } catch (e) { fail(e); } };
    $('#cp').onsubmit = async (ev) => { ev.preventDefault(); try { await A('POST', '/me/password', Object.fromEntries(new FormData(ev.target))); ev.target.reset(); toast('Password changed', 'ok'); } catch (e) { fail(e.status === 401 ? new Error('Current password is wrong') : e); } };
  }

  (async () => {
    try { admin = (await api('GET', '/admin/api/me')).admin; renderShell(); } catch (_) { renderLogin(); }
  })();
})();
