// Makes a new video file in the browser: each clip plays into a canvas, and a MediaRecorder records the canvas
// and the sound. Used to cut a video to its trim and to merge clips. No video tools are needed on the server.
// ponytail: renders in real time (a 10-minute result takes 10 minutes); WebCodecs and an MP4 muxer would be faster.

const PART_SIZE = 10 * 1024 * 1024; // same R2 rule as the extension: equal parts of at least 5 MiB
const AUDIO_SEGMENT_MS = 60_000;
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export const pickMime = () => (window.MediaRecorder && HTMLCanvasElement.prototype.captureStream ? MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) : undefined);

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function once(el, ev) {
  return new Promise((resolve, reject) => {
    const ok = () => { el.removeEventListener("error", bad); resolve(); };
    const bad = () => { el.removeEventListener(ev, ok); reject(new Error("A video could not load")); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });
}

async function retry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

// clips: [{ src, start, end, duration }] in seconds (end null = to the end of the file; duration is a hint for progress).
// uploadPart(n, blob) resolves { partNumber, etag }. uploadAudio(n, startMs, blob) is optional (audio parts for the transcript).
// Resolves { parts, durationMs, thumb }.
export async function renderClips(clips, { mimeType, uploadPart, uploadAudio, onProgress = () => {} }) {
  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "auto";
  video.src = clips[0].src;
  await once(video, "loadeddata");

  const W = even(Math.min(video.videoWidth, 2560));
  const H = even((video.videoHeight * W) / video.videoWidth);
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = canvas.getContext("2d", { alpha: false });
  const draw = () => {
    const s = Math.min(W / video.videoWidth, H / video.videoHeight);
    const w = video.videoWidth * s;
    const h = video.videoHeight * s;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(video, (W - w) / 2, (H - h) / 2, w, h);
  };

  // The sound goes into the recording only, not to the speakers.
  const ac = new AudioContext();
  await ac.resume();
  const dest = ac.createMediaStreamDestination();
  ac.createMediaElementSource(video).connect(dest);
  const stream = new MediaStream([canvas.captureStream(30).getVideoTracks()[0], ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_500_000, audioBitsPerSecond: 128_000 });

  let chunks = [], buffered = 0, n = 0, chain = Promise.resolve(), error = null;
  const parts = [];
  const enqueue = (blob) => {
    const k = ++n;
    chain = chain.then(async () => {
      if (error) return;
      try {
        const p = await retry(() => uploadPart(k, blob));
        parts.push({ partNumber: p.partNumber, etag: p.etag });
      } catch (e) { error = e; }
    });
  };
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    chunks.push(e.data);
    buffered += e.data.size;
    while (buffered >= PART_SIZE) {
      const all = new Blob(chunks);
      chunks = [all.slice(PART_SIZE)];
      buffered = all.size - PART_SIZE;
      enqueue(all.slice(0, PART_SIZE));
    }
  };
  const stopped = new Promise((r) => (rec.onstop = r));

  // Audio-only parts of one minute, like the extension, so the server can make the transcript.
  let doneMs = 0, clip = null, audio = null, audioN = 0, audioChain = Promise.resolve();
  const outMs = () => doneMs + (clip ? Math.max(0, video.currentTime - clip.start) * 1000 : 0);
  const startAudio = () => {
    if (!uploadAudio) return;
    const ar = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32_000 });
    const seg = { n: ++audioN, startMs: Math.round(outMs()), chunks: [] };
    ar.ondataavailable = (e) => e.data.size && seg.chunks.push(e.data);
    seg.stopped = new Promise((r) => (ar.onstop = () => {
      if (seg.chunks.length) {
        const blob = new Blob(seg.chunks, { type: "audio/webm" });
        audioChain = audioChain.then(() => retry(() => uploadAudio(seg.n, seg.startMs, blob)).catch(() => {}));
      }
      r();
    }));
    ar.start(1000);
    audio = { ar, seg };
  };

  const total = clips.reduce((s, c) => s + Math.max(0, (c.end ?? c.duration ?? 0) - c.start), 0);
  // A worker timer keeps drawing when the tab is in the background (page timers slow down there).
  const ticker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 33)"], { type: "text/javascript" })));
  let onTick = () => {};
  ticker.onmessage = () => onTick();
  let thumb = null;

  try {
    for (const [i, c] of clips.entries()) {
      if (i > 0) {
        video.src = c.src;
        await once(video, "loadeddata");
      }
      if (c.start > 0) {
        video.currentTime = c.start;
        await once(video, "seeked");
      }
      clip = c;
      draw();
      if (i === 0) thumb = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
      if (rec.state === "inactive") rec.start(1000);
      else rec.resume();
      if (!audio) startAudio();
      else audio.ar.resume();
      await video.play();
      await new Promise((resolve) => {
        const finish = () => { video.removeEventListener("ended", finish); onTick = () => {}; resolve(); };
        video.addEventListener("ended", finish);
        onTick = () => {
          draw();
          onProgress(outMs() / 1000, total);
          if (c.end !== null && c.end !== undefined && video.currentTime >= c.end) finish();
          if (audio?.ar.state === "recording" && outMs() - audio.seg.startMs >= AUDIO_SEGMENT_MS) {
            audio.ar.stop();
            startAudio();
          }
        };
      });
      video.pause();
      doneMs = outMs();
      clip = null;
      rec.pause();
      audio?.ar.pause();
    }
    rec.stop();
    audio?.ar.stop();
    await stopped;
    await audio?.seg.stopped;
    if (buffered > 0 || n === 0) enqueue(new Blob(chunks));
    await chain;
    await audioChain;
    if (error) throw error;
    return { parts, durationMs: Math.round(doneMs), thumb };
  } finally {
    ticker.terminate();
    ac.close().catch(() => {});
    video.removeAttribute("src");
    video.load();
  }
}
