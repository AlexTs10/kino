import { fill, $, h, ICONS, clock, ago, fmtDate, fmtSize, avatar, api, toast, copy, openMenu } from "./util.js";
import { pickMime, renderClips } from "./render.js";

const boot = JSON.parse($("#boot").textContent);
let ownerName = boot.ownerName || "";
const FREE_BYTES = 10e9; // R2 free tier: 10 GB-month
const PENDING = ["queued", "transcribing", "summarizing"];

const app = $("#app");
const search = h("input", { type: "search", className: "search", placeholder: "Search titles, summaries and transcripts" });
const grid = h("div", { className: "grid" });
const usage = h("div", { className: "usage" });
// Merge: click "Merge videos", then click the videos in the order you want.
let picking = false;
let picked = []; // video ids, in merge order
let videos = [];
const mergeBtn = h("button", { className: "btn", html: `${ICONS.merge}<span>Merge videos</span>`, onclick: () => setPicking(!picking) });
const mergeBar = h("div", { className: "card mergebar", hidden: true });
const who = h("button", { className: "btn ghost", onclick: (e) => openMenu(e.currentTarget, [
  { label: ownerName ? `Change name (${ownerName})` : "Set your name", icon: "user", onclick: setName },
  { label: "Sign out", icon: "logout", onclick: () => (location.href = "/logout") },
  { label: "Delete account", icon: "trash", onclick: deleteAccount },
]) });

async function deleteAccount() {
  if (prompt(`This deletes your account and ALL your videos. You cannot undo this.\nType your email (${boot.email}) to continue.`) !== boot.email) return;
  try {
    await api("/api/me", { method: "DELETE" });
    location.href = "/";
  } catch (e) { toast(e.message); }
}

fill(app, 
  h("header", { className: "topbar" }, h("a", { className: "brand", href: "/library" }, h("span", { className: "logo" }), "Kino"), h("span", { className: "spacer" }), who),
  h("main", { className: "lib" },
    h("div", { className: "lib-head" }, h("h1", {}, "My videos"), search, mergeBtn),
    usage,
    mergeBar,
    grid,
  ),
);

function drawWho() {
  fill(who, avatar(ownerName || boot.email || "Me", 26), h("span", {}, ownerName || "Set your name"));
}
drawWho();

async function setName() {
  const name = prompt("Your name. Viewers see it on your videos and comments.", ownerName);
  if (name === null) return;
  try {
    const r = await api("/api/settings", { method: "PUT", body: JSON.stringify({ owner_name: name }) });
    ownerName = r.owner_name;
    drawWho();
    toast("Name saved");
  } catch (e) { toast(e.message); }
}

let timer;
search.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});

let pollTimer;
async function load() {
  let res;
  try {
    const q = search.value.trim();
    const data = await api(`/api/videos${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    res = data._res;
    videos = Object.values(data).filter((x) => x && typeof x === "object" && x.id);
  } catch (e) {
    if (/unauthorized/.test(e.message)) location.href = "/login?next=/library";
    fill(grid, h("p", { className: "err" }, e.message));
    return;
  }
  const bytes = Number(res.headers.get("x-kino-total-bytes") || 0);
  const count = Number(res.headers.get("x-kino-total-count") || 0);
  const ratio = Math.min(1, bytes / FREE_BYTES);
  fill(usage, 
    h("span", {}, `${count} video${count === 1 ? "" : "s"}`), h("span", {}, "·"),
    h("div", { className: `meter ${ratio > 0.8 ? "warn" : ""}` }, h("div", { style: `width:${(ratio * 100).toFixed(1)}%` })),
    h("span", {}, `${fmtSize(bytes)} of 10 GB free storage`),
  );

  if (!videos.length) {
    fill(grid, h("div", { className: "empty", style: "grid-column:1/-1" },
      search.value ? "No videos match your search." : "No videos yet. Click the Kino icon in Chrome, or press Alt+Shift+K, to record your first video."));
  } else {
    drawGrid();
  }

  clearTimeout(pollTimer);
  if (videos.some((v) => v.status !== "ready" || PENDING.includes(v.ai_status))) pollTimer = setTimeout(load, 5000);
}

function drawGrid() {
  if (videos.length) fill(grid, ...videos.map(card));
}

function card(v) {
  const thumb = h("a", { className: "thumb", href: `/${v.id}` });
  if (v.has_thumb) thumb.style.backgroundImage = `url("/${v.id}/thumb.jpg?v=${v.size_bytes || 0}")`;
  if (v.duration_ms) thumb.append(h("span", { className: "dur" }, clock(v.duration_ms / 1000)));
  const status = v.status !== "ready" ? "Uploading" : { queued: "AI is starting", transcribing: "Transcribing", summarizing: "Writing summary", error: "AI failed" }[v.ai_status];
  if (status) thumb.append(h("span", { className: `chip ai ${v.ai_status === "error" ? "danger" : "accent"}` }, v.ai_status === "error" ? null : h("span", { className: "dot-pulse" }), status));
  const tools = h("div", { className: "tools" },
    h("button", { className: "btn small", html: `${ICONS.link}<span>Copy link</span>`, onclick: (e) => { e.preventDefault(); copy(v.url); } }),
    h("button", { className: "btn small icon", title: "Delete", html: ICONS.trash, onclick: (e) => { e.preventDefault(); del(v); } }),
  );
  const expired = v.expires_at && v.expires_at <= Date.now();
  const lock = v.has_password || v.expires_at
    ? h("span", { html: ICONS.lock, title: [v.has_password ? "Password" : "", v.expires_at ? `${expired ? "Expired" : "Expires"} ${fmtDate(v.expires_at)}` : ""].filter(Boolean).join(" · "), className: expired ? "err" : "" })
    : null;
  const order = picked.indexOf(v.id);
  if (order >= 0) thumb.append(h("span", { className: "order" }, String(order + 1)));
  const el = h("article", { className: `vcard ${picking ? "picking" : ""} ${order >= 0 ? "picked" : ""}` },
    thumb, picking ? null : tools,
    h("div", { className: "body" },
      h("a", { className: "t", href: `/${v.id}` }, v.title),
      v.summary ? h("div", { className: "s" }, v.summary) : null,
      h("div", { className: "m" },
        h("span", { title: new Date(v.created_at).toLocaleString() }, ago(v.created_at)),
        h("span", { html: `${ICONS.eye} ${Number(v.views)}` }),
        v.comment_count ? h("span", { html: `${ICONS.chat} ${Number(v.comment_count)}` }) : null,
        v.size_bytes ? h("span", {}, fmtSize(v.size_bytes)) : null,
        lock,
      ),
    ),
  );
  // While picking, a click selects the video instead of opening it.
  el.addEventListener("click", (e) => {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    if (v.status !== "ready") return toast("This video is still uploading.");
    picked = order >= 0 ? picked.filter((id) => id !== v.id) : [...picked, v.id];
    drawGrid();
    drawMergeBar();
  }, true);
  return el;
}

// ---------- Merge ----------

function setPicking(on) {
  picking = on;
  picked = [];
  mergeBtn.classList.toggle("primary", on);
  drawGrid();
  drawMergeBar();
}

function drawMergeBar() {
  mergeBar.hidden = !picking;
  if (!picking) return;
  fill(mergeBar,
    h("span", {}, picked.length ? `${picked.length} selected. The new video plays them in this order.` : "Click the videos in the order you want. The videos stay as they are; Kino makes a new video."),
    h("span", { style: "flex:1" }),
    h("button", { className: "btn small primary", disabled: picked.length < 2, onclick: merge }, "Merge"),
    h("button", { className: "btn small", onclick: () => setPicking(false) }, "Cancel"),
  );
}

async function merge() {
  const mimeType = pickMime();
  if (!mimeType) return toast("This browser cannot make video files. Use Chrome or Edge.");
  const clips = picked.map((id) => videos.find((x) => x.id === id)).filter(Boolean);
  const status = h("span", {}, "Starting…");
  picking = false;
  mergeBtn.disabled = true;
  drawGrid();
  fill(mergeBar, h("strong", {}, "Merging"), status, h("span", { className: "muted", style: "font-size:13px" }, "Keep this tab open and in front. This takes as long as the new video. You do not hear the sound."));
  let created = null;
  try {
    created = await api("/api/videos", { method: "POST", body: JSON.stringify({ mimeType }) });
    const id = created.id;
    const out = await renderClips(
      clips.map((x) => ({ src: `/${x.id}/video?v=${x.size_bytes || 0}`, start: (x.trim_start_ms || 0) / 1000, end: x.trim_end_ms ? x.trim_end_ms / 1000 : null, duration: (x.duration_ms || 0) / 1000 })),
      {
        mimeType,
        uploadPart: (n, blob) => api(`/api/videos/${id}/parts/${n}`, { method: "PUT", body: blob }),
        uploadAudio: (n, startMs, blob) => api(`/api/videos/${id}/audio/${n}?start=${startMs}`, { method: "PUT", headers: { "content-type": "audio/webm" }, body: blob }),
        onProgress: (done, total) => (status.textContent = `${clock(done)} of ${clock(total)}`),
      },
    );
    status.textContent = "Saving…";
    await api(`/api/videos/${id}/complete`, { method: "POST", body: JSON.stringify({ parts: out.parts, durationMs: out.durationMs }) });
    if (out.thumb) await api(`/api/videos/${id}/thumbnail`, { method: "PUT", body: out.thumb }).catch(() => {});
    location.href = `/${id}`;
  } catch (e) {
    if (created) api(`/api/videos/${created.id}`, { method: "DELETE" }).catch(() => {});
    fill(mergeBar, h("span", { className: "err" }, `The merge failed: ${e.message}`), h("span", { style: "flex:1" }), h("button", { className: "btn small", onclick: () => setPicking(false) }, "Close"));
    mergeBtn.disabled = false;
    picked = [];
  }
}

async function del(v) {
  if (!confirm(`Delete "${v.title}"? You cannot undo this.`)) return;
  try {
    await api(`/api/videos/${v.id}`, { method: "DELETE" });
    toast("Video deleted");
    load();
  } catch (e) { toast(e.message); }
}

load();
