import { createPlayer } from "./player.js";
import { fill, $, h, ICONS, clock, ago, fmtDate, avatar, api, toast, copy, openMenu, store } from "./util.js";
import { pickMime, renderClips } from "./render.js";

const boot = JSON.parse($("#boot").textContent);
let v = boot.video;
let comments = boot.comments;
const owner = boot.owner;
const ownerName = boot.ownerName || "Kino";
const base = `/${v.id}`;
const shareUrl = boot.url || location.origin + base;
const isEmbed = document.body.classList.contains("embed");
const app = $("#app");
const PENDING = ["queued", "transcribing", "summarizing"];
const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "🙌", "🔥", "👀"];

let player = null;
let transcript = null; // { language, segments: [{ s, e, t }] }

const startAt = (() => {
  const t = new URLSearchParams(location.search).get("t");
  if (!t) return 0;
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : Number(t) || 0;
})();

// ---------- Still uploading ----------

function renderUploading() {
  fill(app, h("div", { className: "notice" },
    h("div", { className: "spinner" }),
    h("h1", {}, "This video is still uploading"),
    h("p", { className: "muted" }, "The page opens the video when it is ready. This usually takes a few seconds after the recording stops."),
  ));
  setInterval(async () => {
    const r = await fetch(`${base}/data.json`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (r?.video?.status === "ready") location.reload();
  }, 3000);
}

// ---------- Embed ----------

function renderEmbed() {
  const mount = h("div");
  fill(app, mount);
  player = makePlayer(mount, { brand: { href: shareUrl, text: v.title } });
  loadTranscript();
  trackWatching();
}

// ?v= changes when the file changes (after a cut), so no cache keeps the old file.
const videoSrc = () => `${base}/video?v=${v.size_bytes || 0}`;

function makePlayer(mount, extra = {}) {
  return createPlayer(mount, {
    src: videoSrc(),
    poster: v.has_thumb ? `${base}/thumb.jpg?v=${v.size_bytes || 0}` : "",
    durationHint: (v.duration_ms || 0) / 1000,
    trim: { start: v.trim_start_ms, end: v.trim_end_ms },
    chapters: v.chapters || [],
    reactions: boot.reactions,
    startAt,
    ...extra,
  });
}

// ---------- Share page ----------

function renderShare() {
  const mount = h("div");
  const titleEl = h("h1", { className: "title" }, v.title);
  const topbar = h("header", { className: "topbar" },
    h("a", { className: "brand", href: owner ? "/library" : "/" }, h("span", { className: "logo" }), "Kino"),
    h("span", { className: "spacer" }),
    owner ? h("a", { className: "btn ghost", href: "/library", html: `${ICONS.library}<span>Library</span>` }) : null,
    h("button", { className: "btn primary", html: `${ICONS.link}<span>Copy link</span>`, onclick: () => copy(shareUrl) }),
    h("button", { className: "btn icon", "aria-label": "More", html: ICONS.more, onclick: (e) => openMenu(e.currentTarget, moreMenu()) }),
  );

  const reactbar = h("div", { className: "reactbar" },
    REACTIONS.map((emoji) => h("button", { className: "emoji", title: `React with ${emoji}`, onclick: () => react(emoji) }, emoji)),
    h("span", { className: "sep" }),
    h("button", { className: "btn small", html: `${ICONS.chat}<span>Comment</span>`, onclick: () => { selectTab("comments"); $("#comment-text")?.focus(); } }),
  );

  const byline = h("div", { className: "byline", id: "byline" });
  const summary = h("section", { className: "card summary", id: "summary" });
  const trimPanel = h("section", { className: "card trim", id: "trim", hidden: true });
  const accessPanel = h("section", { className: "card trim", id: "access", hidden: true });

  const main = h("div", { className: "main" },
    mount, reactbar,
    h("div", { className: "title-row" }, titleEl),
    byline, trimPanel, accessPanel, summary,
  );
  const side = h("aside", { className: "card side" },
    h("div", { className: "tabs", role: "tablist" },
      h("button", { role: "tab", id: "tab-transcript", onclick: () => selectTab("transcript") }, "Transcript"),
      h("button", { role: "tab", id: "tab-comments", onclick: () => selectTab("comments") }, "Comments", h("span", { className: "count", id: "comment-count" })),
      owner ? h("button", { role: "tab", id: "tab-viewers", onclick: () => selectTab("viewers") }, "Viewers") : null,
    ),
    h("div", { className: "pane", id: "pane-transcript" }),
    h("div", { className: "pane", id: "pane-comments" }),
    owner ? h("div", { className: "pane", id: "pane-viewers" }) : null,
  );
  fill(app, topbar, h("div", { className: "layout" }, main, side));

  player = makePlayer(mount);
  player.onTime(onTime);

  if (owner) makeTitleEditable(titleEl);
  renderByline();
  renderSummary();
  renderTranscriptPane();
  renderComments();
  selectTab(TABS.includes(store("tab")) ? store("tab") : "transcript");
  loadTranscript();
  trackWatching();
  if (PENDING.includes(v.ai_status)) pollAI();

  // Just recorded: the extension opens the page with ?new=1. Copy the link for the owner.
  if (owner && new URLSearchParams(location.search).get("new") === "1") {
    history.replaceState(null, "", location.pathname);
    navigator.clipboard.writeText(shareUrl).then(
      () => toast("Your video is ready. The link is copied."),
      () => toast("Your video is ready. Click Copy link to share it."),
    );
  }
}

function moreMenu() {
  const items = [
    { label: `Copy link at ${clock(player.visibleTime())}`, icon: "clock", onclick: () => copy(`${shareUrl}?t=${Math.floor(player.visibleTime())}`) },
    { label: "Copy embed code", icon: "code", onclick: () => copy(`<iframe src="${shareUrl}/embed" width="640" height="360" frameborder="0" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`, "Embed code copied") },
    { label: "Download", icon: "download", onclick: () => (location.href = `${base}/video?download`) },
  ];
  if (owner) {
    items.push("-",
      { label: "Trim video", icon: "scissors", onclick: openTrim },
      { label: "Password and expiry", icon: "lock", onclick: openAccess },
      { label: "Regenerate transcript and summary", icon: "sparkle", onclick: regenerate },
      "-",
      { label: "Delete video", icon: "trash", danger: true, onclick: deleteVideo },
    );
  }
  return items;
}

function renderByline() {
  const chip = aiChip();
  fill($("#byline"), 
    avatar(ownerName, 28),
    h("strong", {}, ownerName),
    h("span", {}, "·"),
    h("span", { title: new Date(v.created_at).toLocaleString() }, fmtDate(v.created_at)),
    h("span", {}, "·"),
    h("span", {}, `${v.views} view${v.views === 1 ? "" : "s"}`),
    chip,
    accessChip(),
  );
}

function accessChip() {
  if (!owner || (!v.has_password && !v.expires_at)) return null;
  const expired = v.expires_at && v.expires_at <= Date.now();
  const text = [v.has_password ? "Password" : null, v.expires_at ? (expired ? "Expired" : `Expires ${fmtDate(v.expires_at)}`) : null].filter(Boolean).join(" · ");
  return h("button", { className: `chip ${expired ? "danger" : ""}`, style: "border:0;cursor:pointer", title: "Change password and expiry", html: ICONS.lock, onclick: openAccess }, text);
}

function aiChip() {
  if (!owner && v.ai_status === "error") return null;
  const label = { queued: "AI is starting", transcribing: "Transcribing", summarizing: "Writing summary", error: "AI failed" }[v.ai_status];
  if (!label) return null;
  return h("span", { className: `chip ${v.ai_status === "error" ? "danger" : "accent"}` }, v.ai_status === "error" ? null : h("span", { className: "dot-pulse" }), label);
}

// ---------- Title ----------

function makeTitleEditable(el) {
  el.contentEditable = "plaintext-only";
  el.spellcheck = false;
  el.title = "Click to rename";
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    if (e.key === "Escape") { el.textContent = v.title; el.blur(); }
  });
  el.addEventListener("blur", async () => {
    const t = el.textContent.trim();
    if (!t || t === v.title) return (el.textContent = v.title);
    try {
      await api(`/api/videos/${v.id}`, { method: "PATCH", body: JSON.stringify({ title: t }) });
      v.title = t;
      document.title = t;
      toast("Title saved");
    } catch (err) {
      el.textContent = v.title;
      toast(err.message);
    }
  });
}

// ---------- AI summary and chapters ----------

function renderSummary() {
  const el = $("#summary");
  const head = h("h3", { html: `${ICONS.sparkle}<span>Summary</span>` });
  const pending = PENDING.includes(v.ai_status);

  if (pending && !v.summary) {
    el.hidden = false;
    fill(el, head, h("div", { className: "skeleton", style: "width:92%" }), h("div", { className: "skeleton", style: "width:80%" }), h("div", { className: "skeleton", style: "width:55%" }),
      h("p", { className: "muted", style: "margin-top:10px;font-size:13px" }, v.ai_status === "summarizing" ? "Writing the title, summary and chapters…" : "Making the transcript…"));
    return;
  }
  if (v.ai_status === "error" && !v.summary) {
    el.hidden = !owner;
    if (owner) fill(el, head, h("p", { className: "err" }, `The AI step failed: ${v.ai_error || "unknown error"}`), h("p", {}, h("button", { className: "btn small", onclick: regenerate }, "Try again")));
    return;
  }
  if (!v.summary && !(v.chapters || []).length) {
    el.hidden = !owner || v.has_transcript;
    if (owner && !v.has_transcript) {
      fill(el, head, h("p", { className: "muted" }, v.ai_status === "none" ? "No summary. This video has no recorded voice, or it was recorded before transcripts were available." : ""),
        h("p", {}, h("button", { className: "btn small", onclick: regenerate }, "Try to make a transcript")));
    }
    return;
  }

  el.hidden = false;
  const text = h("p", { id: "summary-text" }, v.summary || "");
  if (owner) {
    head.append(h("span", { className: "actions" },
      h("button", { className: "btn ghost small icon", title: "Edit summary", html: ICONS.edit, onclick: () => editSummary(text) }),
    ));
  }
  const chapters = (v.chapters || []).filter(inTrim);
  fill(el, head, v.summary ? text : null,
    chapters.length ? h("ol", { className: "chapters", id: "chapter-list" }, chapters.map((c) =>
      h("li", {}, h("button", { dataset: { start: c.start }, onclick: () => { player.seekReal(c.start); player.play(); } },
        h("span", { className: "ts" }, clock(c.start - player.trimStart())), h("span", {}, c.title))))) : null,
  );
}

// Chapters: start inside the visible part. Transcript lines: any overlap with the visible part.
function inTrim(c) {
  if (c.start !== undefined) return c.start >= player.trimStart() - 0.5 && c.start < player.endTime();
  return c.e / 1000 > player.trimStart() + 0.2 && c.s / 1000 < player.endTime();
}

function editSummary(textEl) {
  const ta = h("textarea", { rows: 5, value: v.summary || "" });
  const save = h("button", { className: "btn small primary" }, "Save");
  const cancel = h("button", { className: "btn small" }, "Cancel");
  const box = h("div", { style: "display:grid;gap:8px" }, ta, h("div", { style: "display:flex;gap:8px" }, save, cancel));
  textEl.replaceWith(box);
  ta.focus();
  cancel.onclick = renderSummary;
  save.onclick = async () => {
    try {
      await api(`/api/videos/${v.id}`, { method: "PATCH", body: JSON.stringify({ summary: ta.value }) });
      v.summary = ta.value.trim() || null;
      toast("Summary saved");
    } catch (e) { toast(e.message); }
    renderSummary();
  };
}

async function pollAI() {
  while (true) {
    await new Promise((r) => setTimeout(r, 4000));
    const data = await fetch(`${base}/data.json`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (!data?.video) continue;
    const before = v;
    v = data.video;
    if (v.title !== before.title && document.activeElement !== $(".title")) {
      $(".title").textContent = v.title;
      document.title = v.title;
    }
    if (v.ai_status !== before.ai_status || v.summary !== before.summary) {
      renderByline();
      player.setChapters(v.chapters || []);
      renderSummary();
    }
    if (v.has_transcript && !before.has_transcript) loadTranscript();
    if (!PENDING.includes(v.ai_status)) {
      renderTranscriptPane();
      if (v.ai_status === "done" && before.ai_status !== "done") toast("Transcript and summary are ready");
      return;
    }
  }
}

async function regenerate() {
  try {
    await api(`/api/videos/${v.id}/process`, { method: "POST", body: "{}" });
    v.ai_status = "queued";
    v.summary = null;
    renderByline();
    renderSummary();
    renderTranscriptPane();
    pollAI();
    toast("Started again. This takes about a minute.");
  } catch (e) { toast(e.message); }
}

// ---------- Transcript ----------

let segEls = [];
let activeSeg = null;
let lastUserScroll = 0;

async function loadTranscript() {
  if (!v.has_transcript) return;
  transcript = await fetch(`${base}/transcript.json`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!transcript) return;
  player.setSegments(transcript.segments);
  if (!isEmbed) renderTranscriptPane();
}

function renderTranscriptPane() {
  const pane = $("#pane-transcript");
  if (!pane) return;
  segEls = [];
  activeSeg = null;
  if (!transcript?.segments?.length) {
    const pending = PENDING.includes(v.ai_status);
    fill(pane, h("div", { className: "empty", html: ICONS.text },
      h("div", {}, pending ? "The transcript is being made. It appears here in about a minute." : v.has_transcript ? "No speech was found in this video." : "No transcript for this video.")));
    return;
  }
  const search = h("input", { type: "search", placeholder: "Search the transcript", value: store("tsearch") || "" });
  const copyBtn = h("button", { className: "btn small", title: "Copy the full transcript", onclick: () => copy(transcript.segments.map((s) => s.t).join(" "), "Transcript copied") }, "Copy");
  const list = h("div", { className: "scroll", id: "transcript-list" });
  list.addEventListener("wheel", () => (lastUserScroll = Date.now()), { passive: true });
  list.addEventListener("touchmove", () => (lastUserScroll = Date.now()), { passive: true });
  fill(pane, h("div", { className: "pane-tools" }, search, copyBtn), list);

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const chapters = (v.chapters || []).filter(inTrim);
    let ci = 0;
    const rows = [];
    segEls = [];
    for (const s of transcript.segments) {
      if (!inTrim(s)) continue;
      while (!q && ci < chapters.length && chapters[ci].start * 1000 <= s.s + 500) rows.push(h("div", { className: "chapter-head" }, chapters[ci++].title));
      if (q && !s.t.toLowerCase().includes(q)) continue;
      const tx = h("span", { className: "tx" });
      if (q) {
        const i = s.t.toLowerCase().indexOf(q);
        tx.append(s.t.slice(0, i), h("mark", {}, s.t.slice(i, i + q.length)), s.t.slice(i + q.length));
      } else tx.textContent = s.t;
      const row = h("div", { className: "seg", onclick: () => { player.seekReal(s.s / 1000); player.play(); } },
        h("span", { className: "ts" }, clock(Math.max(0, s.s / 1000 - player.trimStart()))), tx);
      row._seg = s;
      segEls.push(row);
      rows.push(row);
    }
    fill(list, ...(rows.length ? rows : [h("div", { className: "empty" }, "No matches.")]));
    activeSeg = null;
    onTime(player.realTime());
  };
  search.addEventListener("input", () => { store("tsearch", search.value); draw(); });
  draw();
}

function onTime(t) {
  const ms = t * 1000;
  // Active transcript line
  let hit = null;
  for (const el of segEls) {
    if (el._seg.s <= ms + 150) hit = el;
    else break;
  }
  if (hit !== activeSeg) {
    activeSeg?.classList.remove("active");
    hit?.classList.add("active");
    activeSeg = hit;
    const list = $("#transcript-list");
    if (hit && list && Date.now() - lastUserScroll > 4000 && !$("#pane-transcript").hidden) {
      const top = hit.offsetTop - list.offsetTop - list.clientHeight / 3;
      list.scrollTo({ top, behavior: "smooth" });
    }
  }
  // Active chapter
  const items = document.querySelectorAll("#chapter-list button");
  let cur = null;
  for (const b of items) if (Number(b.dataset.start) <= t + 0.01) cur = b;
  items.forEach((b) => b.classList.toggle("active", b === cur));
  // Comment checkbox label
  const at = $("#comment-at-label");
  if (at) at.textContent = `at ${clock(player.visibleTime())}`;
}

const TABS = owner ? ["transcript", "comments", "viewers"] : ["transcript", "comments"];

function selectTab(name) {
  store("tab", name);
  for (const n of TABS) {
    $(`#tab-${n}`).setAttribute("aria-selected", String(n === name));
    $(`#pane-${n}`).hidden = n !== name;
  }
  if (name === "viewers") loadViewers();
}

// ---------- Viewer insights ----------

// Sends how many different seconds this viewer played. Owner views do not count (the server checks that too).
function trackWatching() {
  if (owner) return;
  let viewer = store("viewer");
  if (!/^[0-9A-Za-z]{8,40}$/.test(viewer || "")) store("viewer", (viewer = crypto.randomUUID().replace(/-/g, "")));
  const seen = new Set();
  let sent = 0;
  player.onTime((t) => { if (!player.video.paused) seen.add(Math.floor(t)); });
  const send = (beacon) => {
    if (seen.size === sent) return;
    sent = seen.size;
    const body = JSON.stringify({ viewer, name: store("name") || "", seconds: seen.size });
    if (beacon) navigator.sendBeacon(`${base}/watch`, new Blob([body], { type: "application/json" }));
    else fetch(`${base}/watch`, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
  };
  setInterval(() => send(false), 15000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && send(true));
  addEventListener("pagehide", () => send(true));
}

async function loadViewers() {
  const pane = $("#pane-viewers");
  let rows;
  try {
    rows = (await api(`/api/videos/${v.id}/insights`)).viewers;
  } catch (e) {
    return fill(pane, h("div", { className: "empty" }, e.message));
  }
  if (!rows.length) {
    return fill(pane, h("div", { className: "empty", html: ICONS.eye }, h("div", {}, "No viewers yet. Your own views do not count.")));
  }
  const end = player.endTime();
  const dur = Number.isFinite(end) ? end - player.trimStart() : (v.duration_ms || 0) / 1000;
  const pct = (s) => (dur > 0 ? Math.min(100, Math.round((s / dur) * 100)) : 0);
  const avg = Math.round(rows.reduce((n, r) => n + pct(r.seconds), 0) / rows.length);
  fill(pane,
    h("div", { className: "pane-tools muted", style: "font-size:13px" }, `${rows.length} viewer${rows.length === 1 ? "" : "s"} · on average ${avg}% watched`),
    h("div", { className: "scroll" }, rows.map((r) => h("div", { className: "viewer" },
      avatar(r.name || "?", 30),
      h("div", { className: "body" },
        h("div", { className: "meta" },
          h("strong", {}, r.name || "Anonymous viewer"),
          h("span", { className: "when", title: new Date(r.updated_at).toLocaleString() }, ago(r.updated_at))),
        h("div", { className: "meter", title: `${clock(r.seconds)} watched` }, h("div", { style: `width:${pct(r.seconds)}%` }))),
      h("span", { className: "pct" }, `${pct(r.seconds)}%`),
    ))),
  );
}

// ---------- Owner: password and expiry ----------

const localInput = (ts) => {
  const d = new Date(ts);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function openAccess() {
  const panel = $("#access");
  panel.hidden = false;
  const pw = h("input", { type: "password", placeholder: v.has_password ? "New password" : "Password", autocomplete: "new-password", maxLength: 200 });
  const exp = h("input", { type: "datetime-local", value: v.expires_at ? localInput(v.expires_at) : "" });
  const save = async (patch, msg) => {
    try {
      const r = await api(`/api/videos/${v.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      v = { ...v, has_password: r.video.has_password, expires_at: r.video.expires_at };
      toast(msg);
      renderByline();
      openAccess();
    } catch (e) { toast(e.message); }
  };
  fill(panel,
    h("div", { className: "row" }, h("strong", { html: ICONS.lock, style: "width:18px;height:18px;display:inline-block" }), h("strong", {}, "Password and expiry"),
      h("span", { className: "muted", style: "font-size:13px" }, "You always see your own videos.")),
    h("div", { className: "row" }, h("span", { className: "muted", style: "min-width:64px" }, "Password"), pw,
      h("button", { className: "btn small", onclick: () => (pw.value ? save({ password: pw.value }, "Password saved") : pw.focus()) }, "Save"),
      v.has_password ? h("button", { className: "btn small ghost", onclick: () => save({ password: null }, "Password removed") }, "Remove") : null),
    h("div", { className: "row" }, h("span", { className: "muted", style: "min-width:64px" }, "Expires"), exp,
      h("button", { className: "btn small", onclick: () => (exp.value ? save({ expires_at: new Date(exp.value).getTime() }, "Expiry saved") : exp.focus()) }, "Save"),
      v.expires_at ? h("button", { className: "btn small ghost", onclick: () => save({ expires_at: null }, "The link does not expire") }, "Never") : null),
    h("div", { className: "row" }, h("button", { className: "btn small", onclick: () => (panel.hidden = true) }, "Close")),
  );
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- Reactions ----------

async function react(emoji) {
  const t_ms = Math.round(player.realTime() * 1000);
  player.addReaction({ emoji, t_ms });
  try {
    await api(`${base}/reactions`, { method: "POST", body: JSON.stringify({ emoji, t_ms }) });
  } catch (e) { toast(e.message); }
}

// ---------- Comments ----------

function renderComments() {
  const pane = $("#pane-comments");
  $("#comment-count").textContent = comments.length ? String(comments.length) : "";
  const list = h("div", { className: "scroll" });
  if (!comments.length) list.append(h("div", { className: "empty", html: ICONS.chat }, h("div", {}, "No comments yet. Be the first.")));
  for (const c of comments) list.append(commentEl(c));

  const name = h("input", { placeholder: "Your name", value: store("name") || "", maxLength: 60, hidden: owner });
  const text = h("textarea", { id: "comment-text", placeholder: "Add a comment…", rows: 2, maxLength: 2000 });
  const atBox = h("input", { type: "checkbox", checked: true });
  const post = h("button", { className: "btn primary small" }, "Post");
  const send = async () => {
    const body = text.value.trim();
    if (!body) return text.focus();
    if (!owner && !name.value.trim()) return name.focus();
    post.disabled = true;
    try {
      const c = await api(`${base}/comments`, {
        method: "POST",
        body: JSON.stringify({ author: name.value.trim(), body, t_ms: atBox.checked ? Math.round(player.realTime() * 1000) : null }),
      });
      if (!owner) store("name", name.value.trim());
      comments.push(c);
      renderComments();
      $(".side .scroll:not(#transcript-list)")?.scrollTo({ top: 1e9 });
    } catch (e) { toast(e.message); }
    post.disabled = false;
  };
  post.onclick = send;
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); });
  const composer = h("div", { className: "composer" },
    name, text,
    h("div", { className: "row" }, h("label", {}, atBox, h("span", { id: "comment-at-label" }, `at ${clock(player.visibleTime())}`)), h("span", { style: "flex:1" }), post),
  );
  fill(pane, list, composer);
}

function commentEl(c) {
  return h("div", { className: "comment" },
    avatar(c.author, 30),
    h("div", { className: "body" },
      h("div", { className: "meta" },
        h("strong", {}, c.author),
        c.is_owner ? h("span", { className: "badge-owner" }, "Owner") : null,
        h("span", { className: "when", title: new Date(c.created_at).toLocaleString() }, ago(c.created_at)),
        owner ? h("button", { className: "btn ghost small icon del", title: "Delete comment", html: ICONS.trash, onclick: () => deleteComment(c) }) : null,
      ),
      h("div", { className: "text" },
        c.t_ms !== null && c.t_ms !== undefined ? h("button", { className: "ts", onclick: () => { player.seekReal(c.t_ms / 1000); player.play(); } }, clock(c.t_ms / 1000 - player.trimStart())) : null,
        c.t_ms !== null && c.t_ms !== undefined ? " " : null,
        c.body,
      ),
    ),
  );
}

async function deleteComment(c) {
  if (!confirm("Delete this comment?")) return;
  try {
    await api(`/api/videos/${v.id}/comments/${c.id}`, { method: "DELETE" });
    comments = comments.filter((x) => x.id !== c.id);
    renderComments();
  } catch (e) { toast(e.message); }
}

// ---------- Owner: trim, delete ----------

function openTrim() {
  const panel = $("#trim");
  panel.hidden = false;
  let start = v.trim_start_ms || 0;
  let end = v.trim_end_ms || null;
  const full = () => Math.round((player.video.duration && Number.isFinite(player.video.duration) ? player.video.duration : (v.duration_ms || 0) / 1000) * 1000);
  // Show the full video while trimming.
  player.setTrim(0, null);
  const sEl = h("span", { className: "t" });
  const eEl = h("span", { className: "t" });
  const draw = () => {
    sEl.textContent = clock(start / 1000);
    eEl.textContent = clock((end ?? full()) / 1000);
  };
  const close = (restore = true) => {
    panel.hidden = true;
    if (restore) player.setTrim(v.trim_start_ms, v.trim_end_ms);
  };
  fill(panel, 
    h("div", { className: "row" }, h("strong", { html: `${ICONS.scissors}` , style: "width:18px;height:18px;display:inline-block" }), h("strong", {}, "Trim video"),
      h("span", { className: "muted", style: "font-size:13px" }, "Viewers see only the part between start and end. To make the file shorter too, save the trim, then click Cut the file.")),
    h("div", { className: "row" }, h("span", { className: "muted", style: "min-width:44px" }, "Start"), sEl,
      h("button", { className: "btn small", onclick: () => { start = Math.round(player.realTime() * 1000); draw(); } }, "Set to current time"),
      h("button", { className: "btn small ghost", onclick: () => { start = 0; draw(); } }, "Reset")),
    h("div", { className: "row" }, h("span", { className: "muted", style: "min-width:44px" }, "End"), eEl,
      h("button", { className: "btn small", onclick: () => { end = Math.round(player.realTime() * 1000); draw(); } }, "Set to current time"),
      h("button", { className: "btn small ghost", onclick: () => { end = null; draw(); } }, "Reset")),
    h("div", { className: "row" },
      h("button", { className: "btn primary small", onclick: save }, "Save trim"),
      h("button", { className: "btn small", onclick: () => close() }, "Cancel"),
      v.trim_start_ms || v.trim_end_ms ? h("button", { className: "btn small", style: "margin-left:auto", onclick: cutFile }, "Cut the file") : null),
  );
  draw();
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  async function save() {
    if (end !== null && end - start < 1000) return toast("The end must be at least 1 second after the start.");
    try {
      const r = await api(`/api/videos/${v.id}`, { method: "PATCH", body: JSON.stringify({ trim_start_ms: start || null, trim_end_ms: end }) });
      v = { ...v, trim_start_ms: r.video.trim_start_ms, trim_end_ms: r.video.trim_end_ms };
      close();
      renderSummary();
      renderTranscriptPane();
      renderComments();
      toast("Trim saved");
    } catch (e) { toast(e.message); }
  }
}

// Real trim: render the saved trim into a new file. It replaces the old file; the link stays the same.
async function cutFile() {
  const mimeType = pickMime();
  if (!mimeType) return toast("This browser cannot make video files. Use Chrome or Edge.");
  if (!confirm("Cut the file to the saved trim? The parts outside the trim are deleted. You cannot undo this.")) return;
  const panel = $("#trim");
  const status = h("p", { className: "muted", style: "margin:0" }, "Starting…");
  fill(panel, h("strong", {}, "Cutting the file"), status,
    h("p", { className: "muted", style: "margin:0;font-size:13px" }, "Keep this tab open and in front. This takes as long as the trimmed video. You do not hear the sound."));
  player.pause();
  try {
    await api(`/api/videos/${v.id}/edit`, { method: "POST", body: JSON.stringify({ mimeType }) });
    const out = await renderClips(
      [{ src: videoSrc(), start: (v.trim_start_ms || 0) / 1000, end: v.trim_end_ms ? v.trim_end_ms / 1000 : null, duration: (v.duration_ms || 0) / 1000 }],
      {
        mimeType,
        uploadPart: (n, blob) => api(`/api/videos/${v.id}/edit/parts/${n}`, { method: "PUT", body: blob }),
        onProgress: (done, total) => (status.textContent = `Making the new file… ${clock(done)} of ${clock(total)}`),
      },
    );
    status.textContent = "Saving…";
    await api(`/api/videos/${v.id}/edit/complete`, { method: "POST", body: JSON.stringify({ parts: out.parts, durationMs: out.durationMs }) });
    if (out.thumb) await api(`/api/videos/${v.id}/thumbnail`, { method: "PUT", body: out.thumb }).catch(() => {});
    location.reload();
  } catch (e) {
    status.textContent = `The cut failed: ${e.message}. The old file did not change.`;
    status.className = "err";
  }
}

async function deleteVideo() {
  if (!confirm(`Delete "${v.title}"? You cannot undo this.`)) return;
  try {
    await api(`/api/videos/${v.id}`, { method: "DELETE" });
    location.href = "/library";
  } catch (e) { toast(e.message); }
}

// Start after all module-level state above is set up.
if (v.status !== "ready") renderUploading();
else if (isEmbed) renderEmbed();
else renderShare();
