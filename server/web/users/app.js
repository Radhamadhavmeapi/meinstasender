// User & reseller portal. Hash routes: #login #signup #forgot #reset=TOKEN #home #buy[=code] #pay=ID #payments #reseller #profile
(() => {
  const { esc, $, $$, date, time, money, api, toast, dialog, confirm, copy } = UI;
  const root = $('#root');
  let me = null; // { user, entitlement, config }

  const ERR = {
    bad_credentials: 'Email or password is wrong.', email_taken: 'An account with this email already exists. Sign in instead.',
    invalid_email: 'Enter a valid email address.', weak_password: 'Use at least 8 characters for the password.',
    account_disabled: 'This account is disabled. Contact support.', reset_expired: 'This reset link has expired or was already used. Ask for a new one.',
    method_unavailable: 'That payment method is not available right now.', paypal_not_for_product: 'PayPal is not available for this plan.',
    bad_reference: 'Enter the full reference number (6 to 64 characters).', reference_used: 'This reference number was already submitted.',
    already_submitted: 'This payment was already submitted.', bad_proof_type: 'Upload a PNG, JPG, WEBP or PDF file.', proof_too_large: 'The file is larger than 3 MB.',
    not_enough_credits: 'You don\'t have enough credits. Buy credits first.', payments_not_configured: 'Online payment is not set up yet. Choose another method.',
    plan_not_configured: 'Online payment for this plan is not set up yet. Choose another method.', not_reseller: 'Only approved resellers can do this.',
    customer_of_reseller: 'Your account is managed by a reseller, so it can\'t become a reseller.', too_many: 'Too many attempts. Wait a few minutes.',
  };
  const msg = (e) => ERR[e.message] || (e.status === 429 ? ERR.too_many : 'Something went wrong. Try again.');

  // ---------- routing ----------
  function route() {
    const h = location.hash.slice(1);
    const [name, arg] = h.split('=');
    return { name: name || '', arg: arg ? decodeURIComponent(arg) : null };
  }
  async function render() {
    const r = route();
    if (['login', 'signup', 'forgot', 'reset'].includes(r.name)) return renderAuth(r);
    if (!me) {
      try { me = await api('GET', '/api/u/me'); } catch (e) {
        if (r.name === 'buy' && r.arg) sessionStorage.setItem('afterLogin', location.hash);
        location.hash = '#login';
        return;
      }
    }
    renderShell(r);
  }
  addEventListener('hashchange', render);
  const refreshMe = async () => { me = await api('GET', '/api/u/me'); };

  // ---------- auth pages ----------
  function renderAuth(r) {
    me = null;
    const brand = `<a class="brand" href="/"><img src="/shared/logo.png" alt="" width="30" height="30" />MeAPI DM Sender</a>`;
    const pages = {
      login: `<h1>Sign in</h1><p class="sub">Use the same email and password in the extension.</p>
        <form class="f" id="fm"><label><span>Email</span><input type="email" name="email" autocomplete="email" required /></label>
        <label><span>Password</span><input type="password" name="password" autocomplete="current-password" required /></label>
        <div class="err" id="er"></div><button class="btn primary">Sign in</button></form>
        <p class="alt"><a href="#forgot">Forgot password?</a> · New here? <a href="#signup">Create an account</a></p>`,
      signup: `<h1>Create your account</h1><p class="sub">Free plan, no card needed. You can upgrade any time.</p>
        <form class="f" id="fm"><label><span>Name</span><input type="text" name="name" autocomplete="name" /></label>
        <label><span>Email</span><input type="email" name="email" autocomplete="email" required /></label>
        <label><span>Mobile / WhatsApp (optional)</span><input type="tel" name="phone" autocomplete="tel" /></label>
        <label><span>Password</span><input type="password" name="password" autocomplete="new-password" minlength="8" required /><div class="hint">At least 8 characters.</div></label>
        <label class="check small"><input type="checkbox" required /> I agree to the <a href="/terms" target="_blank">terms</a> and <a href="/privacy" target="_blank">privacy policy</a>.</label>
        <div class="err" id="er"></div><button class="btn primary">Create account</button></form>
        <p class="alt">Already have an account? <a href="#login">Sign in</a></p>`,
      forgot: `<h1>Reset your password</h1><p class="sub">We'll email you a link to set a new one.</p>
        <form class="f" id="fm"><label><span>Email</span><input type="email" name="email" required /></label>
        <div class="err" id="er"></div><button class="btn primary">Send reset link</button></form>
        <p class="alt"><a href="#login">Back to sign in</a></p>`,
      reset: `<h1>Choose a new password</h1>
        <form class="f" id="fm"><label><span>New password</span><input type="password" name="password" minlength="8" autocomplete="new-password" required /></label>
        <div class="err" id="er"></div><button class="btn primary">Save password</button></form>`,
    };
    root.innerHTML = `<div class="authwrap"><div class="auth">${brand}${pages[r.name]}</div></div>`;
    const fm = $('#fm');
    fm.onsubmit = async (ev) => {
      ev.preventDefault();
      const b = Object.fromEntries(new FormData(fm));
      const btn = $('button.primary', fm);
      btn.disabled = true;
      $('#er').textContent = '';
      try {
        if (r.name === 'forgot') {
          const out = await api('POST', '/api/u/forgot', b);
          fm.outerHTML = `<div class="notice ok">If an account exists for ${esc(b.email)}, a reset link is on its way. Check your inbox and spam folder.</div>` +
            (out.mail ? '' : '<div class="notice warn">Email sending is not set up yet — contact support to reset your password.</div>');
          return;
        }
        if (r.name === 'reset') await api('POST', '/api/u/reset', { token: r.arg, password: b.password });
        else await api('POST', `/api/u/${r.name === 'signup' ? 'register' : 'login'}`, b);
        me = null;
        const next = sessionStorage.getItem('afterLogin');
        sessionStorage.removeItem('afterLogin');
        location.hash = next || '#home';
      } catch (e) {
        $('#er').textContent = msg(e);
      } finally { btn.disabled = false; }
    };
    setTimeout(() => $('input', fm)?.focus(), 20);
  }

  // ---------- shell ----------
  function renderShell(r) {
    const u = me.user;
    const nav = [['home', 'Dashboard'], ['buy', 'Buy or renew'], ['payments', 'Payments'], ['reseller', u.role === 'reseller' ? 'My customers' : 'Become a reseller'], ['profile', 'Profile']];
    const page = nav.some(([k]) => k === r.name) || r.name === 'pay' ? r.name : 'home';
    root.innerHTML = `<div class="shell">
      <aside class="side"><a class="brand" href="#home"><img src="/shared/logo.png" alt="" width="30" height="30" /><span>MeAPI DM<small>${u.role === 'reseller' ? 'Reseller account' : 'Your account'}</small></span></a>
        ${nav.map(([k, l]) => `<a class="nav ${page === k || (page === 'pay' && k === 'payments') ? 'on' : ''}" href="#${k}">${esc(l)}</a>`).join('')}
        <a class="nav" href="#" id="logout">Sign out</a>
        <div class="foot">${esc(u.email)}</div></aside>
      <main class="main" id="main"></main></div>`;
    $('#logout').onclick = async (e) => { e.preventDefault(); await api('POST', '/api/u/logout').catch(() => {}); me = null; location.hash = '#login'; };
    const main = $('#main');
    ({ home, buy, pay, payments, reseller, profile })[page](main, r.arg);
  }

  // ---------- dashboard ----------
  async function home(main) {
    await refreshMe();
    const { user: u, entitlement: e, config: c } = me;
    const paid = e.tier === 'paid';
    const left = paid ? e.paidUntil - Date.now() : 0;
    const days = Math.max(0, Math.ceil(left / 86400000));
    const pay = await api('GET', '/api/u/payments');
    const pending = pay.manual.filter((m) => m.status === 'pending' || m.status === 'awaiting');
    main.innerHTML = `<h1>Hello${u.name ? ', ' + esc(u.name.split(' ')[0]) : ''}</h1>
      ${pending.length ? `<div class="notice info">${pending.filter((m) => m.status === 'pending').length ? 'A payment is waiting for confirmation. Your plan switches on as soon as it is approved.' : 'You started a payment but haven\'t submitted the reference yet.'} <a href="#payments">View payments</a></div>` : ''}
      ${e.banned ? '<div class="notice warn">This account is blocked. Contact support.</div>' : ''}
      <div class="grid2">
        <div class="box"><div class="muted small">Current plan</div>
          <h2 style="margin:4px 0 2px;font-size:28px">${paid ? (e.paidBy === 'pass' ? '24-hour pass' : 'PRO') : 'Free'}</h2>
          <p class="muted" style="margin:0 0 14px">${paid ? (e.paidBy === 'pass' ? `Ends ${time(e.paidUntil)}` : `Active until ${date(e.paidUntil)} · ${days} day${days === 1 ? '' : 's'} left`) : `${e.usageToday} of ${e.freeDailyLimit} free messages used today`}</p>
          <a class="btn ${paid ? '' : 'primary'}" href="#buy">${paid ? 'Extend' : 'Upgrade'}</a></div>
        <div class="box"><div class="muted small">Get started</div>
          <h2 style="margin:4px 0 8px">Use the extension</h2>
          <ol style="margin:0 0 12px;padding-left:20px;color:var(--ink-2)">
            <li>${c.extensionUrl ? `<a href="${esc(c.extensionUrl)}" target="_blank" rel="noopener">Install MeAPI DM Sender</a> in Chrome.` : 'Install MeAPI DM Sender in Chrome.'}</li>
            <li>Open it and go to <b>Plan</b> → <b>Sign in with email</b>.</li>
            <li>Use <b>${esc(u.email)}</b> and your password.</li></ol>
          <p class="small muted" style="margin:0">Messages today: <b>${e.usageToday}</b>${paid ? '' : ` of ${e.freeDailyLimit}`}</p></div>
      </div>
      <h2>Licence key</h2>
      <div class="box"><p class="small muted" style="margin-top:0">Signing in with email is easier. The key is for using the extension without signing in; keep it private.</p>
        <div class="copybox"><code class="mono" id="key">${'•'.repeat(28)}</code><button class="btn small" id="show">Show</button><button class="btn small" id="cp">Copy</button></div></div>
      ${c.supportEmail || c.supportWhatsapp ? `<h2>Help</h2><div class="box">Need help? ${c.supportEmail ? `Email <a href="mailto:${esc(c.supportEmail)}">${esc(c.supportEmail)}</a>` : ''}${c.supportEmail && c.supportWhatsapp ? ' or ' : ''}${c.supportWhatsapp ? `WhatsApp <a href="https://wa.me/${esc(c.supportWhatsapp.replace(/\D/g, ''))}" target="_blank" rel="noopener">${esc(c.supportWhatsapp)}</a>` : ''}.</div>` : ''}`;
    let shown = false;
    $('#show').onclick = (ev) => { shown = !shown; $('#key').textContent = shown ? u.licenseKey : '•'.repeat(28); ev.target.textContent = shown ? 'Hide' : 'Show'; };
    $('#cp').onclick = () => copy(u.licenseKey);
  }

  // ---------- buying ----------
  const METHOD_INFO = {
    razorpay: ['Card, UPI app, net banking', 'Paid online through Razorpay — switches on instantly'],
    upi: ['UPI (scan QR)', 'Pay to our UPI ID, then enter the UTR number'],
    paypal: ['PayPal', 'International payment in US dollars'],
    bank: ['Bank transfer (NEFT / IMPS)', 'Transfer to our account, then enter the reference'],
  };

  async function buy(main, preselect) {
    const { products } = await api('GET', '/api/u/products');
    const plans = products.filter((p) => p.kind !== 'credits');
    main.innerHTML = `<h1>Buy or renew</h1>
      <p class="muted" style="margin-top:-8px">Paid time adds on to any time you have left.</p>
      <div class="plans">${plans.map((p) => `<article class="plan ${p.code === preselect ? 'sel' : ''}">
        <h3>${esc(p.name)}</h3><div class="price">${esc(p.price)} <small>${p.kind === 'subscription' ? '/ ' + esc(p.interval || 'month') : 'one time'}</small></div>
        ${p.priceUsd ? `<div class="small muted">${esc(p.priceUsd)} with PayPal</div>` : ''}
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <button class="btn ${p.code === 'pro_month' ? 'primary' : ''}" data-code="${esc(p.code)}">Choose ${esc(p.name)}</button></article>`).join('')}</div>`;
    $$('[data-code]', main).forEach((b) => (b.onclick = () => choosePayment(products.find((p) => p.code === b.dataset.code))));
    if (preselect) { const p = products.find((x) => x.code === preselect); if (p) choosePayment(p); }
  }

  async function choosePayment(p) {
    const methods = me.config.methods.filter((m) => m !== 'paypal' || p.priceUsd).filter((m) => m !== 'razorpay' || p.purchasable);
    if (!methods.length) return dialog({ title: 'No payment method available', body: '<p>Online payment isn\'t set up yet. Please contact support to buy this plan.</p>' });
    const v = await dialog({
      title: `Pay for ${p.name}`,
      body: `<p style="margin-top:0">${esc(p.price)}${p.priceUsd ? ` (or ${esc(p.priceUsd)} with PayPal)` : ''}</p><div class="methods">${methods.map((m) =>
        `<button class="method" data-m="${m}"><div><b>${esc(METHOD_INFO[m][0])}</b><span>${esc(METHOD_INFO[m][1])}</span></div></button>`).join('')}</div>`,
      actions: [{ label: 'Cancel', value: null }],
      onOpen: (d, close) => $$('.method', d).forEach((b) => (b.onclick = () => close(b.dataset.m))),
    });
    if (!v) return;
    try {
      if (v === 'razorpay') {
        const { url } = await api('POST', '/api/u/checkout', { productCode: p.code });
        location.href = url;
        return;
      }
      const ins = await api('POST', '/api/u/payments/manual', { productCode: p.code, method: v });
      location.hash = '#pay=' + ins.id;
    } catch (e) { toast(msg(e), 'err'); }
  }

  async function pay(main, id) {
    let ins;
    try { ins = await api('GET', `/api/u/payments/manual/${encodeURIComponent(id)}`); } catch (_) { location.hash = '#payments'; return; }
    const refLabel = ins.method === 'upi' ? 'UTR / UPI reference number (12 digits)' : ins.method === 'bank' ? 'Bank reference (UTR) number' : 'PayPal transaction ID';
    const how = {
      upi: `<div class="row" style="align-items:flex-start;gap:24px"><img class="qr" src="${esc(ins.upiQr)}" alt="UPI QR code for ${esc(ins.amount)}" />
        <div class="grow"><p style="margin-top:0">Scan with any UPI app (GPay, PhonePe, Paytm) and pay <b>${esc(ins.amount)}</b>.</p>
        <div class="small muted">UPI ID</div><div class="copybox" style="margin:4px 0 12px"><code class="mono">${esc(ins.upiId)}</code><button class="btn small" data-copy="${esc(ins.upiId)}">Copy</button></div>
        <div class="small muted">Name</div><p style="margin:2px 0 12px">${esc(ins.upiName)}</p>
        <a class="btn small" href="${esc(ins.upiUri)}">Open UPI app</a><span class="small muted"> (on your phone)</span></div></div>`,
      paypal: `<p style="margin-top:0">Send <b>${esc(ins.amount)}</b> with PayPal.</p>
        ${ins.paypalLink ? `<p><a class="btn primary" href="${esc(ins.paypalLink)}" target="_blank" rel="noopener">Pay with PayPal</a></p>` : ''}
        ${ins.paypalEmail ? `<div class="small muted">PayPal email</div><div class="copybox" style="margin:4px 0"><code class="mono">${esc(ins.paypalEmail)}</code><button class="btn small" data-copy="${esc(ins.paypalEmail)}">Copy</button></div>` : ''}
        <p class="small muted">Choose "Paying for goods or services" and add the note <b>${esc(ins.note)}</b>.</p>`,
      bank: `<p style="margin-top:0">Transfer <b>${esc(ins.amount)}</b> to this account by NEFT, IMPS or RTGS:</p><pre class="bank">${esc(ins.bankDetails)}</pre>
        <p class="small muted">Add <b>${esc(ins.note)}</b> in the remarks if your bank allows it.</p>`,
    }[ins.method];
    const waiting = ins.status === 'pending';
    main.innerHTML = `<div class="head"><h1>Pay for ${esc(ins.product.name)}</h1><a class="btn small" href="#payments">All payments</a></div>
      ${waiting ? '<div class="notice info">Thanks — we received your reference. Your plan switches on as soon as the payment is confirmed (usually within a few hours).</div>' : ''}
      ${ins.status === 'approved' ? '<div class="notice ok">This payment is confirmed and your plan is active.</div>' : ''}
      ${ins.status === 'rejected' ? '<div class="notice warn">We couldn\'t match this payment. Check the reference number and submit again, or contact support.</div>' : ''}
      <div class="grid2"><div class="box"><h2 style="margin-top:0">1. Pay</h2>${how}</div>
      <div class="box"><h2 style="margin-top:0">2. Tell us the reference</h2>
        ${waiting || ins.status === 'approved' ? '<p class="muted">Already submitted.</p>' : `<form class="f" id="sub">
        <label><span>${esc(refLabel)}</span><input type="text" name="reference" required minlength="6" maxlength="64" autocomplete="off" /></label>
        <label><span>Payment screenshot (optional)</span><input type="file" name="proof" accept="image/png,image/jpeg,image/webp,application/pdf" /><div class="hint">Helps us confirm faster. Max 3 MB.</div></label>
        <label><span>Note (optional)</span><input type="text" name="note" maxlength="300" /></label>
        <div class="err" id="er"></div><button class="btn primary">I've paid — submit</button>
        ${ins.status === 'awaiting' ? '<button type="button" class="btn ghost" id="cancel">Cancel this payment</button>' : ''}</form>`}</div></div>`;
    $$('[data-copy]', main).forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
    const f = $('#sub');
    if (!f) return;
    $('#cancel') && ($('#cancel').onclick = async () => { await api('POST', `/api/u/payments/manual/${ins.id}/cancel`).catch(() => {}); location.hash = '#buy'; });
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = $('button.primary', f);
      btn.disabled = true;
      $('#er').textContent = '';
      try {
        const file = f.proof.files[0];
        let proof;
        if (file) {
          if (file.size > 3 * 1024 * 1024) throw new Error('proof_too_large');
          proof = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
        }
        await api('POST', `/api/u/payments/manual/${ins.id}/submit`, { reference: f.reference.value, note: f.note.value, proof });
        toast('Submitted. We\'ll confirm it shortly.', 'ok');
        pay(main, ins.id);
      } catch (e) { $('#er').textContent = msg(e); btn.disabled = false; }
    };
  }

  async function payments(main) {
    const { manual, online } = await api('GET', '/api/u/payments');
    const tag = { awaiting: ['Not submitted', 'warn'], pending: ['Waiting for confirmation', 'vio'], approved: ['Confirmed', 'ok'], rejected: ['Not matched', 'bad'] };
    const rows = [
      ...manual.map((m) => ({ at: m.submitted_at || m.created_at, product: m.product_code, how: m.method.toUpperCase(), amount: money(m.amount, m.currency), ref: m.reference || '', status: tag[m.status], note: m.admin_note, id: m.id, open: m.status === 'awaiting' || m.status === 'rejected' })),
      ...online.map((p) => ({ at: p.created_at, product: p.product_code, how: 'Razorpay', amount: money(p.amount_paise, p.currency || 'INR'), ref: p.razorpay_id, status: ['Paid', 'ok'] })),
    ].sort((a, b) => b.at - a.at);
    main.innerHTML = `<h1>Payments</h1>${rows.length ? `<div class="tablewrap"><table class="t"><tr><th>Date</th><th>Plan</th><th>Method</th><th>Amount</th><th>Reference</th><th>Status</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${time(r.at)}</td><td>${esc(r.product)}</td><td>${esc(r.how)}</td><td>${esc(r.amount)}</td><td class="mono">${esc(r.ref)}</td>
        <td><span class="tag ${r.status[1]}">${esc(r.status[0])}</span>${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ''}</td>
        <td>${r.open ? `<a class="btn small" href="#pay=${r.id}">${r.ref ? 'Resubmit' : 'Continue'}</a>` : ''}</td></tr>`).join('')}</table></div>`
      : '<div class="box muted">No payments yet. <a href="#buy">Choose a plan</a>.</div>'}`;
  }

  // ---------- reseller ----------
  async function reseller(main) {
    await refreshMe();
    const u = me.user;
    if (u.role !== 'reseller') {
      if (u.resellerId) { main.innerHTML = '<h1>Become a reseller</h1><div class="box">Your account is managed by a reseller, so it can\'t become a reseller.</div>'; return; }
      if (u.resellerStatus === 'pending') { main.innerHTML = '<h1>Become a reseller</h1><div class="notice info">Thanks for applying. We\'ll review your application and switch on your reseller dashboard here.</div>'; return; }
      main.innerHTML = `<h1>Become a reseller</h1>
        <div class="grid2"><div class="box"><p style="margin-top:0">Resellers buy credits at a wholesale price and switch on PRO for their own clients. One credit = one client-month of PRO (30 days).</p>
          <ul style="color:var(--ink-2)"><li>Create accounts for your clients</li><li>Activate or renew PRO for 1, 3, 6 or 12 months</li><li>Set your own selling price</li></ul></div>
        <form class="box f" id="ap"><label><span>Tell us about your business</span><textarea name="note" rows="5" placeholder="Company, city, how many clients you expect, how you sell…" required></textarea></label>
          ${u.resellerStatus === 'rejected' ? '<div class="notice warn">Your earlier application was not approved. You can apply again with more detail.</div>' : ''}
          <button class="btn primary">Send application</button></form></div>`;
      $('#ap').onsubmit = async (ev) => {
        ev.preventDefault();
        try { await api('POST', '/api/u/reseller/apply', { note: ev.target.note.value }); toast('Application sent', 'ok'); reseller(main); } catch (e) { toast(msg(e), 'err'); }
      };
      return;
    }
    const [{ customers }, { ledger }, { products }] = await Promise.all([api('GET', '/api/u/reseller/customers'), api('GET', '/api/u/reseller/ledger'), api('GET', '/api/u/products')]);
    const packs = products.filter((p) => p.kind === 'credits');
    const cpm = me.config.creditsPerMonth;
    main.innerHTML = `<div class="head"><h1>My customers</h1><button class="btn primary" id="add">Add customer</button></div>
      <div class="stats"><div class="stat"><b>${u.credits}</b><span>credits left</span></div><div class="stat"><b>${customers.length}</b><span>customers</span></div>
        <div class="stat"><b>${customers.filter((c) => c.tier === 'paid').length}</b><span>on PRO now</span></div></div>
      <h2>Customers</h2>
      ${customers.length ? `<div class="tablewrap"><table class="t"><tr><th>Customer</th><th>Plan</th><th>Today</th><th>Added</th><th></th></tr>
        ${customers.map((c) => `<tr><td><b>${esc(c.name || c.email)}</b><div class="small muted">${esc(c.email)}${c.phone ? ' · ' + esc(c.phone) : ''}</div>${c.status === 'disabled' ? '<span class="tag bad">Disabled</span>' : ''}</td>
          <td>${c.tier === 'paid' ? `<span class="tag ok">PRO</span><div class="small muted">until ${date(c.paidUntil)}</div>` : '<span class="tag">Free</span>'}</td>
          <td>${c.usageToday ?? 0}</td><td>${date(c.createdAt)}</td>
          <td class="row"><button class="btn small primary" data-act="${c.id}">${c.tier === 'paid' ? 'Renew' : 'Activate'}</button>
            <button class="btn small" data-pw="${c.id}">Password</button>
            <button class="btn small ghost" data-st="${c.id}" data-to="${c.status === 'disabled' ? 'active' : 'disabled'}">${c.status === 'disabled' ? 'Enable' : 'Disable'}</button></td></tr>`).join('')}</table></div>`
      : '<div class="box muted">No customers yet. Add your first customer, then activate PRO for them.</div>'}
      <h2>Buy credits</h2>
      <div class="plans">${packs.map((p) => `<article class="plan"><h3>${esc(p.name)}</h3><div class="price">${esc(p.price)}</div>
        <div class="small muted">${esc(p.priceUsd ? p.priceUsd + ' with PayPal · ' : '')}${p.credits ? '₹' + (p.pricePaise / 100 / p.credits).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' per credit' : ''}</div>
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><button class="btn" data-buy="${esc(p.code)}">Buy ${esc(p.name)}</button></article>`).join('') || '<div class="box muted">No credit packs on sale right now.</div>'}</div>
      <h2>Credit history</h2>
      ${ledger.length ? `<div class="tablewrap"><table class="t"><tr><th>Date</th><th>Change</th><th>Balance</th><th>Reason</th></tr>
        ${ledger.map((l) => `<tr><td>${time(l.created_at)}</td><td><b style="color:${l.delta > 0 ? 'var(--safe)' : 'var(--ink)'}">${l.delta > 0 ? '+' : ''}${l.delta}</b></td><td>${l.balance}</td>
          <td>${esc({ purchase: 'Bought credits', admin: 'Added by MeAPI', activate: 'Activated a customer' }[l.reason] || l.reason)}</td></tr>`).join('')}</table></div>` : '<div class="box muted">No credit activity yet.</div>'}`;

    $('#add').onclick = async () => {
      const v = await dialog({
        title: 'Add customer',
        body: `<form class="f" id="nc"><label><span>Name</span><input type="text" name="name" /></label><label><span>Email</span><input type="email" name="email" required /></label>
          <label><span>Mobile (optional)</span><input type="tel" name="phone" /></label><label><span>Password for the customer</span><input type="text" name="password" minlength="8" required /><div class="hint">Share it with your customer; they sign in to the extension with this email and password.</div></label>
          <div class="err" id="ner"></div></form>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Add customer', kind: 'primary', value: async (d) => {
          const f = $('#nc', d);
          if (!f.reportValidity()) return undefined;
          try { return (await api('POST', '/api/u/reseller/customers', Object.fromEntries(new FormData(f)))).customer; } catch (e) { $('#ner', d).textContent = msg(e); return undefined; }
        } }],
        onOpen: (d) => { const pw = $('[name=password]', d); pw.value = Math.random().toString(36).slice(2, 7) + Math.random().toString(36).slice(2, 7).toUpperCase(); },
      });
      if (v) { toast('Customer added', 'ok'); reseller(main); }
    };
    $$('[data-act]', main).forEach((b) => (b.onclick = async () => {
      const c = customers.find((x) => String(x.id) === b.dataset.act);
      const v = await dialog({
        title: `PRO for ${c.name || c.email}`,
        body: `<p style="margin-top:0">You have <b>${u.credits}</b> credits. Time adds on to any PRO time they still have.</p>
          <div class="methods">${[1, 3, 6, 12].map((m) => `<button class="method" data-m="${m}" ${m * cpm > u.credits ? 'disabled' : ''}><div><b>${m} month${m > 1 ? 's' : ''}</b><span>${m * cpm} credit${m * cpm > 1 ? 's' : ''}</span></div></button>`).join('')}</div>
          ${u.credits < cpm ? '<p class="err">Not enough credits — buy credits below.</p>' : ''}`,
        actions: [{ label: 'Cancel', value: null }],
        onOpen: (d, close) => $$('.method', d).forEach((x) => (x.onclick = () => close(Number(x.dataset.m)))),
      });
      if (!v) return;
      try { await api('POST', `/api/u/reseller/customers/${c.id}/activate`, { months: v }); toast(`PRO activated for ${v} month${v > 1 ? 's' : ''}`, 'ok'); reseller(main); } catch (e) { toast(msg(e), 'err'); }
    }));
    $$('[data-pw]', main).forEach((b) => (b.onclick = async () => {
      const v = await dialog({ title: 'Set a new password', body: '<form class="f" id="pf"><label><span>New password for the customer</span><input type="text" name="p" minlength="8" required /></label></form>',
        actions: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', value: (d) => ($('#pf', d).reportValidity() ? $('[name=p]', d).value : undefined) }] });
      if (!v) return;
      try { await api('POST', `/api/u/reseller/customers/${b.dataset.pw}/password`, { password: v }); toast('Password changed', 'ok'); } catch (e) { toast(msg(e), 'err'); }
    }));
    $$('[data-st]', main).forEach((b) => (b.onclick = async () => {
      if (b.dataset.to === 'disabled' && !(await confirm('Disable customer', 'They will be signed out and can\'t use their account until you enable it again.', 'Disable', true))) return;
      await api('POST', `/api/u/reseller/customers/${b.dataset.st}/status`, { status: b.dataset.to });
      reseller(main);
    }));
    $$('[data-buy]', main).forEach((b) => (b.onclick = () => choosePayment(packs.find((p) => p.code === b.dataset.buy))));
  }

  // ---------- profile ----------
  async function profile(main) {
    const u = me.user;
    main.innerHTML = `<h1>Profile</h1><div class="grid2">
      <form class="box f" id="pf"><h2 style="margin:0">Your details</h2>
        <label><span>Email</span><input type="email" value="${esc(u.email)}" disabled /></label>
        <label><span>Name</span><input type="text" name="name" value="${esc(u.name)}" /></label>
        <label><span>Mobile / WhatsApp</span><input type="tel" name="phone" value="${esc(u.phone)}" /></label>
        <button class="btn primary">Save details</button></form>
      <form class="box f" id="pw"><h2 style="margin:0">Password</h2>
        ${u.hasPassword ? '<label><span>Current password</span><input type="password" name="current" autocomplete="current-password" required /></label>' : '<p class="small muted" style="margin:0">You signed up with Google. Set a password to also sign in with email.</p>'}
        <label><span>New password</span><input type="password" name="password" minlength="8" autocomplete="new-password" required /></label>
        <div class="err" id="er"></div><button class="btn primary">Change password</button></form></div>`;
    $('#pf').onsubmit = async (ev) => {
      ev.preventDefault();
      await api('PUT', '/api/u/profile', Object.fromEntries(new FormData(ev.target)));
      await refreshMe();
      toast('Saved', 'ok');
    };
    $('#pw').onsubmit = async (ev) => {
      ev.preventDefault();
      try { await api('POST', '/api/u/password', Object.fromEntries(new FormData(ev.target))); ev.target.reset(); toast('Password changed. Other devices were signed out.', 'ok'); }
      catch (e) { $('#er').textContent = msg(e); }
    };
  }

  render();
})();
