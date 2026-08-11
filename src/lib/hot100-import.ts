import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dedupeText, findDuplicateCandidates, type RecipeLike } from "./dedupe";
import { dataRoot, readSkills } from "./library";
import { coverArtUrl, findOriginalAlbumForRecording } from "./musicbrainz";
import { imageRecipePrompt, parseValidRecipe } from "./recipe-schema";
import { TYPOGRAPHY_SCHEMA_VERSION, typographyText } from "./typography";

const OWNER = "HipsterVizNinja";
const REPO = "random-data";
const PATH = "Music/hot-100/Hot 100.csv";
const DATASET_KEY = `${OWNER}/${REPO}/${PATH}`;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const LEASE_MS = 60_000;
const IDLE_MS = 800;
export const MAX_HOT100_CONCURRENCY = 16;
const ALLOWED_MIME = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]);

export type VisionConfig = { endpoint?: string; model?: string; apiKey?: string };
type Appearance = { chartDate: string; position: number };
export type SongStatus = "pending_lookup" | "looking_up" | "pending_cover" | "downloading" | "pending_analysis" | "analyzing" | "approved" | "merged" | "unmatched" | "no_album" | "no_cover" | "failed";
type JobStatus = "ready" | "running" | "paused" | "completed";
type SongEntry = {
  songId: string; song: string; performer: string; appearances: Appearance[]; peakPosition: number; firstChartDate: string; lastChartDate: string;
  status?: string; retries?: number; error?: string; canonicalReleaseGroupId?: string; recipeId?: string; match?: Record<string, unknown>;
};
type LegacyJob = {
  id: string; status: JobStatus; createdAt: string; updatedAt: string; sourceSnapshot: SourceSnapshot; totalRows: number;
  songs: SongEntry[]; albums?: Record<string, { releaseGroupId: string; recipeId?: string; canonicalSongId: string; artworkUrl: string; status: string }>;
};
type SourceSnapshot = { owner: string; repo: string; path: string; commitSha: string; rawUrl: string; sha256: string; fetchedAt: string; bytes: number; licenseNotice: string };
type SongRow = {
  job_id: string; song_id: string; song: string; performer: string; status: SongStatus; retries: number; error: string | null;
  peak_position: number; first_chart_date: string; last_chart_date: string; appearances_json: string; match_json: string | null;
  release_group_id: string | null; recipe_id: string | null; previous_status: SongStatus | null;
};
type JobRow = { id: string; status: JobStatus; created_at: string; updated_at: string; started_at: string | null; source_json: string; total_rows: number; migration_json: string | null; concurrency: number };

const globalState = globalThis as typeof globalThis & {
  __tasteHot100Db?: DatabaseSync;
  __tasteHot100Worker?: { owner: string; running: boolean };
  __tasteHot100RecipeIndex?: RecipeLike[];
};

function now() { return new Date().toISOString(); }
function sqlNowOffset(ms: number) { return new Date(Date.now() + ms).toISOString(); }
function hot100Directory(root = dataRoot()) { return join(root, "hot100-imports"); }
function cacheDirectory(root = dataRoot()) { return join(root, "hot100-cache"); }
function databasePath(root = dataRoot()) { return join(root, "hot100.sqlite"); }
function safeKey(song: string, performer: string) { return `${song}\u0000${performer}`.trim().toLowerCase(); }

function database() {
  if (globalState.__tasteHot100Db) return globalState.__tasteHot100Db;
  mkdirSync(dataRoot(), { recursive: true });
  const db = new DatabaseSync(databasePath());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS hot100_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hot100_jobs (
      id TEXT PRIMARY KEY, dataset_key TEXT NOT NULL, commit_sha TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, source_json TEXT NOT NULL,
      total_rows INTEGER NOT NULL, migration_json TEXT, concurrency INTEGER NOT NULL DEFAULT 3,
      UNIQUE(dataset_key, commit_sha)
    );
    CREATE TABLE IF NOT EXISTS hot100_songs (
      job_id TEXT NOT NULL, song_id TEXT NOT NULL, song TEXT NOT NULL, performer TEXT NOT NULL,
      appearances_json TEXT NOT NULL, peak_position INTEGER NOT NULL, first_chart_date TEXT NOT NULL, last_chart_date TEXT NOT NULL,
      status TEXT NOT NULL, previous_status TEXT, retries INTEGER NOT NULL DEFAULT 0, error TEXT,
      match_json TEXT, release_group_id TEXT, recipe_id TEXT, available_at TEXT NOT NULL,
      lease_owner TEXT, lease_until TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(job_id, song_id), FOREIGN KEY(job_id) REFERENCES hot100_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS hot100_song_queue ON hot100_songs(job_id, status, available_at);
    CREATE INDEX IF NOT EXISTS hot100_song_album ON hot100_songs(job_id, release_group_id);
    CREATE TABLE IF NOT EXISTS hot100_albums (
      job_id TEXT NOT NULL, release_group_id TEXT NOT NULL, canonical_song_id TEXT NOT NULL,
      status TEXT NOT NULL, artwork_url TEXT, image_hash TEXT, extension TEXT, recipe_id TEXT,
      error TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(job_id, release_group_id), FOREIGN KEY(job_id) REFERENCES hot100_jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS hot100_lookup_cache (
      lookup_key TEXT PRIMARY KEY, result_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hot100_worker_lease (
      id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, expires_at TEXT NOT NULL
    );
  `);
  globalState.__tasteHot100Db = db;
  return db;
}

function transaction<T>(operation: (db: DatabaseSync) => T) {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(db); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

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

function parseSongs(bytes: Buffer) {
  const text = bytes.toString("utf8"); const lines = text.split("\n");
  const headers = parseRow(lines.shift() || "").map((value) => value.replace(/^\uFEFF/, "").trim());
  if (!["song", "performer", "chart_date", "chart_position"].every((header) => headers.includes(header))) throw new Error("Hot 100 CSV 缺少必需列。");
  const songs = new Map<string, SongEntry>(); let totalRows = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const values = parseRow(line); const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
    const song = row.song?.trim(); const performer = row.performer?.trim(); const chartDate = row.chart_date?.trim(); const position = Number(row.chart_position);
    if (!song || !performer || !chartDate || !Number.isInteger(position) || position < 1) continue;
    totalRows += 1;
    const songId = row.song_id?.trim() || safeKey(song, performer); const key = songId.toLowerCase(); const current = songs.get(key);
    const appearance = { chartDate, position };
    if (current) { current.appearances.push(appearance); current.peakPosition = Math.min(current.peakPosition, position); current.firstChartDate = current.firstChartDate < chartDate ? current.firstChartDate : chartDate; current.lastChartDate = current.lastChartDate > chartDate ? current.lastChartDate : chartDate; }
    else songs.set(key, { songId, song, performer, appearances: [appearance], peakPosition: position, firstChartDate: chartDate, lastChartDate: chartDate });
  }
  return { songs: [...songs.values()], totalRows };
}

async function resolveSnapshot() {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits/main`, { headers: { accept: "application/vnd.github+json", "user-agent": "TasteSkillStudio" }, cache: "no-store" });
  if (!response.ok) throw new Error(`无法锁定 GitHub 数据版本（${response.status}）。`);
  const payload = await response.json() as { sha?: string };
  if (!payload.sha || !/^[a-f0-9]{40}$/i.test(payload.sha)) throw new Error("GitHub 未返回有效 commit SHA。");
  return { commitSha: payload.sha, rawUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/${payload.sha}/${PATH.split("/").map(encodeURIComponent).join("/")}` };
}

async function loadSnapshot(commitSha: string, rawUrl: string) {
  await mkdir(cacheDirectory(), { recursive: true });
  const path = join(cacheDirectory(), `${commitSha}.csv`); let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch {
    const response = await fetch(rawUrl, { headers: { accept: "text/csv", "user-agent": "TasteSkillStudio" }, cache: "no-store" });
    if (!response.ok) throw new Error(`无法下载 Hot 100 CSV（${response.status}）。`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error("Hot 100 CSV 文件无效或超过允许的 100MB 大小限制。");
    const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, bytes); await rename(temporary, path);
  }
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("缓存的 Hot 100 CSV 超过允许的 100MB 大小限制。");
  return { ...parseSongs(bytes), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function legacyStatus(status: string | undefined): SongStatus {
  if (status === "pending" || status === "processing") return "pending_lookup";
  if (["approved", "merged", "unmatched", "no_album", "no_cover", "failed"].includes(status || "")) return status as SongStatus;
  return "pending_lookup";
}

const STATUS_WEIGHT: Record<string, number> = { pending_lookup: 0, looking_up: 0, failed: 1, unmatched: 2, no_album: 2, no_cover: 2, merged: 3, approved: 4 };

function insertSongs(db: DatabaseSync, jobId: string, songs: SongEntry[], migrating = false) {
  const existing = db.prepare("SELECT status FROM hot100_songs WHERE job_id = ? AND song_id = ?");
  const insert = db.prepare(`INSERT INTO hot100_songs
    (job_id,song_id,song,performer,appearances_json,peak_position,first_chart_date,last_chart_date,status,retries,error,match_json,release_group_id,recipe_id,available_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id,song_id) DO UPDATE SET song=excluded.song, performer=excluded.performer,
      appearances_json=CASE WHEN length(excluded.appearances_json)>length(hot100_songs.appearances_json) THEN excluded.appearances_json ELSE hot100_songs.appearances_json END,
      peak_position=min(hot100_songs.peak_position,excluded.peak_position), first_chart_date=min(hot100_songs.first_chart_date,excluded.first_chart_date), last_chart_date=max(hot100_songs.last_chart_date,excluded.last_chart_date),
      status=excluded.status, retries=max(hot100_songs.retries,excluded.retries), error=excluded.error,
      match_json=coalesce(excluded.match_json,hot100_songs.match_json), release_group_id=coalesce(excluded.release_group_id,hot100_songs.release_group_id), recipe_id=coalesce(excluded.recipe_id,hot100_songs.recipe_id), updated_at=excluded.updated_at`);
  const timestamp = now();
  for (const song of songs) {
    let status = legacyStatus(song.status);
    if (migrating) {
      const current = existing.get(jobId, song.songId) as { status?: string } | undefined;
      if (current && (STATUS_WEIGHT[current.status || ""] || 0) > (STATUS_WEIGHT[status] || 0)) status = current.status as SongStatus;
    }
    insert.run(jobId, song.songId, song.song, song.performer, JSON.stringify(song.appearances || []), song.peakPosition, song.firstChartDate, song.lastChartDate, status, song.retries || 0, song.error || null, song.match ? JSON.stringify(song.match) : null, song.canonicalReleaseGroupId || null, song.recipeId || null, timestamp, timestamp);
  }
}

async function recoverFromRecipes(db: DatabaseSync, jobId: string, commitSha: string) {
  const directory = join(dataRoot(), "recipes"); let files: string[] = [];
  try { files = (await readdir(directory)).filter((file) => file.endsWith(".json")); } catch { return 0; }
  const update = db.prepare("UPDATE hot100_songs SET status='approved', recipe_id=?, release_group_id=coalesce(?,release_group_id), error=NULL, updated_at=? WHERE job_id=? AND song_id=?");
  const album = db.prepare(`INSERT INTO hot100_albums(job_id,release_group_id,canonical_song_id,status,artwork_url,recipe_id,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(job_id,release_group_id) DO UPDATE SET status='approved',recipe_id=excluded.recipe_id,artwork_url=coalesce(excluded.artwork_url,hot100_albums.artwork_url),updated_at=excluded.updated_at`);
  let recovered = 0;
  for (const file of files) {
    try {
      const recipe = JSON.parse(await readFile(join(directory, file), "utf8")) as { id?: string; source?: { kind?: string; releaseGroupId?: string; artworkUrl?: string; hot100?: { commitSha?: string; songId?: string } } };
      const source = recipe.source; if (source?.kind !== "hot100_album_cover" || source.hot100?.commitSha !== commitSha || !source.hot100.songId || !recipe.id) continue;
      const timestamp = now(); const result = update.run(recipe.id, source.releaseGroupId || null, timestamp, jobId, source.hot100.songId);
      if (Number(result.changes) > 0) recovered += 1;
      if (source.releaseGroupId) album.run(jobId, source.releaseGroupId, source.hot100.songId, "approved", source.artworkUrl || null, recipe.id, timestamp);
    } catch { /* Preserve unreadable recipes and continue migration. */ }
  }
  return recovered;
}

async function migrateLegacyJobs() {
  const db = database();
  if (db.prepare("SELECT value FROM hot100_meta WHERE key='legacy_migration_v1'").get()) return;
  let files: string[] = [];
  try { files = (await readdir(hot100Directory())).filter((file) => file.endsWith(".json")); } catch { files = []; }
  const readable: LegacyJob[] = []; const failures: string[] = [];
  for (const file of files) {
    try { readable.push(JSON.parse(await readFile(join(hot100Directory(), file), "utf8")) as LegacyJob); }
    catch { failures.push(file); }
  }
  const groups = new Map<string, LegacyJob[]>();
  for (const job of readable) { const key = job.sourceSnapshot?.commitSha; if (!key || !Array.isArray(job.songs)) continue; groups.set(key, [...(groups.get(key) || []), job]); }
  for (const [commitSha, jobs] of groups) {
    jobs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)); const primary = jobs[jobs.length - 1];
    const jobId = primary.id || randomUUID(); const migration = { importedFiles: jobs.length, unreadableFiles: failures, recoveredRecipes: 0 };
    transaction((tx) => {
      tx.prepare(`INSERT INTO hot100_jobs(id,dataset_key,commit_sha,status,created_at,updated_at,started_at,source_json,total_rows,migration_json,concurrency)
        VALUES(?,?,?,?,?,?,?,?,?,?,3) ON CONFLICT(dataset_key,commit_sha) DO NOTHING`).run(jobId, DATASET_KEY, commitSha, primary.status === "running" ? "running" : primary.status || "ready", jobs[0].createdAt, primary.updatedAt, primary.status === "running" ? primary.createdAt : null, JSON.stringify(primary.sourceSnapshot), primary.totalRows, JSON.stringify(migration));
      const stored = tx.prepare("SELECT id FROM hot100_jobs WHERE dataset_key=? AND commit_sha=?").get(DATASET_KEY, commitSha) as { id: string };
      for (const job of jobs) {
        insertSongs(tx, stored.id, job.songs, true);
        const albumInsert = tx.prepare(`INSERT INTO hot100_albums(job_id,release_group_id,canonical_song_id,status,artwork_url,recipe_id,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(job_id,release_group_id) DO UPDATE SET status=excluded.status,artwork_url=excluded.artwork_url,recipe_id=coalesce(excluded.recipe_id,hot100_albums.recipe_id),updated_at=excluded.updated_at`);
        for (const value of Object.values(job.albums || {})) albumInsert.run(stored.id, value.releaseGroupId, value.canonicalSongId, value.status, value.artworkUrl, value.recipeId || null, job.updatedAt);
      }
    });
    const stored = db.prepare("SELECT id FROM hot100_jobs WHERE dataset_key=? AND commit_sha=?").get(DATASET_KEY, commitSha) as { id: string };
    migration.recoveredRecipes = await recoverFromRecipes(db, stored.id, commitSha);
    db.prepare("UPDATE hot100_jobs SET migration_json=? WHERE id=?").run(JSON.stringify(migration), stored.id);
  }
  db.prepare("INSERT OR REPLACE INTO hot100_meta(key,value) VALUES('legacy_migration_v1',?)").run(JSON.stringify({ completedAt: now(), readable: readable.length, unreadable: failures }));
}

let initialization: Promise<void> | undefined;
async function initialize() { if (!initialization) initialization = migrateLegacyJobs(); await initialization; }

export async function createHot100Job() {
  await initialize(); const snapshot = await resolveSnapshot(); const db = database();
  const existing = db.prepare("SELECT id FROM hot100_jobs WHERE dataset_key=? AND commit_sha=?").get(DATASET_KEY, snapshot.commitSha) as { id: string } | undefined;
  if (existing) {
    const job = await readHot100Job(existing.id);
    if (!job) throw new Error("已存在的数据任务无法读取。");
    return job;
  }
  const parsed = await loadSnapshot(snapshot.commitSha, snapshot.rawUrl); const id = randomUUID(); const timestamp = now();
  const source: SourceSnapshot = { owner: OWNER, repo: REPO, path: PATH, commitSha: snapshot.commitSha, rawUrl: snapshot.rawUrl, sha256: parsed.sha256, fetchedAt: timestamp, bytes: parsed.bytes, licenseNotice: "Source repository does not declare a license in its README; use is at the operator's risk." };
  transaction((tx) => {
    tx.prepare("INSERT INTO hot100_jobs(id,dataset_key,commit_sha,status,created_at,updated_at,source_json,total_rows,concurrency) VALUES(?,?,?,?,?,?,?,?,3)").run(id, DATASET_KEY, snapshot.commitSha, "ready", timestamp, timestamp, JSON.stringify(source), parsed.totalRows);
    insertSongs(tx, id, parsed.songs);
  });
  const job = await readHot100Job(id);
  if (!job) throw new Error("任务创建后无法读取。");
  return job;
}

export async function readHot100Job(id: string) {
  await initialize(); if (!/^[a-f0-9-]{36}$/i.test(id)) return undefined;
  return database().prepare("SELECT * FROM hot100_jobs WHERE id=?").get(id) as JobRow | undefined;
}

export async function currentHot100Job() {
  await initialize();
  return database().prepare("SELECT * FROM hot100_jobs ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'ready' THEN 2 ELSE 3 END, updated_at DESC LIMIT 1").get() as JobRow | undefined;
}

export function hot100Summary(job: JobRow) {
  const db = database(); const sourceSnapshot = JSON.parse(job.source_json) as SourceSnapshot;
  const grouped = db.prepare("SELECT status, count(*) count FROM hot100_songs WHERE job_id=? GROUP BY status").all(job.id) as Array<{ status: SongStatus; count: number }>;
  const counts: Record<string, number> = { pending_lookup: 0, looking_up: 0, pending_cover: 0, downloading: 0, pending_analysis: 0, analyzing: 0, approved: 0, merged: 0, unmatched: 0, no_album: 0, no_cover: 0, failed: 0 };
  for (const row of grouped) counts[row.status] = Number(row.count);
  counts.pending = counts.pending_lookup + counts.looking_up + counts.pending_cover + counts.downloading + counts.pending_analysis + counts.analyzing;
  counts.processing = counts.looking_up + counts.downloading + counts.analyzing;
  const uniqueSongs = Object.values(counts).slice(0, 12).reduce((sum, count) => sum + count, 0);
  const terminal = counts.approved + counts.merged + counts.unmatched + counts.no_album + counts.no_cover + counts.failed;
  const elapsedMinutes = job.started_at ? Math.max((Date.now() - Date.parse(job.started_at)) / 60_000, 1 / 60) : 0;
  const processedPerMinute = elapsedMinutes ? terminal / elapsedMinutes : 0;
  const etaSeconds = processedPerMinute > 0 ? Math.round((counts.pending / processedPerMinute) * 60) : null;
  const low = db.prepare("SELECT count(*) count FROM hot100_songs WHERE job_id=? AND json_extract(match_json,'$.verificationNeeded')=1").get(job.id) as { count: number };
  const albums = db.prepare("SELECT count(*) count FROM hot100_albums WHERE job_id=?").get(job.id) as { count: number };
  const recent = db.prepare("SELECT song_id,song,performer,status,error,recipe_id FROM hot100_songs WHERE job_id=? AND status!='pending_lookup' ORDER BY updated_at DESC LIMIT 12").all(job.id) as Array<Record<string, string | null>>;
  const active = db.prepare(`SELECT count(*) count FROM hot100_songs songs
    JOIN hot100_worker_lease worker ON worker.owner=songs.lease_owner
    WHERE songs.job_id=? AND songs.status IN ('looking_up','downloading','analyzing')
      AND songs.lease_until>? AND worker.expires_at>?`).get(job.id, now(), now()) as { count: number };
  return { id: job.id, status: job.status, createdAt: job.created_at, updatedAt: job.updated_at, sourceSnapshot, totalRows: job.total_rows, uniqueSongs, uniqueAlbums: Number(albums.count), counts, lowConfidence: Number(low.count), processedPerMinute: Number(processedPerMinute.toFixed(2)), etaSeconds, concurrency: job.concurrency, activeConcurrency: Number(active.count), maxConcurrency: MAX_HOT100_CONCURRENCY, migration: job.migration_json ? JSON.parse(job.migration_json) : undefined, recent: recent.map((item) => ({ songId: item.song_id, song: item.song, performer: item.performer, status: item.status, error: item.error || undefined, recipeId: item.recipe_id || undefined })) };
}

function requiredVision(vision?: VisionConfig): Required<VisionConfig> | undefined {
  const apiKey = vision?.apiKey === "env-configured" ? process.env.VISION_API_KEY : vision?.apiKey || process.env.VISION_API_KEY;
  const endpoint = vision?.endpoint || process.env.VISION_ENDPOINT; const model = vision?.model || process.env.VISION_MODEL;
  return apiKey && endpoint && model ? { apiKey, endpoint, model } : undefined;
}

async function recipeIndex() {
  if (!globalState.__tasteHot100RecipeIndex) globalState.__tasteHot100RecipeIndex = await readSkills(dataRoot(), "all") as RecipeLike[];
  return globalState.__tasteHot100RecipeIndex;
}

async function analyzeAndApprove({ hash, extension, filename, source, vision }: { hash: string; extension: string; filename: string; source: Record<string, unknown>; vision: Required<VisionConfig> }) {
  const root = dataRoot(); const image = await readFile(join(root, "uploads", "default", `${hash}.${extension}`)); const mime = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  const callModel = async (strict = false) => fetch(`${vision.endpoint.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${vision.apiKey}` }, body: JSON.stringify({ model: vision.model, temperature: strict ? 0 : 0.3, response_format: { type: "json_object" }, messages: [{ role: "system", content: strict ? `${imageRecipePrompt} This is a strict retry. Return JSON only.` : imageRecipePrompt }, { role: "user", content: [{ type: "text", text: "Create one independent English visual recipe for this image." }, { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } }] }] }) });
  let response = await callModel(); if (!response.ok) throw new Error(`模型请求失败（HTTP ${response.status}）。`);
  let payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }; let recipe: RecipeLike["recipe"];
  try { recipe = parseValidRecipe(payload.choices?.[0]?.message?.content); } catch { response = await callModel(true); if (!response.ok) throw new Error(`模型重试失败（HTTP ${response.status}）。`); payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }; recipe = parseValidRecipe(payload.choices?.[0]?.message?.content); }
  const existing = await recipeIndex(); const duplicateCandidates = findDuplicateCandidates(recipe, existing); const timestamp = now();
  const recipeData = recipe as NonNullable<RecipeLike["recipe"]> & { metadata?: { title?: string; category?: string; medium?: string[]; useCases?: string[]; retrievalTags?: string[] }; typographyAndGraphicLanguage?: Parameters<typeof typographyText>[0] };
  const metadata = recipeData.metadata || {}; const typographySearchText = typographyText(recipeData.typographyAndGraphicLanguage);
  const stored = { id: hash, libraryType: "photo", status: "approved", providerModel: vision.model, createdAt: timestamp, approvedAt: timestamp, recipeSchemaVersion: "1.1", typographySchemaVersion: TYPOGRAPHY_SCHEMA_VERSION, typographyStatus: "ready", typographyModel: vision.model, typographyUpdatedAt: timestamp, embeddingStatus: "missing", indexStatus: "keyword_only", source: { kind: "hot100_album_cover", filename, hash, ...source }, dedupeText: dedupeText(recipe), duplicateCandidates, duplicateDecision: "keep_independent", recipe };
  const search = { id: hash, libraryType: "photo", title: metadata.title || "Untitled visual recipe", category: metadata.category || "Uncategorized", medium: metadata.medium || [], useCases: metadata.useCases || [], tags: metadata.retrievalTags || [], coreRelationships: recipeData.coreVisualRelationships || [], reuseFormula: recipeData.reuseFormula || "", typographyText: typographySearchText, searchText: [metadata.title, metadata.category, ...(metadata.medium || []), ...(metadata.useCases || []), ...(metadata.retrievalTags || []), ...(recipeData.coreVisualRelationships || []), recipeData.reuseFormula, typographySearchText].filter(Boolean).join(" · "), zhAliases: { title: metadata.title || "", useCases: [], tags: [], searchText: "" }, qualityScore: 0.8, specificityScore: 0.8, approved: true, languages: ["en", "zh-CN"], embeddingStatus: "missing", typographyStatus: "ready", typographySchemaVersion: TYPOGRAPHY_SCHEMA_VERSION, recipeSchemaVersion: "1.1", searchSchemaVersion: "1.1" };
  await mkdir(join(root, "recipes"), { recursive: true }); await mkdir(join(root, "search-documents"), { recursive: true });
  await Promise.all([writeFile(join(root, "recipes", `${hash}.json`), JSON.stringify(stored, null, 2)), writeFile(join(root, "search-documents", `${hash}.json`), JSON.stringify(search, null, 2))]);
  existing.push(stored as unknown as RecipeLike); return hash;
}

function acquireWorkerLease(owner: string) {
  return transaction((db) => {
    const current = db.prepare("SELECT owner,expires_at FROM hot100_worker_lease WHERE id=1").get() as { owner: string; expires_at: string } | undefined;
    if (current && current.owner !== owner && current.expires_at > now()) return false;
    db.prepare("INSERT INTO hot100_worker_lease(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at").run(owner, sqlNowOffset(LEASE_MS));
    if (current && current.owner !== owner) {
      db.prepare(`UPDATE hot100_songs SET status=coalesce(previous_status,'pending_lookup'),previous_status=NULL,lease_owner=NULL,lease_until=NULL,available_at=?,updated_at=? WHERE lease_owner=? AND status IN ('looking_up','downloading','analyzing')`).run(now(), now(), current.owner);
    }
    return true;
  });
}

function renewWorkerLease(owner: string) { database().prepare("UPDATE hot100_worker_lease SET expires_at=? WHERE id=1 AND owner=?").run(sqlNowOffset(LEASE_MS), owner); }

function claimSong(jobId: string, owner: string): SongRow | undefined {
  return transaction((db) => {
    const row = db.prepare(`SELECT * FROM hot100_songs WHERE job_id=? AND status IN ('pending_lookup','pending_cover','pending_analysis') AND available_at<=? ORDER BY CASE status WHEN 'pending_analysis' THEN 0 WHEN 'pending_cover' THEN 1 ELSE 2 END,rowid LIMIT 1`).get(jobId, now()) as SongRow | undefined;
    if (!row) return undefined;
    const next = row.status === "pending_lookup" ? "looking_up" : row.status === "pending_cover" ? "downloading" : "analyzing";
    db.prepare("UPDATE hot100_songs SET previous_status=status,status=?,lease_owner=?,lease_until=?,updated_at=? WHERE job_id=? AND song_id=?").run(next, owner, sqlNowOffset(LEASE_MS * 10), now(), jobId, row.song_id);
    return { ...row, previous_status: row.status, status: next } as SongRow;
  });
}

function finishSong(row: SongRow, status: SongStatus, fields: { error?: string | null; match?: Record<string, unknown>; releaseGroupId?: string; recipeId?: string; delayMs?: number } = {}) {
  database().prepare(`UPDATE hot100_songs SET status=?,previous_status=NULL,error=?,match_json=coalesce(?,match_json),release_group_id=coalesce(?,release_group_id),recipe_id=coalesce(?,recipe_id),available_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE job_id=? AND song_id=?`).run(status, fields.error ?? null, fields.match ? JSON.stringify(fields.match) : null, fields.releaseGroupId || null, fields.recipeId || null, sqlNowOffset(fields.delayMs || 0), now(), row.job_id, row.song_id);
}

function failSong(row: SongRow, error: unknown) {
  database().prepare("UPDATE hot100_songs SET status='failed',previous_status=?,retries=retries+1,error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE job_id=? AND song_id=?").run(row.previous_status || "pending_lookup", error instanceof Error ? error.message.slice(0, 300) : "未知处理失败。", now(), row.job_id, row.song_id);
}

async function processClaim(row: SongRow, vision: Required<VisionConfig>) {
  const db = database();
  try {
    if (row.status === "looking_up") {
      const lookupKey = safeKey(row.song, row.performer);
      const cached = db.prepare("SELECT result_json FROM hot100_lookup_cache WHERE lookup_key=?").get(lookupKey) as { result_json: string } | undefined;
      const cachedResult = cached ? JSON.parse(cached.result_json) as { found: boolean; match?: Awaited<ReturnType<typeof findOriginalAlbumForRecording>> } : undefined;
      const match = cachedResult ? cachedResult.match : await findOriginalAlbumForRecording(row.song, row.performer);
      if (!cachedResult) db.prepare("INSERT OR REPLACE INTO hot100_lookup_cache(lookup_key,result_json,updated_at) VALUES(?,?,?)").run(lookupKey, JSON.stringify({ found: Boolean(match), match }), now());
      if (!match) { finishSong(row, "unmatched"); return; }
      const matchData = { recordingId: match.recordingId, recordingScore: match.recordingScore, releaseId: "releaseId" in match ? match.releaseId : undefined, releaseGroupId: "releaseGroupId" in match ? match.releaseGroupId : undefined, releaseDate: "releaseDate" in match ? match.releaseDate : undefined, albumTitle: "albumTitle" in match ? match.albumTitle : undefined, verificationNeeded: match.recordingScore < 100, lookupVersion: 3 };
      if (match.noAlbum || !("releaseGroupId" in match) || !match.releaseGroupId) { finishSong(row, "no_album", { match: matchData }); return; }
      db.prepare(`INSERT INTO hot100_albums(job_id,release_group_id,canonical_song_id,status,artwork_url,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,release_group_id) DO NOTHING`).run(row.job_id, match.releaseGroupId, row.song_id, "pending_cover", coverArtUrl(match.releaseGroupId), now());
      finishSong(row, "pending_cover", { match: matchData, releaseGroupId: match.releaseGroupId }); return;
    }
    const releaseGroupId = row.release_group_id; if (!releaseGroupId) throw new Error("歌曲缺少 release group，无法继续。");
    const album = db.prepare("SELECT * FROM hot100_albums WHERE job_id=? AND release_group_id=?").get(row.job_id, releaseGroupId) as Record<string, string | null> | undefined;
    if (!album) { finishSong(row, "pending_cover", { delayMs: 1_000 }); return; }
    if (album.recipe_id) { finishSong(row, album.canonical_song_id === row.song_id ? "approved" : "merged", { recipeId: album.recipe_id }); return; }
    if (album.status === "no_cover") { finishSong(row, "no_cover"); return; }
    if (album.canonical_song_id !== row.song_id) { finishSong(row, "pending_cover", { delayMs: 2_000 }); return; }
    if (row.status === "downloading") {
      if (album.image_hash && album.extension) { finishSong(row, "pending_analysis"); return; }
      const artwork = album.artwork_url || coverArtUrl(releaseGroupId); const response = await fetch(artwork, { headers: { accept: "image/jpeg,image/png,image/webp" } });
      if (!response.ok) { db.prepare("UPDATE hot100_albums SET status='no_cover',error=?,updated_at=? WHERE job_id=? AND release_group_id=?").run(`HTTP ${response.status}`, now(), row.job_id, releaseGroupId); finishSong(row, "no_cover"); return; }
      const extension = ALLOWED_MIME.get(response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() || ""); if (!extension) throw new Error("CAA 返回了不受支持的封面格式。");
      const bytes = Buffer.from(await response.arrayBuffer()); if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("CAA 封面文件无效或超过 20MB。");
      const hash = createHash("sha256").update(bytes).digest("hex"); const directory = join(dataRoot(), "uploads", "default"); const path = join(directory, `${hash}.${extension}`); await mkdir(directory, { recursive: true });
      try { await access(path); } catch { await writeFile(path, bytes); }
      db.prepare("UPDATE hot100_albums SET status='pending_analysis',image_hash=?,extension=?,updated_at=? WHERE job_id=? AND release_group_id=?").run(hash, extension, now(), row.job_id, releaseGroupId);
      finishSong(row, "pending_analysis"); return;
    }
    if (!album.image_hash || !album.extension) { finishSong(row, "pending_cover"); return; }
    const recipePath = join(dataRoot(), "recipes", `${album.image_hash}.json`); let recipeId = album.image_hash;
    if (!existsSync(recipePath)) {
      const match = row.match_json ? JSON.parse(row.match_json) as Record<string, unknown> : {};
      const job = db.prepare("SELECT source_json FROM hot100_jobs WHERE id=?").get(row.job_id) as { source_json: string }; const sourceSnapshot = JSON.parse(job.source_json) as SourceSnapshot;
      recipeId = await analyzeAndApprove({ hash: album.image_hash, extension: album.extension, filename: `${String(match.albumTitle || row.song)}.${album.extension}`, source: { provider: "musicbrainz-caa", albumTitle: match.albumTitle || row.song, artist: row.performer, artworkUrl: album.artwork_url, sourceUrl: `https://musicbrainz.org/release-group/${releaseGroupId}`, releaseGroupId, recordingId: match.recordingId, hot100: { repository: `${OWNER}/${REPO}`, commitSha: sourceSnapshot.commitSha, path: PATH, songId: row.song_id, song: row.song, performer: row.performer, peakPosition: row.peak_position, firstChartDate: row.first_chart_date, lastChartDate: row.last_chart_date, appearances: JSON.parse(row.appearances_json) } }, vision });
    }
    transaction((tx) => {
      tx.prepare("UPDATE hot100_albums SET status='approved',recipe_id=?,error=NULL,updated_at=? WHERE job_id=? AND release_group_id=?").run(recipeId, now(), row.job_id, releaseGroupId);
      tx.prepare("UPDATE hot100_songs SET status=CASE WHEN song_id=? THEN 'approved' ELSE 'merged' END,recipe_id=?,error=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE job_id=? AND release_group_id=? AND status NOT IN ('approved','merged')").run(row.song_id, recipeId, now(), row.job_id, releaseGroupId);
    });
  } catch (error) { failSong(row, error); }
}

function updateJobCompletion(jobId: string) {
  const db = database(); const remaining = db.prepare("SELECT count(*) count FROM hot100_songs WHERE job_id=? AND status IN ('pending_lookup','looking_up','pending_cover','downloading','pending_analysis','analyzing')").get(jobId) as { count: number };
  if (!Number(remaining.count)) db.prepare("UPDATE hot100_jobs SET status='completed',updated_at=? WHERE id=? AND status='running'").run(now(), jobId);
  else db.prepare("UPDATE hot100_jobs SET updated_at=? WHERE id=?").run(now(), jobId);
}

async function workerLoop(owner: string) {
  while (globalState.__tasteHot100Worker?.running) {
    if (!acquireWorkerLease(owner)) { await new Promise((resolve) => setTimeout(resolve, 2_000)); continue; }
    renewWorkerLease(owner);
    const job = database().prepare("SELECT * FROM hot100_jobs WHERE status='running' ORDER BY updated_at DESC LIMIT 1").get() as JobRow | undefined;
    const vision = requiredVision();
    if (!job || !vision) { await new Promise((resolve) => setTimeout(resolve, 2_000)); continue; }
    const claims = Array.from({ length: Math.max(1, Math.min(job.concurrency, MAX_HOT100_CONCURRENCY)) }, () => claimSong(job.id, owner)).filter((row): row is SongRow => Boolean(row));
    if (!claims.length) { updateJobCompletion(job.id); await new Promise((resolve) => setTimeout(resolve, IDLE_MS)); continue; }
    const heartbeat = setInterval(() => { try { renewWorkerLease(owner); } catch { /* The next loop will reacquire the lease. */ } }, Math.floor(LEASE_MS / 3));
    try { await Promise.all(claims.map((row) => processClaim(row, vision))); }
    finally { clearInterval(heartbeat); }
    updateJobCompletion(job.id);
  }
}

export async function ensureHot100Worker() {
  await initialize();
  if (globalState.__tasteHot100Worker?.running) return;
  const state = { owner: `${process.pid}:${randomUUID()}`, running: true }; globalState.__tasteHot100Worker = state;
  void workerLoop(state.owner).catch(() => { if (globalState.__tasteHot100Worker?.owner === state.owner) globalState.__tasteHot100Worker.running = false; });
}

export async function runHot100Job(id: string, vision?: VisionConfig, retryFailed = false, concurrency?: number) {
  await initialize(); const db = database(); const job = db.prepare("SELECT * FROM hot100_jobs WHERE id=?").get(id) as JobRow | undefined; if (!job) throw new Error("找不到 Hot 100 导入任务。");
  if (!requiredVision(vision)) throw new Error("请先配置视觉模型，才能自动分析并批准封面。");
  if (retryFailed) db.prepare(`UPDATE hot100_songs SET status=CASE previous_status WHEN 'pending_cover' THEN 'pending_cover' WHEN 'pending_analysis' THEN 'pending_analysis' ELSE 'pending_lookup' END,error=NULL,available_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE job_id=? AND status='failed'`).run(now(), now(), id);
  const value = Math.max(1, Math.min(Number(concurrency) || job.concurrency || 3, MAX_HOT100_CONCURRENCY));
  db.prepare("UPDATE hot100_jobs SET status='running',started_at=coalesce(started_at,?),updated_at=?,concurrency=? WHERE id=?").run(now(), now(), value, id);
  await ensureHot100Worker(); return db.prepare("SELECT * FROM hot100_jobs WHERE id=?").get(id) as JobRow;
}

export async function updateHot100Job(id: string, action: "pause" | "resume" | "configure", concurrency?: number) {
  await initialize(); const db = database(); const current = db.prepare("SELECT * FROM hot100_jobs WHERE id=?").get(id) as JobRow | undefined; if (!current) throw new Error("找不到 Hot 100 导入任务。");
  const value = Math.max(1, Math.min(Number(concurrency) || current.concurrency || 3, MAX_HOT100_CONCURRENCY));
  const status = action === "pause" ? "paused" : action === "resume" ? "running" : current.status;
  db.prepare("UPDATE hot100_jobs SET status=?,concurrency=?,updated_at=? WHERE id=?").run(status, value, now(), id);
  if (status === "running") await ensureHot100Worker(); return db.prepare("SELECT * FROM hot100_jobs WHERE id=?").get(id) as JobRow;
}
