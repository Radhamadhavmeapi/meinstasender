// The send queue. Runs one campaign at a time inside the app page.
//
// Per recipient: pause/cancel check → session + account check → daily limit → batch break → skip-if-sent
//   → server reserve (free-tier quota) → look up user id → render message → open thread → send → record → random interval.
//
// Stops on: logged out, Instagram limiting the account, daily limit, free limit, account switched mid-run,
//           3 failures in a row twice (after one 30-minute cool-off probe).
// Pauses (and keeps the recipient pending) on: no internet, Instagram tab lost.
(() => {
  const U = MDM.u, P = MDM.policy, IG = MDM.ig, L = MDM.license, CAMP = MDM.campaigns, T = MDM.template;
  const PROBE_WAIT_MS = 30 * 60 * 1000;
  const STREAK_STOP = 3;

  const listeners = new Set();
  const emit = (type, data = {}) => listeners.forEach((fn) => { try { fn(type, data); } catch (e) { console.error(e); } });

  let st = fresh();
  function fresh() {
    return {
      state: 'idle',            // idle | running | paused | done
      campaignId: null, viewerId: null, csrf: null,
      paused: false, pauseReason: null, cancelled: false, allowSwitch: false,
      resumeWaiter: null, waitCtl: null,
      results: new Map(),       // rid → 'sent' | 'failed' | 'skipped'
      attempted: new Set(),
      streak: [], probeUsed: false,
      progress: null, stop: null, onlineWatch: null,
    };
  }

  const summary = () => {
    let sent = 0, failed = 0, skipped = 0;
    for (const v of st.results.values()) { if (v === 'sent') sent++; else if (v === 'failed') failed++; else if (v === 'skipped') skipped++; }
    return { sent, failed, skipped };
  };

  function setProgress(p) { st.progress = p; emit('progress', p); }
  function setState(s) { st.state = s; emit('state', { state: s, reason: st.pauseReason }); }

  async function wait(ms) {
    st.waitCtl = new AbortController();
    await U.sleep(ms, st.waitCtl.signal);
    st.waitCtl = null;
  }
  async function waitUntil(t, phase) {
    setProgress({ phase, until: t });
    while (Date.now() < t && !st.paused && !st.cancelled) await wait(Math.min(t - Date.now(), 60000));
  }
  function waitResume() {
    if (!st.paused) return Promise.resolve();
    return new Promise((r) => { st.resumeWaiter = r; });
  }

  function pause(reason = 'user') {
    if (st.state !== 'running') return;
    st.paused = true;
    st.pauseReason = reason;
    st.allowSwitch = true;
    st.waitCtl?.abort();
    setState('paused');
    if (reason === 'offline') watchOnline();
  }
  function resume() {
    if (st.state !== 'paused') return;
    st.paused = false;
    st.pauseReason = null;
    unwatchOnline();
    setState('running');
    st.resumeWaiter?.();
    st.resumeWaiter = null;
  }
  function cancel() {
    if (st.state !== 'running' && st.state !== 'paused') return;
    st.cancelled = true;
    st.waitCtl?.abort();
    if (st.paused) { st.paused = false; st.resumeWaiter?.(); }
  }

  // Auto-resume once both the internet and our server are reachable again.
  function watchOnline() {
    unwatchOnline();
    const check = async () => {
      if (navigator.onLine && (await L.serverReachable())) resume();
    };
    const timer = setInterval(check, 30000);
    addEventListener('online', check);
    st.onlineWatch = () => { clearInterval(timer); removeEventListener('online', check); };
  }
  function unwatchOnline() { st.onlineWatch?.(); st.onlineWatch = null; }

  function rowEvent(rid, status, extra = {}) { emit('row', { rid, status, ...extra }); }

  async function start({ campaignId }) {
    if (st.state === 'running' || st.state === 'paused') throw new Error('busy');
    const session = await IG.getSession();
    if (!session.ok) throw new Error('no_session');
    st = fresh();
    Object.assign(st, { campaignId, viewerId: session.viewerId, csrf: session.csrf });
    setState('running');
    MDM.track('send_start', { campaign: campaignId });
    const a = await P.acct(session.viewerId);
    if (a.igCooldownUntil > Date.now()) emit('warn', { kind: 'ig_cooldown', until: a.igCooldownUntil });
    run().catch((e) => {
      console.error('[queue] crashed', e);
      finish({ reason: 'error', error: String(e.message || e) });
    });
  }

  function finish(stop) {
    unwatchOnline();
    st.stop = stop;
    setProgress(null);
    setState('done');
    const s = summary();
    emit('done', { ...stop, ...s });
    MDM.track('send_done', { reason: stop.reason, sent: s.sent, failed: s.failed });
  }

  async function run() {
    const ent = await L.entitlement({ force: true });
    for (;;) {
      if (st.cancelled) return finish({ reason: 'cancelled', left: await leftCount() });
      if (st.paused) { await waitResume(); continue; }

      const c = await CAMP.get(st.campaignId);
      if (!c || c.status === 'closed') return finish({ reason: 'cancelled', left: 0 });
      const r = c.recipients.find((x) => x.state === 'pending' && !st.attempted.has(x.rid));
      if (!r) return finish({ reason: 'complete', left: await leftCount() });

      // Session / account switch.
      const s = await IG.getSession();
      if (!s.ok) return finish({ reason: 'session', left: await leftCount() });
      if (s.viewerId !== st.viewerId) {
        if (!st.allowSwitch) return finish({ reason: 'acct_switch', left: await leftCount() });
        st.viewerId = s.viewerId; st.csrf = s.csrf;
        emit('switched', { username: s.username });
      }
      st.allowSwitch = false;
      st.csrf = s.csrf;

      const set = await P.settings();
      const a = await P.acct(st.viewerId);
      const cap = Math.min(set.dailyLimit, ent.dailyCap || P.HARD.DAILY_MAX);
      if (a.count >= cap) return finish({ reason: 'daily_limit', limit: cap, left: await leftCount() });
      if (a.breakUntil > Date.now()) { await waitUntil(a.breakUntil, 'break'); continue; }

      // Skip people this browser already messaged (from any account).
      if (set.skipSent) {
        const prior = await P.wasSent(r);
        if (prior) {
          await CAMP.mark(st.campaignId, r.rid, { state: 'skipped', error: 'already_sent' });
          st.results.set(r.rid, 'skipped');
          rowEvent(r.rid, 'skipped');
          await P.addHistory({ status: 'skipped', username: r.username, userId: r.userId, viewerId: st.viewerId, campaignId: st.campaignId, category: 'duplicate' });
          continue;
        }
      }

      // Server-side quota (free plan).
      const q = await L.reserve();
      if (!q.ok) {
        if (q.error === 'free_limit') return finish({ reason: 'free_limit', limit: q.freeDailyLimit, left: await leftCount() });
        if (q.error === 'banned') return finish({ reason: 'banned', left: await leftCount() });
        pause('offline');
        continue;
      }

      st.attempted.add(r.rid);
      const total = c.recipients.length;
      const done = c.recipients.filter((x) => x.state !== 'pending').length;
      setProgress({ phase: 'sending', current: done + 1, total, username: r.username });
      rowEvent(r.rid, 'sending');

      let text = '';
      let user = null;
      try {
        user = r.userId ? { userId: r.userId, fullName: r.fullName } : await IG.resolveUser(r.username, st.csrf);
        if (set.skipSent && !r.userId && (await P.wasSent({ userId: user.userId }))) {
          await L.release();
          await CAMP.mark(st.campaignId, r.rid, { state: 'skipped', userId: user.userId, error: 'already_sent' });
          st.results.set(r.rid, 'skipped');
          rowEvent(r.rid, 'skipped');
          continue;
        }
        text = T.render(c.message, { ...r, fullName: r.fullName || user.fullName });
        if (!text) throw Object.assign(new Error('empty_message'), { layer: 'template' });
        const threadId = await IG.createThread(user.userId);
        await IG.sendText(st.viewerId, threadId, text);

        await P.markSent({ userId: user.userId, username: r.username, viewerId: st.viewerId });
        await CAMP.mark(st.campaignId, r.rid, { state: 'sent', userId: user.userId, fullName: user.fullName, sentBy: st.viewerId });
        await P.noteAttempt(st.viewerId, { sent: true });
        await P.addHistory({ status: 'success', username: r.username, userId: user.userId, viewerId: st.viewerId, campaignId: st.campaignId, message: text, threadId });
        st.results.set(r.rid, 'sent');
        st.streak = [];
        rowEvent(r.rid, 'sent');
        MDM.track('send_ok');
      } catch (e) {
        const cat = P.classify(e);
        if (!e.published) await L.release();
        const terminal = P.TERMINAL.has(cat);
        const retryLater = cat === 'transport' || cat === 'network';
        if (retryLater) {
          st.attempted.delete(r.rid); // try this person again after the pause
          rowEvent(r.rid, 'pending');
        } else {
          await CAMP.mark(st.campaignId, r.rid, { state: 'failed', userId: user?.userId, error: cat, terminal });
          st.results.set(r.rid, 'failed');
          rowEvent(r.rid, 'failed', { error: cat });
          await P.noteAttempt(st.viewerId, { sent: false });
        }
        await P.addHistory({ status: 'failure', username: r.username, userId: user?.userId || r.userId, viewerId: st.viewerId, campaignId: st.campaignId,
          message: text, category: cat, error: String(e.message || e), layer: e.layer || null, httpStatus: e.status || null });
        MDM.track('send_fail', { cat, layer: e.layer || null });

        if (cat === 'session') return finish({ reason: 'session', left: await leftCount() });
        if (cat === 'ig_block') { await P.noteIgBlock(st.viewerId); return finish({ reason: 'ig_block', left: await leftCount() }); }
        if (cat === 'transport') { pause('transport'); continue; }
        if (cat === 'network') { pause('offline'); continue; }
        if (!terminal) {
          st.streak.push(cat);
          if (st.streak.length >= STREAK_STOP) {
            if (st.probeUsed) return finish({ reason: 'fail_streak', category: cat, left: await leftCount() });
            st.probeUsed = true;
            st.streak = [];
            await waitUntil(Date.now() + PROBE_WAIT_MS, 'probe');
            continue;
          }
        }
      }

      const ms = await P.nextInterval();
      await waitUntil(Date.now() + ms, 'interval');
    }
  }

  async function leftCount() {
    const c = await CAMP.get(st.campaignId);
    return c ? c.recipients.filter((x) => x.state === 'pending').length : 0;
  }

  MDM.queue = {
    start, pause, resume, cancel,
    status: () => ({ state: st.state, campaignId: st.campaignId, pauseReason: st.pauseReason, progress: st.progress, results: new Map(st.results), stop: st.stop, viewerId: st.viewerId }),
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    reset: () => { if (st.state === 'done') st = fresh(); },
  };
})();
