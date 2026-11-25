// Send view: recipients (manual / Excel / followers / following), message, phone preview, run controls.
(() => {
  const U = MDM.u, t = (...a) => MDM.t(...a);
  const P = MDM.policy, IG = MDM.ig, CAMP = MDM.campaigns, Q = MDM.queue, T = MDM.template;
  const RESERVED = new Set(['username', 'status', 'rid', 'userid', '_status']);
  const DRAFT_KEY = 'draft';

  let root = null, table = null, offQueue = null, pollTimer = null, mountSeq = 0;
  let draft = null;          // { rows, columns, message, source, campaignId }
  let previewIdx = 0;
  const undo = { past: [], future: [] };

  const emptyDraft = () => ({ rows: [], columns: ['name'], message: '', source: { type: 'manual' }, campaignId: null });

  async function loadDraft() {
    const d = await U.store.get(DRAFT_KEY, null);
    draft = d && Array.isArray(d.rows) ? { ...emptyDraft(), ...d } : emptyDraft();
  }
  let saveTimer = null;
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => U.store.set(DRAFT_KEY, draft), 300);
  }

  const running = () => ['running', 'paused'].includes(Q.status().state);
  const locked = () => Q.status().state === 'running';

  // ---------- undo / redo ----------
  const snap = () => JSON.stringify({ rows: draft.rows, columns: draft.columns });
  function checkpoint() {
    undo.past.push(snap());
    if (undo.past.length > 60) undo.past.shift();
    undo.future = [];
    paintUndo();
  }
  function restore(s) {
    const v = JSON.parse(s);
    draft.rows = v.rows; draft.columns = v.columns;
    saveDraft(); buildTable(); paintAll();
  }
  function doUndo() { if (!undo.past.length || locked()) return; undo.future.push(snap()); restore(undo.past.pop()); paintUndo(); }
  function doRedo() { if (!undo.future.length || locked()) return; undo.past.push(snap()); restore(undo.future.pop()); paintUndo(); }
  function paintUndo() {
    if (!root) return;
    U.$('#undoBtn', root).disabled = !undo.past.length;
    U.$('#redoBtn', root).disabled = !undo.future.length;
  }

  // ---------- rows ----------
  const keyOf = (r) => U.normalizeUsername(r.username);
  function addRows(rows, { dedupe = true } = {}) {
    const have = new Set(draft.rows.map(keyOf).filter(Boolean));
    let added = 0, dup = 0, empty = 0;
    for (const r of rows) {
      const un = U.normalizeUsername(r.username);
      if (!un) { empty++; continue; }
      if (dedupe && have.has(un)) { dup++; continue; }
      have.add(un);
      draft.rows.push({ rid: U.uuid(), username: un, fields: r.fields || {}, userId: r.userId || null, fullName: r.fullName || '', pic: r.pic || null });
      added++;
    }
    return { added, dup, empty };
  }
  function ensureColumns(cols) {
    for (const c of cols) {
      const name = String(c || '').trim();
      if (!name || RESERVED.has(name.toLowerCase())) continue;
      if (!draft.columns.some((x) => x.toLowerCase() === name.toLowerCase())) draft.columns.push(name);
    }
  }

  // ---------- statuses from the bound campaign + live queue ----------
  let campaignCache = null;
  async function refreshCampaign() {
    campaignCache = draft.campaignId ? await CAMP.get(draft.campaignId) : null;
    if (draft.campaignId && !campaignCache) { draft.campaignId = null; saveDraft(); }
  }
  const liveStatus = new Map();
  function statusOf(rid) {
    if (liveStatus.has(rid)) return liveStatus.get(rid);
    const r = campaignCache?.recipients.find((x) => x.rid === rid);
    return r ? r.state : 'pending';
  }

  // ---------- table ----------
  function tableData() {
    return draft.rows.map((r, i) => ({ _i: i + 1, rid: r.rid, username: r.username, ...Object.fromEntries(draft.columns.map((c) => [c, r.fields?.[c] ?? (c.toLowerCase() === 'name' ? r.fullName || '' : '')])), _status: statusOf(r.rid) }));
  }
  function statusFmt(cell) {
    const s = cell.getValue() || 'pending';
    return `<span class="st-${s}">${U.esc(t('status.' + s))}</span>`;
  }
  function buildTable() {
    const el = U.$('#grid', root);
    if (!el) return;
    if (table) { try { table.destroy(); } catch (_) {} table = null; }
    const cols = [
      { title: '#', field: '_i', width: 48, headerSort: false, hozAlign: 'right', cssClass: 'muted' },
      { title: t('send.col.username'), field: 'username', editor: 'input', editable: () => !locked(), minWidth: 160, headerSort: false,
        formatter: (c) => (c.getValue() ? U.esc('@' + c.getValue()) : `<span class="muted">${U.esc(t('send.col.usernamePh'))}</span>`) },
      ...draft.columns.map((c) => ({ title: c, field: c, editor: 'input', editable: () => !locked(), minWidth: 110, headerSort: false,
        headerMenu: [{ label: t('send.col.remove'), action: () => removeColumn(c) }] })),
      { title: t('send.col.status'), field: '_status', width: 120, headerSort: false, formatter: statusFmt },
      { title: '', field: '_del', width: 40, headerSort: false, hozAlign: 'center', formatter: () => '<button class="icon-btn" title="Remove">×</button>',
        cellClick: (e, cell) => { if (!locked()) removeRow(cell.getRow().getData().rid); } },
    ];
    table = new Tabulator(el, {
      data: tableData(), columns: cols, layout: 'fitColumns', height: draft.rows.length > 12 ? 420 : false,
      placeholder: `<div class="empty"><h3>${U.esc(t('send.empty.title'))}</h3><p>${U.esc(t('send.empty.body'))}</p></div>`,
      index: 'rid', reactiveData: false,
    });
    table.on('cellEdited', (cell) => {
      const d = cell.getRow().getData();
      const row = draft.rows.find((r) => r.rid === d.rid);
      if (!row) return;
      checkpoint();
      const f = cell.getField();
      if (f === 'username') {
        const un = U.normalizeUsername(cell.getValue());
        if (un && draft.rows.some((r) => r !== row && keyOf(r) === un)) {
          U.toast.error(t('send.dupUsername', { username: un }));
          cell.restoreOldValue();
          undo.past.pop();
          return;
        }
        row.username = un; row.userId = null; row.fullName = ''; row.pic = null;
        if (un !== cell.getValue()) cell.getRow().update({ username: un });
      } else {
        row.fields = { ...row.fields, [f]: cell.getValue() };
      }
      saveDraft(); paintStats(); paintPreview();
    });
    table.on('rowClick', (e, row) => {
      previewIdx = Math.max(0, draft.rows.findIndex((r) => r.rid === row.getData().rid));
      paintPreview();
    });
  }
  function removeRow(rid) {
    checkpoint();
    draft.rows = draft.rows.filter((r) => r.rid !== rid);
    saveDraft(); buildTable(); paintAll();
  }
  function removeColumn(c) {
    if (running()) return U.toast.error(t('send.busy'));
    checkpoint();
    draft.columns = draft.columns.filter((x) => x !== c);
    for (const r of draft.rows) if (r.fields) delete r.fields[c];
    saveDraft(); buildTable(); paintAll();
  }

  // ---------- paste from Excel ----------
  function parseTSV(text) {
    const rows = [];
    let row = [], cell = '', i = 0, q = false;
    while (i < text.length) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        if (ch === '"') { q = false; i++; continue; }
        cell += ch; i++; continue;
      }
      if (ch === '"' && cell === '') { q = true; i++; continue; }
      if (ch === '\t') { row.push(cell); cell = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(cell); rows.push(row); row = []; cell = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      cell += ch; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }
  function onPaste(e) {
    if (locked()) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !a.closest('#grid')))) return;
    if (a && a.tagName === 'INPUT' && a.closest('#grid')) {
      // Single value into the cell being edited: let the browser do it.
      const txt = e.clipboardData.getData('text/plain');
      if (!/[\t\n]/.test(txt.trim())) return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    const grid = parseTSV(text);
    if (!grid.length) return;
    e.preventDefault();
    const res = importMatrix(grid, { headerGuess: true });
    toastImport(res, 'paste');
  }

  // Turns a 2D array into rows. If the first row looks like headers, use them; otherwise column 1 = username,
  // the rest map onto the existing columns in order.
  function importMatrix(m, { headerGuess }) {
    const first = m[0].map((s) => String(s).trim());
    const uIdx = first.findIndex((h) => /^(@?username|user ?name|instagram( id| handle| username)?|ig( handle| username)?|handle|profile)$/i.test(h));
    let header = null, body = m;
    if (uIdx >= 0 || (headerGuess && first.length > 1 && !first.some((h) => U.USERNAME_RE.test(U.normalizeUsername(h)) && /[._\d]/.test(h)) && m.length > 1)) {
      header = first; body = m.slice(1);
    }
    checkpoint();
    let rows;
    if (header) {
      const ui = uIdx >= 0 ? uIdx : 0;
      const others = header.map((h, i) => ({ h, i })).filter((x) => x.i !== ui && x.h);
      ensureColumns(others.map((x) => x.h));
      rows = body.map((r) => ({ username: r[ui], fields: Object.fromEntries(others.map((x) => [draft.columns.find((c) => c.toLowerCase() === x.h.toLowerCase()) || x.h, String(r[x.i] ?? '').trim()])) }));
    } else {
      rows = body.map((r) => ({ username: r[0], fields: Object.fromEntries(draft.columns.map((c, i) => [c, String(r[i + 1] ?? '').trim()])) }));
    }
    const res = addRows(rows);
    saveDraft(); buildTable(); paintAll();
    return res;
  }
  function toastImport({ added, dup, empty }, kind) {
    const parts = [t(`send.${kind}.done`, { n: added })];
    if (dup) parts.push(t('send.dupSkipped', { n: dup }));
    if (empty) parts.push(t('send.emptySkipped', { n: empty }));
    (added ? U.toast.ok : U.toast.info)(parts.join(' · '));
  }

  // ---------- sources ----------
  async function sourceManual() {
    const v = await U.modal({
      title: t('send.manual.title'),
      body: `<div class="form"><label><span>${U.esc(t('send.manual.label'))}</span><textarea id="manualIn" rows="8" style="width:100%" placeholder="natgeo\n@nasa\nhttps://instagram.com/meapi.in"></textarea></label>
        <p class="small muted">${U.esc(t('send.manual.hint'))}</p></div>`,
      actions: [{ label: t('common.cancel'), value: null }, { label: t('send.manual.add'), kind: 'primary', value: (w) => U.$('#manualIn', w).value }],
      onMount: (w) => setTimeout(() => U.$('#manualIn', w).focus(), 30),
    });
    if (!v) return;
    const names = v.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    checkpoint();
    const res = addRows(names.map((username) => ({ username })));
    saveDraft(); buildTable(); paintAll();
    toastImport(res, 'manual');
  }

  async function sourceFile() {
    const body = U.h(`<div>
      <div class="drop" id="drop"><b>${U.esc(t('send.file.select'))}</b><div class="small muted">${U.esc(t('send.file.types'))}</div></div>
      <input type="file" id="fileIn" accept=".xlsx,.xls,.csv,.tsv,.txt" hidden />
      <p class="small">${U.esc(t('send.file.hint'))}</p>
      <button class="btn sm" id="sample">${U.esc(t('send.file.sample'))}</button></div>`);
    let done = null;
    const pick = async (file) => {
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sh = wb.Sheets[wb.SheetNames[0]];
        const m = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' }).map((r) => r.map((c) => String(c ?? '')));
        const rows = m.filter((r) => r.some((c) => c.trim()));
        if (rows.length < 1) throw new Error(t('send.file.noData'));
        const res = importMatrix(rows, { headerGuess: true });
        draft.source = { type: 'file', fileName: file.name };
        saveDraft();
        toastImport(res, 'file');
        MDM.track('import_file', { rows: res.added });
        done?.();
      } catch (e) {
        U.toast.error(t('send.file.parseError', { msg: e.message }));
      }
    };
    U.modal({ title: t('send.file.title'), body, actions: [{ label: t('common.close'), value: null }], onMount: (w, close) => {
      done = () => close(null);
      const inp = U.$('#fileIn', w), drop = U.$('#drop', w);
      drop.onclick = () => inp.click();
      inp.onchange = () => pick(inp.files[0]);
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); };
      U.$('#sample', w).onclick = () => {
        const ws = XLSX.utils.aoa_to_sheet([['username', 'name', 'company', 'city'], ['natgeo', 'Priya Sharma', 'ABC Pvt Ltd', 'Mumbai'], ['nasa', 'Rahul Verma', 'XYZ Traders', 'Ahmedabad']]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Recipients');
        XLSX.writeFile(wb, 'meapi-dm-sample.xlsx');
      };
    } });
  }

  async function sourceAudience(kind) {
    const s = await IG.getSession();
    if (!s.ok) return U.toast.error(t('send.err.noIg'));
    const set = await P.settings();
    const sentIdx = await P.sentIndex();
    const body = U.h(`<div class="form">
      <label><span>${U.esc(t('aud.target'))}</span><input type="text" id="audT" placeholder="${U.esc(t('aud.targetPh'))}" /></label>
      <div><span class="small" style="display:block;margin-bottom:4px">${U.esc(t('aud.list'))}</span>
        <div class="seg" id="audK"><button data-k="followers">${U.esc(t('aud.followers'))}</button><button data-k="following">${U.esc(t('aud.following'))}</button></div></div>
      <label><span>${U.esc(t('aud.count'))}</span><input type="number" id="audN" value="100" min="1" max="5000" /></label>
      <label class="chk"><input type="checkbox" id="audSkip" ${set.skipSent ? 'checked' : ''}/> ${U.esc(t('aud.skipSent'))}</label>
      <div id="audProg" class="small"></div></div>`);
    let ctl = null, collected = [];
    const result = await U.modal({
      title: t('aud.title'), body,
      actions: [{ label: t('common.cancel'), value: 'cancel' }, { label: t('aud.start'), kind: 'primary', value: 'noop' }],
      onMount: (w, close) => {
        let k = kind;
        const seg = U.$('#audK', w);
        const paintSeg = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
        seg.querySelectorAll('button').forEach((b) => (b.onclick = () => { k = b.dataset.k; paintSeg(); }));
        paintSeg();
        setTimeout(() => U.$('#audT', w).focus(), 30);
        const [cancelBtn, goBtn] = w.querySelectorAll('.modal-foot .btn');
        cancelBtn.onclick = () => { if (ctl) ctl.abort(); else close('cancel'); };
        goBtn.onclick = async () => {
          const target = U.normalizeUsername(U.$('#audT', w).value);
          const max = Math.max(1, Math.min(5000, parseInt(U.$('#audN', w).value, 10) || 100));
          if (!U.USERNAME_RE.test(target)) return U.toast.error(t('aud.errTarget'));
          const skip = U.$('#audSkip', w).checked;
          const have = new Set(draft.rows.map(keyOf));
          ctl = new AbortController();
          goBtn.disabled = true;
          cancelBtn.textContent = t('aud.stop');
          const prog = U.$('#audProg', w);
          prog.textContent = t('aud.collecting', { n: 0 });
          try {
            const r = await IG.enumerate({
              source: k, target, max, csrf: s.csrf, signal: ctl.signal,
              exclude: (u) => have.has(String(u.username).toLowerCase()) || (skip && sentIdx[String(u.pk || u.id)]),
              onProgress: (n) => { prog.textContent = t('aud.collecting', { n }); },
            });
            collected = r.users;
            if (ctl.signal.aborted) {
              close(collected.length ? { users: collected, target, k, partial: true } : 'cancel');
            } else close({ users: collected, target, k, limited: r.limited, skipped: r.skipped });
          } catch (e) {
            const partial = e.partial || [];
            const msg = e.message === 'rate_limited' ? t('aud.errRate') : e.message === 'user_not_found' ? t('aud.errNotFound')
              : e.message === 'private' ? t('aud.errPrivate') : e.message === 'login_required' ? t('send.err.noIg') : t('aud.errBlocked');
            if (partial.length) close({ users: partial, target, k, partial: true, error: msg });
            else { U.toast.error(msg); close('cancel'); }
          }
        };
      },
    });
    if (!result || result === 'cancel' || result === 'noop') return;
    if (result.partial) {
      const keep = await U.confirm(t('aud.title'), (result.error ? result.error + ' ' : '') + t('aud.partialAsk', { n: result.users.length }), t('aud.partialKeep', { n: result.users.length }));
      if (!keep) return;
    }
    checkpoint();
    ensureColumns(['name']);
    const res = addRows(result.users.map((u) => ({ username: u.username, userId: u.userId, fullName: u.fullName, pic: u.pic, fields: { name: u.fullName } })));
    draft.source = { type: result.k, target: result.target };
    saveDraft(); buildTable(); paintAll();
    U.toast.ok(t('aud.collected', { n: res.added }) + (res.dup ? ' · ' + t('send.dupSkipped', { n: res.dup }) : ''));
    if (result.limited) U.toast.info(t('aud.limited', { n: result.users.length }), 8000);
    MDM.track('import_audience', { kind: result.k, n: res.added });
  }

  async function addColumn() {
    if (running()) return U.toast.error(t('send.busy'));
    const v = await U.modal({
      title: t('send.col.add'), body: `<div class="form"><input type="text" id="colIn" placeholder="${U.esc(t('send.col.addPh'))}"/></div>`,
      actions: [{ label: t('common.cancel'), value: null }, { label: t('common.add'), kind: 'primary', value: (w) => U.$('#colIn', w).value.trim() }],
      onMount: (w) => setTimeout(() => U.$('#colIn', w).focus(), 30),
    });
    if (!v) return;
    if (RESERVED.has(v.toLowerCase()) || draft.columns.some((c) => c.toLowerCase() === v.toLowerCase())) return U.toast.error(t('send.col.exists', { name: v }));
    checkpoint();
    draft.columns.push(v);
    saveDraft(); buildTable(); paintAll();
  }

  async function addBlankRow() {
    if (locked()) return;
    checkpoint();
    draft.rows.push({ rid: U.uuid(), username: '', fields: {} });
    saveDraft(); buildTable(); paintAll();
    const last = table.getRows().pop();
    setTimeout(() => last?.getCell('username')?.edit(), 50);
  }

  async function clearAll() {
    if (running()) return U.toast.error(t('send.busy'));
    if (!draft.rows.length && !draft.campaignId) return;
    if (!(await U.confirm(t('send.new.title'), t('send.new.confirm'), t('send.new.ok'), true))) return;
    const msg = draft.message;
    draft = emptyDraft();
    draft.message = msg;
    liveStatus.clear();
    undo.past = []; undo.future = [];
    campaignCache = null;
    saveDraft(); buildTable(); paintAll();
  }

  // ---------- campaign sync ----------
  async function upsertCampaign() {
    const rows = draft.rows.filter((r) => r.username).map((r) => ({ ...r, fields: { ...r.fields } }));
    if (draft.campaignId && campaignCache && campaignCache.status !== 'closed') {
      await CAMP.setRecipients(draft.campaignId, rows, draft.columns);
      await CAMP.setMessage(draft.campaignId, draft.message);
    } else {
      const c = await CAMP.create({ source: draft.source, message: draft.message, columns: draft.columns, recipients: rows });
      // Keep row ids identical so statuses line up.
      draft.campaignId = c.id;
      draft.rows = c.recipients.map((r) => ({ rid: r.rid, username: r.username, fields: r.fields, userId: r.userId, fullName: r.fullName, pic: r.pic }));
      saveDraft();
    }
    await refreshCampaign();
    return campaignCache;
  }

  function validate() {
    if (!draft.message.trim()) { U.toast.error(t('send.err.noMessage')); U.$('#msg', root).focus(); return false; }
    if (!draft.rows.some((r) => r.username)) { U.toast.error(t('send.err.noRecipients')); return false; }
    return true;
  }

  async function startSending() {
    if (running()) return;
    if (!validate()) return;
    const s = await IG.getSession();
    if (!s.ok) return U.toast.error(t('send.err.noIg'));
    const c = await upsertCampaign();
    const stats = CAMP.stats(c);
    if (stats.pending === 0) {
      if (stats.failed > 0 && (await U.confirm(t('send.retry.title'), t('send.retry.body', { n: stats.failed }), t('send.retry.ok')))) {
        await CAMP.retryFailed(c.id);
        await refreshCampaign();
      } else return U.toast.info(t('send.nothingLeft'));
    }
    liveStatus.clear();
    try {
      await Q.start({ campaignId: c.id });
    } catch (e) {
      U.toast.error(e.message === 'no_session' ? t('send.err.noIg') : t('send.busy'));
    }
    buildTable(); paintAll();
  }

  async function saveAsCampaign() {
    if (running()) return U.toast.error(t('send.busy'));
    if (!validate()) return;
    const was = draft.campaignId;
    await upsertCampaign();
    U.toast.ok(was ? t('send.saved') : t('send.campaignCreated'));
    paintAll();
    MDM.app.refreshBadge();
  }

  async function resumeRun() {
    // Edits made while paused go into the campaign before we continue.
    await upsertCampaign();
    Q.resume();
  }

  // Called from the Campaigns view.
  async function openCampaign(id) {
    if (running() && Q.status().campaignId !== id) { U.toast.error(t('send.busy')); return false; }
    const c = await CAMP.get(id);
    if (!c) return false;
    draft = {
      rows: c.recipients.map((r) => ({ rid: r.rid, username: r.username, fields: r.fields, userId: r.userId, fullName: r.fullName, pic: r.pic })),
      columns: c.columns?.length ? c.columns : ['name'], message: c.message, source: c.source, campaignId: c.id,
    };
    undo.past = []; undo.future = [];
    liveStatus.clear();
    await U.store.set(DRAFT_KEY, draft);
    return true;
  }

  // ---------- painting ----------
  function paintAll() { paintStats(); paintChips(); paintPreview(); paintRun(); paintBanner(); paintUndo(); }

  function paintStats() {
    if (!root) return;
    const n = draft.rows.filter((r) => r.username).length;
    const counts = { sent: 0, failed: 0, skipped: 0 };
    for (const r of draft.rows) { const s = statusOf(r.rid); if (counts[s] != null) counts[s]++; }
    const parts = [t('send.count', { n })];
    if (counts.sent) parts.push(t('send.countSent', { n: counts.sent }));
    if (counts.failed) parts.push(t('send.countFailed', { n: counts.failed }));
    if (counts.skipped) parts.push(t('send.countSkipped', { n: counts.skipped }));
    U.$('#gridStats', root).textContent = parts.join(' · ');
  }

  function paintChips() {
    if (!root) return;
    const vars = ['username', 'name', 'first_name', ...draft.columns.filter((c) => !['name', 'first_name'].includes(c.toLowerCase()))];
    const box = U.$('#chips', root);
    box.innerHTML = vars.map((v) => `<button class="chip" data-v="${U.esc(v)}">{{${U.esc(v)}}}</button>`).join('') +
      `<button class="chip" data-v="__spin" title="${U.esc(t('send.spinHint'))}">{Hi|Hello}</button>`;
    box.querySelectorAll('.chip').forEach((b) => (b.onclick = () => insertAtCursor(b.dataset.v === '__spin' ? '{Hi|Hello|Hey}' : `{{${b.dataset.v}}}`)));
  }
  function insertAtCursor(text) {
    const ta = U.$('#msg', root);
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.dispatchEvent(new Event('input'));
  }

  let picToken = 0;
  async function paintPreview() {
    if (!root) return;
    const rows = draft.rows.filter((r) => r.username);
    const thread = U.$('#pvThread', root), who = U.$('#pvWho', root), sub = U.$('#pvSub', root), nav = U.$('#pvNav', root);
    if (!rows.length) {
      thread.innerHTML = `<div class="hint">${U.esc(t('send.preview.empty'))}</div>`;
      who.textContent = t('send.preview.add'); sub.textContent = '';
      nav.hidden = true;
      return;
    }
    previewIdx = Math.min(Math.max(0, previewIdx), rows.length - 1);
    const r = rows[previewIdx];
    who.textContent = r.fullName || r.fields?.name || r.username;
    sub.textContent = '@' + r.username;
    nav.hidden = false;
    U.$('#pvPos', root).textContent = `${previewIdx + 1} / ${rows.length}`;
    const text = T.render(draft.message, r, mulberry(previewIdx + 1));
    thread.innerHTML = text ? `<div class="bubble"></div>` : `<div class="hint">${U.esc(t('send.preview.noMsg'))}</div>`;
    if (text) thread.firstChild.textContent = text;
    const tok = ++picToken;
    const img = U.$('#pvPic', root);
    img.removeAttribute('src');
    if (r.pic) { const u = await IG.picUrl(r.pic); if (u && tok === picToken) img.src = u; }
  }
  // Deterministic spintax pick per preview row (so the preview doesn't flicker while typing).
  function mulberry(seed) {
    return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  }

  function paintBanner() {
    if (!root) return;
    const el = U.$('#campBanner', root);
    if (!campaignCache) { el.hidden = true; return; }
    const s = CAMP.stats(campaignCache);
    el.hidden = false;
    el.innerHTML = `<span>📁</span><div class="grow"><b></b><div class="small muted">${U.esc(t('camp.progress', { sent: s.sent, total: s.total, pending: s.pending }))}</div></div>
      <button class="btn sm" id="bnNew">${U.esc(t('send.new.btn'))}</button>`;
    el.querySelector('b').textContent = campaignCache.name;
    U.$('#bnNew', el).onclick = clearAll;
  }

  let tick = null;
  function paintRun() {
    if (!root) return;
    const st = Q.status();
    const box = U.$('#runbox', root), acts = U.$('#actions', root);
    const mine = st.campaignId && st.campaignId === draft.campaignId;
    const active = (st.state === 'running' || st.state === 'paused') && mine;
    acts.hidden = active;
    box.hidden = !active;
    U.$('#msg', root).disabled = st.state === 'running' && mine;
    clearInterval(tick);
    if (!active) return;
    const p = st.progress || {};
    const c = campaignCache ? CAMP.stats(campaignCache) : { total: 0, sent: 0, failed: 0, skipped: 0 };
    const doneN = c.sent + c.failed + c.skipped;
    U.$('.bar i', box).style.width = (c.total ? (doneN / c.total) * 100 : 0) + '%';
    const phase = U.$('.phase', box), detail = U.$('.detail', box);
    const btns = U.$('.runbtns', box);
    btns.innerHTML = st.state === 'paused'
      ? `<button class="btn primary" id="rRes">${U.esc(t('run.resume'))}</button><button class="btn danger" id="rCan">${U.esc(t('run.cancel'))}</button>`
      : `<button class="btn" id="rPau">${U.esc(t('run.pause'))}</button><button class="btn danger" id="rCan">${U.esc(t('run.cancel'))}</button>`;
    U.$('#rRes', btns) && (U.$('#rRes', btns).onclick = resumeRun);
    U.$('#rPau', btns) && (U.$('#rPau', btns).onclick = () => Q.pause('user'));
    U.$('#rCan', btns).onclick = async () => { if (await U.confirm(t('run.cancel'), t('run.cancelConfirm'), t('run.cancel'), true)) Q.cancel(); };
    const render = () => {
      const left = p.until ? Math.max(0, p.until - Date.now()) : 0;
      if (st.state === 'paused') {
        const r = st.pauseReason;
        phase.textContent = r === 'offline' ? t('run.offline') : r === 'transport' ? t('run.transport') : t('run.paused');
        detail.textContent = r === 'transport' ? t('run.transportDetail') : r === 'offline' ? t('run.offlineDetail') : t('run.pausedDetail');
      } else if (p.phase === 'sending') {
        phase.textContent = t('run.sending', { current: p.current, total: p.total });
        detail.textContent = '@' + (p.username || '');
      } else if (p.phase === 'interval') {
        phase.textContent = t('run.interval', { s: Math.ceil(left / 1000) });
        detail.textContent = t('run.counts', { sent: c.sent, failed: c.failed, total: c.total });
      } else if (p.phase === 'break') {
        phase.textContent = t('run.break');
        detail.textContent = t('run.breakDetail', { time: U.fmtDur(left) });
      } else if (p.phase === 'probe') {
        phase.textContent = t('run.probe');
        detail.textContent = t('run.probeDetail', { time: U.fmtDur(left) });
      } else {
        phase.textContent = t('run.starting');
        detail.textContent = '';
      }
    };
    render();
    tick = setInterval(render, 1000);
  }

  // ---------- info bar ----------
  async function paintInfo() {
    if (!root) return;
    const seq = mountSeq;
    const [s, set, info, peek] = await Promise.all([IG.getSession(), P.settings(), MDM.license.entitlement(), IG.transportPeek()]);
    if (seq !== mountSeq || !root) return;
    const bar = U.$('#infobar', root);
    const a = s.ok ? await P.acct(s.viewerId) : { count: 0 };
    const cap = Math.min(set.dailyLimit, info.dailyCap || 100);
    const conn = !s.ok ? `<span class="dot bad"></span>${U.esc(t('info.igLogin'))}`
      : peek.ready ? `<span class="dot ok"></span>${U.esc(t('info.connected'))}`
      : peek.tabId ? `<span class="dot warn"></span>${U.esc(t('info.connecting'))}`
      : `<span class="dot warn"></span>${U.esc(t('info.noTab'))}`;
    const plan = info.tier === 'paid'
      ? `<span class="pill ok">${U.esc(info.paidBy === 'pass' ? t('plan.passBadge', { left: U.fmtDur(info.paidUntil - Date.now()) }) : 'PRO')}</span>`
      : `<span class="pill">${U.esc(t('plan.free'))}</span> <span class="small muted">${info.freeDailyLimit != null ? `${info.usageToday}/${info.freeDailyLimit}` : ''}</span>`;
    bar.innerHTML = `
      <div><span class="k">${U.esc(t('info.instagram'))}</span><span class="v">${conn}</span>
        <span class="row">${!s.ok ? `<button class="btn sm" id="ibOpen">${U.esc(t('info.openIg'))}</button>` : !peek.ready ? `<button class="btn sm" id="ibRe">${U.esc(t('info.reconnect'))}</button>` : ''}</span></div>
      <div class="acct" style="min-width:150px"><span class="k">${U.esc(t('info.account'))}</span><span class="v"><img id="ibPic" alt="" hidden/>${s.ok ? U.esc('@' + (s.username || s.viewerId)) : '—'}</span></div>
      <div><span class="k">${U.esc(t('info.today'))}</span><span class="v">${a.count} / ${cap}</span><div class="meter"><i style="width:${Math.min(100, (a.count / cap) * 100)}%"></i></div></div>
      <div><span class="k">${U.esc(t('info.plan'))}</span><span class="v">${plan}</span></div>
      <div><span class="k">${U.esc(t('info.pacing'))}</span><span class="v small">${U.esc(t('info.pacingVal', { s: set.intervalSec, b: P.HARD.BATCH_SIZE, m: set.batchBreakMin }))}</span>
        <a href="#" id="ibSet" class="small">${U.esc(t('info.change'))}</a></div>
      <div style="margin-left:auto;justify-content:center"><button class="btn sm" id="ibAcct">${U.esc(t('acct.title'))}</button></div>`;
    U.$('#ibOpen', bar) && (U.$('#ibOpen', bar).onclick = async () => { await IG.focusInstagram(); });
    U.$('#ibRe', bar) && (U.$('#ibRe', bar).onclick = async (e) => { e.target.disabled = true; await IG.transportReopen(); paintInfo(); });
    U.$('#ibSet', bar).onclick = (e) => { e.preventDefault(); MDM.app.go('settings'); };
    U.$('#ibAcct', bar).onclick = () => MDM.popups.accounts();
    if (s.ok && s.pic) IG.picUrl(s.pic).then((u) => { const im = U.$('#ibPic', bar); if (u && im) { im.src = u; im.hidden = false; } });
  }

  // ---------- queue events ----------
  async function onQueue(type, d) {
    if (!root) return;
    if (type === 'row') {
      liveStatus.set(d.rid, d.status);
      table?.updateData([{ rid: d.rid, _status: d.status }]).catch(() => {});
      if (['sent', 'failed', 'skipped'].includes(d.status)) { await refreshCampaign(); liveStatus.delete(d.rid); paintBanner(); paintInfo(); }
      paintStats();
      return;
    }
    if (type === 'progress' || type === 'state') { await refreshCampaign(); paintRun(); return; }
    if (type === 'switched') { U.toast.info(d.username ? t('run.switched', { handle: d.username }) : t('run.switchedUnknown')); paintInfo(); return; }
    if (type === 'warn' && d.kind === 'ig_cooldown') { U.toast.info(t('run.cooldownWarn', { time: U.fmtDur(d.until - Date.now()) }), 9000); return; }
    if (type === 'done') {
      await refreshCampaign();
      buildTable(); paintAll(); paintInfo();
      MDM.app.refreshPlan();
      handleDone(d);
    }
  }

  async function handleDone(d) {
    const counts = { sent: d.sent, failed: d.failed, left: d.left };
    switch (d.reason) {
      case 'complete': U.toast.ok(t('done.complete', counts), 8000); break;
      case 'cancelled': U.toast.info(t('done.cancelled', counts), 8000); break;
      case 'daily_limit': U.modal({ title: t('done.dailyTitle'), body: `<p>${U.esc(t('done.daily', { limit: d.limit, ...counts }))}</p>` }); break;
      case 'free_limit': MDM.popups.limit({ left: d.left }); break;
      case 'session': U.modal({ title: t('done.sessionTitle'), body: `<p>${U.esc(t('done.session', counts))}</p>` }); break;
      case 'acct_switch': U.modal({ title: t('done.switchTitle'), body: `<p>${U.esc(t('done.switch', counts))}</p>` }); break;
      case 'banned': U.modal({ title: t('done.bannedTitle'), body: `<p>${U.esc(t('done.banned'))}</p>` }); break;
      case 'ig_block': U.modal({ title: t('done.igTitle'), body: `<p>${U.esc(t('done.ig', counts))}</p><p class="small muted">${U.esc(t('done.igTip'))}</p>` }); break;
      case 'fail_streak':
      case 'error': {
        const v = await U.modal({ title: t('done.failTitle'), body: `<p>${U.esc(t('done.fail', { ...counts, cat: d.category || d.error || '?' }))}</p>`,
          actions: [{ label: t('common.close'), value: null }, { label: t('support.contact'), kind: 'primary', value: 'mail' }] });
        if (v === 'mail') MDM.popups.support({ reason: d.reason, category: d.category || d.error, sent: d.sent });
        break;
      }
      default: break;
    }
  }

  // ---------- mount ----------
  async function mount(el) {
    root = el;
    const seq = ++mountSeq;
    await loadDraft();
    await refreshCampaign();
    if (seq !== mountSeq) return;
    const set = await P.settings();
    el.innerHTML = `
      <div class="view-head"><h1>${U.esc(t('nav.send'))}</h1><span class="sp"></span></div>
      <div class="card infobar" id="infobar"><div><span class="k">…</span></div></div>
      <div id="campBanner" class="camp-banner" hidden></div>
      <div class="send-grid">
        <div>
          <div class="card pad" style="margin-bottom:16px">
            <h2 class="sec"><span class="n">1</span>${U.esc(t('send.step.recipients'))}</h2>
            <div class="sources">
              <button class="source" data-s="manual"><span class="ico">✍️</span><b>${U.esc(t('send.src.manual'))}</b><span>${U.esc(t('send.src.manualDesc'))}</span></button>
              <button class="source" data-s="file"><span class="ico">📊</span><b>${U.esc(t('send.src.file'))}</b><span>${U.esc(t('send.src.fileDesc'))}</span></button>
              <button class="source" data-s="followers"><span class="ico">👥</span><b>${U.esc(t('send.src.followers'))}</b><span>${U.esc(t('send.src.followersDesc'))}</span></button>
              <button class="source" data-s="following"><span class="ico">➡️</span><b>${U.esc(t('send.src.following'))}</b><span>${U.esc(t('send.src.followingDesc'))}</span></button>
            </div>
            <div class="card" style="box-shadow:none">
              <div class="gridbar">
                <button class="btn sm" id="addRow">＋ ${U.esc(t('send.addRow'))}</button>
                <button class="btn sm" id="addCol">＋ ${U.esc(t('send.col.add'))}</button>
                <button class="btn sm" id="undoBtn" title="Ctrl+Z">↶ ${U.esc(t('send.undo'))}</button>
                <button class="btn sm" id="redoBtn" title="Ctrl+Y">↷ ${U.esc(t('send.redo'))}</button>
                <button class="btn sm ghost danger" id="clearBtn">${U.esc(t('send.clear'))}</button>
                <span class="stats" id="gridStats"></span>
              </div>
              <div id="grid"></div>
              <div class="gridfoot">
                <label class="chk"><input type="checkbox" id="skipSent" ${set.skipSent ? 'checked' : ''}/> ${U.esc(t('send.skipSent'))}</label>
                <span class="grow"></span><span>${U.esc(t('send.pasteHint'))}</span>
              </div>
            </div>
          </div>
          <div class="card pad">
            <h2 class="sec"><span class="n">2</span>${U.esc(t('send.step.message'))}</h2>
            <div class="small muted">${U.esc(t('send.vars'))}</div>
            <div class="chips" id="chips"></div>
            <textarea id="msg" placeholder="${U.esc(t('send.msgPh'))}"></textarea>
            <div class="msg-foot"><span>${U.esc(t('send.spinHint'))}</span><span id="msgLen"></span></div>
            <div class="actions" id="actions">
              <button class="btn primary lg" id="startBtn">${U.esc(t('send.start'))}</button>
              <button class="btn" id="saveBtn">${U.esc(t('send.saveCampaign'))}</button>
              <span class="small muted">${U.esc(t('send.safetyNote'))}</span>
            </div>
            <div class="card runbox" id="runbox" hidden>
              <div class="row"><div class="grow"><div class="phase"></div><div class="detail"></div></div><div class="row runbtns"></div></div>
              <div class="bar"><i style="width:0"></i></div>
            </div>
          </div>
        </div>
        <div>
          <div class="phone"><div class="screen">
            <div class="top"><img id="pvPic" class="ph" alt="" /><div><b id="pvWho"></b><small id="pvSub"></small></div></div>
            <div class="thread" id="pvThread"></div>
            <div class="compose">${U.esc(t('send.preview.compose'))}</div>
          </div>
          <div class="preview-nav" id="pvNav"><button id="pvPrev">‹</button><span id="pvPos"></span><button id="pvNext">›</button></div></div>
        </div>
      </div>`;

    el.querySelectorAll('.source').forEach((b) => (b.onclick = () => {
      if (locked()) return U.toast.error(t('send.busy'));
      ({ manual: sourceManual, file: sourceFile, followers: () => sourceAudience('followers'), following: () => sourceAudience('following') })[b.dataset.s]();
    }));
    U.$('#addRow', el).onclick = addBlankRow;
    U.$('#addCol', el).onclick = addColumn;
    U.$('#undoBtn', el).onclick = doUndo;
    U.$('#redoBtn', el).onclick = doRedo;
    U.$('#clearBtn', el).onclick = clearAll;
    U.$('#startBtn', el).onclick = startSending;
    U.$('#saveBtn', el).onclick = saveAsCampaign;
    U.$('#skipSent', el).onchange = (e) => P.saveSettings({ skipSent: e.target.checked });
    U.$('#pvPrev', el).onclick = () => { previewIdx--; paintPreview(); };
    U.$('#pvNext', el).onclick = () => { previewIdx++; paintPreview(); };
    const ta = U.$('#msg', el);
    ta.value = draft.message;
    const onMsg = () => {
      draft.message = ta.value;
      U.$('#msgLen', el).textContent = t('send.chars', { n: ta.value.length });
      saveDraft(); paintPreview();
    };
    ta.oninput = onMsg;
    onMsg();
    el.addEventListener('paste', onPaste);
    el.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && !e.target.closest('#grid'))) return;
      if (e.target.tagName === 'INPUT') return; // editing a cell: let the input handle its own undo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
    });

    buildTable();
    paintAll();
    paintInfo();
    offQueue = Q.on(onQueue);
    pollTimer = setInterval(paintInfo, 8000);
  }

  function unmount() {
    mountSeq++;
    offQueue?.(); offQueue = null;
    clearInterval(pollTimer); clearInterval(tick);
    if (table) { try { table.destroy(); } catch (_) {} table = null; }
    clearTimeout(saveTimer);
    if (draft) U.store.set(DRAFT_KEY, draft);
    root = null;
  }

  MDM.views = MDM.views || {};
  MDM.views.send = { mount, unmount, openCampaign };
})();
