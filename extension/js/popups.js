// Shared popups: free-limit upsell, server notices, account status, support report.
(() => {
  const U = MDM.u, t = (...a) => MDM.t(...a);

  // ---------- free limit reached ----------
  // left: recipients still waiting. Offers the 24h pass (when the server sells one) and PRO.
  async function limit({ left }) {
    const info = await MDM.license.entitlement({ force: true });
    let products = [];
    try { products = await MDM.license.products(); } catch (_) {}
    const pro = products.find((p) => p.kind === 'subscription' && p.purchasable && p.interval === 'month') || products.find((p) => p.kind === 'subscription' && p.purchasable);
    const pass = info.passOffer;
    const free = info.freeDailyLimit || 0;
    const cap = info.dailyCap || 100;
    const freeDays = free ? Math.ceil(left / free) : null;
    const proDays = Math.ceil(left / cap);
    const lines = [];
    lines.push(freeDays && freeDays > 1 ? t('limit.freeDays', { limit: free, days: freeDays }) : t('limit.freeTomorrow'));
    lines.push(proDays <= 1 ? t('limit.proToday', { n: left }) : t('limit.proDays', { n: left, days: proDays }));
    if (pass && left <= cap) lines.push(t('limit.passWithin', { n: left }));

    const body = U.h(`<div>
      <p class="limit-hero">${U.esc(left === 1 ? t('limit.titleOne') : t('limit.title', { n: left }))}</p>
      <ul>${lines.map((l) => `<li>${U.esc(l)}</li>`).join('')}</ul>
      <p class="small muted">${U.esc(t('limit.safe'))}</p>
      <div class="limit-choices"></div>
    </div>`);
    const box = body.querySelector('.limit-choices');
    const choice = (label, sub, kind, code) => {
      const b = U.h(`<button class="btn ${kind}"><span></span><small></small></button>`);
      b.children[0].textContent = label;
      b.children[1].textContent = sub;
      b.onclick = async () => {
        b.disabled = true;
        try { await MDM.license.checkout(code); watchUpgrade(); } catch (e) { U.toast.error(t('plan.checkoutFail', { msg: e.message })); }
        b.disabled = false;
      };
      box.appendChild(b);
    };
    const passFirst = pass && left <= cap;
    if (pass && passFirst) choice(`${t('plan.passName')} · ${pass.price}`, t('plan.passOnce'), 'primary', pass.code);
    if (pro) choice(`${pro.name} · ${pro.price}`, t('plan.perInterval', { interval: t('plan.interval.' + (pro.interval || 'month')) }), passFirst ? '' : 'primary', pro.code);
    if (pass && !passFirst) choice(`${t('plan.passName')} · ${pass.price}`, t('plan.passOnce'), '', pass.code);
    if (!box.children.length) box.remove();
    MDM.track('limit_popup', { left });
    return U.modal({ title: t('limit.heading'), body, actions: [{ label: t('limit.tomorrow'), value: 'later' }] });
  }

  // After checkout opens in a new tab, re-check the plan whenever the user comes back.
  let watching = null;
  function watchUpgrade() {
    if (watching) return;
    let tries = 0;
    const check = async () => {
      const info = await MDM.license.entitlement({ force: true });
      if (info.tier === 'paid') {
        stop();
        U.toast.ok(t('plan.applied'));
        MDM.app?.refreshPlan();
        document.querySelector('.modal-back')?.remove();
      } else if (++tries > 40) stop();
    };
    const onFocus = () => setTimeout(check, 1500);
    const timer = setInterval(check, 15000);
    addEventListener('focus', onFocus);
    const stop = () => { clearInterval(timer); removeEventListener('focus', onFocus); watching = null; };
    watching = stop;
  }

  // ---------- server notice ----------
  async function notice() {
    let n = null;
    try { n = await MDM.license.notice(); } catch (_) {}
    if (!n) return;
    const seen = (await U.store.get('noticesSeen', [])) || [];
    if (seen.includes(n.id) && n.level !== 'critical') return;
    await U.store.set('noticesSeen', [...seen, n.id].slice(-50));
    const body = U.h(`<div><p style="white-space:pre-line"></p></div>`);
    body.firstChild.textContent = n.body;
    const actions = [{ label: t('common.ok'), kind: n.linkUrl ? '' : 'primary', value: 'ok' }];
    if (n.linkUrl && /^https:\/\//.test(n.linkUrl)) actions.push({ label: n.linkLabel || t('notice.open'), kind: 'primary', value: 'link' });
    const v = await U.modal({ title: n.title, body, actions });
    if (v === 'link') chrome.tabs.create({ url: n.linkUrl });
  }

  // ---------- account status ----------
  async function accounts() {
    const [known, states, session, set, info] = await Promise.all([
      MDM.ig.knownAccounts(), MDM.policy.allAccountStates(), MDM.ig.getSession(), MDM.policy.settings(), MDM.license.entitlement(),
    ]);
    const limit = Math.min(set.dailyLimit, info.dailyCap || 100);
    const ids = Array.from(new Set([...Object.keys(known), ...Object.keys(states)]));
    const body = U.h(`<div><p class="small">${U.esc(t('acct.subtitle'))}</p><div class="list"></div><p class="small muted">${U.esc(t('acct.note'))}</p></div>`);
    const listEl = body.querySelector('.list');
    if (info.tier === 'free' && info.freeDailyLimit) {
      listEl.before(U.h(`<div class="banner info small">${U.esc(t('acct.freeNote', { used: info.usageToday, limit: info.freeDailyLimit }))}</div>`));
    }
    if (!ids.length) listEl.innerHTML = `<p class="muted">${U.esc(t('acct.empty'))}</p>`;
    for (const id of ids) {
      const k = known[id] || {};
      const s = states[id] || { count: 0 };
      const cur = session.ok && session.viewerId === id;
      const cool = s.igCooldownUntil && s.igCooldownUntil > Date.now() ? s.igCooldownUntil - Date.now() : 0;
      const row = U.h(`<div class="acct-row"><span class="ph"></span><div class="grow"><b></b> ${cur ? `<span class="pill acc">${U.esc(t('acct.current'))}</span>` : ''}
        <div class="small muted"></div></div><div class="meter"><i></i></div><b class="small">${s.count}/${limit}</b></div>`);
      row.querySelector('b').textContent = k.username ? '@' + k.username : id;
      row.querySelector('.small.muted').textContent = cool ? t('acct.cooldown', { time: U.fmtDur(cool) }) : t('acct.today');
      row.querySelector('.meter i').style.width = Math.min(100, (s.count / limit) * 100) + '%';
      if (k.pic) MDM.ig.picUrl(k.pic).then((u) => { if (u) row.querySelector('.ph').replaceWith(Object.assign(document.createElement('img'), { src: u, alt: '' })); });
      listEl.appendChild(row);
    }
    const v = await U.modal({ title: t('acct.title'), body, actions: [
      { label: t('common.close'), value: null },
      { label: t('acct.switch'), kind: 'primary', value: 'switch' },
    ] });
    if (v === 'switch') {
      if (MDM.queue.status().state === 'running') return U.toast.error(t('acct.pauseFirst'));
      await MDM.ig.focusInstagram();
      U.toast.info(t('acct.switchHint'), 9000);
    }
  }

  // ---------- support report ----------
  function support({ reason, category, sent }) {
    const subject = `[MeAPI DM] Sending stopped${category ? ` (${category})` : ''}`;
    const bodyText = [
      'Sending stopped. Details:',
      `- Version: ${MDM.config.VERSION}`,
      `- Time: ${new Date().toISOString()}`,
      `- Reason: ${reason}${category ? ' / ' + category : ''}`,
      `- Sent this run: ${sent ?? '?'}`,
      `- Browser: ${navigator.userAgent}`,
    ].join('\n');
    U.copy(bodyText);
    chrome.tabs.create({ url: `mailto:${MDM.config.SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}` });
    U.toast.info(t('support.copied', { email: MDM.config.SUPPORT_EMAIL }), 8000);
  }

  MDM.popups = { limit, notice, accounts, support, watchUpgrade };
})();
