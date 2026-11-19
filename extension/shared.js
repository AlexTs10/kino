// Shared helpers for extension pages and the service worker.

// ponytail: one fixed server. Change this line to test against `wrangler dev` (and add it to host_permissions).
export const SERVER = "https://kino.alextoska.xyz";
const SESSION_COOKIE = "kino_session";

export const DEFAULTS = {
  quality: "1080",
  recordType: "screen", // screen | cam (camera only)
  camOn: true,
  micOn: true,
  mode: "screen-cam", // set at start from recordType and camOn: screen-cam | screen | cam
  camId: "", // "" = default camera
  micId: "", // "" = default microphone
  camInVideo: false, // draw the camera into the video instead of the bubble on the page
  systemAudio: true,
  noiseSuppression: true,
  camPosition: "bl", // bl | br | tl | tr
  camSize: "m", // s | m | l (bubble size)
  mirror: true,
  openAfter: true,
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

// The extension uses the website's session cookie as its Bearer token.
// Sign in on the website once; sign out there and the extension is signed out too.
export async function sessionToken() {
  const c = await chrome.cookies.get({ url: SERVER, name: SESSION_COOKIE }).catch(() => null);
  return c?.value || "";
}

// A cookie can exist but be dead (signed out elsewhere, expired, or an old pre-account session).
// Ask the server; remove a cookie that it rejects.
export async function signedIn() {
  const token = await sessionToken();
  if (!token) return false;
  const res = await fetch(`${SERVER}/api/me`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (res?.status === 401) {
    await chrome.cookies.remove({ url: SERVER, name: SESSION_COOKIE }).catch(() => {});
    return false;
  }
  return true; // ponytail: offline or server error counts as signed in; the upload shows the real error.
}

export async function openLogin() {
  return chrome.tabs.create({ url: `${SERVER}/login?next=/library` });
}

export async function api(path, init = {}) {
  const token = await sessionToken();
  if (!token) throw new Error("Sign in to Kino first.");
  const res = await fetch(`${SERVER}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* not JSON */ }
    throw new Error(`${res.status} ${msg}`.trim());
  }
  return res.json();
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export async function openWeb(path, { tabId } = {}) {
  const url = `${SERVER}${path}`;
  if (tabId) return chrome.tabs.update(tabId, { url, active: true });
  return chrome.tabs.create({ url });
}

// Recording state, shared by the recorder tab, the popup, the in-page controls and the service worker.
export const IDLE = { status: "idle" };
export const ACTIVE = ["picking", "countdown", "recording", "paused", "finishing"];

export async function getRecState() {
  const { recState } = await chrome.storage.local.get("recState");
  return recState || IDLE;
}

// Some sites block the camera and the microphone for all frames on the page (Permissions-Policy).
// The Kino frames can still check this, and then use the relay in offscreen.js.
export function pageBlocks(feature) {
  try {
    return document.featurePolicy?.allowsFeature(feature) === false;
  } catch {
    return false;
  }
}

// Opens a port to the relay page (offscreen.js). The background creates the page when necessary.
export async function connectRelay(name) {
  for (let i = 0; i < 6; i++) {
    await chrome.runtime.sendMessage({ type: "ensure-relay" }).catch(() => {});
    const port = chrome.runtime.connect({ name });
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(true), 150);
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        clearTimeout(t);
        resolve(false);
      });
    });
    if (ok) return port;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("The camera relay did not start");
}
