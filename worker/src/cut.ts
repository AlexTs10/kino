// Cut editor: the browser sends the parts of the old file that stay, in ms of the old file.
// These functions move transcript lines and chapters to the new, shorter timeline.
import type { Chapter, Segment } from "./ai";

export type Range = { s: number; e: number };

// Checks the parts from the browser: sorted, not overlapping, at least 1 second in total. Null if bad.
export function cleanRanges(raw: unknown): Range[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 1000) return null;
  const out: Range[] = [];
  for (const r of raw) {
    const s = Math.round(Number(r?.s));
    const e = Math.round(Number(r?.e));
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s || (out.at(-1)?.e ?? 0) > s) return null;
    out.push({ s, e });
  }
  return keptMs(out) >= 1000 ? out : null;
}

export const keptMs = (keep: Range[]) => keep.reduce((n, r) => n + r.e - r.s, 0);

// Old time to new time. A time in a deleted part goes to the cut point after it.
export function toNew(t: number, keep: Range[]): number {
  let off = 0;
  for (const r of keep) {
    if (t < r.s) return off;
    if (t <= r.e) return off + t - r.s;
    off += r.e - r.s;
  }
  return off;
}

// [[start, end, new start]] for each part, for the SQL that moves comments and reactions.
export const rangeTable = (keep: Range[]) => keep.map((r) => [r.s, r.e, toNew(r.s, keep)]);

export function cutTimeline(keep: Range[], segments: Segment[], chapters: Chapter[]) {
  const total = keptMs(keep);
  const segs = segments.map((x) => ({ s: toNew(x.s, keep), e: toNew(x.e, keep), t: x.t })).filter((x) => x.e > x.s);
  const chs: Chapter[] = [];
  for (const ch of chapters) {
    const ms = toNew(ch.start * 1000, keep);
    if (ms >= total) break;
    const start = Math.round(ms / 1000);
    // Two chapters at the same cut point: keep the later one, it is the one that runs there.
    if (chs.at(-1)?.start === start) chs.pop();
    chs.push({ ...ch, start });
  }
  if (chs[0]) chs[0].start = 0;
  return { segments: segs, chapters: chs.length >= 2 ? chs : [] };
}
