import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dedupeText, findDuplicateCandidates, type RecipeLike } from "./dedupe";
import { dataRoot, readSkills } from "./library";
import { coverArtUrl, findOriginalAlbumForRecording, hasFrontCover } from "./musicbrainz";
import { imageRecipePrompt, parseValidRecipe } from "./recipe-schema";
import { TYPOGRAPHY_SCHEMA_VERSION, typographyText } from "./typography";

const OWNER = "HipsterVizNinja";
const REPO = "random-data";
const PATH = "Music/hot-100/Hot 100.csv";
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const ALLOWED_MIME = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]);

export type VisionConfig = { endpoint?: string; model?: string; apiKey?: string };
type Appearance = { chartDate: string; position: number };
type SongStatus = "pending" | "processing" | "approved" | "merged" | "unmatched" | "no_album" | "no_cover" | "failed";
type SongEntry = {
  songId: string; song: string; performer: string; appearances: Appearance[]; peakPosition: number; firstChartDate: string; lastChartDate: string;
  status: SongStatus; retries: number; error?: string; canonicalReleaseGroupId?: string; recipeId?: string;
  match?: { recordingId?: string; recordingScore?: number; releaseId?: string; releaseGroupId?: string; releaseDate?: string; verificationNeeded?: boolean; lookupVersion?: number };
};
type CanonicalAlbum = { releaseGroupId: string; recipeId?: string; canonicalSongId: string; artworkUrl: string; status: "approved" | "existing" };
export type Hot100Job = {
  id: string; status: "ready" | "running" | "paused" | "completed"; createdAt: string; updatedAt: string;
  sourceSnapshot: { owner: string; repo: string; path: string; commitSha: string; rawUrl: string; sha256: string; fetchedAt: string; bytes: number; licenseNotice: string };
  totalRows: number; songs: SongEntry[]; albums: Record<string, CanonicalAlbum>;
};

function hot100Directory(root = dataRoot()) { return join(root, "hot100-imports"); }
function jobPath(id: string, root = dataRoot()) { return join(hot100Directory(root), `${id}.json`); }
function now() { return new Date().toISOString(); }
function safeKey(song: string, performer: string) { return `${song}\u0000${performer}`.trim().toLowerCase(); }

function parseRow(line: string) {
  const fields: string[] = []; let value = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { fields.push(value); value = ""; }
    else value += character;
  }
  fields.push(value.replace(/\r$/, ""));
  return fields;
}

async function resolveSnapshot() {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits/main`, { headers: { accept: "application/vnd.github+json", "user-agent": "TasteSkillStudio" }, cache: "no-store" });
  if (!response.ok) throw new Error(`无法锁定 GitHub 数据版本（${response.status}）。`);
  const payload = await response.json() as { sha?: string };
  if (!payload.sha || !/^[a-f0-9]{40}$/i.test(payload.sha)) throw new Error("GitHub 未返回有效 commit SHA。");
  return { commitSha: payload.sha, rawUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/${payload.sha}/${PATH.split("/").map(encodeURIComponent).join("/")}` };
}

async function downloadSongs(rawUrl: string) {
  const response = await fetch(rawUrl, { headers: { accept: "text/csv", "user-agent": "TasteSkillStudio" }, cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`无法下载 Hot 100 CSV（${response.status}）。`);
  const hash = createHash("sha256"); const decoder = new TextDecoder(); let remainder = ""; let headers: string[] | undefined; let bytes = 0; let totalRows = 0;
  const songs = new Map<string, SongEntry>();
  const consume = (line: string) => {
    if (!line.trim()) return;
    const values = parseRow(line);
    if (!headers) { headers = values.map((value) => value.replace(/^\uFEFF/, "").trim()); return; }
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
    const song = row.song?.trim(); const performer = row.performer?.trim(); const chartDate = row.chart_date?.trim(); const position = Number(row.chart_position);
    if (!song || !performer || !chartDate || !Number.isInteger(position) || position < 1) return;
    totalRows += 1;
    const songId = row.song_id?.trim() || safeKey(song, performer); const key = songId.toLowerCase();
    const current = songs.get(key);
    const appearance = { chartDate, position };
    if (current) { current.appearances.push(appearance); current.peakPosition = Math.min(current.peakPosition, position); current.firstChartDate = current.firstChartDate < chartDate ? current.firstChartDate : chartDate; current.lastChartDate = current.lastChartDate > chartDate ? current.lastChartDate : chartDate; }
    else songs.set(key, { songId, song, performer, appearances: [appearance], peakPosition: position, firstChartDate: chartDate, lastChartDate: chartDate, status: "pending", retries: 0 });
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength; if (bytes > MAX_SOURCE_BYTES) throw new Error("Hot 100 CSV 超过允许的 100MB 大小限制。");
    hash.update(chunk); remainder += decoder.decode(chunk, { stream: true });
    const lines = remainder.split("\n"); remainder = lines.pop() || ""; for (const line of lines) consume(line);
  }
  remainder += decoder.decode(); if (remainder.trim()) consume(remainder);
  if (!headers || !["song", "performer", "chart_date", "chart_position"].every((header) => headers!.includes(header))) throw new Error("Hot 100 CSV 缺少必需列。");
  return { songs: [...songs.values()], totalRows, bytes, sha256: hash.digest("hex") };
}

export async function createHot100Job() {
  const snapshot = await resolveSnapshot(); const parsed = await downloadSongs(snapshot.rawUrl); const id = randomUUID(); const timestamp = now();
  const job: Hot100Job = { id, status: "ready", createdAt: timestamp, updatedAt: timestamp, sourceSnapshot: { owner: OWNER, repo: REPO, path: PATH, commitSha: snapshot.commitSha, rawUrl: snapshot.rawUrl, sha256: parsed.sha256, fetchedAt: timestamp, bytes: parsed.bytes, licenseNotice: "Source repository does not declare a license in its README; use is at the operator's risk." }, totalRows: parsed.totalRows, songs: parsed.songs, albums: {} };
  await saveHot100Job(job); return job;
}

export async function readHot100Job(id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return undefined;
  try { return JSON.parse(await readFile(jobPath(id), "utf8")) as Hot100Job; } catch { return undefined; }
}

export async function saveHot100Job(job: Hot100Job) {
  job.updatedAt = now(); await mkdir(hot100Directory(), { recursive: true }); await writeFile(jobPath(job.id), JSON.stringify(job, null, 2));
}

export function hot100Summary(job: Hot100Job) {
  const counts = Object.fromEntries(["pending", "processing", "approved", "merged", "unmatched", "no_album", "no_cover", "failed"].map((status) => [status, 0])) as Record<SongStatus, number>;
  let lowConfidence = 0;
  for (const song of job.songs) { counts[song.status] += 1; if (song.match?.verificationNeeded) lowConfidence += 1; }
  return { id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, sourceSnapshot: job.sourceSnapshot, totalRows: job.totalRows, uniqueSongs: job.songs.length, uniqueAlbums: Object.keys(job.albums).length, counts, lowConfidence, recent: job.songs.filter((song) => song.status !== "pending").slice(-12).reverse().map((song) => ({ songId: song.songId, song: song.song, performer: song.performer, status: song.status, error: song.error, recipeId: song.recipeId })) };
}

function extensionFor(response: Response) {
  return ALLOWED_MIME.get(response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() || "");
}

async function analyzeAndApprove({ hash, extension, filename, source, vision }: { hash: string; extension: string; filename: string; source: Record<string, unknown>; vision: Required<VisionConfig> }) {
  const root = dataRoot(); const image = await readFile(join(root, "uploads", "default", `${hash}.${extension}`)); const mime = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  const callModel = async (strict = false) => fetch(`${vision.endpoint.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${vision.apiKey}` }, body: JSON.stringify({ model: vision.model, temperature: strict ? 0 : 0.3, response_format: { type: "json_object" }, messages: [{ role: "system", content: strict ? `${imageRecipePrompt} This is a strict retry. Return JSON only.` : imageRecipePrompt }, { role: "user", content: [{ type: "text", text: "Create one independent English visual recipe for this image." }, { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } }] }] }) });
  let response = await callModel(); if (!response.ok) throw new Error(`模型请求失败（HTTP ${response.status}）。`);
  let payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }; let recipe: RecipeLike["recipe"];
  try { recipe = parseValidRecipe(payload.choices?.[0]?.message?.content); } catch { response = await callModel(true); if (!response.ok) throw new Error(`模型重试失败（HTTP ${response.status}）。`); payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }; recipe = parseValidRecipe(payload.choices?.[0]?.message?.content); }
  const existing = await readSkills(root, "all") as RecipeLike[]; const duplicateCandidates = findDuplicateCandidates(recipe, existing); const timestamp = now();
  const recipeData = recipe as NonNullable<RecipeLike["recipe"]> & { metadata?: { title?: string; category?: string; medium?: string[]; useCases?: string[]; retrievalTags?: string[] }; typographyAndGraphicLanguage?: Parameters<typeof typographyText>[0] };
  const metadata = recipeData.metadata || {}; const typographySearchText = typographyText(recipeData.typographyAndGraphicLanguage);
  const stored = { id: hash, libraryType: "photo", status: "approved", providerModel: vision.model, createdAt: timestamp, approvedAt: timestamp, recipeSchemaVersion: "1.1", typographySchemaVersion: TYPOGRAPHY_SCHEMA_VERSION, typographyStatus: "ready", typographyModel: vision.model, typographyUpdatedAt: timestamp, embeddingStatus: "missing", indexStatus: "keyword_only", source: { kind: "hot100_album_cover", filename, hash, ...source }, dedupeText: dedupeText(recipe), duplicateCandidates, duplicateDecision: "keep_independent", recipe };
  const search = { id: hash, libraryType: "photo", title: metadata.title || "Untitled visual recipe", category: metadata.category || "Uncategorized", medium: metadata.medium || [], useCases: metadata.useCases || [], tags: metadata.retrievalTags || [], coreRelationships: recipeData.coreVisualRelationships || [], reuseFormula: recipeData.reuseFormula || "", typographyText: typographySearchText, searchText: [metadata.title, metadata.category, ...(metadata.medium || []), ...(metadata.useCases || []), ...(metadata.retrievalTags || []), ...(recipeData.coreVisualRelationships || []), recipeData.reuseFormula, typographySearchText].filter(Boolean).join(" · "), zhAliases: { title: metadata.title || "", useCases: [], tags: [], searchText: "" }, qualityScore: 0.8, specificityScore: 0.8, approved: true, languages: ["en", "zh-CN"], embeddingStatus: "missing", typographyStatus: "ready", typographySchemaVersion: TYPOGRAPHY_SCHEMA_VERSION, recipeSchemaVersion: "1.1", searchSchemaVersion: "1.1" };
  await mkdir(join(root, "recipes"), { recursive: true }); await mkdir(join(root, "search-documents"), { recursive: true });
  await Promise.all([writeFile(join(root, "recipes", `${hash}.json`), JSON.stringify(stored, null, 2)), writeFile(join(root, "search-documents", `${hash}.json`), JSON.stringify(search, null, 2))]);
  return hash;
}

function requiredVision(vision: VisionConfig | undefined): Required<VisionConfig> | undefined {
  const apiKey = vision?.apiKey === "env-configured" ? process.env.VISION_API_KEY : vision?.apiKey || process.env.VISION_API_KEY;
  const endpoint = vision?.endpoint || process.env.VISION_ENDPOINT; const model = vision?.model || process.env.VISION_MODEL;
  return apiKey && endpoint && model ? { apiKey, endpoint, model } : undefined;
}

async function processSong(job: Hot100Job, song: SongEntry, vision: Required<VisionConfig>) {
  const match = await findOriginalAlbumForRecording(song.song, song.performer);
  if (!match) { song.status = "unmatched"; return; }
  song.match = { recordingId: match.recordingId, recordingScore: match.recordingScore, releaseId: "releaseId" in match ? match.releaseId : undefined, releaseGroupId: "releaseGroupId" in match ? match.releaseGroupId : undefined, releaseDate: "releaseDate" in match ? match.releaseDate : undefined, verificationNeeded: match.recordingScore < 100, lookupVersion: 2 };
  if (match.noAlbum || !("releaseGroupId" in match) || !match.releaseGroupId) { song.status = "no_album"; return; }
  const releaseGroupId = match.releaseGroupId; song.canonicalReleaseGroupId = releaseGroupId;
  const known = job.albums[releaseGroupId];
  if (known) { song.status = "merged"; song.recipeId = known.recipeId; return; }
  if (!await hasFrontCover(releaseGroupId)) { song.status = "no_cover"; return; }
  const artwork = coverArtUrl(releaseGroupId); const imageResponse = await fetch(artwork, { headers: { accept: "image/jpeg,image/png,image/webp" } });
  if (!imageResponse.ok) { song.status = "no_cover"; return; }
  const extension = extensionFor(imageResponse); if (!extension) throw new Error("CAA 返回了不受支持的封面格式。");
  const bytes = Buffer.from(await imageResponse.arrayBuffer()); if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("CAA 封面文件无效或超过 20MB。");
  const hash = createHash("sha256").update(bytes).digest("hex"); const root = dataRoot(); const uploadPath = join(root, "uploads", "default", `${hash}.${extension}`); await mkdir(join(root, "uploads", "default"), { recursive: true });
  try { await access(uploadPath); } catch { await writeFile(uploadPath, bytes); }
  let recipeId = hash; let existingRecipe = false;
  try { await access(join(root, "recipes", `${hash}.json`)); existingRecipe = true; } catch { /* Analyze new image. */ }
  if (!existingRecipe) recipeId = await analyzeAndApprove({ hash, extension, filename: `${match.albumTitle}.${extension}`, source: { provider: "musicbrainz-caa", albumTitle: match.albumTitle, artist: song.performer, artworkUrl: artwork, sourceUrl: `https://musicbrainz.org/release-group/${releaseGroupId}`, releaseGroupId, recordingId: match.recordingId, hot100: { repository: `${OWNER}/${REPO}`, commitSha: job.sourceSnapshot.commitSha, path: PATH, songId: song.songId, song: song.song, performer: song.performer, peakPosition: song.peakPosition, firstChartDate: song.firstChartDate, lastChartDate: song.lastChartDate, appearances: song.appearances } }, vision });
  job.albums[releaseGroupId] = { releaseGroupId, recipeId, canonicalSongId: song.songId, artworkUrl: artwork, status: existingRecipe ? "existing" : "approved" }; song.recipeId = recipeId; song.status = "approved";
}

export async function runHot100Job(id: string, vision: VisionConfig | undefined, retryFailed = false, limit = 2) {
  const job = await readHot100Job(id); if (!job) throw new Error("找不到 Hot 100 导入任务。");
  if (job.status === "paused") throw new Error("任务已暂停，请先继续任务。");
  const config = requiredVision(vision); if (!config) throw new Error("请先配置视觉模型，才能自动分析并批准封面。");
  for (const song of job.songs) if (song.status === "processing") { song.status = "pending"; song.error = "上次运行在当前项目处理时中断，已安全恢复到待处理队列。"; }
  for (const song of job.songs) if (song.status === "no_album" && song.match?.lookupVersion !== 2) { song.status = "pending"; song.error = undefined; }
  if (retryFailed) for (const song of job.songs) if (song.status === "failed") { song.status = "pending"; song.error = undefined; }
  job.status = "running"; await saveHot100Job(job); let handled = 0;
  for (const song of job.songs) {
    if (handled >= Math.max(1, Math.min(limit, 5)) || song.status !== "pending") continue;
    song.status = "processing"; await saveHot100Job(job);
    try { await processSong(job, song, config); } catch (error) { song.status = "failed"; song.retries += 1; song.error = error instanceof Error ? error.message.slice(0, 300) : "未知处理失败。"; }
    handled += 1; await saveHot100Job(job);
  }
  if (!job.songs.some((song) => song.status === "pending" || song.status === "processing")) job.status = "completed";
  else job.status = "ready";
  await saveHot100Job(job); return { job, handled };
}

export async function pauseHot100Job(id: string, paused: boolean) {
  const job = await readHot100Job(id); if (!job) throw new Error("找不到 Hot 100 导入任务。");
  job.status = paused ? "paused" : "ready"; await saveHot100Job(job); return job;
}
