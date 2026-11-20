// Run: node --test worker/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanRanges, cutTimeline, rangeTable, toNew } from "../src/cut.ts";

const keep = [{ s: 2000, e: 5000 }, { s: 8000, e: 10000 }]; // keep 2-5 s and 8-10 s: 5 s in total

test("toNew", () => {
  assert.equal(toNew(0, keep), 0);
  assert.equal(toNew(3000, keep), 1000);
  assert.equal(toNew(6000, keep), 3000); // deleted part: goes to the cut point
  assert.equal(toNew(9000, keep), 4000);
  assert.equal(toNew(99000, keep), 5000);
  assert.deepEqual(rangeTable(keep), [[2000, 5000, 0], [8000, 10000, 3000]]);
});

test("cleanRanges", () => {
  assert.deepEqual(cleanRanges(keep), keep);
  assert.equal(cleanRanges([{ s: 5000, e: 6000 }, { s: 5500, e: 7000 }]), null); // overlap
  assert.equal(cleanRanges([{ s: 0, e: 500 }]), null); // shorter than 1 s
  assert.equal(cleanRanges("x"), null);
});

test("cutTimeline", () => {
  const segs = [{ s: 0, e: 1000, t: "gone" }, { s: 4000, e: 9000, t: "over the cut" }, { s: 6000, e: 7000, t: "gone too" }];
  const chs = [{ start: 0, title: "A" }, { start: 6, title: "B" }, { start: 9, title: "C" }];
  const out = cutTimeline(keep, segs, chs);
  assert.deepEqual(out.segments, [{ s: 2000, e: 4000, t: "over the cut" }]);
  assert.deepEqual(out.chapters, [{ start: 0, title: "A" }, { start: 3, title: "B" }, { start: 4, title: "C" }]);
});
