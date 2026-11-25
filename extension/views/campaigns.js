// Campaigns view: saved send lists with progress; open, continue, retry failed, rename, end, delete, export.
(() => {
  const U = MDM.u, t = (...a) => MDM.t(...a), CAMP = MDM.campaigns, Q = MDM.queue;
  let root = null, filter = 'all', off = null;
  const open = new Set();

  async function render() {
    if (!root) return;
    const all = await CAMP.list();
    const st = Q.status();
    const counts = { all: all.length, notStarted: 0, active: 0, done: 0, closed: 0 };
    for (const c of all) counts[CAMP.displayState(c)]++;
    const shown = all.filter((c) => filter === 'all' || CAMP.displayState(c) === filter);
    root.innerHTML = `
      <div class="view-head"><h1>${U.esc(t('nav.campaigns'))}</h1><span class="sp"></span>
        <button class="btn primary" id="newCamp">＋ ${U.esc(t('camp.new'))}</button></div>
      <div class="filters" style="margin-bottom:14px">${['all', 'notStarted', 'active', 'done', 'closed'].map((f) =>
        `<button data-f="${f}" class="${f === filter ? 'on' : ''}">${U.esc(t('camp.state.' + f))} · ${counts[f]}</button>`).join('')}</div>
      <div class="camp-list" id="list"></div>`;
    root.querySelectorAll('.filters button').forEach((b) => (b.onclick = () => { filter = b.dataset.f; render(); }));
    U.$('#newCamp', root).onclick = async () => {
      if (['running', 'paused'].includes(st.state)) return U.toast.error(t('send.busy'));
      await U.store.remove('draft');
      MDM.app.go('send');
    };
    const list = U.$('#list', root);
    if (!all.length) {
      list.innerHTML = `<div class="card empty"><h3>${U.esc(t('camp.empty.title'))}</h3><p>${U.esc(t('camp.empty.body'))}</p></div>`;
      return;
    }
    if (!shown.length) list.innerHTML = `<div class="card empty"><p>${U.esc(t('camp.noMatch'))}</p></div>`;
    for (const c of shown) list.appendChild(card(c, st));
  }

  function card(c, st) {
    const s = CAMP.stats(c);
    const ds = CAMP.displayState(c);
    const isRunning = st.campaignId === c.id && ['running', 'paused'].includes(st.state);
    const pillKind = { notStarted: '', active: 'acc', done: 'ok', closed: 'warn' }[ds];
    const el = U.h(`<div class="card camp">
      <div class="head"><div class="grow"><b></b><div class="small muted">${U.esc(sourceLabel(c))} · ${U.esc(U.fmtDate(c.createdAt))}</div></div>
        ${isRunning ? `<span class="pill acc">● ${U.esc(st.state === 'paused' ? t('run.paused') : t('camp.sendingNow'))}</span>` : ''}
        <span class="pill ${pillKind}">${U.esc(t('camp.state.' + ds))}</span>
        <b class="small">${s.sent} / ${s.total}</b><span class="muted">${open.has(c.id) ? '▴' : '▾'}</span></div>
      <div class="prog"><i style="width:${s.total ? (s.sent / s.total) * 100 : 0}%"></i></div>
      <div class="body" ${open.has(c.id) ? '' : 'hidden'}>
        <div class="small">${U.esc(t('camp.breakdown', s))}</div>
        <div class="small muted" style="margin-top:8px">${U.esc(t('send.step.message'))}</div>
        <div class="msgbox"></div>
        <div class="row">
          ${ds !== 'closed' && ds !== 'done' ? `<button class="btn primary sm" data-a="send">${U.esc(ds === 'notStarted' ? t('camp.start') : t('camp.resume'))}</button>` : ''}
          <button class="btn sm" data-a="open">${U.esc(t('camp.open'))}</button>
          ${s.failed ? `<button class="btn sm" data-a="retry">${U.esc(t('camp.retry', { n: s.failed }))}</button>` : ''}
          <button class="btn sm" data-a="rename">${U.esc(t('camp.rename'))}</button>
          <button class="btn sm" data-a="export">${U.esc(t('camp.export'))}</button>
          <span class="grow"></span>
          ${ds === 'closed' ? `<button class="btn sm" data-a="reopen">${U.esc(t('camp.reopen'))}</button>` : `<button class="btn sm" data-a="close">${U.esc(t('camp.close'))}</button>`}
          <button class="btn sm danger" data-a="delete">${U.esc(t('camp.delete'))}</button>
        </div>
      </div></div>`);
    el.querySelector('.head b').textContent = c.name;
    el.querySelector('.msgbox').textContent = c.message || t('camp.noMessage');
    el.querySelector('.head').onclick = () => { open.has(c.id) ? open.delete(c.id) : open.add(c.id); render(); };
    el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); act(b.dataset.a, c, isRunning); }));
    return el;
  }

  function sourceLabel(c) {
    const src = c.source || {};
    if (src.type === 'followers' || src.type === 'following') return `@${src.target} · ${t('aud.' + src.type)}`;
    if (src.type === 'file') return src.fileName || t('send.src.file');
    return t('send.src.manual');
  }

  async function act(a, c, isRunning) {
    const busy = ['running', 'paused'].includes(Q.status().state);
    switch (a) {
      case 'open':
        if (await MDM.views.send.openCampaign(c.id)) MDM.app.go('send');
        break;
      case 'send':
        if (busy && !isRunning) return U.toast.error(t('send.busy'));
        if (!(await MDM.views.send.openCampaign(c.id))) return;
        MDM.app.go('send');
        if (!isRunning) {
          try { await Q.start({ campaignId: c.id }); } catch (e) { U.toast.error(e.message === 'no_session' ? t('send.err.noIg') : t('send.busy')); }
        }
        break;
      case 'retry':
        if (isRunning) return U.toast.error(t('send.busy'));
        await CAMP.retryFailed(c.id);
        U.toast.ok(t('camp.retried'));
        render();
        break;
      case 'rename': {
        const v = await U.modal({ title: t('camp.rename'), body: `<div class="form"><input type="text" id="rn" /></div>`,
          actions: [{ label: t('common.cancel'), value: null }, { label: t('common.save'), kind: 'primary', value: (w) => U.$('#rn', w).value.trim() }],
          onMount: (w) => { const i = U.$('#rn', w); i.value = c.name; i.focus(); i.select(); } });
        if (v) { await CAMP.rename(c.id, v); render(); }
        break;
      }
      case 'export': {
        const cols = ['username', ...(c.columns || []), 'state', 'error', 'sentAt'];
        const aoa = [cols, ...c.recipients.map((r) => cols.map((k) => k === 'username' ? r.username : k === 'state' ? r.state : k === 'error' ? r.error || '' : k === 'sentAt' ? (r.sentAt ? new Date(r.sentAt).toISOString() : '') : r.fields?.[k] ?? ''))];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Recipients');
        XLSX.writeFile(wb, `${c.name.replace(/[^\w@.-]+/g, '_').slice(0, 60)}.xlsx`);
        break;
      }
      case 'close':
        if (isRunning) return U.toast.error(t('send.busy'));
        if (await U.confirm(t('camp.close'), t('camp.closeConfirm'), t('camp.close'), true)) { await CAMP.close(c.id); render(); }
        break;
      case 'reopen':
        await CAMP.reopen(c.id); render();
        break;
      case 'delete':
        if (isRunning) return U.toast.error(t('send.busy'));
        if (await U.confirm(t('camp.delete'), t('camp.deleteConfirm'), t('camp.delete'), true)) {
          await CAMP.remove(c.id);
          const d = await U.store.get('draft', null);
          if (d?.campaignId === c.id) await U.store.set('draft', { ...d, campaignId: null });
          render();
          MDM.app.refreshBadge();
        }
        break;
      default:
    }
  }

  MDM.views = MDM.views || {};
  MDM.views.campaigns = {
    mount(el) { root = el; render(); off = Q.on((type) => { if (type === 'state' || type === 'done' || type === 'row') render(); }); },
    unmount() { off?.(); off = null; root = null; },
  };
})();
