// Settings: daily limit, interval, batch break (with a guide panel), language, data reset.
(() => {
  const U = MDM.u, t = (...a) => MDM.t(...a), P = MDM.policy;
  let root = null, focus = 'dailyLimit';

  async function render() {
    if (!root) return;
    const s = await P.settings();
    const H = P.HARD;
    const items = [
      { k: 'dailyLimit', min: 1, max: H.DAILY_MAX, step: 1, unit: t('set.unit.perDay'), val: s.dailyLimit },
      { k: 'intervalSec', min: H.INTERVAL_MIN, max: H.INTERVAL_MAX, step: 5, unit: t('set.unit.sec'), val: s.intervalSec },
      { k: 'batchBreakMin', min: H.BREAK_MIN, max: H.BREAK_MAX, step: 5, unit: t('set.unit.min'), val: s.batchBreakMin },
    ];
    root.innerHTML = `
      <div class="view-head"><h1>${U.esc(t('nav.settings'))}</h1></div>
      <div class="settings-grid">
        <div>
          <div class="card" id="sets">${items.map((i) => `
            <div class="setting ${focus === i.k ? 'on' : ''}" data-k="${i.k}">
              <div class="top"><b>${U.esc(t(`set.${i.k}.label`))}</b><span class="val"><span data-v>${i.val}</span><small>${U.esc(i.unit)}</small></span></div>
              <input type="range" min="${i.min}" max="${i.max}" step="${i.step}" value="${i.val}" />
              <div class="row small muted"><span>${i.min}</span><span class="grow"></span><span>${i.max}</span></div>
            </div>`).join('')}
          </div>
          <p class="small muted" style="margin:10px 2px">${t('set.hardCaps', { daily: H.DAILY_MAX, interval: H.INTERVAL_MIN, batch: H.BATCH_SIZE })}</p>
          <div class="row" style="margin-bottom:20px"><button class="btn primary" id="save">${U.esc(t('common.save'))}</button></div>

          <div class="card pad" style="margin-bottom:16px">
            <h2 class="sec">${U.esc(t('set.language'))}</h2>
            <select id="lang">${MDM.i18n.SUPPORTED.map((l) => `<option value="${l}" ${MDM.i18n.lang() === l ? 'selected' : ''}>${U.esc(MDM.i18n.NAMES[l])}</option>`).join('')}</select>
          </div>

          <div class="card pad danger-zone">
            <h2 class="sec" style="color:var(--bad)">${U.esc(t('set.danger.title'))}</h2>
            <p class="small">${U.esc(t('set.danger.body'))}</p>
            <div class="row"><button class="btn solid-danger" id="reset">${U.esc(t('set.danger.reset'))}</button>
              <button class="btn sm ghost" id="raw">${U.esc(t('set.raw'))}</button></div>
            <pre class="raw mono" id="rawOut" hidden style="margin-top:10px"></pre>
          </div>
        </div>
        <div class="card pad guide" id="guide"></div>
      </div>`;

    const paintGuide = () => {
      U.$('#guide', root).innerHTML = `<h3>${U.esc(t(`set.${focus}.title`))}</h3><p>${U.esc(t(`set.${focus}.body`))}</p>
        <hr style="border:0;border-top:1px solid var(--line2);margin:16px 0"/>
        <h3>${U.esc(t('set.guide.title'))}</h3><p>${U.esc(t('set.guide.intro'))}</p>
        <ul><li>${t('set.guide.tip1')}</li><li>${t('set.guide.tip2')}</li><li>${t('set.guide.tip3')}</li><li>${t('set.guide.tip4')}</li></ul>`;
    };
    paintGuide();
    root.querySelectorAll('.setting').forEach((el) => {
      const r = el.querySelector('input');
      r.oninput = () => { el.querySelector('[data-v]').textContent = r.value; };
      el.onclick = () => {
        focus = el.dataset.k;
        root.querySelectorAll('.setting').forEach((x) => x.classList.toggle('on', x === el));
        paintGuide();
      };
    });
    U.$('#save', root).onclick = async () => {
      const v = {};
      root.querySelectorAll('.setting').forEach((el) => { v[el.dataset.k] = parseInt(el.querySelector('input').value, 10); });
      await P.saveSettings(v);
      U.toast.ok(t('set.saved'));
      MDM.track('settings_save', v);
    };
    U.$('#lang', root).onchange = async (e) => { await MDM.i18n.setLang(e.target.value); MDM.app.rerender(); };
    U.$('#reset', root).onclick = async () => {
      if (['running', 'paused'].includes(MDM.queue.status().state)) return U.toast.error(t('send.busy'));
      if (!(await U.confirm(t('set.danger.title'), t('set.danger.confirm'), t('set.danger.reset'), true))) return;
      const all = await U.store.all();
      const keep = new Set(['licenseKey', 'licenseKeyAnon', 'licenseKeyHistory', 'accountEmail', 'lang', 'igAccounts']);
      await U.store.remove(Object.keys(all).filter((k) => !keep.has(k)));
      U.toast.ok(t('set.danger.done'));
      render();
    };
    U.$('#raw', root).onclick = async () => {
      const out = U.$('#rawOut', root);
      if (!out.hidden) { out.hidden = true; return; }
      const all = await U.store.all();
      const view = {
        settings: all.settings, lang: all.lang,
        accounts: Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('acct:'))),
        sentCount: Object.keys(all.sent || {}).length, historyCount: (all.history || []).length, campaigns: (all.campaigns || []).length,
        tier: all.tierCache ? { tier: all.tierCache.tier, paidBy: all.tierCache.paidBy, paidUntil: all.tierCache.paidUntil } : null,
      };
      out.textContent = JSON.stringify(view, null, 2);
      out.hidden = false;
    };
  }

  MDM.views = MDM.views || {};
  MDM.views.settings = { mount(el) { root = el; render(); }, unmount() { root = null; } };
})();
