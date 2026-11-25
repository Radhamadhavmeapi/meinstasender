// History view: every attempt, filter by status, search, expand for details, export, unblock, clear.
(() => {
  const U = MDM.u, t = (...a) => MDM.t(...a), P = MDM.policy;
  const STATUSES = ['success', 'failure', 'skipped'];
  const PAGE = 50;
  let root = null;
  const state = { q: '', statuses: new Set(STATUSES), page: 0, open: new Set() };

  async function render() {
    if (!root) return;
    const [all, accounts] = await Promise.all([P.history(), MDM.ig.knownAccounts()]);
    const q = state.q.trim().toLowerCase();
    const rows = all.filter((r) => state.statuses.has(r.status) && (!q || String(r.username || '').includes(q) || String(r.message || '').toLowerCase().includes(q)));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * PAGE, state.page * PAGE + PAGE);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, all.filter((r) => r.status === s).length]));
    root.innerHTML = `
      <div class="view-head"><h1>${U.esc(t('nav.history'))}</h1><span class="sp"></span>
        <button class="btn sm" id="exCsv">${U.esc(t('hist.exportCsv'))}</button>
        <button class="btn sm" id="exJson">${U.esc(t('hist.exportJson'))}</button>
        <button class="btn sm danger" id="clr">${U.esc(t('hist.clear'))}</button></div>
      <div class="row" style="margin-bottom:12px">
        <input type="search" id="q" placeholder="${U.esc(t('hist.search'))}" value="${U.esc(state.q)}" style="width:280px"/>
        <div class="filters">${STATUSES.map((s) => `<button data-s="${s}" class="${state.statuses.has(s) ? 'on' : ''}">${U.esc(t('hist.status.' + s))} · ${counts[s]}</button>`).join('')}</div>
      </div>
      <div class="card" id="tbl"></div>`;
    const tbl = U.$('#tbl', root);
    if (!all.length) tbl.innerHTML = `<div class="empty"><h3>${U.esc(t('hist.empty.title'))}</h3><p>${U.esc(t('hist.empty.body'))}</p></div>`;
    else if (!rows.length) tbl.innerHTML = `<div class="empty"><p>${U.esc(t('hist.noMatch'))}</p></div>`;
    else {
      tbl.innerHTML = `<table class="t"><thead><tr><th>${U.esc(t('hist.col.time'))}</th><th>${U.esc(t('hist.col.recipient'))}</th><th>${U.esc(t('hist.col.from'))}</th>
        <th>${U.esc(t('hist.col.status'))}</th><th>${U.esc(t('hist.col.message'))}</th></tr></thead><tbody></tbody></table>
        <div class="pager"><span>${U.esc(t('hist.count', { n: rows.length }))}</span>
        <button class="btn sm" id="pp" ${state.page === 0 ? 'disabled' : ''}>‹</button><span>${state.page + 1} / ${pages}</span>
        <button class="btn sm" id="pn" ${state.page >= pages - 1 ? 'disabled' : ''}>›</button></div>`;
      const tb = tbl.querySelector('tbody');
      for (const r of slice) {
        const kind = r.status === 'success' ? 'ok' : r.status === 'failure' ? 'bad' : 'warn';
        const from = accounts[r.viewerId]?.username ? '@' + accounts[r.viewerId].username : r.viewerId || '—';
        const tr = U.h(`<table><tr class="click"><td class="small">${U.esc(U.fmtTime(r.at))}</td><td><b></b></td><td class="small muted"></td>
          <td><span class="pill ${kind}">${U.esc(t('hist.status.' + r.status))}</span>${r.category ? ` <span class="small muted">${U.esc(t('cat.' + r.category))}</span>` : ''}</td>
          <td class="msg"></td></tr></table>`).querySelector('tr');
        tr.querySelector('b').textContent = '@' + (r.username || '?');
        tr.children[2].textContent = from;
        tr.querySelector('.msg').textContent = r.message || '';
        tr.onclick = () => { state.open.has(r.id) ? state.open.delete(r.id) : state.open.add(r.id); render(); };
        tb.appendChild(tr);
        if (state.open.has(r.id)) {
          const d = U.h(`<table><tr class="detail-row"><td colspan="5"><div class="row" style="align-items:flex-start">
            <div class="grow"><div class="small muted">${U.esc(t('hist.col.message'))}</div><div class="msgbox" style="white-space:pre-wrap;margin:4px 0 8px"></div>
            <pre class="raw mono"></pre></div>
            <div class="row"><a class="btn sm" target="_blank" href="https://www.instagram.com/${encodeURIComponent(r.username || '')}/">${U.esc(t('hist.profile'))}</a>
            ${r.status === 'success' || r.category === 'duplicate' ? `<button class="btn sm" data-ub>${U.esc(t('hist.unblock'))}</button>` : ''}</div></div></td></tr></table>`).querySelector('tr');
          d.querySelector('.msgbox').textContent = r.message || t('hist.noMessage');
          const { message, ...rest } = r;
          d.querySelector('pre').textContent = JSON.stringify(rest, null, 2);
          const ub = d.querySelector('[data-ub]');
          if (ub) ub.onclick = async () => {
            if (await U.confirm(t('hist.unblock'), t('hist.unblockConfirm', { username: r.username }), t('hist.unblock'))) {
              await P.unmarkSent(r.username);
              U.toast.ok(t('hist.unblocked'));
            }
          };
          tb.appendChild(d);
        }
      }
      U.$('#pp', tbl).onclick = () => { state.page--; render(); };
      U.$('#pn', tbl).onclick = () => { state.page++; render(); };
    }
    const qi = U.$('#q', root);
    let deb;
    qi.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { state.q = qi.value; state.page = 0; render().then(() => { const n = U.$('#q', root); n.focus(); n.selectionStart = n.value.length; }); }, 250); };
    root.querySelectorAll('.filters button').forEach((b) => (b.onclick = () => {
      const s = b.dataset.s;
      state.statuses.has(s) ? state.statuses.delete(s) : state.statuses.add(s);
      if (!state.statuses.size) state.statuses = new Set(STATUSES);
      state.page = 0; render();
    }));
    U.$('#exJson', root).onclick = () => U.download(`meapi-dm-history-${U.todayUTC()}.json`, JSON.stringify(all, null, 2));
    U.$('#exCsv', root).onclick = () => {
      const cols = ['at', 'status', 'category', 'username', 'userId', 'viewerId', 'message', 'error', 'threadId', 'campaignId'];
      const ws = XLSX.utils.json_to_sheet(all.map((r) => Object.fromEntries(cols.map((c) => [c, c === 'at' ? new Date(r.at).toISOString() : r[c] ?? '']))), { header: cols });
      U.download(`meapi-dm-history-${U.todayUTC()}.csv`, XLSX.utils.sheet_to_csv(ws), 'text/csv');
    };
    U.$('#clr', root).onclick = async () => {
      if (await U.confirm(t('hist.clear'), t('hist.clearConfirm'), t('hist.clear'), true)) { await P.clearHistory(); render(); }
    };
  }

  MDM.views = MDM.views || {};
  MDM.views.history = { mount(el) { root = el; render(); }, unmount() { root = null; } };
})();
