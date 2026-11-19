// Service worker.
// - Kino icon / Alt+Shift+K: opens the Kino panel on the current page (overlay.js).
// - Start: opens the recorder in a small window; after you choose what to share, the window is minimized
//   and you are back on your page with the camera bubble and the recording toolbar.
// - Stop: opens the share page in a new tab next to your page.
import { getRecState, openWeb, openLogin, signedIn, IDLE } from "./shared.js";

const RECORDER_URL = chrome.runtime.getURL("recorder.html");
const SHOW_OVERLAY = ["countdown", "recording", "paused", "finishing"];

function canInject(url) {
  return /^https?:|^file:/.test(url || "") && !/^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/.test(url);
}

async function injectOverlay(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!canInject(tab.url)) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
    return true;
  } catch {
    return false;
  }
}

// Pages where extensions cannot run (chrome://, the Web Store): show the classic popup instead.
async function openFallbackPopup(tabId) {
  await chrome.action.setPopup({ tabId, popup: "popup.html" });
  try {
    await chrome.action.openPopup();
  } finally {
    setTimeout(() => chrome.action.setPopup({ tabId, popup: "" }), 1000);
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const s = await getRecState();
  if (s.status !== "idle" && s.recorderWindowId) {
    // Already recording: just make sure the controls are on this page.
    if (await injectOverlay(tab.id)) return;
    return openFallbackPopup(tab.id);
  }
  if (await injectOverlay(tab.id)) {
    chrome.tabs.sendMessage(tab.id, { type: "kino-panel", open: "toggle" }).catch(() => {});
  } else {
    openFallbackPopup(tab.id);
  }
});

async function openRecorder(returnTabId, bubble) {
  const state = await getRecState();
  if (state.recorderWindowId && state.status !== "idle") {
    try {
      await chrome.windows.update(state.recorderWindowId, { focused: true, state: "normal" });
      return;
    } catch { /* the window is gone; start a new one */ }
  }
  let bounds = { left: 100, top: 100, width: 1280, height: 800 };
  if (returnTabId) {
    try {
      const w = await chrome.windows.get((await chrome.tabs.get(returnTabId)).windowId);
      bounds = { left: w.left, top: w.top, width: w.width, height: w.height };
    } catch { /* use the default position */ }
  }
  const width = 760;
  const height = 640;
  const q = new URLSearchParams();
  if (returnTabId) q.set("return", String(returnTabId));
  if (bubble) q.set("bubble", "1");
  const opts = { url: `${RECORDER_URL}?${q}`, type: "popup", width, height, focused: true };
  try {
    await chrome.windows.create({
      ...opts,
      left: Math.round(bounds.left + (bounds.width - width) / 2),
      top: Math.round(bounds.top + Math.max(40, (bounds.height - height) / 2)),
    });
  } catch {
    // "Bounds must be at least 50% within visible screen space" (for example with several screens).
    await chrome.windows.create(opts);
  }
}

// Hidden page that opens the camera and mic for sites that block them (see offscreen.js).
let relayCreating = null;
async function ensureRelay() {
  if (await chrome.offscreen.hasDocument?.()) return;
  relayCreating ??= chrome.offscreen
    .createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA", "WEB_RTC"], justification: "Camera preview and microphone level on sites that block the camera" })
    .catch((e) => {
      if (!/single offscreen|already/i.test(e.message)) throw e;
    })
    .finally(() => (relayCreating = null));
  await relayCreating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const type = msg?.type;
    if (type === "start") {
      // From the panel (sender.tab is the page) or from the fallback popup (msg.returnTabId).
      const returnTabId = sender.tab?.id ?? msg.returnTabId;
      if (sender.tab?.id) chrome.tabs.sendMessage(sender.tab.id, { type: "kino-panel", open: false }).catch(() => {});
      await openRecorder(returnTabId, !!sender.tab?.id);
    } else if (type === "rec-armed") {
      // The source is chosen: hide the recorder window and go back to the page.
      if (sender.tab?.windowId) chrome.windows.update(sender.tab.windowId, { state: "minimized" }).catch(() => {});
      if (msg.returnTabId) {
        try {
          const tab = await chrome.tabs.update(msg.returnTabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          await injectOverlay(msg.returnTabId);
        } catch { /* the page was closed */ }
      }
    } else if (type === "show-recorder") {
      if (sender.tab?.windowId) await chrome.windows.update(sender.tab.windowId, { state: "normal", focused: true }).catch(() => {});
    } else if (type === "open-share") {
      // Open the finished video next to the page you recorded from.
      let opts = { url: msg.url, active: true };
      try {
        const t = await chrome.tabs.get(msg.returnTabId);
        opts = { ...opts, windowId: t.windowId, index: t.index + 1 };
        await chrome.windows.update(t.windowId, { focused: true });
      } catch { /* no page to return to */ }
      await chrome.tabs.create(opts);
    } else if (type === "open-web") {
      await openWeb(msg.path);
    } else if (type === "open-login") {
      await openLogin();
    } else if (type === "open-options") {
      chrome.runtime.openOptionsPage();
    } else if (type === "ensure-relay") {
      await ensureRelay();
    } else if (type === "open-permissions") {
      chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html") });
    }
    sendResponse({ ok: true });
  })();
  return true;
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const s = await getRecState();
  if (SHOW_OVERLAY.includes(s.status) && tabId !== s.recorderTabId) injectOverlay(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.active) return;
  const s = await getRecState();
  if (SHOW_OVERLAY.includes(s.status) && tabId !== s.recorderTabId) injectOverlay(tabId).catch(() => {});
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const s = await getRecState();
  if (s.recorderWindowId === windowId && s.status !== "idle") {
    await chrome.storage.local.set({ recState: IDLE });
    chrome.action.setBadgeText({ text: "" });
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const s = await getRecState();
  if (s.status === "idle") return;
  const action = { "toggle-pause": "pause", "stop-recording": "stop" }[cmd];
  if (action) chrome.runtime.sendMessage({ type: "rec-control", action }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ recState: IDLE });
  chrome.action.setBadgeText({ text: "" });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.action.setPopup({ popup: "" });
  if (reason === "install" && !(await signedIn())) openLogin();
});
