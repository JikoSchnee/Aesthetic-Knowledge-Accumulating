export const PINTEREST_MIN_SAVES = 1_000;
export const PINTEREST_MIN_FOLLOWERS = 10_000;
export const PINTEREST_TOPIC_MIN_SAVES = 20;
export const PINTEREST_MAX_SEARCHES = 4;
export const PINTEREST_MAX_DETAILS = 40;
export const PINTEREST_MAX_TARGET = 24;

export const PINTEREST_DESIGN_QUERIES = [
  "graphic design poster",
  "editorial design",
  "typography poster",
  "brand identity design",
  "packaging design",
  "web design",
  "UI design",
  "book cover design",
  "album cover design",
  "experimental graphic design",
  "motion design frames",
  "information design"
] as const;

type UnknownRecord = Record<string, unknown>;

export type PinterestCandidate = {
  id: string;
  pinUrl: string;
  imageUrl: string;
  title: string;
  description: string;
  board?: string;
  author?: string;
  searchQuery?: string;
};

export type PinterestPinMetrics = PinterestCandidate & {
  saves: number;
  followers?: number;
};

export type QualifiedPinterestPin = PinterestPinMetrics & {
  selectionMode: "fixed_threshold" | "relative_batch";
  qualityScore?: number;
  savePercentile?: number;
  followerPercentile?: number;
  minimumSaves?: number;
};

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function nested(value: unknown, ...path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    const item = record(current);
    if (!item) return undefined;
    current = item[key];
  }
  return current;
}

function text(...values: unknown[]) {
  const found = values.find((value) => typeof value === "string" && value.trim());
  return typeof found === "string" ? found.trim() : "";
}

function count(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return undefined;
}

function canonicalPinUrl(value: string, id: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && (url.hostname === "pinterest.com" || url.hostname.endsWith(".pinterest.com"))) return url.toString();
  } catch { /* Use the stable ID fallback. */ }
  return `https://www.pinterest.com/pin/${encodeURIComponent(id)}/`;
}

function pinIdFromUrl(value: string) {
  try {
    const match = new URL(value, "https://www.pinterest.com").pathname.match(/\/pin\/(\d+)/);
    return match?.[1] || "";
  } catch { return ""; }
}

export function parsePinterestSearch(payload: unknown, existingPinIds = new Set<string>()) {
  const body = record(payload) || {};
  const pins = Array.isArray(body.pins) ? body.pins : Array.isArray(nested(body, "data", "pins")) ? nested(body, "data", "pins") as unknown[] : [];
  const seen = new Set(existingPinIds);
  const candidates: PinterestCandidate[] = [];
  for (const value of pins) {
    const pin = record(value);
    if (!pin || pin.is_promoted === true || pin.isPromoted === true) continue;
    const sourceUrl = text(pin.url, pin.seoUrl, pin.seo_url);
    const id = pinIdFromUrl(sourceUrl) || text(pin.id, pin.entityId, pin.entity_id);
    const imageUrl = text(nested(pin, "images", "orig", "url"), nested(pin, "imageSpec_orig", "url"), nested(pin, "imageSpecOrig", "url"));
    if (!/^\d+$/.test(id) || !imageUrl || seen.has(id)) continue;
    seen.add(id);
    candidates.push({
      id,
      pinUrl: canonicalPinUrl(sourceUrl, id),
      imageUrl,
      title: text(pin.grid_title, pin.gridTitle, pin.title, pin.seo_title, pin.seoTitle) || `Pinterest pin ${id}`,
      description: text(pin.description, pin.auto_alt_text, pin.autoAltText, pin.seo_alt_text, pin.seoAltText),
      board: text(nested(pin, "board", "name")) || undefined,
      author: text(nested(pin, "originPinner", "fullName"), nested(pin, "nativeCreator", "fullName"), nested(pin, "pinner", "full_name"), nested(pin, "pinner", "fullName")) || undefined
    });
  }
  return { candidates, cursor: text(body.cursor, nested(body, "data", "cursor")) || undefined };
}

function detailRoot(payload: unknown) {
  const body = record(payload) || {};
  return record(body.pin) || record(nested(body, "data", "pin")) || record(body.data) || body;
}

export function extractPinterestPinMetrics(payload: unknown, candidate: PinterestCandidate): PinterestPinMetrics | undefined {
  const pin = detailRoot(payload);
  if (pin.isUnsafe === true || pin.is_unsafe === true || pin.isPromoted === true || pin.is_promoted === true) return undefined;
  const saves = count(
    nested(pin, "aggregatedPinData", "aggregatedStats", "saves"),
    nested(pin, "aggregated_pin_data", "aggregated_stats", "saves"),
    pin.repinCount,
    pin.repin_count
  );
  const followers = count(
    nested(pin, "originPinner", "followerCount"),
    nested(pin, "origin_pinner", "follower_count"),
    nested(pin, "nativeCreator", "followerCount"),
    nested(pin, "native_creator", "follower_count"),
    nested(pin, "pinner", "followerCount"),
    nested(pin, "pinner", "follower_count")
  );
  if (saves == null) return undefined;
  const imageUrl = text(nested(pin, "imageSpec_orig", "url"), nested(pin, "imageSpecOrig", "url"), nested(pin, "images", "orig", "url"), candidate.imageUrl);
  return {
    ...candidate,
    imageUrl,
    title: text(pin.gridTitle, pin.grid_title, pin.title, pin.seoTitle, pin.seo_title, candidate.title),
    description: text(pin.description, pin.closeupDescription, pin.closeup_description, pin.autoAltText, candidate.description),
    board: text(nested(pin, "board", "name"), candidate.board) || undefined,
    author: text(nested(pin, "originPinner", "fullName"), nested(pin, "origin_pinner", "full_name"), nested(pin, "nativeCreator", "fullName"), nested(pin, "native_creator", "full_name"), nested(pin, "pinner", "fullName"), nested(pin, "pinner", "full_name"), candidate.author) || undefined,
    saves,
    followers
  };
}

export function qualifyPinterestPin(payload: unknown, candidate: PinterestCandidate, minimums = { saves: PINTEREST_MIN_SAVES, followers: PINTEREST_MIN_FOLLOWERS }): QualifiedPinterestPin | undefined {
  const metrics = extractPinterestPinMetrics(payload, candidate);
  if (!metrics || metrics.followers == null || metrics.saves < minimums.saves || metrics.followers < minimums.followers) return undefined;
  return { ...metrics, selectionMode: "fixed_threshold", minimumSaves: minimums.saves };
}

function percentile(values: number[], value: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  let lastMatch = -1;
  for (let index = 0; index < sorted.length; index += 1) if (sorted[index] <= value) lastMatch = index;
  return (lastMatch + 1) / sorted.length;
}

export function rankTopicPinterestPins(values: PinterestPinMetrics[], targetCount: number, minimumSaves = PINTEREST_TOPIC_MIN_SAVES): QualifiedPinterestPin[] {
  const eligible = values.filter((value) => value.saves >= minimumSaves);
  const saves = eligible.map((value) => value.saves);
  const followers = eligible.flatMap((value) => value.followers == null ? [] : [value.followers]);
  return eligible.map((value) => {
    const savePercentile = percentile(saves, value.saves);
    const followerPercentile = value.followers == null ? 0 : percentile(followers, value.followers);
    const higher = Math.max(savePercentile, followerPercentile);
    const lower = Math.min(savePercentile, followerPercentile);
    return { ...value, selectionMode: "relative_batch" as const, qualityScore: Number((higher * 0.7 + lower * 0.3).toFixed(6)), savePercentile: Number(savePercentile.toFixed(6)), followerPercentile: Number(followerPercentile.toFixed(6)), minimumSaves };
  }).sort((left, right) => (right.qualityScore || 0) - (left.qualityScore || 0) || right.saves - left.saves || (right.followers ?? -1) - (left.followers ?? -1) || left.id.localeCompare(right.id)).slice(0, clampPinterestTarget(targetCount));
}

export function shuffled<T>(values: readonly T[], random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function clampPinterestTarget(value: unknown) {
  const target = typeof value === "number" ? value : Number(value);
  return Math.min(PINTEREST_MAX_TARGET, Math.max(1, Number.isFinite(target) ? Math.floor(target) : 12));
}
