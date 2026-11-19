import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import type { Bindings } from "./auth";

// Transcript format stored in R2 at videos/<id>/transcript.json.
// s and e are milliseconds on the video timeline.
export type Segment = { s: number; e: number; t: string };
export type Transcript = { language: string | null; segments: Segment[] };
export type Chapter = { start: number; title: string };

type Params = { videoId: string };
type AudioPart = { key: string; startMs: number };

const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const MAX_PROMPT_CHARS = 120_000;

async function setStatus(env: Bindings, id: string, status: string, error: string | null = null) {
  await env.DB.prepare("UPDATE videos SET ai_status = ?, ai_error = ? WHERE id = ?").bind(status, error, id).run();
  return true;
}

// Runs after each upload: transcribe every audio part, then write title, summary and chapters.
// Each step is retried by Workflows, and its result is saved, so a retry does not repeat finished steps.
export class ProcessVideo extends WorkflowEntrypoint<Bindings, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const id = event.payload.videoId;
    try {
      const parts = await step.do("list audio parts", async () => {
        const listed = await this.env.BUCKET.list({ prefix: `videos/${id}/audio/`, include: ["customMetadata"] });
        return listed.objects
          .map((o) => ({ key: o.key, startMs: Number(o.customMetadata?.startMs ?? 0) }))
          .sort((a, b) => a.startMs - b.startMs);
      });
      if (!parts.length) {
        await step.do("no audio", () => setStatus(this.env, id, "none"));
        return;
      }

      await step.do("status transcribing", () => setStatus(this.env, id, "transcribing"));
      // All parts at the same time: total wait is about one part, not the sum of all parts.
      // ponytail: no concurrency cap; the runtime queues extra AI calls. Add a pool if Workers AI rate-limits long videos.
      const results = await Promise.all(
        parts.map((p, i) =>
          step.do(
            `transcribe part ${i + 1}`,
            { retries: { limit: 4, delay: "15 seconds", backoff: "exponential" }, timeout: "10 minutes" },
            () => transcribePart(this.env, p, null),
          ),
        ),
      );
      const language = results.find((r) => r.language)?.language ?? null;
      let segments: Segment[] = results.flatMap((r) => r.segments);
      // After a cut, the audio parts start before the file: move the lines and drop the ones that were cut.
      // Outside a step on purpose: a replay of the workflow must shift the lines again.
      const row = await step.do("read cut offset", async () =>
        this.env.DB.prepare("SELECT audio_shift_ms, duration_ms FROM videos WHERE id = ?").bind(id).first<{ audio_shift_ms: number; duration_ms: number | null }>(),
      );
      const shift = row?.audio_shift_ms ?? 0;
      if (shift) {
        const end = row?.duration_ms || Infinity;
        segments = segments
          .map((s) => ({ s: Math.max(0, s.s - shift), e: Math.min(end, s.e - shift), t: s.t }))
          .filter((s) => s.e > 0 && s.s < end);
      }

      const wordCount = await step.do("save transcript", async () => {
        const transcript: Transcript = { language, segments };
        await this.env.BUCKET.put(`videos/${id}/transcript.json`, JSON.stringify(transcript), {
          httpMetadata: { contentType: "application/json" },
        });
        const text = segments.map((s) => s.t).join(" ").slice(0, 500_000);
        await this.env.DB.prepare("UPDATE videos SET transcript_text = ?, language = ?, ai_status = 'summarizing' WHERE id = ?")
          .bind(text, language, id)
          .run();
        return text.split(/\s+/).filter(Boolean).length;
      });

      if (wordCount < 8) {
        // Too little speech for a useful title or summary.
        await step.do("done without summary", () => setStatus(this.env, id, "done"));
        return;
      }

      await step.do(
        "title, summary and chapters",
        { retries: { limit: 3, delay: "20 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => {
          const v = await this.env.DB.prepare("SELECT duration_ms, trim_start_ms, trim_end_ms FROM videos WHERE id = ?")
            .bind(id)
            .first<{ duration_ms: number | null; trim_start_ms: number | null; trim_end_ms: number | null }>();
          const durationS = Math.round((v?.duration_ms ?? segments.at(-1)?.e ?? 0) / 1000);
          const meta = await generateMeta(this.env, segments, durationS, language);
          await this.env.DB.prepare(
            `UPDATE videos SET summary = ?, chapters = ?, ai_status = 'done', ai_error = NULL,
               title = CASE WHEN title_source = 'auto' AND ? != '' THEN ? ELSE title END
             WHERE id = ?`,
          )
            .bind(meta.summary, meta.chapters.length ? JSON.stringify(meta.chapters) : null, meta.title, meta.title, id)
            .run();
          return true;
        },
      );
    } catch (e) {
      await step.do("mark error", () => setStatus(this.env, id, "error", String((e as Error)?.message ?? e).slice(0, 500)));
    }
  }
}

async function transcribePart(env: Bindings, part: AudioPart, language: string | null) {
  const obj = await env.BUCKET.get(part.key);
  if (!obj) return { language, segments: [] as Segment[] };
  const res = await env.AI.run(WHISPER, {
    audio: { body: obj.body, contentType: obj.httpMetadata?.contentType || "audio/webm" },
    vad_filter: true,
    ...(language ? { language } : {}),
  });
  const segments: Segment[] = [];
  for (const s of res.segments ?? []) {
    const t = (s.text ?? "").trim();
    if (!t || s.start === undefined || s.end === undefined) continue;
    segments.push({ s: Math.round(s.start * 1000) + part.startMs, e: Math.round(s.end * 1000) + part.startMs, t });
  }
  const lang = res.transcription_info?.language;
  return { language: language ?? (lang && /^[a-z]{2,3}$/.test(lang) ? lang : null), segments };
}

// ---------- Title, summary, chapters ----------

const SYSTEM_PROMPT = `You write the title, summary and chapters for a short screen recording, from its transcript.
The speaker records their screen to explain something to a colleague: a bug, a code change, a design, a demo, a how-to.

Rules:
- Write in the same language as the transcript.
- Title: specific and short (at most 70 characters). Say what the video is about, like a good email subject. No quotes, no emoji, do not start with "Video" or "Recording".
- Summary: 2 to 4 plain sentences. Say what the speaker shows and any request or next step. Write about the content directly ("Shows how…", "Explains why…"), not "In this video".
- Chapters: only when the video is longer than 2 minutes and has clear topic changes. Give 3 to 8 chapters. "start" is in whole seconds from the timestamps in the transcript. The first chapter starts at 0. Chapter titles have at most 6 words. For shorter videos, return an empty list.
- Use only facts from the transcript. The transcript is automatic and can have errors; fix obvious ones in names and terms.`;

const META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "chapters"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    chapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "title"],
        properties: { start: { type: "integer" }, title: { type: "string" } },
      },
    },
  },
} as const;

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function transcriptPrompt(segments: Segment[], durationS: number, language: string | null) {
  let lines = segments.map((s) => `[${clock(s.s)}] ${s.t}`);
  // Very long transcripts: keep an even sample of lines so the prompt stays small.
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total > MAX_PROMPT_CHARS) {
    const keep = Math.max(1, Math.floor((lines.length * MAX_PROMPT_CHARS) / total));
    const stepBy = lines.length / keep;
    lines = Array.from({ length: keep }, (_, i) => lines[Math.floor(i * stepBy)]);
  }
  return `Video length: ${clock(durationS * 1000)}${language ? `\nDetected language: ${language}` : ""}\n\n<transcript>\n${lines.join("\n")}\n</transcript>`;
}

type Meta = { title: string; summary: string; chapters: Chapter[] };

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("The model did not return JSON");
    return JSON.parse(m[0]);
  }
}

function cleanMeta(raw: unknown, durationS: number): Meta {
  const r = (raw ?? {}) as Partial<{ title: unknown; summary: unknown; chapters: unknown }>;
  const title = String(r.title ?? "")
    .replace(/^["'“”„«»\s]+|["'“”„«»\s.]+$/g, "")
    .slice(0, 100);
  const summary = String(r.summary ?? "").trim().slice(0, 2000);
  let chapters: Chapter[] = [];
  if (Array.isArray(r.chapters) && durationS > 120) {
    const seen = new Set<number>();
    chapters = r.chapters
      .map((c) => ({ start: Math.round(Number((c as Chapter)?.start)), title: String((c as Chapter)?.title ?? "").trim().slice(0, 80) }))
      .filter((c) => Number.isFinite(c.start) && c.start >= 0 && c.start < durationS && c.title)
      .sort((a, b) => a.start - b.start)
      .filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)))
      .slice(0, 12);
    if (chapters.length) chapters[0].start = 0;
    if (chapters.length < 2) chapters = [];
  }
  return { title, summary, chapters };
}

async function generateMeta(env: Bindings, segments: Segment[], durationS: number, language: string | null): Promise<Meta> {
  const prompt = transcriptPrompt(segments, durationS, language);
  const raw = env.ANTHROPIC_API_KEY ? await metaWithClaude(env, prompt) : await metaWithWorkersAI(env, prompt);
  return cleanMeta(raw, durationS);
}

async function metaWithWorkersAI(env: Bindings, prompt: string): Promise<unknown> {
  const model = (env.AI_MODEL || "@cf/google/gemma-4-26b-a4b-it") as "@cf/google/gemma-4-26b-a4b-it";
  const out = (await env.AI.run(model, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_schema", json_schema: { name: "video_metadata", schema: META_SCHEMA, strict: true } },
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 1500,
    temperature: 0.3,
  })) as unknown as { choices?: { message?: { content?: unknown } }[]; response?: unknown };
  const content = out.choices?.[0]?.message?.content ?? out.response;
  if (content && typeof content === "object") return content;
  return parseJsonLoose(String(content ?? ""));
}

async function metaWithClaude(env: Bindings, prompt: string): Promise<unknown> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  // Server-side fallback: if the model declines, the API retries on a fallback model in the same call.
  const withFallback = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
  const msg = await client.beta.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low", format: { type: "json_schema", schema: META_SCHEMA as unknown as Record<string, unknown> } },
    ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to summarize this transcript");
  const text = msg.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("Claude returned no text");
  return parseJsonLoose(text.text);
}
