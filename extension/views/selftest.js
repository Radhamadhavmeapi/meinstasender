// Self-test: cookies → Instagram tab → user lookup → chat connection → (optional) real DM to yourself.
// The optional send bypasses our counters and duplicate list so it never affects real campaigns.
(() => {
  const U = MDM.u, t = (...a) => MDM.t(...a), IG = MDM.ig;
  let root = null, busy = false;

  function render() {
    if (!root) return;
    root.innerHTML = `
      <div class="view-head"><h1>${U.esc(t('nav.selftest'))}</h1></div>
      <p class="muted" style="max-width:720px">${U.esc(t('test.desc'))}</p>
      <div class="row" style="margin:12px 0 16px">
        <label class="chk"><input type="checkbox" id="withSend" /> ${U.esc(t('test.includeSend'))}</label>
        <span class="grow"></span><button class="btn primary" id="run">${U.esc(t('test.run'))}</button>
      </div>
      <div class="card" id="steps"></div>
      <details style="margin-top:14px"><summary class="small muted" style="cursor:pointer">${U.esc(t('test.raw'))}</summary><pre class="raw mono card pad" id="raw"></pre></details>`;
    U.$('#run', root).onclick = run;
  }

  async function run() {
    if (busy) return;
    if (['running', 'paused'].includes(MDM.queue.status().state)) return U.toast.error(t('send.busy'));
    busy = true;
    const btn = U.$('#run', root);
    btn.disabled = true;
    const withSend = U.$('#withSend', root).checked;
    const steps = [
      { k: 'server', fn: async () => { const ok = await MDM.license.serverReachable(); if (!ok) throw new Error('license server unreachable'); return MDM.config.API_BASE; } },
      { k: 'cookies', fn: async () => { const s = await IG.getSession({ refreshMe: true }); if (!s.ok) throw new Error('not logged in to Instagram'); ctx.s = s; return `viewer ${s.viewerId} · @${s.username || '?'}`; } },
      { k: 'transport', fn: async () => { const r = await IG.transportEnsure(); if (!r.ok) throw new Error(r.error || 'tab not ready'); return `tab ${r.tabId}`; } },
      { k: 'lookup', fn: async () => { IG.clearLookupCache(); const u = await IG.resolveUser(ctx.s.username, ctx.s.csrf); ctx.u = u; return `@${u.username} → ${u.userId} (via ${u.via})`; } },
      { k: 'mqtt', fn: async () => { const r = await IG.mqttHandshake(); if (!r.ok) throw Object.assign(new Error(r.error), { layer: r.layer }); return 'handshake ok'; } },
    ];
    if (withSend) steps.push({ k: 'send', fn: async () => {
      const th = await IG.createThread(ctx.u.userId);
      await IG.sendText(ctx.s.viewerId, th, `MeAPI DM self-test ✓ ${new Date().toLocaleString()}`);
      return `thread ${th}`;
    } });
    const ctx = {};
    const box = U.$('#steps', root);
    box.innerHTML = steps.map((s) => `<div class="step" data-k="${s.k}"><span class="ic">○</span><div class="grow"><div class="ttl">${U.esc(t('test.step.' + s.k))}</div><div class="small muted"></div></div></div>`).join('');
    const log = [];
    let failed = false;
    for (const s of steps) {
      const el = box.querySelector(`[data-k="${s.k}"]`);
      if (failed) { el.querySelector('.ic').textContent = '–'; el.querySelector('.small').textContent = t('test.skipped'); continue; }
      el.querySelector('.ic').textContent = '…';
      const t0 = performance.now();
      try {
        const out = await s.fn();
        el.querySelector('.ic').textContent = '✅';
        el.querySelector('.small').textContent = `${out} · ${Math.round(performance.now() - t0)} ms`;
        log.push({ step: s.k, ok: true, out });
      } catch (e) {
        failed = true;
        el.querySelector('.ic').textContent = '❌';
        el.querySelector('.small').textContent = `${e.layer ? e.layer + ': ' : ''}${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`;
        log.push({ step: s.k, ok: false, error: e.message, layer: e.layer, status: e.status, body: e.body });
      }
    }
    U.$('#raw', root).textContent = JSON.stringify({ version: MDM.config.VERSION, at: new Date().toISOString(), log }, null, 2);
    MDM.track('selftest', { ok: !failed, failedAt: log.find((l) => !l.ok)?.step || null });
    btn.disabled = false;
    busy = false;
  }

  MDM.views = MDM.views || {};
  MDM.views.selftest = { mount(el) { root = el; render(); }, unmount() { root = null; } };
})();
