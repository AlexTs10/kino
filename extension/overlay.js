// Kino on the page: the setup panel, the live camera bubble, the recording toolbar and the 3-2-1 countdown.
// Injected by the service worker into the active tab. Everything lives in a closed shadow root,
// so page styles do not change it and the page cannot read it.
(() => {
  if (window.__kino) return window.__kino.refresh();

  const EXT_ORIGIN = new URL(chrome.runtime.getURL("")).origin;
  const SIZES = { s: 150, m: 210, l: 300 };
  const ICON = {
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z"/></svg>',
    restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="9" r="1.6"/><circle cx="16" cy="9" r="1.6"/><circle cx="12" cy="9" r="1.6"/><circle cx="8" cy="15" r="1.6"/><circle cx="12" cy="15" r="1.6"/><circle cx="16" cy="15" r="1.6"/></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    camoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 2 20 20M10.4 6H14a2 2 0 0 1 2 2v3.6l1 1 5-3.6v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/></svg>',
  };

  const host = document.createElement("kino-root");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
<style>
  * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  [hidden] { display: none !important; }
  .panel { position: fixed; top: 14px; right: 14px; width: 344px; height: 520px; border: 0; border-radius: 22px; pointer-events: auto;
    box-shadow: 0 24px 70px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06); color-scheme: light; background: transparent;
    animation: slidein .18s ease-out; }
  @keyframes slidein { from { opacity: 0; transform: translateY(-8px) scale(.98); } }

  .bubble { position: fixed; border-radius: 50%; pointer-events: auto; cursor: grab; touch-action: none;
    box-shadow: 0 14px 40px rgba(0,0,0,.35); transition: width .18s, height .18s; }
  .bubble:active { cursor: grabbing; }
  .bubble iframe { width: 100%; height: 100%; border: 0; border-radius: 50%; pointer-events: none; display: block; color-scheme: light; background: transparent; }
  .bubble .tools { position: absolute; left: 50%; bottom: -14px; transform: translateX(-50%); display: flex; gap: 2px; padding: 3px; border-radius: 999px;
    background: rgba(20,20,26,.92); opacity: 0; transition: opacity .15s; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
  .bubble:hover .tools { opacity: 1; }
  .bubble .tools button { all: unset; cursor: pointer; color: #fff; font: 700 11px ui-sans-serif, system-ui, sans-serif; height: 24px; min-width: 24px; padding: 0 6px; border-radius: 999px; display: grid; place-items: center; }
  .bubble .tools button:hover, .bubble .tools button.on { background: rgba(255,255,255,.18); }
  .bubble .tools svg { width: 14px; height: 14px; }

  .bar { position: fixed; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 6px; border-radius: 18px; width: 58px;
    background: rgba(22,22,28,.94); color: #fff; pointer-events: auto; user-select: none; backdrop-filter: blur(12px);
    box-shadow: 0 14px 40px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08); }
  .bar button { all: unset; display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; cursor: pointer; color: #fff; }
  .bar button:hover:not(:disabled) { background: rgba(255,255,255,.14); }
  .bar button:disabled { opacity: .4; cursor: default; }
  .bar button svg { width: 20px; height: 20px; }
  .bar button.on { background: rgba(255,255,255,.22); color: #ffd54a; }
  .bar button.stop { background: #e5484d; }
  .bar button.stop:hover:not(:disabled) { background: #f05a5f; }
  .bar .time { font: 700 13px ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums; padding: 4px 0 2px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .bar .time i { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; animation: blink 1s infinite; }
  .bar.paused .time i { background: #9a9ca6; animation: none; }
  @keyframes blink { 50% { opacity: .25; } }
  .bar .sep { width: 28px; height: 1px; background: rgba(255,255,255,.14); margin: 2px 0; }
  .bar .grip { cursor: grab; opacity: .45; height: 18px; display: grid; place-items: center; }
  .bar .grip svg { width: 22px; height: 22px; }
  .bar .up { font: 600 11px ui-sans-serif, system-ui, sans-serif; text-align: center; padding: 6px 0; opacity: .85; }
  .spin { width: 18px; height: 18px; margin: 4px auto; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .count { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(10,10,14,.35); pointer-events: auto; }
  .count .n { width: 190px; height: 190px; border-radius: 50%; display: grid; place-items: center; background: rgba(20,20,26,.88); color: #fff;
    font: 800 100px ui-sans-serif, system-ui, sans-serif; box-shadow: 0 20px 60px rgba(0,0,0,.4); animation: pop 1s ease-out infinite; }
  .count .hint { position: absolute; top: calc(50% + 120px); color: #fff; font: 600 15px ui-sans-serif, system-ui, sans-serif; text-shadow: 0 1px 6px rgba(0,0,0,.5); }
  @keyframes pop { from { transform: scale(1.12); } to { transform: scale(1); } }

  .ink { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; }
  .ink.on { pointer-events: auto; cursor: crosshair; }
  .ring { position: fixed; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; pointer-events: none;
    border: 3px solid #ffc53d; background: rgba(255,197,61,.28); animation: ring .6s ease-out forwards; }
  @keyframes ring { from { transform: scale(.35); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
</style>
<canvas class="ink" hidden></canvas>
<iframe class="panel" hidden allow="camera; microphone" title="Kino"></iframe>
<div class="bubble" hidden>
  <iframe allow="camera" title="Kino camera"></iframe>
  <div class="tools">
    <button data-size="s" title="Small">S</button><button data-size="m" title="Medium">M</button><button data-size="l" title="Large">L</button>
    <button class="hide" title="Turn camera off">${ICON.camoff}</button>
  </div>
</div>
<div class="bar" hidden>
  <div class="live">
    <button class="stop" title="Stop and share (Alt+Shift+S)">${ICON.stop}</button>
    <div class="time"><i></i><span class="t">0:00</span></div>
    <button class="pause" title="Pause (Alt+Shift+P)">${ICON.pause}</button>
    <button class="pen" title="Draw on the page (Esc to stop)">${ICON.pen}</button>
    <button class="restart" title="Restart">${ICON.restart}</button>
    <button class="trash" title="Delete">${ICON.trash}</button>
    <div class="sep" style="margin:4px auto"></div>
  </div>
  <div class="up" hidden><div class="spin"></div>Saving</div>
  <div class="grip" title="Drag">${ICON.grip}</div>
</div>
<div class="count" hidden><div class="n"></div><div class="hint">Recording starts. Press Alt+Shift+S to stop.</div></div>`;
  (document.body || document.documentElement).append(host);

  const $ = (s) => root.querySelector(s);
  const panel = $(".panel");
  const bubble = $(".bubble");
  const bar = $(".bar");

  let panelOpen = false;
  let rec = { status: "idle" };
  let cfg = { camOn: true, recordType: "screen", camSize: "m", bubblePos: null, barPos: null, clickHighlights: true, pipOpen: false };
  let timer = null;
  let wasActive = false;

  // ---------- Panel ----------

  function setPanel(open) {
    panelOpen = open === "toggle" ? !panelOpen : !!open;
    if (panelOpen && !panel.getAttribute("src")) panel.src = chrome.runtime.getURL("panel.html");
    if (!panelOpen) panel.removeAttribute("src"); // releases the panel's microphone meter
    render();
  }

  addEventListener("message", (e) => {
    if (e.origin !== EXT_ORIGIN || !e.data?.kino) return;
    if (e.data.kino === "close") setPanel(false);
    if (e.data.kino === "starting") openPip();
    if (e.data.kino === "size") panel.style.height = `${Math.min(innerHeight - 28, e.data.h)}px`;
  });

  // ---------- Camera bubble ----------

  function bubbleWanted() {
    const live = ["countdown", "recording", "paused"].includes(rec.status);
    if (live) return rec.bubble && rec.mode !== "screen";
    return panelOpen && cfg.camOn !== false;
  }

  function placeBubble() {
    const d = SIZES[cfg.camSize] || SIZES.m;
    bubble.style.width = bubble.style.height = `${d}px`;
    const p = cfg.bubblePos || { x: 28, y: innerHeight - d - 36 };
    bubble.style.left = `${Math.min(Math.max(8, p.x), innerWidth - d - 8)}px`;
    bubble.style.top = `${Math.min(Math.max(8, p.y), innerHeight - d - 20)}px`;
    for (const b of root.querySelectorAll(".bubble [data-size]")) b.classList.toggle("on", b.dataset.size === cfg.camSize);
  }

  function renderBubble() {
    const show = bubbleWanted() && document.visibilityState === "visible";
    const frame = bubble.querySelector("iframe");
    if (show && !frame.getAttribute("src")) frame.src = chrome.runtime.getURL("bubble.html");
    if (!show && frame.getAttribute("src")) frame.removeAttribute("src"); // turns the camera off
    bubble.hidden = !show;
    if (show) placeBubble();
  }

  drag(bubble, (x, y) => {
    cfg.bubblePos = { x, y };
    placeBubble();
  }, () => chrome.storage.local.set({ bubblePos: cfg.bubblePos }));

  for (const b of root.querySelectorAll(".bubble [data-size]")) {
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.onclick = () => chrome.storage.local.set({ camSize: b.dataset.size });
  }
  $(".bubble .hide").addEventListener("pointerdown", (e) => e.stopPropagation());
  $(".bubble .hide").onclick = () => chrome.storage.local.set({ camOn: false });

  // ---------- Recording toolbar ----------

  const send = (action) => {
    try {
      chrome.runtime.sendMessage({ type: "rec-control", action }).catch(() => {});
    } catch {
      teardown(); // the extension was reloaded
    }
  };
  $(".bar .stop").onclick = () => send("stop");
  $(".bar .pause").onclick = () => send("pause");
  $(".bar .restart").onclick = () => send("restart");
  $(".bar .trash").onclick = () => confirm("Delete this recording?") && send("delete");

  // ---------- Floating controls ----------
  // The toolbar goes into a Document Picture-in-Picture window: it floats over all tabs and apps,
  // and it is not in a tab or window recording. A full screen recording still shows it.
  // Without the API (or if Chrome refuses), the toolbar stays on the page.
  let pip = null;
  let pipSeen = false; // a recording state arrived since the window opened
  const LIVE = ["picking", "countdown", "recording", "paused", "finishing"];

  async function openPip() {
    if (pip) return;
    chrome.storage.local.set({ pipOpen: false });
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: 72, height: 380 });
    } catch {
      return;
    }
    chrome.storage.local.set({ pipOpen: true }); // other tabs then hide their page toolbar
    pipSeen = false;
    const d = pip.document;
    d.title = "Kino";
    d.head.append(Object.assign(d.createElement("style"), { textContent: root.querySelector("style").textContent + PIP_CSS }));
    d.body.append(bar, Object.assign(d.createElement("div"), { className: "wait", textContent: "Choose what to share" }));
    pip.addEventListener("pagehide", () => {
      root.append(bar);
      pip = null;
      try { chrome.storage.local.set({ pipOpen: false }); } catch { /* extension reloaded */ }
      render();
    });
    render();
  }
  const PIP_CSS = `
    html, body { margin: 0; height: 100%; background: #16161c; color: #fff; overflow: hidden; }
    body { display: grid; place-items: center; }
    .bar { position: static; box-shadow: none; backdrop-filter: none; background: transparent; }
    .bar .grip { display: none; }
    .wait { font: 600 12px ui-sans-serif, system-ui, sans-serif; text-align: center; padding: 8px; opacity: .8; }`;

  function renderPip(st) {
    if (!pip) return;
    if (LIVE.includes(st)) pipSeen = true;
    else if (pipSeen) return pip.close();
    pip.document.querySelector(".wait").hidden = !bar.hidden;
  }

  function placeBar() {
    if (pip) return;
    const h = bar.offsetHeight || 300;
    const p = cfg.barPos || { x: 16, y: (innerHeight - h) / 2 - 60 };
    bar.style.left = `${Math.min(Math.max(8, p.x), innerWidth - 66)}px`;
    bar.style.top = `${Math.min(Math.max(8, p.y), innerHeight - h - 8)}px`;
  }
  drag($(".bar .grip"), (x, y) => {
    cfg.barPos = { x, y };
    placeBar();
  }, () => chrome.storage.local.set({ barPos: cfg.barPos }), bar);

  // ---------- Drawing and click highlights ----------
  // They are on the page, so they are in the recording when you record this tab, its window or the screen.

  const ink = $(".ink");
  const inkCtx = ink.getContext("2d");
  const FADE_AFTER = 2500; // a line stays this long after you draw it, then fades
  const FADE_MS = 600;
  let drawing = false;
  let strokes = []; // { pts: [[x, y]], end: ms | null }
  let inkFrame = 0;

  $(".bar .pen").onclick = () => {
    drawing = !drawing;
    render();
  };

  function sizeInk() {
    const d = devicePixelRatio || 1;
    ink.width = Math.round(innerWidth * d);
    ink.height = Math.round(innerHeight * d);
    inkCtx.setTransform(d, 0, 0, d, 0, 0);
  }
  sizeInk();

  ink.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    ink.setPointerCapture(e.pointerId);
    const s = { pts: [[e.clientX, e.clientY]], end: null };
    strokes.push(s);
    const move = (ev) => s.pts.push([ev.clientX, ev.clientY]);
    const up = () => {
      s.end = performance.now();
      ink.removeEventListener("pointermove", move);
      ink.removeEventListener("pointerup", up);
      ink.removeEventListener("pointercancel", up);
    };
    ink.addEventListener("pointermove", move);
    ink.addEventListener("pointerup", up);
    ink.addEventListener("pointercancel", up);
    drawInk();
  });

  function drawInk() {
    cancelAnimationFrame(inkFrame);
    const now = performance.now();
    strokes = strokes.filter((s) => s.end === null || now - s.end < FADE_AFTER + FADE_MS);
    inkCtx.clearRect(0, 0, innerWidth, innerHeight);
    inkCtx.lineCap = inkCtx.lineJoin = "round";
    inkCtx.lineWidth = 5;
    inkCtx.strokeStyle = "#e5484d";
    for (const s of strokes) {
      inkCtx.globalAlpha = s.end === null ? 1 : Math.min(1, Math.max(0, 1 - (now - s.end - FADE_AFTER) / FADE_MS));
      inkCtx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? inkCtx.lineTo(x, y) : inkCtx.moveTo(x, y)));
      if (s.pts.length === 1) inkCtx.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]); // a dot
      inkCtx.stroke();
    }
    if (strokes.length) inkFrame = requestAnimationFrame(drawInk);
  }

  // A ring where you click on the page. Clicks on the Kino controls do not show.
  function onPagePointer(e) {
    if (rec.status !== "recording" || cfg.clickHighlights === false || drawing || e.button !== 0) return;
    if (e.composedPath().includes(host)) return;
    const ring = document.createElement("div");
    ring.className = "ring";
    ring.style.left = `${e.clientX}px`;
    ring.style.top = `${e.clientY}px`;
    root.append(ring);
    setTimeout(() => ring.remove(), 650);
  }

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  function tick() {
    if (rec.status === "countdown") $(".count .n").textContent = String(Math.max(1, Math.ceil((rec.countdownEnd - Date.now()) / 1000)));
    $(".bar .t").textContent = fmt((rec.activeMs || 0) + (rec.resumedAt ? Date.now() - rec.resumedAt : 0));
  }

  // ---------- Render ----------

  function render() {
    const st = rec.status;
    const recording = ["countdown", "recording", "paused", "finishing"].includes(st);
    if (recording && panelOpen) {
      panelOpen = false;
      panel.removeAttribute("src");
    }
    panel.hidden = !panelOpen;
    renderBubble();

    bar.hidden = !recording || (cfg.pipOpen && !pip); // the controls float in another tab's window
    bar.classList.toggle("paused", st === "paused");
    $(".bar .live").hidden = st === "finishing";
    $(".bar .up").hidden = st !== "finishing";
    $(".bar .pause").innerHTML = st === "paused" ? ICON.play : ICON.pause;
    $(".bar .pause").title = st === "paused" ? "Resume (Alt+Shift+P)" : "Pause (Alt+Shift+P)";
    for (const b of root.querySelectorAll(".bar button")) b.disabled = st === "countdown";
    $(".count").hidden = st !== "countdown";
    if (recording) placeBar();
    renderPip(st);

    const live = st === "recording" || st === "paused";
    if (!live) drawing = false;
    ink.hidden = !live;
    ink.classList.toggle("on", drawing);
    $(".bar .pen").classList.toggle("on", drawing);

    clearInterval(timer);
    if (recording) {
      tick();
      timer = setInterval(tick, 250);
    }
    // Remove everything when the panel closes and no recording runs.
    // Not on the first render: the "open panel" message can arrive just after it.
    if (panelOpen || recording) wasActive = true;
    else if (wasActive) teardown();
  }

  // ---------- Dragging ----------

  function drag(handle, onMove, onEnd, box = handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const start = { x: e.clientX, y: e.clientY, left: box.offsetLeft, top: box.offsetTop };
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => onMove(start.left + ev.clientX - start.x, start.top + ev.clientY - start.y);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        onEnd();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  // ---------- Wiring ----------

  async function refresh() {
    try {
      const data = await chrome.storage.local.get(["recState", "camOn", "recordType", "camSize", "bubblePos", "barPos", "clickHighlights", "pipOpen"]);
      rec = data.recState || { status: "idle" };
      cfg = { ...cfg, ...data, camSize: data.camSize || "m" };
      if (!host.isConnected) (document.body || document.documentElement).append(host);
      render();
    } catch {
      teardown();
    }
  }

  function onStorage(changes) {
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k === "recState") rec = newValue || { status: "idle" };
      else if (k in cfg || ["camOn", "recordType", "camSize"].includes(k)) cfg[k] = newValue;
    }
    render();
  }

  function onMessage(msg) {
    if (msg?.type === "kino-panel") setPanel(msg.open);
  }

  function onVisibility() {
    renderBubble();
  }

  function onResize() {
    sizeInk();
    if (!bubble.hidden) placeBubble();
    if (!bar.hidden) placeBar();
  }

  function teardown() {
    clearInterval(timer);
    pip?.close();
    host.remove();
    removeEventListener("resize", onResize);
    removeEventListener("pointerdown", onPagePointer, true);
    removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVisibility);
    try {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch { /* extension reloaded */ }
    window.__kino = null;
  }

  chrome.storage.onChanged.addListener(onStorage);
  chrome.runtime.onMessage.addListener(onMessage);
  addEventListener("resize", onResize);
  document.addEventListener("visibilitychange", onVisibility);
  addEventListener("pointerdown", onPagePointer, true);
  function onKey(e) {
    if (e.key !== "Escape") return;
    if (panelOpen) setPanel(false);
    if (drawing) {
      drawing = false;
      render();
    }
  }
  addEventListener("keydown", onKey);
  window.__kino = { refresh };
  refresh();
})();
