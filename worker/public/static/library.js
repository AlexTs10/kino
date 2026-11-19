import { fill, $, h, ICONS, clock, ago, fmtSize, avatar, api, toast, copy, openMenu } from "./util.js";

const boot = JSON.parse($("#boot").textContent);
let ownerName = boot.ownerName || "";
const FREE_BYTES = 10e9; // R2 free tier: 10 GB-month
const PENDING = ["queued", "transcribing", "summarizing"];

const app = $("#app");
const search = h("input", { type: "search", className: "search", placeholder: "Search titles, summaries and transcripts" });
const grid = h("div", { className: "grid" });
const usage = h("div", { className: "usage" });
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
    h("div", { className: "lib-head" }, h("h1", {}, "My videos"), search),
    usage,
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
  let videos, res;
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
    fill(grid, ...videos.map(card));
  }

  clearTimeout(pollTimer);
  if (videos.some((v) => v.status !== "ready" || PENDING.includes(v.ai_status))) pollTimer = setTimeout(load, 5000);
}

function card(v) {
  const thumb = h("a", { className: "thumb", href: `/${v.id}` });
  if (v.has_thumb) thumb.style.backgroundImage = `url("/${v.id}/thumb.jpg")`;
  if (v.duration_ms) thumb.append(h("span", { className: "dur" }, clock(v.duration_ms / 1000)));
  const status = v.status !== "ready" ? "Uploading" : { queued: "AI is starting", transcribing: "Transcribing", summarizing: "Writing summary", error: "AI failed" }[v.ai_status];
  if (status) thumb.append(h("span", { className: `chip ai ${v.ai_status === "error" ? "danger" : "accent"}` }, v.ai_status === "error" ? null : h("span", { className: "dot-pulse" }), status));
  const tools = h("div", { className: "tools" },
    h("button", { className: "btn small", html: `${ICONS.link}<span>Copy link</span>`, onclick: (e) => { e.preventDefault(); copy(v.url); } }),
    h("button", { className: "btn small icon", title: "Delete", html: ICONS.trash, onclick: (e) => { e.preventDefault(); del(v); } }),
  );
  return h("article", { className: "vcard" },
    thumb, tools,
    h("div", { className: "body" },
      h("a", { className: "t", href: `/${v.id}` }, v.title),
      v.summary ? h("div", { className: "s" }, v.summary) : null,
      h("div", { className: "m" },
        h("span", { title: new Date(v.created_at).toLocaleString() }, ago(v.created_at)),
        h("span", { html: `${ICONS.eye} ${Number(v.views)}` }),
        v.comment_count ? h("span", { html: `${ICONS.chat} ${Number(v.comment_count)}` }) : null,
        v.size_bytes ? h("span", {}, fmtSize(v.size_bytes)) : null,
      ),
    ),
  );
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
