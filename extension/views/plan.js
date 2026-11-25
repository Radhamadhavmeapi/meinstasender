// Plan view: license status, plans from the server (Razorpay checkout), Google sign-in, license key tools.
(() => {
  const U = MDM.u, t = (...a) => MDM.t(...a), L = MDM.license;
  let root = null, gen = 0;

  async function render({ force = false } = {}) {
    if (!root) return;
    const my = ++gen;
    root.innerHTML = `<div class="view-head"><h1>${U.esc(t('nav.plan'))}</h1></div><p class="muted">${U.esc(t('common.loading'))}</p>`;
    const [info, key, hist, email] = await Promise.all([L.entitlement({ force }), L.getKey(), L.history(), U.store.get('accountEmail', null)]);
    let products = null, prodErr = null;
    try { products = await L.products(); } catch (e) { prodErr = e.message; }
    if (my !== gen || !root) return;

    const paid = info.tier === 'paid';
    const left = info.paidUntil ? info.paidUntil - Date.now() : 0;
    const sub = info.subscription;
    let tierLine = paid ? (info.paidBy === 'pass' ? t('plan.passBadge', { left: U.fmtDur(left) }) : 'PRO') : t('plan.free');
    let tierSub = '';
    if (paid && info.paidBy === 'pro') tierSub = sub && sub.status === 'active' ? t('plan.renews', { date: U.fmtDate(sub.currentEnd) }) : t('plan.expires', { date: U.fmtDate(info.paidUntil) });
    if (!paid && info.freeDailyLimit != null) tierSub = t('plan.todayUsage', { used: info.usageToday, limit: info.freeDailyLimit });

    root.innerHTML = `
      <div class="view-head"><h1>${U.esc(t('nav.plan'))}</h1><span class="sp"></span><button class="btn sm" id="refresh">⟳ ${U.esc(t('plan.refresh'))}</button></div>
      ${info.offline ? `<div class="banner warn">${U.esc(t('plan.offline'))}</div>` : ''}
      ${info.banned ? `<div class="banner bad">${U.esc(t('done.banned'))}</div>` : ''}
      <div class="card pad" style="margin-bottom:18px">
        <div class="row"><div class="grow"><div class="small muted">${U.esc(t('plan.current'))}</div>
          <div style="font-size:22px;font-weight:700">${U.esc(tierLine)}</div><div class="small muted">${U.esc(tierSub)}</div></div>
          <div id="acctBox" style="text-align:right"></div></div>
      </div>
      <h2 class="sec">${U.esc(t('plan.plans'))}</h2>
      <div class="plans" id="plans"></div>
      <p class="small muted" style="margin-top:10px">${U.esc(t('plan.safetyNote'))} <a href="#" id="refund">${U.esc(t('plan.refund'))}</a></p>
      <details class="card pad" style="margin-top:20px"><summary style="cursor:pointer;font-weight:600">${U.esc(t('plan.key.summary'))}</summary>
        <p class="small muted">${U.esc(email ? t('plan.key.noteLinked') : t('plan.key.noteAnon'))}</p>
        <div class="keybox"><code class="mono" id="keyText">${key ? '•'.repeat(24) : U.esc(t('plan.key.none'))}</code>
          <button class="btn sm" id="keyShow">${U.esc(t('plan.key.show'))}</button><button class="btn sm" id="keyCopy">${U.esc(t('plan.key.copy'))}</button></div>
        <p class="small" style="color:var(--warn)">${U.esc(t('plan.key.warning'))}</p>
        <div class="row"><input type="text" id="keyIn" class="grow mono" placeholder="${U.esc(t('plan.key.pastePh'))}"/><button class="btn" id="keyApply">${U.esc(t('plan.key.apply'))}</button></div>
        ${hist.length ? `<div style="margin-top:14px"><div class="small muted">${U.esc(t('plan.key.history'))}</div>${hist.map((h) =>
          `<div class="row small" style="margin-top:6px"><code class="mono">${U.esc(h.key.slice(0, 12))}…${U.esc(h.key.slice(-6))}</code><span class="muted">${U.esc(U.fmtDate(h.at))}</span>
            <button class="btn sm" data-restore="${U.esc(h.key)}">${U.esc(t('plan.key.restore'))}</button></div>`).join('')}</div>` : ''}
      </details>`;

    // account box
    const ab = U.$('#acctBox', root);
    if (email || info.account) {
      ab.innerHTML = `<div class="small muted">${U.esc(t('plan.signedInAs'))}</div><b></b><div><button class="btn sm" id="logout" style="margin-top:6px">${U.esc(t('plan.logout'))}</button></div>`;
      ab.querySelector('b').textContent = info.account?.email || email;
      U.$('#logout', ab).onclick = async () => {
        if (['running', 'paused'].includes(MDM.queue.status().state)) return U.toast.error(t('send.busy'));
        if (!(await U.confirm(t('plan.logout'), t('plan.logoutConfirm'), t('plan.logout')))) return;
        await L.signOut(); U.toast.ok(t('plan.loggedOut')); MDM.app.refreshPlan(); render();
      };
    } else {
      ab.innerHTML = `<button class="btn" id="gsign">G&nbsp; ${U.esc(t('plan.google'))}</button><div class="small muted" style="max-width:260px;margin-top:6px">${U.esc(t('plan.googleWhy'))}</div>`;
      U.$('#gsign', ab).onclick = async (e) => {
        if (['running', 'paused'].includes(MDM.queue.status().state)) return U.toast.error(t('send.busy'));
        e.target.disabled = true;
        try { await L.signInWithGoogle(); U.toast.ok(t('plan.signedIn')); MDM.app.refreshPlan(); render(); }
        catch (err) { U.toast.error(t('plan.signinFail', { msg: err.message })); e.target.disabled = false; }
      };
    }

    // plans
    const box = U.$('#plans', root);
    const freeCard = U.h(`<div class="card plan-card"><b>${U.esc(t('plan.free'))}</b><div class="price">₹0 <small>${U.esc(t('plan.forever'))}</small></div>
      <ul><li>${U.esc(t('plan.freeFeat1', { limit: info.freeDailyLimit ?? '—' }))}</li><li>${U.esc(t('plan.freeFeat2'))}</li><li>${U.esc(t('plan.freeFeat3'))}</li></ul>
      <button class="btn" disabled>${U.esc(paid ? t('plan.basePlan') : t('plan.currentPlan'))}</button></div>`);
    box.appendChild(freeCard);
    if (prodErr) box.appendChild(U.h(`<div class="card pad"><p>${U.esc(t('plan.loadFail'))}</p><button class="btn sm" id="retryP">${U.esc(t('common.retry'))}</button></div>`));
    for (const p of products || []) {
      const isCurrent = paid && ((p.kind === 'pass' && info.paidBy === 'pass') || (p.kind === 'subscription' && sub && sub.product === p.code && sub.status === 'active'));
      const per = p.kind === 'subscription' ? `/ ${t('plan.interval.' + (p.interval || 'month'))}` : t('plan.oneTime');
      const card = U.h(`<div class="card plan-card ${p.code.includes('month') ? 'hl' : ''}"><b></b><div class="price">${U.esc(p.price)} <small>${U.esc(per)}</small></div>
        <ul>${p.features.map((f) => `<li>${U.esc(f)}</li>`).join('')}</ul><button class="btn ${isCurrent ? '' : 'primary'}"></button></div>`);
      card.querySelector('b').textContent = p.name;
      const btn = card.querySelector('button');
      if (isCurrent && p.kind === 'subscription') { btn.textContent = t('plan.subscribed'); btn.disabled = true; }
      else if (!p.purchasable) { btn.textContent = t('plan.soon'); btn.disabled = true; }
      else {
        btn.textContent = p.kind === 'pass' && isCurrent ? t('plan.passExtend') : t('plan.buy', { name: p.name });
        btn.onclick = async () => {
          btn.disabled = true;
          try { await L.checkout(p.code); MDM.popups.watchUpgrade(); U.toast.info(t('plan.checkoutOpened'), 8000); }
          catch (e) { U.toast.error(t('plan.checkoutFail', { msg: e.message })); }
          btn.disabled = false;
        };
      }
      box.appendChild(card);
    }

    U.$('#refresh', root).onclick = async () => { await render({ force: true }); U.toast.ok(t('plan.refreshed')); MDM.app.refreshPlan(); };
    U.$('#retryP', root) && (U.$('#retryP', root).onclick = () => render());
    U.$('#refund', root).onclick = (e) => {
      e.preventDefault();
      U.modal({ title: t('plan.refund'), body: `<p>${U.esc(t('plan.refundBody', { email: MDM.config.SUPPORT_EMAIL }))}</p><div class="keybox"><code class="mono">${U.esc(MDM.config.SUPPORT_EMAIL)}</code></div>`,
        actions: [{ label: t('common.close'), value: null }, { label: t('plan.key.copy'), kind: 'primary', value: 'c' }] })
        .then((v) => { if (v) U.copy(MDM.config.SUPPORT_EMAIL).then(() => U.toast.ok(t('plan.copied'))); });
    };
    let shown = false;
    U.$('#keyShow', root).onclick = (e) => { shown = !shown; U.$('#keyText', root).textContent = shown ? key : '•'.repeat(24); e.target.textContent = shown ? t('plan.key.hide') : t('plan.key.show'); };
    U.$('#keyCopy', root).onclick = async () => U.toast[(await U.copy(key)) ? 'ok' : 'error'](t('plan.copied'));
    const apply = async (k) => {
      if (['running', 'paused'].includes(MDM.queue.status().state)) return U.toast.error(t('send.busy'));
      try { await L.applyKey(k); U.toast.ok(t('plan.key.applied')); MDM.app.refreshPlan(); render(); }
      catch (e) { U.toast.error(e.message === 'invalid_format' ? t('plan.key.invalid') : e.message === 'not_found' ? t('plan.key.notFound') : t('plan.key.fail')); }
    };
    U.$('#keyApply', root).onclick = () => apply(U.$('#keyIn', root).value);
    root.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = () => apply(b.dataset.restore)));
  }

  MDM.views = MDM.views || {};
  MDM.views.plan = { mount(el) { root = el; render(); }, unmount() { root = null; } };
})();
