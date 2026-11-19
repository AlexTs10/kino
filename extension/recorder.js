// The recording engine. It runs in its own tab so the recording keeps going while you use other tabs and apps.
// Flow: choose source -> 3-2-1 -> record (video parts and audio parts upload while you record) -> finish -> open the share page.
import { api, getSettings, fmtDuration, IDLE, signedIn } from "./shared.js";


// R2 multipart rule: all parts except the last must have the same size, and at least 5 MiB.
const PART_SIZE = 10 * 1024 * 1024;
const BITRATE = { 720: 2_500_000, 1080: 4_500_000, 1440: 7_000_000 };
// MP4 first: Safari and iOS play it. WebM is the fallback.
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1,opus",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
// A separate small audio-only recording feeds the transcript. New file every minute: the server transcribes all parts at the same time, so the wait after you stop stays short.
const AUDIO_MIME = "audio/webm;codecs=opus";
const AUDIO_SEGMENT_MS = 60 * 1000;
const COUNTDOWN = 3;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const returnTabId = Number(params.get("return")) || null;
const settings = await getSettings();
const myTab = await chrome.tabs.getCurrent();
// The camera shows as a bubble on the page (captured with the screen), unless the page cannot host it
// or you chose "Draw the camera into the video" in Settings.
const pageBubble = params.get("bubble") === "1";
const composite = settings.mode === "screen-cam" && (settings.camInVideo || !pageBubble);

let state = { status: "picking" };
let media = null; // streams and tracks, kept across "Restart"
let rec = null; // the current take

// ---------- State shared with the popup, the in-page controls and the service worker ----------

function publish(patch) {
  state = {
    ...state,
    ...patch,
    recorderTabId: myTab.id,
    recorderWindowId: myTab.windowId,
    mode: settings.mode,
    bubble: pageBubble && settings.mode !== "screen" && !composite,
  };
  chrome.storage.local.set({ recState: state });
  render();
}

function elapsed(s = rec) {
  if (!s) return 0;
  return s.activeMs + (s.resumedAt ? Date.now() - s.resumedAt : 0);
}

function badge() {
  const ms = elapsed();
  const s = Math.floor(ms / 1000);
  const text = state.status === "paused" ? "❚❚" : s < 600 ? fmtDuration(ms) : `${Math.floor(s / 60)}m`;
  chrome.action.setBadgeBackgroundColor({ color: state.status === "paused" ? "#6b6d76" : "#e5484d" });
  chrome.action.setBadgeText({ text });
}

// ---------- UI of this tab ----------

let uiTimer;
function render() {
  const st = state.status;
  const live = st === "recording" || st === "paused";
  $("picking").hidden = st !== "picking";
  $("timer").hidden = !(live || st === "countdown");
  $("controls").hidden = !live;
  $("tip").hidden = !live || settings.mode === "cam";
  $("uploading").hidden = st !== "finishing";
  $("stage").hidden = !(settings.mode === "cam" && media?.cam && st !== "finishing" && st !== "done");
  $("count").hidden = st !== "countdown";
  $("pause").textContent = st === "paused" ? "Resume" : "Pause";
  $("status").className = `status ${st === "paused" ? "paused" : st === "done" ? "done" : ""}`;
  $("status-text").textContent = {
    picking: "Choose what to record",
    countdown: "Get ready",
    recording: "Recording",
    paused: "Paused",
    finishing: "Finishing upload",
    done: "Your video is ready",
    error: "Recording stopped",
  }[st] || "";
  clearInterval(uiTimer);
  if (live) uiTimer = setInterval(() => ($("timer").textContent = fmtDuration(elapsed())), 250);
  $("timer").textContent = fmtDuration(elapsed());
}

function showError(msg) {
  chrome.runtime.sendMessage({ type: "show-recorder" }).catch(() => {});
  $("error").textContent = msg;
  $("retry").hidden = false;
  publish({ status: "error" });
  chrome.storage.local.set({ recState: IDLE });
  chrome.action.setBadgeText({ text: "" });
}

$("again").onclick = () => location.reload();
$("close").onclick = () => closeAndReturn();

// ---------- Getting the streams ----------

function chooseSource() {
  return new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab", "audio"], myTab, (streamId, options) =>
      resolve({ streamId, canRequestAudioTrack: !!options?.canRequestAudioTrack }),
    );
  });
}

async function acquire() {
  const height = Number(settings.quality) || 1080;
  const m = { display: null, mic: null, cam: null, audioCtx: null, audioTrack: null, videoTrack: null, worker: null, warnings: [] };

  if (settings.mode !== "cam") {
    const { streamId, canRequestAudioTrack } = await chooseSource();
    if (!streamId) return null; // the user clicked Cancel
    const desktop = { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } };
    m.display = await navigator.mediaDevices.getUserMedia({
      audio: settings.systemAudio && canRequestAudioTrack ? desktop : false,
      video: { mandatory: { ...desktop.mandatory, maxFrameRate: 30 } },
    });
    // Scale big screens (for example Retina) down to the chosen quality.
    const track = m.display.getVideoTracks()[0];
    const { width, height: h } = track.getSettings();
    if (h > height) await track.applyConstraints({ width: Math.round((width * height) / h), height, frameRate: 30 }).catch(() => {});
  }

  if (settings.micOn !== false && settings.micId !== "none") {
    try {
      m.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(settings.micId ? { deviceId: { exact: settings.micId } } : {}),
          echoCancellation: true,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: true,
        },
      });
    } catch (e) {
      m.warnings.push(`Microphone not available (${e.message}). Recording without your voice.`);
    }
  }

  if (settings.mode === "cam" || composite) {
    try {
      const big = settings.mode === "cam";
      m.cam = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(settings.camId ? { deviceId: { exact: settings.camId } } : {}),
          width: { ideal: big ? Math.round((height * 16) / 9) : 1280 },
          height: { ideal: big ? height : 720 },
          frameRate: { ideal: 30 },
        },
      });
    } catch (e) {
      if (settings.mode === "cam") throw new Error(`Camera not available: ${e.message}`);
      m.warnings.push(`Camera not available (${e.message}). Recording the screen only.`);
    }
  }

  // Mix tab/system audio and the microphone into one track.
  const audioSources = [m.display, m.mic].filter((s) => s?.getAudioTracks().length);
  if (audioSources.length) {
    m.audioCtx = new AudioContext();
    const dest = m.audioCtx.createMediaStreamDestination();
    for (const s of audioSources) m.audioCtx.createMediaStreamSource(s).connect(dest);
    m.audioTrack = dest.stream.getAudioTracks()[0];
  }

  if (settings.mode === "cam") {
    m.videoTrack = m.cam.getVideoTracks()[0];
  } else if (composite && m.cam && "MediaStreamTrackProcessor" in window && "MediaStreamTrackGenerator" in window) {
    // Draw the camera bubble into the video, so it is there whatever you share.
    const screenProc = new MediaStreamTrackProcessor({ track: m.display.getVideoTracks()[0] });
    const camProc = new MediaStreamTrackProcessor({ track: m.cam.getVideoTracks()[0] });
    const gen = new MediaStreamTrackGenerator({ kind: "video" });
    m.worker = new Worker("compose-worker.js");
    m.worker.postMessage(
      {
        type: "start",
        screen: screenProc.readable,
        cam: camProc.readable,
        out: gen.writable,
        cfg: { maxHeight: height, position: settings.camPosition, size: settings.camSize, mirror: settings.mirror, camOn: true },
      },
      [screenProc.readable, camProc.readable, gen.writable],
    );
    m.videoTrack = gen;
  } else {
    if (m.cam) m.warnings.push("This Chrome version cannot draw the camera into the video. Recording the screen only.");
    m.cam?.getTracks().forEach((t) => t.stop());
    m.cam = null;
    m.videoTrack = m.display.getVideoTracks()[0];
  }

  // Chrome's "Stop sharing" button ends the screen track.
  m.display?.getVideoTracks()[0].addEventListener("ended", () => finish());
  return m;
}

function releaseMedia() {
  if (!media) return;
  for (const s of [media.display, media.mic, media.cam]) s?.getTracks().forEach((t) => t.stop());
  media.videoTrack?.stop();
  media.audioCtx?.close().catch(() => {});
  media.worker?.terminate();
  $("preview").srcObject = null;
}

function pickMime() {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

// ---------- One take ----------

async function beginTake() {
  const mimeType = pickMime();
  if (!mimeType) throw new Error("This browser cannot record video with MediaRecorder.");
  const created = await api("/videos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mimeType }),
  });
  const s = {
    id: created.id,
    url: created.url,
    mimeType,
    chunks: [], buffered: 0, partNumber: 0, parts: [],
    chain: Promise.resolve(), audioChain: Promise.resolve(), uploadError: null,
    activeMs: 0, resumedAt: null,
    audioN: 0, audioRec: null, audioSeg: null,
    thumb: null, discarded: false, finishing: false,
  };
  rec = s;

  // 3-2-1
  publish({ status: "countdown", countdownEnd: Date.now() + COUNTDOWN * 1000, activeMs: 0, resumedAt: null, videoUrl: s.url });
  for (let i = COUNTDOWN; i > 0; i--) {
    $("count").textContent = String(i);
    await new Promise((r) => setTimeout(r, 1000));
    if (s.discarded) return;
  }

  const tracks = [media.videoTrack, ...(media.audioTrack ? [media.audioTrack] : [])];
  s.recorder = new MediaRecorder(new MediaStream(tracks), {
    mimeType,
    videoBitsPerSecond: BITRATE[settings.quality] || BITRATE[1080],
    audioBitsPerSecond: 128_000,
  });
  s.recorder.ondataavailable = (e) => {
    if (e.data.size) onChunk(s, e.data);
  };
  s.stopped = new Promise((r) => s.recorder.addEventListener("stop", r, { once: true }));
  s.recorder.start(1000);
  if (media.audioTrack) startAudioSegment(s);
  s.resumedAt = Date.now();
  publish({ status: "recording", activeMs: 0, resumedAt: s.resumedAt });
  setTimeout(() => grabThumb(s), 1500);
}

// Runs once per second from a worker timer, so it keeps going while the recorder window is minimized.
// (Video chunks are not a good clock: the MP4 recorder sends data only when a fragment is complete.)
const ticker = new Worker("ticker.js");
ticker.onmessage = () => {
  const s = rec;
  if (s?.recorder && !s.finishing && !s.discarded && (state.status === "recording" || state.status === "paused")) heartbeat(s);
};

function heartbeat(s) {
  badge();
  if (s.audioRec?.state === "recording" && elapsed(s) - s.audioSeg.startMs >= AUDIO_SEGMENT_MS) {
    s.audioRec.stop();
    startAudioSegment(s);
  }
}

function startAudioSegment(s) {
  const ar = new MediaRecorder(new MediaStream([media.audioTrack]), { mimeType: AUDIO_MIME, audioBitsPerSecond: 32_000 });
  const seg = { n: ++s.audioN, startMs: Math.round(elapsed(s)), chunks: [] };
  seg.stopped = new Promise((resolve) => {
    ar.ondataavailable = (e) => e.data.size && seg.chunks.push(e.data);
    ar.onstop = () => {
      if (!s.discarded && seg.chunks.length) {
        const body = new Blob(seg.chunks, { type: "audio/webm" });
        s.audioChain = s.audioChain.then(() =>
          withRetry(() => api(`/videos/${s.id}/audio/${seg.n}?start=${seg.startMs}`, { method: "PUT", headers: { "content-type": "audio/webm" }, body })).catch(() => {}),
        );
      }
      resolve();
    };
  });
  ar.start(1000);
  if (s.resumedAt === null && s.audioRec) ar.pause();
  s.audioRec = ar;
  s.audioSeg = seg;
}

function togglePause() {
  const s = rec;
  if (!s?.recorder || s.finishing) return;
  if (s.recorder.state === "recording") {
    s.recorder.pause();
    s.audioRec?.pause();
    s.activeMs += Date.now() - s.resumedAt;
    s.resumedAt = null;
    publish({ status: "paused", activeMs: s.activeMs, resumedAt: null });
  } else if (s.recorder.state === "paused") {
    s.recorder.resume();
    s.audioRec?.resume();
    s.resumedAt = Date.now();
    publish({ status: "recording", activeMs: s.activeMs, resumedAt: s.resumedAt });
  }
  badge();
}

// Throw away the current take (Restart and Delete).
function discard(s) {
  if (!s) return;
  s.discarded = true;
  if (s.recorder && s.recorder.state !== "inactive") s.recorder.stop();
  if (s.audioRec && s.audioRec.state !== "inactive") s.audioRec.stop();
  s.chain.then(() => api(`/videos/${s.id}`, { method: "DELETE" })).catch(() => {});
}

async function restart() {
  if (!rec || rec.finishing) return;
  discard(rec);
  try {
    await beginTake();
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function deleteRecording() {
  discard(rec);
  rec = null;
  releaseMedia();
  await chrome.storage.local.set({ recState: IDLE });
  chrome.action.setBadgeText({ text: "" });
  closeAndReturn();
}

// ---------- Upload ----------

function onChunk(s, blob) {
  if (s.discarded) return;
  s.chunks.push(blob);
  s.buffered += blob.size;
  while (s.buffered >= PART_SIZE) {
    const all = new Blob(s.chunks);
    s.chunks = [all.slice(PART_SIZE)];
    s.buffered = all.size - PART_SIZE;
    enqueuePart(s, all.slice(0, PART_SIZE));
  }
}

function enqueuePart(s, blob) {
  const n = ++s.partNumber;
  s.chain = s.chain.then(async () => {
    if (s.uploadError || s.discarded) return;
    try {
      s.parts.push(await withRetry(() => api(`/videos/${s.id}/parts/${n}`, { method: "PUT", body: blob })));
    } catch (e) {
      s.uploadError = e;
    }
  });
}

async function withRetry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

async function grabThumb(s) {
  try {
    let blob = null;
    if (media.worker) {
      blob = await new Promise((resolve) => {
        const onMsg = ({ data }) => {
          if (data.type !== "thumb") return;
          media.worker.removeEventListener("message", onMsg);
          resolve(data.blob);
        };
        media.worker.addEventListener("message", onMsg);
        media.worker.postMessage({ type: "thumb" });
      });
    } else {
      const bmp = await new ImageCapture(media.videoTrack).grabFrame();
      const scale = Math.min(1, 1280 / bmp.width);
      const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
      const ctx = c.getContext("2d");
      if (settings.mode === "cam" && settings.mirror) {
        ctx.translate(c.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    }
    s.thumb = blob;
  } catch { /* no thumbnail; the share page still works */ }
}

async function finish() {
  const s = rec;
  if (!s || s.finishing || s.discarded) return;
  s.finishing = true;
  if (s.resumedAt) s.activeMs += Date.now() - s.resumedAt;
  s.resumedAt = null;
  publish({ status: "finishing", activeMs: s.activeMs, resumedAt: null });
  chrome.action.setBadgeText({ text: "…" });

  if (s.recorder && s.recorder.state !== "inactive") s.recorder.stop();
  if (s.audioRec && s.audioRec.state !== "inactive") s.audioRec.stop();
  if (s.recorder) await s.stopped;
  await s.audioSeg?.stopped;
  if (!s.thumb) await grabThumb(s);
  releaseMedia();

  if (s.buffered > 0 || s.partNumber === 0) enqueuePart(s, new Blob(s.chunks));
  s.chunks = [];
  const total = s.partNumber;
  const progress = setInterval(() => {
    $("bar").style.width = `${Math.round((s.parts.length / total) * 100)}%`;
    $("upload-text").textContent = `Uploading… ${s.parts.length} of ${total} part${total === 1 ? "" : "s"}`;
  }, 200);

  try {
    await s.chain;
    await s.audioChain; // all audio must be there before the AI step starts
    clearInterval(progress);
    if (s.uploadError) throw s.uploadError;
    $("bar").style.width = "100%";
    $("upload-text").textContent = "Saving…";
    await withRetry(() =>
      api(`/videos/${s.id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: s.parts, durationMs: Math.round(s.activeMs) }),
      }),
    );
    if (s.thumb) await api(`/videos/${s.id}/thumbnail`, { method: "PUT", body: s.thumb }).catch(() => {});
  } catch (e) {
    clearInterval(progress);
    showError(`Upload failed: ${e.message || e}\nThe link ${s.url} will not work.`);
    chrome.runtime.sendMessage({ type: "show-recorder" }).catch(() => {});
    return;
  }

  await chrome.storage.local.set({ recState: IDLE });
  chrome.action.setBadgeText({ text: "" });
  state = { status: "done" };
  rec = null;
  render();

  // Open the video page next to the page you recorded. It copies the link to your clipboard.
  await chrome.runtime.sendMessage({ type: "open-share", url: `${s.url}?new=1`, returnTabId }).catch(() => {});
  window.close();
}

async function closeAndReturn() {
  if (returnTabId) await chrome.tabs.update(returnTabId, { active: true }).catch(() => {});
  window.close();
}

// ---------- Controls from the popup, the in-page controls and keyboard shortcuts ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "rec-control") return;
  if (msg.action === "pause") togglePause();
  if (msg.action === "stop") finish();
  if (msg.action === "restart") restart();
  if (msg.action === "delete") deleteRecording();
});

$("pause").onclick = togglePause;
$("stop").onclick = () => finish();
$("restart").onclick = () => restart();
$("delete").onclick = () => confirm("Delete this recording?") && deleteRecording();

window.addEventListener("beforeunload", (e) => {
  if (["countdown", "recording", "paused", "finishing"].includes(state.status)) e.preventDefault();
});

// ---------- Start ----------

async function main() {
  if (!(await signedIn())) {
    showError("Sign in to Kino first. Click the Kino icon, then Sign in.");
    return;
  }
  publish({ status: "picking" });
  try {
    media = await acquire();
  } catch (e) {
    releaseMedia();
    showError(e.message || String(e));
    return;
  }
  if (!media) {
    // Cancelled in Chrome's picker.
    await chrome.storage.local.set({ recState: IDLE });
    return closeAndReturn();
  }
  if (media.warnings.length) $("error").textContent = media.warnings.join("\n");

  if (settings.mode === "cam") {
    $("preview").srcObject = media.cam;
    $("preview").classList.toggle("mirror", settings.mirror);
  }
  if (returnTabId) {
    // Hide this window and go back to the page. The countdown and the controls show there.
    await chrome.runtime.sendMessage({ type: "rec-armed", returnTabId }).catch(() => {});
  }

  try {
    await beginTake();
  } catch (e) {
    releaseMedia();
    showError(e.message || String(e));
  }
}

main();
