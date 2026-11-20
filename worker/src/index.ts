import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bearerUser, checkPassword, cookieOpts, cookieUser, createSession, currentUser, deleteSession, hashPassword, LOGIN_MINUTES, randomToken, sha256, SESSION_COOKIE, type AppEnv, type Bindings } from "./auth";
import type { Chapter, Transcript } from "./ai";
import { cleanRanges, cutTimeline, keptMs, rangeTable } from "./cut";
import { checkEmailPage, expiredPage, homePage, libraryPage, loginPage, notFoundPage, passwordPage, privacyPage, sharePage, supportPage, verifyPage } from "./pages";

export { ProcessVideo } from "./ai";

export type Video = {
  id: string;
  user_id: string | null;
  title: string;
  title_source: "auto" | "user";
  status: "uploading" | "ready";
  mime_type: string;
  video_key: string;
  upload_id: string | null;
  size_bytes: number | null;
  duration_ms: number | null;
  has_thumb: number;
  views: number;
  created_at: number;
  ai_status: "none" | "queued" | "transcribing" | "summarizing" | "done" | "error";
  ai_error: string | null;
  summary: string | null;
  chapters: string | null;
  language: string | null;
  transcript_text: string | null;
  trim_start_ms: number | null;
  trim_end_ms: number | null;
  password_hash: string | null;
  expires_at: number | null;
  edit_key: string | null;
  edit_upload_id: string | null;
  audio_shift_ms: number;
};

const ID = "{[0-9A-Za-z]{12}}";
const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "🙌", "🔥", "👀"];
const MAX_COMMENTS = 500;
const MAX_REACTIONS = 3000;
const MAX_VIEWERS = 5000;
const UNLOCK_DAYS = 30;

const app = new Hono<AppEnv>();

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function newId(len = 12): string {
  // Rejection sampling: no modulo bias.
  let out = "";
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < 248 && out.length < len) out += ID_ALPHABET[b % 62];
    }
  }
  return out;
}

function extFor(mime: string): string {
  return mime.startsWith("video/mp4") ? "mp4" : mime.startsWith("video/quicktime") ? "mov" : "webm";
}

async function getVideo(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM videos WHERE id = ?").bind(id).first<Video>();
}

// A video of the signed-in user, or null. Every /api/videos/:id route must use this, not getVideo.
async function ownVideo(c: Context<AppEnv>) {
  return c.env.DB.prepare("SELECT * FROM videos WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("user").id).first<Video>();
}

async function userName(db: D1Database, userId: string | null): Promise<string> {
  if (!userId) return "";
  const r = await db.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string }>();
  return r?.name ?? "";
}

async function deleteVideo(env: Bindings, v: Video) {
  if (v.upload_id) {
    await env.BUCKET.resumeMultipartUpload(v.video_key, v.upload_id).abort().catch(() => {});
  }
  if (v.edit_key && v.edit_upload_id) {
    await env.BUCKET.resumeMultipartUpload(v.edit_key, v.edit_upload_id).abort().catch(() => {});
  }
  await deletePrefix(env.BUCKET, `videos/${v.id}/`);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM comments WHERE video_id = ?").bind(v.id),
    env.DB.prepare("DELETE FROM reactions WHERE video_id = ?").bind(v.id),
    env.DB.prepare("DELETE FROM watches WHERE video_id = ?").bind(v.id),
    env.DB.prepare("DELETE FROM videos WHERE id = ?").bind(v.id),
  ]);
}

async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function startProcessing(env: Bindings, id: string) {
  await env.DB.prepare("UPDATE videos SET ai_status = 'queued', ai_error = NULL WHERE id = ?").bind(id).run();
  await env.PROCESS.create({ params: { videoId: id } });
}

// The fields a viewer may see. Never send upload ids, R2 keys or the full transcript text here.
function publicVideo(v: Video) {
  return {
    id: v.id,
    title: v.title,
    status: v.status,
    mime_type: v.mime_type,
    duration_ms: v.duration_ms,
    has_thumb: v.has_thumb,
    views: v.views,
    created_at: v.created_at,
    ai_status: v.ai_status,
    ai_error: v.ai_error,
    summary: v.summary,
    chapters: v.chapters ? JSON.parse(v.chapters) : null,
    language: v.language,
    has_transcript: v.transcript_text !== null,
    trim_start_ms: v.trim_start_ms,
    trim_end_ms: v.trim_end_ms,
    size_bytes: v.size_bytes, // changes when the file changes: the page adds it to the video URL, so caches get the new file
    has_password: !!v.password_hash,
    expires_at: v.expires_at,
  };
}

// ---------- Password and expiry ----------

const unlockValue = (v: Video) => sha256(`${v.id}:${v.password_hash}`); // a new password makes old cookies invalid

// The owner always sees the video. Other people only before the expiry date, and with the password.
async function access(c: Context<AppEnv>, v: Video): Promise<"ok" | "expired" | "locked"> {
  if (!v.password_hash && !v.expires_at) return "ok";
  if (v.user_id && (await currentUser(c))?.id === v.user_id) return "ok";
  if (v.expires_at && v.expires_at <= Date.now()) return "expired";
  if (v.password_hash && getCookie(c, `ku_${v.id}`) !== (await unlockValue(v))) return "locked";
  return "ok";
}

// The video of a public route, or null when it does not exist or this viewer may not see it.
async function viewable(c: Context<AppEnv>) {
  const v = await getVideo(c.env.DB, c.req.param("id")!);
  return v && (await access(c, v)) === "ok" ? v : null;
}

async function shareData(env: Bindings, v: Video) {
  const [comments, reactions] = await env.DB.batch([
    env.DB.prepare("SELECT id, author, body, t_ms, is_owner, created_at FROM comments WHERE video_id = ? ORDER BY created_at").bind(v.id),
    env.DB.prepare(`SELECT emoji, t_ms FROM reactions WHERE video_id = ? ORDER BY id DESC LIMIT ${MAX_REACTIONS}`).bind(v.id),
  ]);
  return { video: publicVideo(v), comments: comments.results, reactions: reactions.results };
}

// Public write endpoints (comments, reactions) accept only requests from our own pages.
function sameOrigin(c: Context<AppEnv>): boolean {
  const origin = c.req.header("origin");
  return !!origin && origin === new URL(c.req.url).origin;
}

// ---------- Authenticated API (extension: Bearer token; web pages: session cookie) ----------

const api = new Hono<AppEnv>();

api.use("*", async (c, next) => {
  const fromBearer = await bearerUser(c);
  if (fromBearer) {
    c.set("user", fromBearer);
    return next();
  }
  const fromCookie = await cookieUser(c);
  if (fromCookie) {
    // CSRF guard for cookie sessions: a cross-site form cannot set this header.
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-kino") !== "1") {
      return c.json({ error: "missing x-kino header" }, 403);
    }
    c.set("user", fromCookie);
    return next();
  }
  return c.json({ error: "unauthorized" }, 401);
});

api.get("/me", (c) => c.json({ ok: true, ...c.get("user") }));

// Delete the account, all its videos, comments and sessions.
api.delete("/me", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare("SELECT * FROM videos WHERE user_id = ?").bind(user.id).all<Video>();
  for (const v of results) await deleteVideo(c.env, v);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM login_tokens WHERE email = ?").bind(user.email),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

api.get("/settings", (c) => c.json({ owner_name: c.get("user").name }));

api.put("/settings", async (c) => {
  const body = await c.req.json<{ owner_name?: string }>().catch(() => ({}) as { owner_name?: string });
  const name = (body.owner_name ?? "").trim().slice(0, 60);
  await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, c.get("user").id).run();
  return c.json({ ok: true, owner_name: name });
});

api.get("/videos", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const uid = c.get("user").id;
  const cols = `id, title, status, mime_type, size_bytes, duration_ms, has_thumb, views, created_at, ai_status, summary,
    trim_start_ms, trim_end_ms, expires_at, password_hash IS NOT NULL AS has_password,
    (SELECT COUNT(*) FROM comments WHERE comments.video_id = videos.id) AS comment_count`;
  const stmt = q
    ? c.env.DB.prepare(
        `SELECT ${cols} FROM videos WHERE user_id = ?2 AND (title LIKE ?1 OR summary LIKE ?1 OR transcript_text LIKE ?1) ORDER BY created_at DESC LIMIT 200`,
      ).bind(`%${q.replace(/[%_]/g, "")}%`, uid)
    : c.env.DB.prepare(`SELECT ${cols} FROM videos WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`).bind(uid);
  const { results } = await stmt.all<Record<string, unknown> & { id: string }>();
  const total = await c.env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS n FROM videos WHERE user_id = ?").bind(uid).first<{ bytes: number; n: number }>();
  const origin = c.env.PUBLIC_URL || new URL(c.req.url).origin;
  c.header("x-kino-total-bytes", String(total?.bytes ?? 0));
  c.header("x-kino-total-count", String(total?.n ?? 0));
  return c.json(results.map((v) => ({ ...v, url: `${origin}/${v.id}` })));
});

// Start a recording: creates the row and an R2 multipart upload.
api.post("/videos", async (c) => {
  type Body = { title?: string; mimeType?: string };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const mime = body.mimeType?.startsWith("video/") ? body.mimeType : "video/webm";
  const id = newId();
  const key = `videos/${id}/video.${extFor(mime)}`;
  const upload = await c.env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: mime.split(";")[0] },
  });
  const given = (body.title || "").trim().slice(0, 200);
  const title = given || `Recording ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  await c.env.DB.prepare(
    "INSERT INTO videos (id, user_id, title, title_source, status, mime_type, video_key, upload_id, created_at) VALUES (?, ?, ?, ?, 'uploading', ?, ?, ?, ?)",
  )
    .bind(id, c.get("user").id, title, given ? "user" : "auto", mime, key, upload.uploadId, Date.now())
    .run();
  return c.json({ id, url: `${c.env.PUBLIC_URL || new URL(c.req.url).origin}/${id}` }, 201);
});

// Upload one video part. R2 rule: every part except the last must have the same size (>= 5 MiB).
async function putPart(c: Context<AppEnv>, key: string, uploadId: string) {
  const n = Number(c.req.param("n"));
  if (!Number.isInteger(n) || n < 1 || n > 10000) return c.json({ error: "bad part number" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: "empty part" }, 400);
  return c.json(await c.env.BUCKET.resumeMultipartUpload(key, uploadId).uploadPart(n, body));
}

api.put("/videos/:id/parts/:n", async (c) => {
  const v = await ownVideo(c);
  if (!v || v.status !== "uploading" || !v.upload_id) return c.json({ error: "not uploading" }, 409);
  return putPart(c, v.video_key, v.upload_id);
});

// ---------- Cut the file (trim and cut editor) ----------
// The share page renders the parts that stay into a new file and uploads it here.
// The new file replaces the old one under the same link. Transcript, chapters, comments and reactions move with it.

api.post("/videos/:id/edit", async (c) => {
  const v = await ownVideo(c);
  if (!v || v.status !== "ready") return c.json({ error: "not ready" }, 409);
  const body = await c.req.json<{ mimeType?: string }>().catch(() => ({}) as { mimeType?: string });
  const mime = body.mimeType?.startsWith("video/") ? body.mimeType : "video/webm";
  if (v.edit_key && v.edit_upload_id) await c.env.BUCKET.resumeMultipartUpload(v.edit_key, v.edit_upload_id).abort().catch(() => {});
  const key = `videos/${v.id}/video-${Date.now()}.${extFor(mime)}`;
  const upload = await c.env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: mime.split(";")[0] } });
  const leftover = (await c.env.BUCKET.list({ prefix: `videos/${v.id}/edit-audio/` })).objects.map((o) => o.key);
  if (leftover.length) await c.env.BUCKET.delete(leftover);
  await c.env.DB.prepare("UPDATE videos SET edit_key = ?, edit_upload_id = ? WHERE id = ?").bind(key, upload.uploadId, v.id).run();
  return c.json({ ok: true });
});

api.put("/videos/:id/edit/parts/:n", async (c) => {
  const v = await ownVideo(c);
  if (!v?.edit_key || !v.edit_upload_id) return c.json({ error: "no cut in progress" }, 409);
  return putPart(c, v.edit_key, v.edit_upload_id);
});

api.put("/videos/:id/edit/audio/:n", async (c) => {
  const v = await ownVideo(c);
  if (!v?.edit_key || !v.edit_upload_id) return c.json({ error: "no cut in progress" }, 409);
  return putAudio(c, `videos/${v.id}/edit-audio`);
});

api.post("/videos/:id/edit/complete", async (c) => {
  const v = await ownVideo(c);
  if (!v?.edit_key || !v.edit_upload_id) return c.json({ error: "no cut in progress" }, 409);
  const body = await c.req.json<{ parts: R2UploadedPart[]; durationMs?: number; keep?: unknown }>();
  const keep = cleanRanges(body.keep);
  if (!keep) return c.json({ error: "bad parts to keep" }, 400);
  const obj = await c.env.BUCKET.resumeMultipartUpload(v.edit_key, v.edit_upload_id).complete(body.parts.sort((a, b) => a.partNumber - b.partNumber));
  const dur = Math.round(Number(body.durationMs) || 0) || keptMs(keep);

  let text = v.transcript_text;
  const t = await getTranscript(c.env, v.id);
  const cut = cutTimeline(keep, t?.segments ?? [], v.chapters ? (JSON.parse(v.chapters) as Chapter[]) : []);
  if (t) {
    t.segments = cut.segments;
    await c.env.BUCKET.put(`videos/${v.id}/transcript.json`, JSON.stringify(t), { httpMetadata: { contentType: "application/json" } });
    text = t.segments.map((s) => s.t).join(" ").slice(0, 500_000);
  }
  await moveEditAudio(c.env, v.id);

  // New time of t_ms, or NULL when t_ms is in a deleted part. ?1 is rangeTable(keep).
  const map = `(SELECT t_ms - json_extract(value, '$[0]') + json_extract(value, '$[2]') FROM json_each(?1)
    WHERE t_ms BETWEEN json_extract(value, '$[0]') AND json_extract(value, '$[1]'))`;
  const ranges = JSON.stringify(rangeTable(keep));
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE videos SET video_key = ?, mime_type = ?, size_bytes = ?, duration_ms = ?, trim_start_ms = NULL, trim_end_ms = NULL,
         edit_key = NULL, edit_upload_id = NULL, audio_shift_ms = 0, chapters = ?, transcript_text = ? WHERE id = ?`,
    ).bind(v.edit_key, obj.httpMetadata?.contentType || v.mime_type, obj.size, dur, cut.chapters.length ? JSON.stringify(cut.chapters) : null, text, v.id),
    // Comments in a deleted part stay, without a time. Reactions there are deleted.
    c.env.DB.prepare(`UPDATE comments SET t_ms = ${map} WHERE video_id = ?2 AND t_ms IS NOT NULL`).bind(ranges, v.id),
    c.env.DB.prepare(`DELETE FROM reactions WHERE video_id = ?2 AND t_ms IS NOT NULL AND ${map} IS NULL`).bind(ranges, v.id),
    c.env.DB.prepare(`UPDATE reactions SET t_ms = ${map} WHERE video_id = ?2 AND t_ms IS NOT NULL`).bind(ranges, v.id),
  ]);
  // Delete the old file only after the row points to the new one.
  if (v.video_key !== v.edit_key) await c.env.BUCKET.delete(v.video_key);
  return c.json({ ok: true, size: obj.size });
});

// The cut also records new audio parts (for "Regenerate"). They replace the old ones only when the cut is saved.
async function moveEditAudio(env: Bindings, id: string) {
  const fresh = (await env.BUCKET.list({ prefix: `videos/${id}/edit-audio/` })).objects.map((o) => o.key);
  const made = new Set<string>();
  for (const key of fresh) {
    const obj = await env.BUCKET.get(key);
    if (!obj) continue;
    const to = key.replace("/edit-audio/", "/audio/");
    await env.BUCKET.put(to, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
    made.add(to);
  }
  const old = (await env.BUCKET.list({ prefix: `videos/${id}/audio/` })).objects.map((o) => o.key).filter((k) => !made.has(k));
  if (old.length) await env.BUCKET.delete(old);
  if (fresh.length) await env.BUCKET.delete(fresh);
}

// ---------- Viewer insights ----------

api.get("/videos/:id/insights", async (c) => {
  const v = await ownVideo(c);
  if (!v) return c.json({ error: "not found" }, 404);
  const { results } = await c.env.DB.prepare("SELECT name, seconds, created_at, updated_at FROM watches WHERE video_id = ? ORDER BY updated_at DESC LIMIT 500")
    .bind(v.id)
    .all();
  return c.json({ viewers: results });
});

// Upload one audio-only part (Opus, a few minutes long). Used only for the transcript.
api.put("/videos/:id/audio/:n", async (c) => {
  const v = await ownVideo(c);
  if (!v) return c.json({ error: "not found" }, 404);
  return putAudio(c, `videos/${v.id}/audio`);
});

async function putAudio(c: Context<AppEnv>, folder: string) {
  const n = Number(c.req.param("n"));
  const startMs = Math.max(0, Math.round(Number(c.req.query("start") ?? 0)));
  if (!Number.isInteger(n) || n < 1 || n > 9999 || !Number.isFinite(startMs)) return c.json({ error: "bad audio part" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ ok: true, skipped: true });
  if (body.byteLength > 25_000_000) return c.json({ error: "audio part too large" }, 413);
  await c.env.BUCKET.put(`${folder}/${String(n).padStart(4, "0")}.webm`, body, {
    httpMetadata: { contentType: c.req.header("content-type")?.split(";")[0] || "audio/webm" },
    customMetadata: { startMs: String(startMs) },
  });
  return c.json({ ok: true });
}

api.post("/videos/:id/complete", async (c) => {
  const v = await ownVideo(c);
  if (!v || v.status !== "uploading" || !v.upload_id) return c.json({ error: "not uploading" }, 409);
  const body = await c.req.json<{ parts: R2UploadedPart[]; durationMs?: number }>();
  const mpu = c.env.BUCKET.resumeMultipartUpload(v.video_key, v.upload_id);
  const obj = await mpu.complete(body.parts.sort((a, b) => a.partNumber - b.partNumber));
  await c.env.DB.prepare("UPDATE videos SET status = 'ready', upload_id = NULL, size_bytes = ?, duration_ms = ? WHERE id = ?")
    .bind(obj.size, body.durationMs ?? null, v.id)
    .run();
  await startProcessing(c.env, v.id).catch((e) =>
    c.env.DB.prepare("UPDATE videos SET ai_status = 'error', ai_error = ? WHERE id = ?").bind(String(e).slice(0, 500), v.id).run(),
  );
  return c.json({ ok: true, size: obj.size, url: `${c.env.PUBLIC_URL || new URL(c.req.url).origin}/${v.id}` });
});

// Run transcript, title, summary and chapters again.
api.post("/videos/:id/process", async (c) => {
  const v = await ownVideo(c);
  if (!v || v.status !== "ready") return c.json({ error: "not ready" }, 409);
  const body = await c.req.json<{ resetTitle?: boolean }>().catch(() => ({}) as { resetTitle?: boolean });
  if (body.resetTitle) await c.env.DB.prepare("UPDATE videos SET title_source = 'auto' WHERE id = ?").bind(v.id).run();
  await startProcessing(c.env, v.id);
  return c.json({ ok: true });
});

api.put("/videos/:id/thumbnail", async (c) => {
  const v = await ownVideo(c);
  if (!v) return c.json({ error: "not found" }, 404);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 2_000_000) return c.json({ error: "thumbnail too large" }, 413);
  await c.env.BUCKET.put(`videos/${v.id}/thumb.jpg`, body, { httpMetadata: { contentType: "image/jpeg" } });
  await c.env.DB.prepare("UPDATE videos SET has_thumb = 1 WHERE id = ?").bind(v.id).run();
  return c.json({ ok: true });
});

api.patch("/videos/:id", async (c) => {
  type Body = { title?: string; summary?: string; trim_start_ms?: number | null; trim_end_ms?: number | null; password?: string | null; expires_at?: number | null };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const v = await ownVideo(c);
  if (!v) return c.json({ error: "not found" }, 404);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.title !== undefined) {
    const t = body.title.trim().slice(0, 200);
    if (!t) return c.json({ error: "title required" }, 400);
    sets.push("title = ?", "title_source = 'user'");
    args.push(t);
  }
  if (body.summary !== undefined) {
    sets.push("summary = ?");
    args.push(body.summary.trim().slice(0, 4000) || null);
  }
  if ("trim_start_ms" in body || "trim_end_ms" in body) {
    const norm = (x: unknown) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Math.max(0, Math.round(Number(x))));
    const s = norm(body.trim_start_ms);
    const e = norm(body.trim_end_ms);
    if (s !== null && e !== null && e - s < 1000) return c.json({ error: "the trimmed video must be at least 1 second" }, 400);
    sets.push("trim_start_ms = ?", "trim_end_ms = ?");
    args.push(s || null, e);
  }
  if (body.password !== undefined) {
    const pw = String(body.password ?? "").slice(0, 200);
    sets.push("password_hash = ?");
    args.push(pw ? await hashPassword(pw) : null);
  }
  if (body.expires_at !== undefined) {
    const at = body.expires_at === null ? null : Math.round(Number(body.expires_at));
    if (at !== null && !Number.isFinite(at)) return c.json({ error: "bad expiry date" }, 400);
    sets.push("expires_at = ?");
    args.push(at);
  }
  if (!sets.length) return c.json({ error: "nothing to change" }, 400);
  await c.env.DB.prepare(`UPDATE videos SET ${sets.join(", ")} WHERE id = ?`).bind(...args, v.id).run();
  return c.json({ ok: true, video: publicVideo((await getVideo(c.env.DB, v.id))!) });
});

api.delete("/videos/:id", async (c) => {
  const v = await ownVideo(c);
  if (!v) return c.json({ error: "not found" }, 404);
  await deleteVideo(c.env, v);
  return c.json({ ok: true });
});

api.delete("/videos/:id/comments/:cid", async (c) => {
  if (!(await ownVideo(c))) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM comments WHERE id = ? AND video_id = ?").bind(c.req.param("cid"), c.req.param("id")).run();
  return c.json({ ok: true });
});

app.route("/api", api);

// ---------- Owner pages ----------

app.get("/", async (c) => ((await cookieUser(c)) ? c.redirect("/library") : c.html(homePage())));

app.get("/privacy", (c) => c.html(privacyPage()));

app.get("/support", (c) => c.html(supportPage()));

// Contact form: mails the owner. Reply-To is the sender, so a reply in the mail app goes to them.
app.post("/support", async (c) => {
  if (!sameOrigin(c)) return c.html(supportPage("Send the form from this page."), 403);
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().slice(0, 254);
  const message = String(form.message ?? "").trim().slice(0, 5000);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message) return c.html(supportPage("Enter your email and a message."), 400);
  // ponytail: no rate limit; add a Cloudflare rate-limiting rule on /support if spam arrives.
  const res = c.env.RESEND_API_KEY && c.env.OWNER_EMAIL
    ? await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${c.env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: c.env.FROM_EMAIL, to: c.env.OWNER_EMAIL, reply_to: email, subject: `Kino support: ${email}`, text: message }),
      })
    : null;
  if (!res?.ok) return c.html(supportPage("We could not send your message. Try again later."), 502);
  return c.html(supportPage("Thank you. We received your message and will reply by email."));
});

app.get("/login", (c) => c.html(loginPage()));

const sameSitePath = (p: string | undefined) => (p && /^\/(?![\/\\])/.test(p) ? p : "/library");

// Step 1: send a sign-in link by email.
app.post("/auth/email", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase().slice(0, 254);
  const next = sameSitePath(String(form.next ?? ""));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.html(loginPage("Enter a valid email address."), 400);
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?")
    .bind(email, Date.now() - 3_600_000)
    .first<{ n: number }>();
  // ponytail: per-email cap only; add a Cloudflare rate-limiting rule on /auth/email if bots send to many addresses.
  if ((recent?.n ?? 0) >= 5) return c.html(loginPage("Too many sign-in emails. Wait one hour, then try again."), 429);
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM login_tokens WHERE expires_at < ?").bind(now - 3_600_000),
    c.env.DB.prepare("INSERT INTO login_tokens (hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(
      await sha256(token),
      email,
      now + LOGIN_MINUTES * 60_000,
      now,
    ),
  ]);
  const origin = c.env.PUBLIC_URL && new URL(c.req.url).hostname !== "localhost" ? c.env.PUBLIC_URL : new URL(c.req.url).origin;
  const link = `${origin}/auth/verify?t=${token}&next=${encodeURIComponent(next)}`;
  if (!c.env.RESEND_API_KEY) {
    console.log(`[dev] sign-in link for ${email}: ${link}`); // local dev without email
  } else {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${c.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: c.env.FROM_EMAIL,
        to: email,
        subject: "Your Kino sign-in link",
        text: `Click this link to sign in to Kino:\n\n${link}\n\nThe link works one time, for ${LOGIN_MINUTES} minutes. If you did not ask for it, ignore this email.`,
      }),
    });
    if (!res.ok) {
      console.error("resend", res.status, await res.text());
      return c.html(loginPage("We could not send the email. Try again later."), 502);
    }
  }
  return c.html(checkEmailPage(email));
});

// Step 2: the link opens a page with a button. Email scanners open links (GET) but do not click buttons (POST),
// so a scanner cannot use the one-time token.
app.get("/auth/verify", (c) => c.html(verifyPage(c.req.query("t") ?? "", sameSitePath(c.req.query("next")))));

app.post("/auth/verify", async (c) => {
  const form = await c.req.parseBody();
  const hash = await sha256(String(form.t ?? ""));
  const row = await c.env.DB.prepare("DELETE FROM login_tokens WHERE hash = ? RETURNING email, expires_at").bind(hash).first<{ email: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return c.html(loginPage("This link is not valid or is too old. Get a new link."), 400);
  await c.env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING").bind(newId(), row.email, Date.now()).run();
  const user = (await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(row.email).first<{ id: string }>())!;
  // The owner of the single-user install gets the videos from before accounts.
  if (c.env.OWNER_EMAIL && row.email === c.env.OWNER_EMAIL.trim().toLowerCase()) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE videos SET user_id = ? WHERE user_id IS NULL").bind(user.id),
      c.env.DB.prepare("UPDATE users SET name = COALESCE((SELECT value FROM settings WHERE key = 'owner_name'), name) WHERE id = ? AND name = ''").bind(user.id),
    ]);
  }
  setCookie(c, SESSION_COOKIE, await createSession(c.env.DB, user.id), cookieOpts(c));
  return c.redirect(sameSitePath(String(form.next ?? "")));
});

app.get("/logout", async (c) => {
  await deleteSession(c.env.DB, getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/");
});

app.get("/library", async (c) => {
  const user = await cookieUser(c);
  if (!user) return c.redirect("/login?next=/library");
  return c.html(libraryPage(user.name, user.email));
});

// ---------- Public share pages ----------

async function mailView(c: Context<AppEnv>, v: Video) {
  const to = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(v.user_id).first<{ email: string }>();
  if (!to) return;
  const link = `${c.env.PUBLIC_URL || new URL(c.req.url).origin}/${v.id}`;
  const times = `${v.views} time${v.views === 1 ? "" : "s"}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${c.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: c.env.FROM_EMAIL,
      to: to.email,
      subject: `Someone watched "${v.title}" (viewed ${times})`,
      text: `Someone opened your video "${v.title}".\n\nIt is now viewed ${times}.\n\n${link}`,
    }),
  });
  if (!res.ok) console.error("resend view", res.status, await res.text());
}

async function renderShare(c: Context<AppEnv>, embed: boolean) {
  const v = await getVideo(c.env.DB, c.req.param("id")!);
  if (!v) return c.html(notFoundPage(), 404);
  const gate = await access(c, v);
  if (gate !== "ok") {
    c.header("cache-control", "private, no-store");
    if (!embed) c.header("content-security-policy", "frame-ancestors 'self'");
    return gate === "expired" ? c.html(expiredPage(), 410) : c.html(passwordPage(v.id, embed), 401);
  }
  const owner = !!v.user_id && (await currentUser(c))?.id === v.user_id;
  // Count each viewer once per 12 hours, and never count the owner.
  if (v.status === "ready" && !owner && !embed && !getCookie(c, `kv_${v.id}`)) {
    v.views += 1;
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE videos SET views = views + 1 WHERE id = ?").bind(v.id).run());
    setCookie(c, `kv_${v.id}`, "1", { path: `/${v.id}`, maxAge: 12 * 3600, sameSite: "Lax", httpOnly: true });
    // Mail the owner about the view. ponytail: one email per counted view; add a digest if a video goes viral.
    if (c.env.RESEND_API_KEY && v.user_id) c.executionCtx.waitUntil(mailView(c, v));
  }
  const data = await shareData(c.env, v);
  const ownerName = await userName(c.env.DB, v.user_id);
  c.header("cache-control", "private, no-store");
  if (!embed) c.header("content-security-policy", "frame-ancestors 'self'");
  return c.html(sharePage({ ...data, owner, ownerName, copied: c.req.query("copied") === "1" }, c.env.PUBLIC_URL || new URL(c.req.url).origin, embed));
}

app.get(`/:id${ID}`, (c) => renderShare(c, false));
app.get(`/:id${ID}/embed`, (c) => renderShare(c, true));

// Password form. The cookie works for this video only, and for embeds on other sites too (SameSite=None).
app.post(`/:id${ID}/unlock`, async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const v = await getVideo(c.env.DB, c.req.param("id"));
  if (!v) return c.html(notFoundPage(), 404);
  const form = await c.req.parseBody();
  const embed = form.embed === "1";
  // ponytail: no attempt limit; add a Cloudflare rate-limiting rule on /*/unlock if someone guesses passwords.
  if (v.password_hash && !(await checkPassword(String(form.password ?? ""), v.password_hash))) {
    return c.html(passwordPage(v.id, embed, "Wrong password. Try again."), 401);
  }
  if (v.password_hash) {
    const secure = new URL(c.req.url).protocol === "https:";
    setCookie(c, `ku_${v.id}`, await unlockValue(v), { path: `/${v.id}`, maxAge: UNLOCK_DAYS * 86400, httpOnly: true, secure, sameSite: secure ? "None" : "Lax" });
  }
  return c.redirect(`/${v.id}${embed ? "/embed" : ""}`);
});

// Viewer insights: the share page reports how many different seconds this viewer played.
app.post(`/:id${ID}/watch`, async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "forbidden" }, 403);
  const v = await viewable(c);
  if (!v || v.status !== "ready") return c.json({ error: "not found" }, 404);
  const b = await c.req.json<{ viewer?: string; name?: string; seconds?: number }>().catch(() => ({}) as { viewer?: string; name?: string; seconds?: number });
  if (!/^[0-9A-Za-z]{8,40}$/.test(b.viewer ?? "")) return c.json({ error: "bad viewer" }, 400);
  const user = await currentUser(c);
  if (user && user.id === v.user_id) return c.json({ ok: true }); // never count the owner
  // A signed-in Kino user shows with their name or email. Other viewers with the name they gave for comments.
  const name = (user ? user.name || user.email : String(b.name ?? "")).trim().slice(0, 60);
  const seconds = Math.min(86_400, Math.max(0, Math.round(Number(b.seconds) || 0)));
  const now = Date.now();
  // ponytail: one D1 write per viewer every 15 s; send less often if the free 100k writes per day get tight.
  await c.env.DB.prepare(
    `INSERT INTO watches (video_id, viewer, name, seconds, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?5 WHERE (SELECT COUNT(*) FROM watches WHERE video_id = ?1) < ?6
     ON CONFLICT(video_id, viewer) DO UPDATE SET seconds = MAX(seconds, excluded.seconds),
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END, updated_at = excluded.updated_at`,
  )
    .bind(v.id, b.viewer, name, seconds, now, MAX_VIEWERS)
    .run();
  return c.json({ ok: true });
});

app.get(`/:id${ID}/data.json`, async (c) => {
  const v = await viewable(c);
  if (!v) return c.json({ error: "not found" }, 404);
  c.header("cache-control", "no-store");
  return c.json(await shareData(c.env, v));
});

async function getTranscript(env: Bindings, id: string): Promise<Transcript | null> {
  const obj = await env.BUCKET.get(`videos/${id}/transcript.json`);
  return obj ? obj.json<Transcript>() : null;
}

app.get(`/:id${ID}/transcript.json`, async (c) => {
  if (!(await viewable(c))) return c.json({ error: "not found" }, 404);
  const obj = await c.env.BUCKET.get(`videos/${c.req.param("id")}/transcript.json`);
  if (!obj) return c.json({ error: "no transcript" }, 404);
  return new Response(obj.body, { headers: { "content-type": "application/json", "cache-control": "no-cache" } });
});

function vttTime(ms: number) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const x = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(x).padStart(3, "0")}`;
}

app.get(`/:id${ID}/captions.vtt`, async (c) => {
  if (!(await viewable(c))) return c.text("WEBVTT\n", 404, { "content-type": "text/vtt" });
  const t = await getTranscript(c.env, c.req.param("id"));
  if (!t) return c.text("WEBVTT\n", 404, { "content-type": "text/vtt" });
  const cues = t.segments.map((s, i) => `${i + 1}\n${vttTime(s.s)} --> ${vttTime(Math.max(s.e, s.s + 500))}\n${s.t.replace(/-->/g, "→")}\n`);
  return c.text(`WEBVTT\n\n${cues.join("\n")}`, 200, { "content-type": "text/vtt; charset=utf-8", "cache-control": "no-cache" });
});

app.post(`/:id${ID}/comments`, async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "forbidden" }, 403);
  const v = await viewable(c);
  if (!v || v.status !== "ready") return c.json({ error: "not found" }, 404);
  type Body = { author?: string; body?: string; t_ms?: number | null };
  const b = await c.req.json<Body>().catch(() => ({}) as Body);
  const owner = !!v.user_id && (await currentUser(c))?.id === v.user_id;
  const author = owner ? (await userName(c.env.DB, v.user_id)) || "Owner" : (b.author ?? "").trim().slice(0, 60);
  const text = (b.body ?? "").trim().slice(0, 2000);
  if (!author || !text) return c.json({ error: "name and comment are required" }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE video_id = ?").bind(v.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_COMMENTS) return c.json({ error: "this video has too many comments" }, 429);
  const t = b.t_ms === null || b.t_ms === undefined || !Number.isFinite(Number(b.t_ms)) ? null : Math.max(0, Math.round(Number(b.t_ms)));
  const comment = { id: newId(10), author, body: text, t_ms: t, is_owner: owner ? 1 : 0, created_at: Date.now() };
  await c.env.DB.prepare("INSERT INTO comments (id, video_id, author, body, t_ms, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(comment.id, v.id, comment.author, comment.body, comment.t_ms, comment.is_owner, comment.created_at)
    .run();
  return c.json(comment, 201);
});

app.post(`/:id${ID}/reactions`, async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "forbidden" }, 403);
  const b = await c.req.json<{ emoji?: string; t_ms?: number }>().catch(() => ({}) as { emoji?: string; t_ms?: number });
  if (!b.emoji || !REACTIONS.includes(b.emoji)) return c.json({ error: "unknown reaction" }, 400);
  if (!(await viewable(c))) return c.json({ error: "not found" }, 404);
  const id = c.req.param("id");
  const n = await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM videos WHERE id = ?1 AND status = 'ready') AS ok, (SELECT COUNT(*) FROM reactions WHERE video_id = ?1) AS n")
    .bind(id)
    .first<{ ok: number; n: number }>();
  if (!n?.ok) return c.json({ error: "not found" }, 404);
  if (n.n >= MAX_REACTIONS) return c.json({ error: "too many reactions" }, 429);
  const t = Math.max(0, Math.round(Number(b.t_ms) || 0));
  await c.env.DB.prepare("INSERT INTO reactions (video_id, emoji, t_ms, created_at) VALUES (?, ?, ?, ?)").bind(id, b.emoji, t, Date.now()).run();
  return c.json({ ok: true }, 201);
});

// Video bytes with HTTP Range support (needed for seeking and for Safari).
app.get(`/:id${ID}/video`, async (c) => {
  const v = await viewable(c);
  if (!v || v.status !== "ready") return c.notFound();
  const obj = await c.env.BUCKET.get(v.video_key, { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
  if (!obj) return c.notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", v.password_hash || v.expires_at ? "private, max-age=3600" : "public, max-age=86400");
  if (c.req.query("download") !== undefined) {
    const name = v.title.replace(/[^\p{L}\p{N} _.-]+/gu, "").trim().slice(0, 80) || v.id;
    headers.set("content-disposition", `attachment; filename="${v.id}.${extFor(v.mime_type)}"; filename*=UTF-8''${encodeURIComponent(name)}.${extFor(v.mime_type)}`);
  }

  if (!("body" in obj)) return new Response(null, { status: 304, headers });

  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && c.req.header("range")) {
    let start: number, len: number;
    if (range.suffix !== undefined) {
      len = Math.min(range.suffix, obj.size);
      start = obj.size - len;
    } else {
      start = range.offset ?? 0;
      len = range.length ?? obj.size - start;
    }
    headers.set("content-range", `bytes ${start}-${start + len - 1}/${obj.size}`);
    headers.set("content-length", String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
});

app.get(`/:id${ID}/thumb.jpg`, async (c) => {
  const v = await viewable(c);
  const obj = v && (await c.env.BUCKET.get(`videos/${v.id}/thumb.jpg`));
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: { "content-type": "image/jpeg", "cache-control": v.password_hash || v.expires_at ? "private, max-age=3600" : "public, max-age=3600" },
  });
});

app.notFound((c) => c.html(notFoundPage(), 404));

export default app;
