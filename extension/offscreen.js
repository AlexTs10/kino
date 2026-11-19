// Camera and microphone relay for pages that block them.
// Some sites (for example the Cloudflare dashboard) send "Permissions-Policy: camera=(), microphone=()".
// Chrome applies that policy to the Kino frames on the page as well. This hidden extension page is not
// inside the site, so it can open the camera. It sends the picture to the bubble with a local WebRTC
// connection, and the microphone level to the panel as numbers.

let cam = null; // { key, stream, users }

async function getCam(camId) {
  const key = camId || "";
  if (cam && cam.key !== key && cam.users === 0) {
    cam.stream.getTracks().forEach((t) => t.stop());
    cam = null;
  }
  if (!cam || cam.key !== key) {
    const video = { width: { ideal: 640 }, height: { ideal: 640 }, frameRate: { ideal: 30 } };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: camId ? { ...video, deviceId: { exact: camId } } : video });
    } catch (e) {
      if (!camId || e.name !== "OverconstrainedError") throw e;
      stream = await navigator.mediaDevices.getUserMedia({ video }); // The saved camera is gone: use the default one.
    }
    if (cam) cam.stream.getTracks().forEach((t) => t.stop());
    cam = { key, stream, users: 0 };
  }
  cam.users++;
  return cam;
}

function releaseCam(c) {
  if (!c) return;
  c.users--;
  if (c.users <= 0 && cam === c) {
    c.stream.getTracks().forEach((t) => t.stop());
    cam = null;
  }
}

const gathered = (pc) =>
  pc.iceGatheringState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => {
        const done = () => pc.iceGatheringState === "complete" && resolve();
        pc.addEventListener("icegatheringstatechange", done);
        setTimeout(resolve, 1500); // Local candidates are enough.
      });

function camPeer(port) {
  let pc = null;
  let held = null;
  let closed = false;
  port.onDisconnect.addListener(() => {
    closed = true;
    pc?.close();
    releaseCam(held);
    held = null;
  });
  port.onMessage.addListener(async (m) => {
    try {
      if (m.type === "start") {
        held = await getCam(m.camId);
        if (closed) return releaseCam(held);
        pc = new RTCPeerConnection();
        const track = held.stream.getVideoTracks()[0];
        const sender = pc.addTrack(track, held.stream);
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = 3_000_000;
        params.degradationPreference = "maintain-resolution";
        await sender.setParameters(params).catch(() => {});
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc);
        if (!closed) port.postMessage({ type: "offer", sdp: pc.localDescription.toJSON() });
      } else if (m.type === "answer" && pc) {
        await pc.setRemoteDescription(m.sdp);
      }
    } catch (e) {
      if (!closed) port.postMessage({ type: "error", name: e.name, message: e.message });
    }
  });
}

function micLevel(port) {
  let stream = null;
  let ctx = null;
  let timer = 0;
  const stop = () => {
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close().catch(() => {});
    stream = ctx = null;
  };
  port.onDisconnect.addListener(stop);
  port.onMessage.addListener(async (m) => {
    if (m.type !== "start") return;
    stop();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: m.micId ? { deviceId: { exact: m.micId } } : true });
    } catch (e) {
      return port.postMessage({ type: "error", name: e.name, message: e.message });
    }
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      try {
        port.postMessage({ type: "level", rms: Math.sqrt(sum / buf.length) });
      } catch {
        stop();
      }
    }, 60);
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "kino-cam") camPeer(port);
  else if (port.name === "kino-mic") micLevel(port);
});

// For tests: is the camera open?
globalThis.kinoRelayCamOpen = () => !!cam;
