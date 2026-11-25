// Service worker.
// 1. Toolbar click opens (or focuses) the app page.
// 2. Owns one dedicated instagram.com "transport" tab. Instagram only accepts the chat WebSocket and the
//    thread-creation POST from an instagram.com origin, so those calls run in content.js inside that tab.
//    We never borrow the user's own Instagram tabs for this.
// 3. Relays {type:'transport', msg} from the app page to that tab.

const APP_URL = chrome.runtime.getURL('app.html');
const IG_HOME = 'https://www.instagram.com/';
const TAB_KEY = 'transportTabId';
const READY_TIMEOUT_MS = 15000;

async function openApp() {
  const tabs = await chrome.tabs.query({ url: APP_URL + '*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
}

chrome.action.onClicked.addListener(openApp);
chrome.runtime.onInstalled.addListener((d) => { if (d.reason === 'install') openApp(); });

async function storedTabId() {
  return (await chrome.storage.session.get(TAB_KEY))[TAB_KEY] || null;
}
async function setStoredTabId(id) {
  if (id == null) await chrome.storage.session.remove(TAB_KEY);
  else await chrome.storage.session.set({ [TAB_KEY]: id });
}

async function aliveIgTab(tabId) {
  if (!tabId) return null;
  try {
    const t = await chrome.tabs.get(tabId);
    return t && t.url && t.url.startsWith(IG_HOME) ? t : null;
  } catch (_) {
    return null;
  }
}

function ping(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'mdm_ping' }, (r) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(r || null);
    });
  });
}

async function waitReady(tabId, timeoutMs = READY_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await ping(tabId);
    if (r && r.ok) return r;
    await new Promise((res) => setTimeout(res, 400));
  }
  return null;
}

let creating = null; // de-duplicates concurrent ensureTab() calls

async function ensureTab() {
  const existing = await aliveIgTab(await storedTabId());
  if (existing) {
    const r = await waitReady(existing.id, 4000);
    if (r) return { ok: true, tabId: existing.id };
    try { await chrome.tabs.reload(existing.id); } catch (_) {}
    const r2 = await waitReady(existing.id);
    if (r2) return { ok: true, tabId: existing.id };
  }
  if (!creating) {
    creating = (async () => {
      const tab = await chrome.tabs.create({ url: IG_HOME, active: false, pinned: true });
      await setStoredTabId(tab.id);
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (_) {}
      const r = await waitReady(tab.id);
      return r ? { ok: true, tabId: tab.id } : { ok: false, error: 'transport_not_ready' };
    })().finally(() => { creating = null; });
  }
  return creating;
}

async function peekTab() {
  const t = await aliveIgTab(await storedTabId());
  if (!t) return { ok: true, tabId: null, ready: false };
  const r = await ping(t.id);
  return { ok: true, tabId: t.id, ready: !!(r && r.ok) };
}

async function reopenTab() {
  const id = await storedTabId();
  if (id) { try { await chrome.tabs.remove(id); } catch (_) {} }
  await setStoredTabId(null);
  return ensureTab();
}

async function relay(msg) {
  const t = await ensureTab();
  if (!t.ok) return { ok: false, layer: 'no_ig_tab', error: t.error };
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(t.tabId, msg, (r) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, layer: 'bridge', error: chrome.runtime.lastError.message });
      resolve(r || { ok: false, layer: 'bridge', error: 'no_response' });
    });
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await storedTabId())) await setStoredTabId(null);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages may drive the transport tab.
  if (sender.id !== chrome.runtime.id || !sender.url || !sender.url.startsWith(chrome.runtime.getURL(''))) return false;
  const run = async () => {
    switch (msg && msg.type) {
      case 'transport_ensure': return ensureTab();
      case 'transport_peek': return peekTab();
      case 'transport_reopen': return reopenTab();
      case 'transport': return relay(msg.msg);
      case 'focus_ig': {
        const t = await ensureTab();
        if (t.ok) {
          const tab = await chrome.tabs.update(t.tabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return t;
      }
      default: return { ok: false, error: 'unknown_message' };
    }
  };
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});
