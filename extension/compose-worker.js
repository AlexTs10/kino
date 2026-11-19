// Draws the camera bubble onto the screen video, off the main thread.
// Input: screen frames and camera frames (ReadableStreams of VideoFrame).
// Output: composed VideoFrames, written to a MediaStreamTrackGenerator.
// The camera drives the frame rate (about 30 fps), so the video stays smooth when the screen does not change.

let cfg = { maxHeight: 1080, position: "bl", size: "m", mirror: true, camOn: true };
let canvas = null;
let ctx = null;
let screen = null; // latest screen VideoFrame
let writer = null;
let lastOut = 0;

const SIZE = { s: 0.2, m: 0.27, l: 0.36 }; // bubble diameter as a part of the video height

self.onmessage = async ({ data }) => {
  if (data.type === "start") {
    cfg = { ...cfg, ...data.cfg };
    writer = data.out.getWriter();
    readScreen(data.screen);
    readCamera(data.cam);
  } else if (data.type === "config") {
    cfg = { ...cfg, ...data.cfg };
  } else if (data.type === "thumb") {
    let blob = null;
    if (canvas) {
      const scale = Math.min(1, 1280 / canvas.width);
      const small = new OffscreenCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
      small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);
      blob = await small.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    }
    self.postMessage({ type: "thumb", blob });
  }
};

async function readScreen(readable) {
  const reader = readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    screen?.close();
    screen = value;
    // If the camera stops sending frames, keep the video going from screen frames.
    if (performance.now() - lastOut > 200) await compose(null, value.timestamp);
  }
}

let cam = null;
async function readCamera(readable) {
  if (!readable) return;
  const reader = readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    cam?.close();
    cam = value;
    await compose(cam, value.timestamp);
  }
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

async function compose(camFrame, timestamp) {
  if (!screen || !writer) return;
  const sw = screen.displayWidth;
  const sh = screen.displayHeight;
  const scale = Math.min(1, cfg.maxHeight / sh);
  const W = even(sw * scale);
  const H = even(sh * scale);
  if (!canvas || canvas.width !== W || canvas.height !== H) {
    canvas = new OffscreenCanvas(W, H);
    ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  }
  ctx.drawImage(screen, 0, 0, W, H);

  const frame = camFrame || cam;
  if (cfg.camOn && frame) {
    const d = Math.round(Math.min(W, H) * (SIZE[cfg.size] || SIZE.m));
    const m = Math.round(Math.min(W, H) * 0.035);
    const x = cfg.position.endsWith("r") ? W - d - m : m;
    const y = cfg.position.startsWith("t") ? m : H - d - m;
    const cw = frame.displayWidth;
    const ch = frame.displayHeight;
    const side = Math.min(cw, ch);
    const sx = (cw - side) / 2;
    const sy = (ch - side) / 2;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.35)";
    ctx.shadowBlur = d * 0.08;
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    ctx.clip();
    if (cfg.mirror) {
      ctx.translate(x + d, y);
      ctx.scale(-1, 1);
      ctx.drawImage(frame, sx, sy, side, side, 0, 0, d, d);
    } else {
      ctx.drawImage(frame, sx, sy, side, side, x, y, d, d);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2 - 1, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, d * 0.018);
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.stroke();
  }

  lastOut = performance.now();
  const out = new VideoFrame(canvas, { timestamp });
  try {
    await writer.write(out);
  } catch {
    out.close();
  }
}
