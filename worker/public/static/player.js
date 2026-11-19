// Custom video player: chapters on the timeline, reactions, captions from the transcript,
// non-destructive trim, speed, keyboard shortcuts.
// All times inside are "real" seconds of the file. The UI shows "visible" time (real minus trim start).
import { fill, ICONS, h, clock, store, isTyping } from "./util.js";

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 2.5, 0.75];

export function createPlayer(mount, opts) {
  let trimStart = (opts.trim?.start || 0) / 1000;
  let trimEnd = opts.trim?.end ? opts.trim.end / 1000 : null;
  let chapters = opts.chapters || []; // [{ start (s), title }]
  let segments = []; // [{ s, e, t }] in ms
  let reactions = [...(opts.reactions || [])]; // [{ emoji, t_ms }]
  let capOn = store("captions") ?? false;
  const listeners = new Set();

  const video = h("video", { playsInline: true, preload: "metadata", poster: opts.poster || "", src: opts.src });
  const big = h("button", { className: "kp-big", "aria-label": "Play", html: ICONS.play });
  const cap = h("div", { className: "kp-cap", "aria-live": "off" });
  const played = h("div", { className: "kp-played" });
  const buf = h("div", { className: "kp-buf" });
  const rail = h("div", { className: "kp-rail" }, buf, played);
  const knob = h("div", { className: "kp-knob" });
  const tip = h("div", { className: "kp-tip" });
  const marks = h("div", { className: "kp-marks" });
  const prog = h("div", { className: "kp-prog", role: "slider", "aria-label": "Seek", tabIndex: -1 }, rail, knob, tip, marks);
  const playBtn = h("button", { "aria-label": "Play (k)", title: "Play (k)", html: ICONS.play });
  const volBtn = h("button", { "aria-label": "Mute (m)", title: "Mute (m)", html: ICONS.volume });
  const volRange = h("input", { type: "range", min: 0, max: 1, step: 0.05, "aria-label": "Volume" });
  const time = h("span", { className: "kp-time" }, "0:00 / 0:00");
  const chapName = h("span", { className: "kp-chap" });
  const ccBtn = h("button", { "aria-label": "Captions (c)", title: "Captions (c)", html: ICONS.cc, hidden: true });
  const speedBtn = h("button", { "aria-label": "Speed", title: "Speed (Shift + > / <)" }, "1×");
  const pipBtn = h("button", { "aria-label": "Picture in picture", title: "Picture in picture", html: ICONS.pip, hidden: !document.pictureInPictureEnabled });
  const fsBtn = h("button", { "aria-label": "Full screen (f)", title: "Full screen (f)", html: ICONS.full });
  const ctrl = h("div", { className: "kp-ctrl" },
    prog,
    h("div", { className: "kp-row" }, playBtn, h("div", { className: "kp-vol" }, volBtn, volRange), time, chapName, h("span", { className: "kp-spacer" }), ccBtn, speedBtn, pipBtn, fsBtn),
  );
  const root = h("div", { className: "kp", tabIndex: 0 }, video, h("div", { className: "kp-ended" }), cap, h("div", { className: "kp-spinner" }), big, ctrl);
  if (opts.brand) root.append(h("a", { className: "kp-brand", href: opts.brand.href, target: "_blank", rel: "noopener" }, opts.brand.text));
  fill(mount, root);

  // ----- time model -----
  const realDur = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (opts.durationHint || 0));
  const endT = () => Math.min(trimEnd ?? Infinity, realDur() || Infinity);
  const visDur = () => Math.max(0, (Number.isFinite(endT()) ? endT() : 0) - trimStart);
  const pct = (real) => (visDur() ? Math.min(100, Math.max(0, ((real - trimStart) / visDur()) * 100)) : 0);

  function seekReal(t) {
    const end = endT();
    const max = Number.isFinite(end) ? end - 0.05 : t;
    video.currentTime = Math.max(trimStart, Math.min(t, max));
    root.classList.remove("ended");
    update();
  }

  // ----- volume and speed (remembered per browser) -----
  video.volume = store("volume") ?? 1;
  video.muted = store("muted") ?? false;
  const speed = store("speed") ?? 1;
  video.playbackRate = speed;
  video.defaultPlaybackRate = speed;
  function syncVol() {
    volRange.value = video.muted ? 0 : video.volume;
    volBtn.innerHTML = video.muted || video.volume === 0 ? ICONS.muted : ICONS.volume;
  }
  syncVol();
  volBtn.onclick = () => { video.muted = !video.muted; store("muted", video.muted); syncVol(); };
  volRange.oninput = () => { video.volume = Number(volRange.value); video.muted = video.volume === 0; store("volume", video.volume); store("muted", video.muted); syncVol(); };
  function setSpeed(r) {
    video.playbackRate = r;
    store("speed", r);
    speedBtn.textContent = `${r}×`;
  }
  speedBtn.textContent = `${speed}×`;
  speedBtn.onclick = () => setSpeed(SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length] ?? 1);

  // ----- play / pause -----
  function play() {
    if (root.classList.contains("ended") || video.currentTime >= endT() - 0.1 || video.currentTime < trimStart) seekReal(trimStart);
    return video.play().catch(() => {});
  }
  const toggle = () => (video.paused ? play() : video.pause());
  big.onclick = (e) => { e.stopPropagation(); toggle(); };
  playBtn.onclick = toggle;
  video.addEventListener("click", toggle);
  video.addEventListener("dblclick", () => toggleFs());
  video.addEventListener("play", () => { root.classList.add("playing"); root.classList.remove("ended"); playBtn.innerHTML = ICONS.pause; loop(); });
  video.addEventListener("pause", () => { root.classList.remove("playing"); playBtn.innerHTML = ICONS.play; root.classList.remove("idle"); });
  video.addEventListener("waiting", () => root.classList.add("waiting"));
  for (const ev of ["playing", "canplay", "seeked"]) video.addEventListener(ev, () => root.classList.remove("waiting"));
  video.addEventListener("ended", () => markEnded());
  video.addEventListener("loadedmetadata", () => {
    if (video.currentTime < trimStart || opts.startAt) seekReal(trimStart + (opts.startAt || 0));
    renderMarks();
    update();
  });
  video.addEventListener("durationchange", () => { renderMarks(); update(); });
  video.addEventListener("progress", update);
  video.addEventListener("timeupdate", update);

  function markEnded() {
    video.pause();
    root.classList.add("ended");
    big.innerHTML = ICONS.replay;
    big.classList.add("replay");
  }

  function loop() {
    update();
    if (!video.paused) requestAnimationFrame(loop);
  }

  // ----- progress bar -----
  function update() {
    const t = video.currentTime;
    const end = endT();
    if (!video.paused && Number.isFinite(end) && t >= end - 0.05) markEnded();
    if (!root.classList.contains("ended") && big.classList.contains("replay")) { big.innerHTML = ICONS.play; big.classList.remove("replay"); }
    played.style.width = `${pct(t)}%`;
    knob.style.left = `${pct(t)}%`;
    if (video.buffered.length) buf.style.width = `${pct(video.buffered.end(video.buffered.length - 1))}%`;
    time.textContent = `${clock(t - trimStart)} / ${clock(visDur())}`;
    const ch = chapterAt(t);
    chapName.textContent = ch ? `· ${ch.title}` : "";
    renderCaption(t);
    for (const fn of listeners) fn(t);
  }

  function chapterAt(t) {
    let cur = null;
    for (const c of chapters) if (c.start <= t + 0.01) cur = c;
    return cur;
  }

  function realFromEvent(e) {
    const r = rail.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return trimStart + x * visDur();
  }
  prog.addEventListener("pointermove", (e) => {
    const t = realFromEvent(e);
    const ch = chapterAt(t);
    tip.textContent = ch ? `${clock(t - trimStart)} · ${ch.title}` : clock(t - trimStart);
    tip.style.left = `${pct(t)}%`;
    if (prog.classList.contains("drag")) seekReal(t);
  });
  prog.addEventListener("pointerdown", (e) => {
    prog.setPointerCapture(e.pointerId);
    prog.classList.add("drag");
    seekReal(realFromEvent(e));
  });
  prog.addEventListener("pointerup", () => prog.classList.remove("drag"));
  prog.addEventListener("pointercancel", () => prog.classList.remove("drag"));

  function renderMarks() {
    rail.querySelectorAll(".kp-gap").forEach((g) => g.remove());
    for (const c of chapters) {
      if (c.start > trimStart + 0.5 && c.start < endT() - 0.5) rail.append(h("div", { className: "kp-gap", style: `left:${pct(c.start)}%` }));
    }
    // One emoji per 1.5% of the bar, the most recent wins.
    const buckets = new Map();
    for (const r of reactions) {
      const t = r.t_ms / 1000;
      if (t < trimStart || t > endT()) continue;
      buckets.set(Math.round(pct(t) / 1.5), r.emoji);
    }
    fill(marks, ...[...buckets].map(([b, emoji]) => h("span", { className: "kp-mark", style: `left:${Math.min(98.5, b * 1.5)}%` }, emoji)));
  }

  // ----- captions -----
  function renderCaption(t) {
    if (!capOn || !segments.length) return fill(cap, );
    const ms = t * 1000;
    let lo = 0, hi = segments.length - 1, hit = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].s <= ms) { hit = segments[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    const text = hit && ms <= Math.max(hit.e, hit.s + 1500) ? hit.t : "";
    if (cap.textContent !== text) fill(cap, text ? h("span", {}, text) : "");
  }
  function setCaptions(on) {
    capOn = on;
    store("captions", on);
    ccBtn.classList.toggle("on", on);
    update();
  }
  ccBtn.onclick = () => setCaptions(!capOn);

  // ----- full screen, PiP -----
  function toggleFs() {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (root.requestFullscreen) return root.requestFullscreen().catch(() => {});
    video.webkitEnterFullscreen?.();
  }
  fsBtn.onclick = toggleFs;
  document.addEventListener("fullscreenchange", () => (fsBtn.innerHTML = document.fullscreenElement ? ICONS.unfull : ICONS.full));
  pipBtn.onclick = () => (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => {});

  // ----- hide controls when idle -----
  let idleTimer;
  function wake() {
    root.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => !video.paused && !prog.classList.contains("drag") && root.classList.add("idle"), 2500);
  }
  root.addEventListener("pointermove", wake);
  root.addEventListener("pointerdown", wake);
  root.addEventListener("mouseleave", () => !video.paused && root.classList.add("idle"));

  // ----- keyboard -----
  if (opts.keyboard !== false) {
    document.addEventListener("keydown", (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      const step = (d) => seekReal(video.currentTime + d);
      const actions = {
        " ": toggle, k: toggle, K: toggle,
        ArrowLeft: () => step(-5), ArrowRight: () => step(5), j: () => step(-10), l: () => step(10),
        ArrowUp: () => { video.volume = Math.min(1, video.volume + 0.1); video.muted = false; syncVol(); },
        ArrowDown: () => { video.volume = Math.max(0, video.volume - 0.1); syncVol(); },
        m: () => volBtn.click(), f: toggleFs, c: () => segments.length && setCaptions(!capOn),
        ">": () => setSpeed(Math.min(3, Math.round((video.playbackRate + 0.25) * 100) / 100)),
        "<": () => setSpeed(Math.max(0.5, Math.round((video.playbackRate - 0.25) * 100) / 100)),
      };
      if (/^[0-9]$/.test(k)) actions[k] = () => seekReal(trimStart + (Number(k) / 10) * visDur());
      if (actions[k]) {
        e.preventDefault();
        actions[k]();
        wake();
      }
    });
  }

  function floatReaction(emoji) {
    const el = h("span", { className: "kp-float", style: `left:${10 + Math.random() * 75}%` }, emoji);
    root.append(el);
    setTimeout(() => el.remove(), 1700);
  }

  return {
    root,
    video,
    play,
    pause: () => video.pause(),
    realTime: () => video.currentTime,
    visibleTime: () => video.currentTime - trimStart,
    trimStart: () => trimStart,
    endTime: endT,
    seekReal,
    onTime: (fn) => listeners.add(fn),
    setSegments(segs) {
      segments = segs || [];
      ccBtn.hidden = !segments.length;
      ccBtn.classList.toggle("on", capOn);
      update();
    },
    setChapters(list) {
      chapters = list || [];
      renderMarks();
      update();
    },
    setTrim(startMs, endMs) {
      trimStart = (startMs || 0) / 1000;
      trimEnd = endMs ? endMs / 1000 : null;
      renderMarks();
      if (video.currentTime < trimStart || video.currentTime > endT()) seekReal(trimStart);
      update();
    },
    addReaction(r, animate = true) {
      reactions.push(r);
      renderMarks();
      if (animate) floatReaction(r.emoji);
    },
    setReactions(list) {
      reactions = [...list];
      renderMarks();
    },
  };
}
