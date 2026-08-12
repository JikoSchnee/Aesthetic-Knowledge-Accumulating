import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSkills, dataRoot } from "../../../../src/lib/library";
import {
  PINTEREST_DESIGN_QUERIES,
  PINTEREST_MAX_DETAILS,
  PINTEREST_MAX_SEARCHES,
  PINTEREST_TOPIC_MIN_SAVES,
  clampPinterestTarget,
  extractPinterestPinMetrics,
  parsePinterestSearch,
  qualifyPinterestPin,
  rankTopicPinterestPins,
  shuffled,
  type PinterestPinMetrics,
  type QualifiedPinterestPin
} from "../../../../src/lib/pinterest-import";

export const runtime = "nodejs";
export const maxDuration = 300;

type ImportRequest = { mode?: "random" | "topic"; query?: string; targetCount?: number };
type IntakeRecord = { hash: string; extension: string; filename: string; outcome: "new" | "retry" | "skipped_duplicate"; reason?: string; source: Record<string, unknown> };

const SCRAPE_BASE = "https://api.scrapecreators.com/v1/pinterest";
const imageTypes = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]);

class ScrapeCreatorsRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

function safeMessage(value: unknown) {
  if (typeof value !== "string") return "上游未返回错误说明。";
  return value.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 280);
}

async function scrape(path: "search" | "pin", parameters: Record<string, string>, apiKey: string) {
  const url = new URL(`${SCRAPE_BASE}/${path}`);
  for (const [key, value] of Object.entries(parameters)) if (value) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json", "x-api-key": apiKey }, cache: "no-store", signal: AbortSignal.timeout(25_000) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知网络错误";
    throw new ScrapeCreatorsRequestError(`ScrapeCreators ${path} 网络请求失败：${safeMessage(reason)}`);
  }
  if (!response.ok) {
    const raw = await response.text();
    let code = "";
    try { const value = JSON.parse(raw) as { error?: unknown }; if (typeof value.error === "string") code = value.error; } catch { /* Preserve the upstream text below. */ }
    throw new ScrapeCreatorsRequestError(`ScrapeCreators ${path} 请求失败（HTTP ${response.status}）：${safeMessage(raw)}`, response.status, code);
  }
  return response.json() as Promise<unknown>;
}

function pinIdFromSource(source: unknown) {
  if (!source || typeof source !== "object") return "";
  const id = (source as Record<string, unknown>).pinId;
  return typeof id === "string" ? id : "";
}

function validatedImageUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "i.pinimg.com") throw new Error("Pinterest 原图必须来自 HTTPS i.pinimg.com。 ");
  return url;
}

async function savePin(pin: QualifiedPinterestPin, query: string, root: string): Promise<IntakeRecord> {
  const imageUrl = validatedImageUrl(pin.imageUrl);
  let response: Response | undefined; let lastNetworkError = "";
  for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
    try { response = await fetch(imageUrl, { headers: { accept: "image/jpeg,image/png,image/webp,image/*" }, cache: "no-store", signal: AbortSignal.timeout(30_000) }); }
    catch (error) { lastNetworkError = error instanceof Error ? error.message : "未知网络错误"; }
  }
  if (!response) throw new Error(`Pinterest 原图网络下载失败（已重试 1 次）：${safeMessage(lastNetworkError)}`);
  if (!response.ok) throw new Error(`原图下载失败（HTTP ${response.status}）。`);
  validatedImageUrl(response.url);
  const mime = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
  const extension = imageTypes.get(mime);
  if (!extension) throw new Error("原图格式不受支持，仅支持 JPEG、PNG 或 WebP。");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("原图无效或超过 20MB。");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const uploadDir = join(root, "uploads", "default");
  const recipeDir = join(root, "recipes");
  const destination = join(uploadDir, `${hash}.${extension}`);
  await mkdir(uploadDir, { recursive: true });
  let outcome: IntakeRecord["outcome"] = "new";
  try {
    await access(destination);
    try { await access(join(recipeDir, `${hash}.json`)); outcome = "skipped_duplicate"; }
    catch { outcome = "retry"; }
  } catch { await writeFile(destination, bytes); }
  const filename = `Pinterest — ${pin.title || pin.id}.${extension}`;
  const source = { kind: "pinterest", pinId: pin.id, pinUrl: pin.pinUrl, imageUrl: pin.imageUrl, searchQuery: query, title: pin.title, description: pin.description, board: pin.board, author: pin.author, saves: pin.saves, followers: pin.followers, followersMetric: "exposure_proxy", selectionMode: pin.selectionMode, qualityScore: pin.qualityScore, savePercentile: pin.savePercentile, followerPercentile: pin.followerPercentile, minimumSaves: pin.minimumSaves, fetchedAt: new Date().toISOString() };
  return { hash, extension, filename, outcome, source, ...(outcome === "skipped_duplicate" ? { reason: "该 Pinterest 图片已生成过配方。" } : {}) };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as ImportRequest;
  const mode = body.mode === "topic" ? "topic" : "random";
  const query = (body.query || "").replace(/[\r\n]/g, " ").trim().slice(0, 160);
  if (mode === "topic" && !query) return Response.json({ error: "主题模式需要输入搜索主题。" }, { status: 400 });
  const apiKey = process.env.SCRAPECREATORS_API_KEY || "";
  if (!apiKey) return Response.json({ error: "请先在 API 配置中保存 ScrapeCreators API Key。" }, { status: 400 });
  const targetCount = clampPinterestTarget(body.targetCount);
  const root = dataRoot();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      let searches = 0; let inspected = 0; let unavailableDetails = 0; let failedDetails = 0; let failedDownloads = 0;
      try {
        const recipes = await readSkills(root, "photo");
        const existingPinIds = new Set(recipes.map((recipe) => pinIdFromSource(recipe.source)).filter(Boolean));
        const candidates = [] as ReturnType<typeof parsePinterestSearch>["candidates"];
        const seen = new Set(existingPinIds);
        let cursor: string | undefined;
        const randomQueries = shuffled(PINTEREST_DESIGN_QUERIES).slice(0, PINTEREST_MAX_SEARCHES);
        for (let index = 0; index < PINTEREST_MAX_SEARCHES; index += 1) {
          const searchQuery = mode === "topic" ? query : randomQueries[index];
          const payload = await scrape("search", { query: searchQuery, ...(mode === "topic" && cursor ? { cursor } : {}), trim: "false" }, apiKey);
          searches += 1;
          const parsed = parsePinterestSearch(payload, seen);
          for (const candidate of parsed.candidates) { seen.add(candidate.id); candidates.push({ ...candidate, searchQuery }); }
          cursor = parsed.cursor;
          emit({ type: "search", searches, maxSearches: PINTEREST_MAX_SEARCHES, candidates: candidates.length, query: searchQuery });
          if (candidates.length >= PINTEREST_MAX_DETAILS || (mode === "topic" && !cursor)) break;
        }

        const pool = shuffled(candidates).slice(0, PINTEREST_MAX_DETAILS);
        const fixedQualified: QualifiedPinterestPin[] = [];
        const topicMetrics: PinterestPinMetrics[] = [];
        for (let offset = 0; offset < pool.length && (mode === "topic" || fixedQualified.length < targetCount); offset += 4) {
          const batch = pool.slice(offset, Math.min(offset + 4, PINTEREST_MAX_DETAILS));
          const results = await Promise.all(batch.map(async (candidate) => {
            try {
              const payload = await scrape("pin", { url: candidate.pinUrl, trim: "false", cache_max_age: "7d" }, apiKey);
              return mode === "topic" ? extractPinterestPinMetrics(payload, candidate) : qualifyPinterestPin(payload, candidate);
            }
            catch (error) {
              if (error instanceof ScrapeCreatorsRequestError && error.status === 404 && (!error.code || error.code === "not_found")) { unavailableDetails += 1; return undefined; }
              const message = error instanceof Error ? error.message : "Pin 详情读取失败。";
              if (/HTTP (401|403)/.test(message)) throw error;
              failedDetails += 1;
              emit({ type: "detail-error", pinId: candidate.id, message }); return undefined;
            }
          }));
          inspected += batch.length;
          for (const result of results) {
            if (!result) continue;
            if (mode === "topic") topicMetrics.push(result);
            else if (fixedQualified.length < targetCount) fixedQualified.push(result as QualifiedPinterestPin);
          }
          const eligible = mode === "topic" ? topicMetrics.filter((item) => item.saves >= PINTEREST_TOPIC_MIN_SAVES).length : fixedQualified.length;
          emit({ type: "inspect", inspected, maxDetails: PINTEREST_MAX_DETAILS, qualified: mode === "topic" ? 0 : fixedQualified.length, eligible, unavailableDetails, failedDetails, targetCount, selectionMode: mode === "topic" ? "relative_batch" : "fixed_threshold" });
        }

        const qualified = mode === "topic" ? rankTopicPinterestPins(topicMetrics, targetCount) : fixedQualified;
        if (mode === "topic") emit({ type: "rank", inspected, eligible: topicMetrics.filter((item) => item.saves >= PINTEREST_TOPIC_MIN_SAVES).length, selected: qualified.length, targetCount, minimumSaves: PINTEREST_TOPIC_MIN_SAVES });

        const records: IntakeRecord[] = [];
        for (const pin of qualified) {
          try { records.push(await savePin(pin, pin.searchQuery || (mode === "topic" ? query : "random-design-pool"), root)); }
          catch (error) { failedDownloads += 1; emit({ type: "download-error", pinId: pin.id, message: error instanceof Error ? error.message : "Pinterest 原图下载失败。" }); }
          emit({ type: "download", completed: records.length + failedDownloads, total: qualified.length, downloaded: records.length, failed: failedDownloads });
        }
        const eligible = mode === "topic" ? topicMetrics.filter((item) => item.saves >= PINTEREST_TOPIC_MIN_SAVES).length : fixedQualified.length;
        const stats = { searches, inspected, unavailableDetails, failedDetails, eligible, relativeSelected: mode === "topic" ? qualified.length : 0, qualified: qualified.length, downloaded: records.length, duplicates: records.filter((item) => item.outcome === "skipped_duplicate").length, failed: failedDownloads, requestsUsed: searches + inspected, requestLimit: PINTEREST_MAX_SEARCHES + PINTEREST_MAX_DETAILS, targetCount, exhausted: qualified.length < targetCount, selectionMode: mode === "topic" ? "relative_batch" : "fixed_threshold" };
        emit({ type: "complete", batchId: randomUUID(), records, stats });
      } catch (error) { emit({ type: "error", error: error instanceof Error ? error.message : "Pinterest 导入失败。", searches, inspected }); }
      finally { controller.close(); }
    }
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
