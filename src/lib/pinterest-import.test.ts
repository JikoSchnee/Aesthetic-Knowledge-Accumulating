import assert from "node:assert/strict";
import test from "node:test";
import { clampPinterestTarget, extractPinterestPinMetrics, parsePinterestSearch, qualifyPinterestPin, rankTopicPinterestPins, shuffled, type PinterestPinMetrics } from "./pinterest-import";

const candidate = { id: "123", pinUrl: "https://www.pinterest.com/pin/123/", imageUrl: "https://i.pinimg.com/originals/a.jpg", title: "Poster", description: "Design" };

test("search parsing removes promoted, duplicate, and image-less pins", () => {
  const result = parsePinterestSearch({ cursor: "next", pins: [
    { id: "known", url: "/pin/known", images: { orig: { url: "https://i.pinimg.com/originals/known.jpg" } } },
    { id: "ad", is_promoted: true, images: { orig: { url: "https://i.pinimg.com/originals/ad.jpg" } } },
    { id: "empty" },
    { id: "123", url: "https://www.pinterest.com/pin/123/", grid_title: "Poster", images: { orig: { url: "https://i.pinimg.com/originals/a.jpg" } } }
  ] }, new Set(["known"]));
  assert.equal(result.cursor, "next");
  assert.deepEqual(result.candidates, [{ ...candidate, description: "", board: undefined, author: undefined }]);
});

test("search parsing prefers the stable numeric ID embedded in the Pin URL", () => {
  const result = parsePinterestSearch({ pins: [{
    id: "UGluOjEyMzQ1",
    url: "https://www.pinterest.com/pin/12345/",
    images: { orig: { url: "https://i.pinimg.com/originals/url-id.jpg" } }
  }] });
  assert.equal(result.candidates[0]?.id, "12345");
  assert.equal(result.candidates[0]?.pinUrl, "https://www.pinterest.com/pin/12345/");
});

test("search parsing skips opaque node IDs that cannot form a valid Pin URL", () => {
  const result = parsePinterestSearch({ pins: [{
    id: "UGluOjEyMzQ1",
    images: { orig: { url: "https://i.pinimg.com/originals/opaque.jpg" } }
  }] });
  assert.equal(result.candidates.length, 0);
});

test("detail qualification accepts threshold boundaries and camelCase fields", () => {
  const result = qualifyPinterestPin({ aggregatedPinData: { aggregatedStats: { saves: 1000 } }, originPinner: { followerCount: 10000, fullName: "Designer" }, imageSpec_orig: { url: "https://i.pinimg.com/originals/b.jpg" } }, candidate);
  assert.equal(result?.saves, 1000);
  assert.equal(result?.followers, 10000);
  assert.equal(result?.author, "Designer");
  assert.equal(result?.imageUrl, "https://i.pinimg.com/originals/b.jpg");
});

test("detail qualification supports snake_case and rejects missing or low metrics", () => {
  const snake = qualifyPinterestPin({ aggregated_pin_data: { aggregated_stats: { saves: "1500" } }, native_creator: { follower_count: "12000" } }, candidate);
  assert.equal(snake?.saves, 1500);
  assert.equal(qualifyPinterestPin({ aggregatedPinData: { aggregatedStats: { saves: 999 } }, pinner: { followerCount: 999999 } }, candidate), undefined);
  assert.equal(qualifyPinterestPin({ aggregatedPinData: { aggregatedStats: { saves: 999999 } } }, candidate), undefined);
});

test("metric extraction keeps niche pins with missing followers", () => {
  const result = extractPinterestPinMetrics({ aggregatedPinData: { aggregatedStats: { saves: 20 } } }, candidate);
  assert.equal(result?.saves, 20);
  assert.equal(result?.followers, undefined);
  assert.equal(qualifyPinterestPin({ aggregatedPinData: { aggregatedStats: { saves: 10000 } } }, candidate), undefined);
});

test("relative ranking enforces the 20-save floor and lets either strong metric lead", () => {
  const values: PinterestPinMetrics[] = [
    { ...candidate, id: "below", saves: 19, followers: 1_000_000 },
    { ...candidate, id: "saves", saves: 500, followers: 50 },
    { ...candidate, id: "followers", saves: 20, followers: 100_000 },
    { ...candidate, id: "balanced", saves: 120, followers: 8_000 },
    { ...candidate, id: "missing", saves: 300 }
  ];
  const ranked = rankTopicPinterestPins(values, 4);
  assert.equal(ranked.some((item) => item.id === "below"), false);
  assert.equal(ranked.length, 4);
  assert.equal(ranked[0].id, "saves");
  assert.equal(ranked.some((item) => item.id === "followers"), true);
  assert.equal(ranked.find((item) => item.id === "missing")?.followerPercentile, 0);
  assert.ok(ranked.every((item) => item.selectionMode === "relative_batch" && item.minimumSaves === 20));
});

test("relative ranking is deterministic for tied scores", () => {
  const values: PinterestPinMetrics[] = [
    { ...candidate, id: "b", saves: 20, followers: 20 },
    { ...candidate, id: "a", saves: 20, followers: 20 }
  ];
  assert.deepEqual(rankTopicPinterestPins(values, 2).map((item) => item.id), ["a", "b"]);
});

test("target clamping and shuffle are deterministic with an injected random source", () => {
  assert.equal(clampPinterestTarget(0), 1);
  assert.equal(clampPinterestTarget(99), 24);
  assert.equal(clampPinterestTarget("bad"), 12);
  assert.deepEqual(shuffled([1, 2, 3, 4], () => 0), [2, 3, 4, 1]);
});
