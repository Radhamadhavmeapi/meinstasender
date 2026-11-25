// Safety limits, per-account counters, de-duplication, history and error classification.
//
// Storage:
//   settings              { dailyLimit, intervalSec, batchBreakMin, skipSent }
//   acct:<viewerId>       { day, count, batchCount, lastSendAt, breakUntil, igCooldownUntil }
//   sent                  { [userId]: { at, by, username } }   — everyone this browser ever messaged
//   history               HistoryRecord[] (newest first, max 5000)
(() => {
  const U = MDM.u;

  const HARD = Object.freeze({
    DAILY_MAX: 100,          // per Instagram account per UTC day
    INTERVAL_MIN: 20,        // seconds between sends (actual wait is random 1–2×)
    INTERVAL_MAX: 300,
    BATCH_SIZE: 10,          // attempts before a long break
    BREAK_MIN: 30,           // minutes
    BREAK_MAX: 240,
    HISTORY_MAX: 5000,
    IG_COOLDOWN_H: 24,       // after Instagram blocks an account
  });
  const DEFAULTS = Object.freeze({ dailyLimit: 50, intervalSec: 30, batchBreakMin: 60, skipSent: true });

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  async function settings() {
    const s = { ...DEFAULTS, ...((await U.store.get('settings', {})) || {}) };
    return {
      dailyLimit: clamp(parseInt(s.dailyLimit, 10) || DEFAULTS.dailyLimit, 1, HARD.DAILY_MAX),
      intervalSec: clamp(parseInt(s.intervalSec, 10) || DEFAULTS.intervalSec, HARD.INTERVAL_MIN, HARD.INTERVAL_MAX),
      batchBreakMin: clamp(parseInt(s.batchBreakMin, 10) || DEFAULTS.batchBreakMin, HARD.BREAK_MIN, HARD.BREAK_MAX),
      skipSent: s.skipSent !== false,
    };
  }
  async function saveSettings(patch) {
    const cur = (await U.store.get('settings', {})) || {};
    await U.store.set('settings', { ...cur, ...patch });
    return settings();
  }

  // ---- per-account state ----
  async function acct(viewerId) {
    const s = (await U.store.get(`acct:${viewerId}`, null)) || {};
    const today = U.todayUTC();
    // The daily count resets at 00:00 UTC; breaks and cooldowns are wall-clock and carry over.
    if (s.day !== today) { s.day = today; s.count = 0; }
    return { count: 0, batchCount: 0, lastSendAt: 0, breakUntil: 0, igCooldownUntil: 0, ...s };
  }
  const saveAcct = (viewerId, s) => U.store.set(`acct:${viewerId}`, s);

  async function allAccountStates() {
    const all = await U.store.all();
    const today = U.todayUTC();
    const out = {};
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('acct:')) continue;
      out[k.slice(5)] = { ...v, count: v.day === today ? v.count || 0 : 0 };
    }
    return out;
  }

  // Counts one attempt (success or failed send) toward the batch; returns the updated state.
  async function noteAttempt(viewerId, { sent }) {
    const s = await acct(viewerId);
    const set = await settings();
    if (sent) { s.count += 1; s.lastSendAt = Date.now(); }
    s.batchCount += 1;
    if (s.batchCount >= HARD.BATCH_SIZE) {
      s.batchCount = 0;
      const base = set.batchBreakMin * 60 * 1000;
      s.breakUntil = Date.now() + U.jitter(base, base * 1.25);
    }
    await saveAcct(viewerId, s);
    return s;
  }
  async function noteIgBlock(viewerId) {
    const s = await acct(viewerId);
    s.igCooldownUntil = Date.now() + HARD.IG_COOLDOWN_H * 3600 * 1000;
    await saveAcct(viewerId, s);
  }
  async function clearBreak(viewerId) {
    const s = await acct(viewerId);
    s.breakUntil = 0;
    await saveAcct(viewerId, s);
  }

  // Random wait between sends: interval .. 2×interval.
  async function nextInterval() {
    const { intervalSec } = await settings();
    return U.jitter(intervalSec * 1000, intervalSec * 2000);
  }

  // ---- de-duplication ----
  async function sentIndex() { return (await U.store.get('sent', {})) || {}; }
  async function wasSent({ userId, username }) {
    const idx = await sentIndex();
    if (userId && idx[userId]) return idx[userId];
    const un = U.normalizeUsername(username);
    if (!un) return null;
    for (const v of Object.values(idx)) if (v.username === un) return v;
    return null;
  }
  async function markSent({ userId, username, viewerId }) {
    const idx = await sentIndex();
    idx[userId] = { at: Date.now(), by: viewerId, username: U.normalizeUsername(username) };
    await U.store.set('sent', idx);
  }
  async function unmarkSent(username) {
    const idx = await sentIndex();
    const un = U.normalizeUsername(username);
    for (const [k, v] of Object.entries(idx)) if (v.username === un) delete idx[k];
    await U.store.set('sent', idx);
  }

  // ---- history ----
  async function history() { return (await U.store.get('history', [])) || []; }
  let histChain = Promise.resolve();
  function addHistory(rec) {
    histChain = histChain.then(async () => {
      const h = await history();
      h.unshift({ id: U.uuid(), at: Date.now(), ...rec });
      if (h.length > HARD.HISTORY_MAX) h.length = HARD.HISTORY_MAX;
      await U.store.set('history', h);
    });
    return histChain;
  }
  const clearHistory = () => U.store.set('history', []);

  // ---- error classification ----
  // category       → what the queue does
  //   not_found      terminal for this recipient (skip, never retry)
  //   cant_message   terminal (user doesn't accept DMs from you / restricted)
  //   session        stop: logged out
  //   ig_block       stop + 24h cooldown: Instagram is limiting the account (feedback_required, spam, 429)
  //   transport      pause: Instagram tab gone
  //   network        pause until back online
  //   instagram      retryable glitch (5xx, unknown Instagram reply)
  function classify(e) {
    const m = String(e?.message || e || '').toLowerCase();
    const st = e?.status || 0;
    const layer = e?.layer || '';
    if (m.includes('user_not_found') || st === 404) return 'not_found';
    if (m.includes('login_required') || st === 401 || m.includes('not_logged_in')) return 'session';
    if (st === 429 || /feedback_required|spam|try again later|please wait|rate_limited|action blocked|checkpoint|challenge/.test(m)) return 'ig_block';
    if (/can'?t (send|message)|cannot (send|message)|not allowed|restricted|blocked by|privacy|1545003|1545012/.test(m)) return 'cant_message';
    if (layer === 'no_ig_tab' || layer === 'bridge') return 'transport';
    if (m.startsWith('network') || layer === 'network' || (typeof navigator !== 'undefined' && !navigator.onLine)) return 'network';
    if (layer.startsWith('mqtt') && (m.includes('handshake') || m.includes('connection_lost') || m === 'timeout')) return 'connection';
    if (st === 403) return 'ig_block';
    return 'instagram';
  }
  const TERMINAL = new Set(['not_found', 'cant_message']);

  MDM.policy = {
    HARD, DEFAULTS, settings, saveSettings, acct, saveAcct, allAccountStates, noteAttempt, noteIgBlock, clearBreak, nextInterval,
    sentIndex, wasSent, markSent, unmarkSent, history, addHistory, clearHistory, classify, TERMINAL,
  };
})();
