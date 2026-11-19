import { getSettings, getRecState, fmtDuration, ACTIVE, signedIn } from "./shared.js";

const $ = (id) => document.getElementById(id);
const settings = await getSettings();
let camStream = null;
let micStream = null;
let audioCtx = null;

$("settings").onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
$("open-login").onclick = () => { chrome.runtime.sendMessage({ type: "open-login" }); window.close(); };
$("library").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "open-web", path: "/library" });
  window.close();
};
$("grant").onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html") }); window.close(); };

// ---------- Live recording controls ----------

let liveTimer;
function showLive(state) {
  $("setup").hidden = true;
  $("perm-needed").hidden = true;
  $("live").hidden = false;
  stopMedia();
  const paused = state.status === "paused";
  $("live-state").className = `state ${paused ? "paused" : ""}`;
  $("live-state").querySelector("span").textContent = {
    picking: "Choosing what to share", countdown: "Starting", recording: "Recording", paused: "Paused", finishing: "Uploading",
  }[state.status] || "";
  $("live-pause").textContent = paused ? "Resume" : "Pause";
  for (const id of ["live-pause", "live-restart", "live-stop", "live-delete"]) $(id).disabled = !["recording", "paused"].includes(state.status);
  clearInterval(liveTimer);
  const tick = () => ($("live-timer").textContent = fmtDuration((state.activeMs || 0) + (state.resumedAt ? Date.now() - state.resumedAt : 0)));
  tick();
  liveTimer = setInterval(tick, 250);
}
const control = (action) => chrome.runtime.sendMessage({ type: "rec-control", action });
$("live-pause").onclick = () => control("pause");
$("live-restart").onclick = () => control("restart");
$("live-stop").onclick = () => { control("stop"); window.close(); };
$("live-delete").onclick = () => { if (confirm("Delete this recording?")) { control("delete"); window.close(); } };

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.recState) return;
  const s = changes.recState.newValue || { status: "idle" };
  if (ACTIVE.includes(s.status)) showLive(s);
  else location.reload();
});

const state = await getRecState();
if (ACTIVE.includes(state.status)) {
  showLive(state);
} else {
  await initSetup();
}

// ---------- Setup ----------

async function initSetup() {
  if (!(await signedIn())) {
    $("setup-needed").hidden = false;
    $("start").disabled = true;
  }
  setMode(settings.mode);
  for (const b of document.querySelectorAll("#modes button")) {
    b.onclick = () => {
      setMode(b.dataset.mode);
      chrome.storage.local.set({ mode: b.dataset.mode });
    };
  }
  $("systemAudio").checked = settings.systemAudio;
  $("systemAudio").onchange = () => chrome.storage.local.set({ systemAudio: $("systemAudio").checked });
  $("preview").classList.toggle("mirror", settings.mirror);
  await loadDevices();
  $("cam").onchange = async () => { await chrome.storage.local.set({ camId: $("cam").value }); startPreview(); };
  $("mic").onchange = async () => { await chrome.storage.local.set({ micId: $("mic").value }); startMeter(); };
  $("start").onclick = start;
}

function setMode(mode) {
  settings.mode = mode;
  for (const b of document.querySelectorAll("#modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  $("cam-block").hidden = mode === "screen";
  $("sys-row").hidden = mode === "cam";
  startPreview();
}

async function loadDevices() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  const camPerm = await navigator.permissions.query({ name: "camera" }).catch(() => ({ state: "prompt" }));
  const micPerm = await navigator.permissions.query({ name: "microphone" }).catch(() => ({ state: "prompt" }));
  if (camPerm.state !== "granted" || micPerm.state !== "granted") $("perm-needed").hidden = false;

  const cams = devices.filter((d) => d.kind === "videoinput" && d.deviceId);
  const mics = devices.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "communications");
  fill($("cam"), cams, "Default camera", [], settings.camId);
  fill($("mic"), mics, "Default microphone", [["none", "No microphone"]], settings.micId);
  startPreview();
  startMeter();
}

function fill(select, list, defaultLabel, extra, saved) {
  select.replaceChildren();
  if (!list.length || !list[0].label) select.add(new Option(defaultLabel, ""));
  list.forEach((d, i) => d.label && select.add(new Option(d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, ""), d.deviceId === "default" ? "" : d.deviceId)));
  for (const [value, label] of extra) select.add(new Option(label, value));
  if ([...select.options].some((o) => o.value === saved)) select.value = saved;
}

async function startPreview() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  $("preview").srcObject = null;
  if (settings.mode === "screen" || !$("cam").options.length) return;
  try {
    const id = $("cam").value;
    camStream = await navigator.mediaDevices.getUserMedia({ video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 640 }, height: { ideal: 640 } } });
    $("preview").srcObject = camStream;
  } catch { /* no permission yet: the notice above explains it */ }
}

async function startMeter() {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  await audioCtx?.close().catch(() => {});
  audioCtx = null;
  $("level").style.width = "0";
  const id = $("mic").value;
  if (id === "none") return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
  } catch { return; }
  audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const draw = () => {
    if (!audioCtx) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
    $("level").style.width = `${Math.round(level * 100)}%`;
    requestAnimationFrame(draw);
  };
  draw();
}

function stopMedia() {
  camStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close().catch(() => {});
  camStream = micStream = audioCtx = null;
}

async function start() {
  $("start").disabled = true;
  await chrome.storage.local.set({ mode: settings.mode, camId: $("cam").value, micId: $("mic").value, systemAudio: $("systemAudio").checked });
  stopMedia();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ type: "start", returnTabId: tab?.id });
  window.close();
}
