// App shell: navigation, boot, plan badge in the sidebar, notice on start.
(() => {
  const U = MDM.u, t = (...a) => MDM.t(...a);
  const NAV = [
    { id: 'send', ico: '✉️' },
    { id: 'campaigns', ico: '📁' },
    { id: 'history', ico: '🕘' },
    { id: 'settings', ico: '⚙️' },
    { id: 'plan', ico: '⭐' },
    { id: 'selftest', ico: '🩺' },
  ];
  let current = null;

  function paintNav() {
    const nav = U.$('#nav');
    nav.innerHTML = NAV.map((n) => `<button data-id="${n.id}" class="${n.id === current ? 'on' : ''}"><span class="ico">${n.ico}</span>${U.esc(t('nav.' + n.id))}<span class="badge" data-badge="${n.id}" hidden></span></button>`).join('');
    nav.querySelectorAll('button').forEach((b) => (b.onclick = () => go(b.dataset.id)));
    refreshBadge();
  }

  function go(id) {
    if (!MDM.views[id]) id = 'send';
    if (current && MDM.views[current]) MDM.views[current].unmount();
    current = id;
    location.hash = id;
    U.$$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    const el = U.$('#content');
    el.innerHTML = '';
    el.scrollTop = 0;
    MDM.views[id].mount(el);
  }

  async function refreshBadge() {
    const list = await MDM.campaigns.list();
    const n = list.filter((c) => ['active', 'notStarted'].includes(MDM.campaigns.displayState(c))).length;
    const b = U.$('[data-badge="campaigns"]');
    if (b) { b.hidden = !n; b.textContent = n; }
    const s = MDM.queue.status();
    const sb = U.$('[data-badge="send"]');
    if (sb) { sb.hidden = !['running', 'paused'].includes(s.state); sb.textContent = s.state === 'paused' ? '❚❚' : '●'; }
  }

  async function refreshPlan() {
    const info = await MDM.license.entitlement();
    const foot = U.$('#sideFoot');
    const label = info.tier === 'paid' ? (info.paidBy === 'pass' ? t('plan.passShort') : 'PRO') : t('plan.free');
    foot.innerHTML = `<div class="plan"><span>${U.esc(t('info.plan'))}</span><span class="pill ${info.tier === 'paid' ? 'ok' : ''}">${U.esc(label)}</span></div>
      ${info.tier !== 'paid' ? `<button class="btn sm primary" style="width:100%;margin:6px 0" id="upg">${U.esc(t('plan.upgrade'))}</button>` : ''}
      <div>v${U.esc(MDM.config.VERSION)} · <a href="#" id="help">${U.esc(t('nav.help'))}</a></div>`;
    U.$('#upg', foot) && (U.$('#upg', foot).onclick = () => go('plan'));
    U.$('#help', foot).onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: MDM.config.WEBSITE }); };
  }

  function rerender() {
    document.documentElement.lang = MDM.i18n.lang();
    paintNav();
    refreshPlan();
    go(current || 'send');
  }

  // Warn before closing the tab while a run is going.
  addEventListener('beforeunload', (e) => {
    if (['running', 'paused'].includes(MDM.queue.status().state)) { e.preventDefault(); e.returnValue = ''; }
  });
  MDM.queue.on((type) => { if (type === 'state' || type === 'done') refreshBadge(); });

  async function boot() {
    await MDM.i18n.init();
    document.documentElement.lang = MDM.i18n.lang();
    current = (location.hash || '#send').slice(1);
    paintNav();
    go(current);
    await MDM.license.ensureKey();
    refreshPlan();
    MDM.ig.transportEnsure(); // open the Instagram tab in the background so sending is ready
    MDM.track('app_open');
    setTimeout(() => MDM.popups.notice(), 1200);
  }

  MDM.app = { go, refreshBadge, refreshPlan, rerender };
  boot();
})();
