// Live camera preview inside the round bubble on the page.
// Normal pages: this frame opens the camera itself.
// Pages that block the camera (Permissions-Policy): the picture comes from the relay (offscreen.js).
import { getSettings, pageBlocks, connectRelay } from "./shared.js";

const video = document.querySelector("video");
const spin = document.querySelector(".spin");
const msg = document.querySelector(".msg");
let stream = null;
let pc = null;
let port = null;
let run = 0;

function stopAll() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  pc?.close();
  pc = null;
  try {
    port?.disconnect();
  } catch { /* already closed */ }
  port = null;
}

function show(text) {
  spin.hidden = true;
  msg.textContent = text;
  msg.hidden = !text;
}

function explain(e) {
  if (e?.name === "NotAllowedError") return "Allow camera access in the Kino panel";
  if (e?.name === "NotReadableError") return "The camera is in use by another app";
  if (e?.name === "NotFoundError") return "No camera found";
  return "Camera not available";
}

async function camGranted() {
  try {
    return (await navigator.permissions.query({ name: "camera" })).state === "granted";
  } catch {
    return false;
  }
}

async function direct(s) {
  const v = { width: { ideal: 720 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  try {
    return await navigator.mediaDevices.getUserMedia({ video: s.camId ? { ...v, deviceId: { exact: s.camId } } : v });
  } catch (e) {
    if (s.camId && e.name === "OverconstrainedError") return navigator.mediaDevices.getUserMedia({ video: v });
    throw e;
  }
}

async function relay(s, my) {
  const p = await connectRelay("kino-cam");
  if (my !== run) return p.disconnect();
  port = p;
  pc = new RTCPeerConnection();
  const conn = pc;
  conn.ontrack = (ev) => {
    video.srcObject = ev.streams[0] || new MediaStream([ev.track]);
    video.play().catch(() => {});
  };
  conn.onconnectionstatechange = () => {
    if (conn === pc && conn.connectionState === "failed") show("Camera not available");
  };
  p.onDisconnect.addListener(() => {
    if (p === port && my === run) show("Camera not available");
  });
  p.onMessage.addListener(async (m) => {
    if (conn !== pc) return;
    if (m.type === "error") return show(explain(m));
    if (m.type !== "offer") return;
    await conn.setRemoteDescription(m.sdp);
    await conn.setLocalDescription(await conn.createAnswer());
    if (conn.iceGatheringState !== "complete") {
      await new Promise((resolve) => {
        conn.addEventListener("icegatheringstatechange", () => conn.iceGatheringState === "complete" && resolve());
        setTimeout(resolve, 1500);
      });
    }
    p.postMessage({ type: "answer", sdp: conn.localDescription.toJSON() });
  });
  p.postMessage({ type: "start", camId: s.camId });
}

async function start() {
  const my = ++run;
  const s = await getSettings();
  video.classList.toggle("mirror", s.mirror);
  stopAll();
  video.srcObject = null;
  spin.hidden = false;
  msg.hidden = true;
  try {
    if (pageBlocks("camera")) {
      await relay(s, my);
    } else {
      try {
        const st = await direct(s);
        if (my !== run) return st.getTracks().forEach((t) => t.stop());
        stream = st;
        video.srcObject = st;
        await video.play().catch(() => {});
      } catch (e) {
        // The page may block the camera in a way that featurePolicy does not show. If Kino has the
        // camera permission, the relay can still open it.
        if (e.name === "NotAllowedError" && (await camGranted())) await relay(s, my);
        else throw e;
      }
    }
  } catch (e) {
    if (my === run) show(explain(e));
  }
}

video.addEventListener("playing", () => (spin.hidden = true));
chrome.storage.onChanged.addListener((c) => {
  if (c.camId || c.mirror) start();
});
addEventListener("pagehide", stopAll);
start();
