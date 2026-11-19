// The Kino panel on the page (an extension iframe inside overlay.js).
import { getSettings, pageBlocks, connectRelay, signedIn } from "./shared.js";

const $ = (id) => document.getElementById(id);
const s = await getSettings();
let micStream = null;
let audioCtx = null;

const post = (msg) => parent.postMessage({ kino: msg.kino, ...msg }, "*");
function reportSize() {
  post({ kino: "size", h: Math.ceil($("card").getBoundingClientRect().height) });
}
new ResizeObserver(reportSize).observe($("card"));

$("close").onclick = () => post({ kino: "close" });
$("settings").onclick = () => chrome.runtime.sendMessage({ type: "open-options" });
$("open-login").onclick = () => chrome.runtime.sendMessage({ type: "open-login" });
$("library").onclick = () => chrome.runtime.sendMessage({ type: "open-web", path: "/library" });
$("grant").onclick = () => chrome.runtime.sendMessage({ type: "open-permissions" });
addEventListener("keydown", (e) => e.key === "Escape" && post({ kino: "close" }));

if (!(await signedIn())) {
  $("setup-needed").hidden = false;
  $("start").disabled = true;
}

// ---------- What to record ----------

function renderType() {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-pressed", String(b.dataset.type === s.recordType));
  $("screen-row").hidden = s.recordType === "cam";
  $("sys-row").hidden = s.recordType === "cam";
  $("cam-toggle").hidden = s.recordType === "cam"; // camera-only always needs the camera
  renderToggles();
}
for (const b of document.querySelectorAll(".tabs button")) {
  b.onclick = () => {
    s.recordType = b.dataset.type;
    const patch = { recordType: s.recordType };
    if (s.recordType === "cam" && !s.camOn) patch.camOn = s.camOn = true;
    chrome.storage.local.set(patch);
    renderType();
  };
}

function renderToggles() {
  const set = (id, row, on) => {
    $(id).textContent = on ? "On" : "Off";
    $(id).classList.toggle("on", on);
    $(row).classList.toggle("on", on);
  };
  set("cam-toggle", "cam-row", s.camOn || s.recordType === "cam");
  set("mic-toggle", "mic-row", s.micOn);
  set("sys-toggle", "sys-row", s.systemAudio);
  $("level").parentElement.hidden = !s.micOn;
}
$("cam-toggle").onclick = () => { s.camOn = !s.camOn; chrome.storage.local.set({ camOn: s.camOn }); renderToggles(); };
$("mic-toggle").onclick = () => { s.micOn = !s.micOn; chrome.storage.local.set({ micOn: s.micOn }); renderToggles(); startMeter(); };
$("sys-toggle").onclick = () => { s.systemAudio = !s.systemAudio; chrome.storage.local.set({ systemAudio: s.systemAudio }); renderToggles(); };

// The bubble on the page can turn the camera off too.
chrome.storage.onChanged.addListener((c) => {
  if (c.camOn) { s.camOn = c.camOn.newValue; renderToggles(); }
});

// ---------- Devices ----------

function cleanLabel(l) {
  return (l || "").replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "").replace(/^Default - /, "");
}

async function loadDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  if (pageBlocks("camera") || pageBlocks("microphone")) {
    // On pages that block the camera, the permission check in this frame always says "no".
    // Device names are only visible after Kino has the permission, so use them.
    const named = (kind) => devices.some((d) => d.kind === kind && d.label);
    if (!named("videoinput") || !named("audioinput")) $("perm-needed").hidden = false;
  } else {
    const cam = await navigator.permissions.query({ name: "camera" }).catch(() => ({ state: "prompt" }));
    const mic = await navigator.permissions.query({ name: "microphone" }).catch(() => ({ state: "prompt" }));
    if (cam.state !== "granted" || mic.state !== "granted") $("perm-needed").hidden = false;
  }

  fill($("cam"), devices.filter((d) => d.kind === "videoinput" && d.deviceId), "Default camera", s.camId);
  fill($("mic"), devices.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "communications"), "Default microphone", s.micId);
  $("cam-label").textContent = $("cam").selectedOptions[0]?.text || "Camera";
  $("mic-label").textContent = $("mic").selectedOptions[0]?.text || "Microphone";
}

function fill(select, list, defaultLabel, saved) {
  select.replaceChildren();
  const labeled = list.filter((d) => d.label);
  if (!labeled.length) select.add(new Option(defaultLabel, ""));
  for (const d of labeled) {
    const value = d.deviceId === "default" ? "" : d.deviceId;
    if ([...select.options].some((o) => o.value === value)) continue;
    select.add(new Option(cleanLabel(d.label), value));
  }
  if ([...select.options].some((o) => o.value === saved)) select.value = saved;
}

$("cam").onchange = () => {
  s.camId = $("cam").value;
  $("cam-label").textContent = $("cam").selectedOptions[0]?.text;
  chrome.storage.local.set({ camId: s.camId, camOn: true });
  s.camOn = true;
  renderToggles();
};
$("mic").onchange = () => {
  s.micId = $("mic").value;
  $("mic-label").textContent = $("mic").selectedOptions[0]?.text;
  chrome.storage.local.set({ micId: s.micId, micOn: true });
  s.micOn = true;
  renderToggles();
  startMeter();
};

// The page blocks the microphone: the level comes from the relay (offscreen.js).
let meterPort = null;
function stopRelayMeter() {
  try {
    meterPort?.disconnect();
  } catch { /* already closed */ }
  meterPort = null;
}
async function relayMeter() {
  stopRelayMeter();
  let p;
  try {
    p = await connectRelay("kino-mic");
  } catch {
    return;
  }
  meterPort = p;
  p.onMessage.addListener((m) => {
    if (m.type === "level" && p === meterPort) $("level").style.width = `${Math.min(100, Math.round(m.rms * 600))}%`;
  });
  p.postMessage({ type: "start", micId: s.micId });
}

async function startMeter() {
  stopRelayMeter();
  micStream?.getTracks().forEach((t) => t.stop());
  await audioCtx?.close().catch(() => {});
  micStream = audioCtx = null;
  $("level").style.width = "0";
  if (!s.micOn) return;
  if (pageBlocks("microphone")) return relayMeter();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: s.micId ? { deviceId: { exact: s.micId } } : true });
  } catch (e) {
    if (e.name === "NotAllowedError") relayMeter();
    return;
  }
  audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const ctx = audioCtx;
  const draw = () => {
    if (audioCtx !== ctx) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    $("level").style.width = `${Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 600))}%`;
    requestAnimationFrame(draw);
  };
  draw();
}

// ---------- Start ----------

$("start").onclick = async () => {
  $("start").disabled = true;
  const mode = s.recordType === "cam" ? "cam" : s.camOn ? "screen-cam" : "screen";
  await chrome.storage.local.set({ mode });
  stopRelayMeter();
  micStream?.getTracks().forEach((t) => t.stop());
  await audioCtx?.close().catch(() => {});
  await chrome.runtime.sendMessage({ type: "start" });
};

renderType();
await loadDevices().catch((e) => ($("error").textContent = e.message));
startMeter();
reportSize();
