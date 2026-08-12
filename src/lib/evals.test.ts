import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_MAX_CONCURRENCY, EVAL_MAX_RETRIES, evalConcurrency, evalTextInstruction, evalTextSuggestion, isEvalRetryDue, scheduleEvalRetry, type EvalCaseRun } from "./evals";
import { GenerationTransientError, isGenerationTransientError, resolveGeneratedImage, validateRaster } from "./image-generation";
import { IMAGE_GENERATION_DEFAULTS, templateForFalModel, validateImageGenerationSettings, visibleImageGenerationSettings } from "./image-generation-settings";
import { buildEligibleSkillPool, keywordScore, rankSkillPool, retrieveSkills } from "./retrieval";
import { migrateRetrievalProfiles } from "./retrieval-profile-migration";
import { retrievalProfileForRecipe, writeActiveSkillVersions } from "./skill-governance";

test("fal presets use the model-specific reference image field", () => {
  const kontext = JSON.parse(templateForFalModel("fal-ai/flux-pro/kontext", "png") || "{}") as Record<string, unknown>;
  const flux2 = JSON.parse(templateForFalModel("fal-ai/flux-2/edit", "webp") || "{}") as Record<string, unknown>;
  assert.equal(kontext.image_url, "{{image_url}}");
  assert.deepEqual(flux2.image_urls, ["{{image_url}}"]);
  assert.equal(flux2.output_format, "webp");
});

test("Seedream 4.5, Nano Banana, and GPT Image 2 presets match fal schemas", () => {
  const seedream = JSON.parse(templateForFalModel("fal-ai/bytedance/seedream/v4.5/edit", "webp") || "{}") as Record<string, unknown>;
  const nanoBanana = JSON.parse(templateForFalModel("fal-ai/nano-banana/edit", "jpeg") || "{}") as Record<string, unknown>;
  const gptImage = JSON.parse(templateForFalModel("openai/gpt-image-2/edit", "png") || "{}") as Record<string, unknown>;
  assert.deepEqual(seedream.image_urls, ["{{image_url}}"]);
  assert.equal(seedream.image_size, "auto_2K");
  assert.equal(seedream.output_format, undefined);
  assert.deepEqual(nanoBanana.image_urls, ["{{image_url}}"]);
  assert.equal(nanoBanana.aspect_ratio, "auto");
  assert.equal(nanoBanana.limit_generations, true);
  assert.equal(nanoBanana.output_format, "jpeg");
  assert.deepEqual(gptImage.image_urls, ["{{image_url}}"]);
  assert.equal(gptImage.image_size, "auto");
  assert.equal(gptImage.quality, "high");
  assert.equal(gptImage.output_format, "png");
});

test("custom fal templates reject unsupported or missing placeholders", () => {
  const base = { ...IMAGE_GENERATION_DEFAULTS, provider: "fal" as const, endpoint: "https://queue.fal.run", apiKey: "secret", model: "owner/model" };
  assert.throws(() => validateImageGenerationSettings({ ...base, falInputTemplate: JSON.stringify({ prompt: "{{prompt}}", file: "{{unsafe}}" }) }), /只允许/);
  assert.throws(() => validateImageGenerationSettings({ ...base, falInputTemplate: JSON.stringify({ prompt: "{{prompt}}" }) }), /参考图占位符/);
  assert.doesNotThrow(() => validateImageGenerationSettings({ ...base, falInputTemplate: JSON.stringify({ prompt: "{{prompt}}", image_url: "{{image_url}}" }) }));
});

test("visible image generation settings never expose the API key", () => {
  const previousProvider = process.env.IMAGE_GENERATION_PROVIDER;
  const previousKey = process.env.IMAGE_GENERATION_API_KEY;
  process.env.IMAGE_GENERATION_PROVIDER = "openrouter";
  process.env.IMAGE_GENERATION_API_KEY = "sk-private-value";
  assert.equal(visibleImageGenerationSettings().apiKey, "env-configured");
  if (previousProvider === undefined) delete process.env.IMAGE_GENERATION_PROVIDER; else process.env.IMAGE_GENERATION_PROVIDER = previousProvider;
  if (previousKey === undefined) delete process.env.IMAGE_GENERATION_API_KEY; else process.env.IMAGE_GENERATION_API_KEY = previousKey;
});

test("raster validation accepts PNG magic and rejects disguised text", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  assert.deepEqual(validateRaster(png), { mime: "image/png", extension: "png" });
  assert.throws(() => validateRaster(Buffer.from("not an image")), /不是有效/);
});

test("generated image downloads require HTTPS", async () => {
  await assert.rejects(() => resolveGeneratedImage({ state: "completed", imageUrl: "http://127.0.0.1/private.png" }), /HTTPS/);
});

test("transient generation errors include network failures and temporary HTTP responses", async () => {
  assert.equal(isGenerationTransientError(new TypeError("fetch failed")), true);
  assert.equal(isGenerationTransientError(new GenerationTransientError("rate limited", 429)), true);
  assert.equal(isGenerationTransientError(new Error("invalid API key")), false);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(() => resolveGeneratedImage({ state: "completed", imageUrl: "https://example.com/image.png" }), GenerationTransientError);
  globalThis.fetch = originalFetch;
});

test("Eval text suggestions keep meaningful short copy and fall back safely", () => {
  assert.deepEqual(evalTextSuggestion({ evalTextSuggestion: { language: "en", copy: "Night Drive" } }), { language: "en", copy: "Night Drive" });
  assert.deepEqual(evalTextSuggestion({ evalTextSuggestion: { language: "zh", copy: "月光街景" } }), { language: "zh", copy: "月光街景" });
  assert.deepEqual(evalTextSuggestion({ evalTextSuggestion: { language: "en", copy: "ZXQ-77 $$$" }, metadata: { title: "Quiet Harbor" } }), { language: "en", copy: "Quiet Harbor" });
  assert.deepEqual(evalTextSuggestion({ evalTextSuggestion: { language: "zh", copy: "too short" } }), { language: "en", copy: "Visual Story" });
});

test("Eval text instructions allow only the suggested copy", () => {
  const instruction = evalTextInstruction({ evalTextSuggestion: { language: "en", copy: "Night Drive" } });
  assert.match(instruction, /"Night Drive"/);
  assert.match(instruction, /Do not add any other readable words/);
  assert.match(instruction, /Do not substitute or misspell/);
});

test("Eval concurrency stays within the supported range", () => {
  assert.equal(evalConcurrency(undefined), 3);
  assert.equal(evalConcurrency(0), 1);
  assert.equal(evalConcurrency(5.6), 6);
  assert.equal(evalConcurrency(99), EVAL_MAX_CONCURRENCY);
});

test("Eval transient failures persist a three-attempt backoff schedule", () => {
  const item = { caseId: "case", filename: "case.png", stage: "pending_generation", timings: {} } as EvalCaseRun;
  const error = new GenerationTransientError("fetch failed");
  assert.equal(scheduleEvalRetry(item, error, 100), true);
  assert.equal(item.nextRetryAt, new Date(1100).toISOString());
  assert.equal(isEvalRetryDue(item, 1099), false);
  assert.equal(isEvalRetryDue(item, 1100), true);
  assert.equal(scheduleEvalRetry(item, error, 1100), true);
  assert.equal(item.nextRetryAt, new Date(4100).toISOString());
  assert.equal(scheduleEvalRetry(item, error, 4100), true);
  assert.equal(item.retryCount, EVAL_MAX_RETRIES);
  assert.equal(scheduleEvalRetry(item, error, 13100), false);
});

test("keyword scoring remains deterministic", () => {
  assert.equal(keywordScore("warm poster", "warm editorial poster with warm colors"), 0.75);
  assert.equal(keywordScore("", "anything"), 0);
});

const minimalRecipe = (title: string, tag: string) => ({ metadata: { title, category: "poster", medium: ["digital"], useCases: ["campaign poster"], retrievalTags: [tag] }, retrievalProfile: { description: `${title} for ${tag} campaign posters`, triggerTerms: [tag], excludeWhen: ["quiet minimal layouts"], reviewStatus: "reviewed" }, visualDefinition: `${tag} visual language`, coreVisualRelationships: ["one", "two", "three"], coreInvariants: ["contrast"], reuseFormula: `${tag} formula`, aestheticFloor: { avoid: ["quiet minimal layouts"] } });
const writeSkillFixture = async (root: string, record: Record<string, unknown>, search = true) => {
  const library = record.libraryType === "imported_skill" ? "imported-skills" : "recipes";
  await mkdir(join(root, library), { recursive: true }); await writeFile(join(root, library, `${record.id}.json`), JSON.stringify(record));
  if (search) { const recipe = record.recipe as ReturnType<typeof minimalRecipe>; const profile = retrievalProfileForRecipe(recipe); await mkdir(join(root, "search-documents"), { recursive: true }); await writeFile(join(root, "search-documents", `${record.id}.json`), JSON.stringify({ id: record.id, skillId: record.skillId, versionId: record.versionId, version: record.version, libraryType: record.libraryType || "photo", title: recipe.metadata.title, category: recipe.metadata.category, tags: recipe.metadata.retrievalTags, retrievalProfile: profile, searchText: [profile.description, ...profile.triggerTerms].join(" · "), approved: record.status === "approved" })); }
};

test("approval and active-version gates run before Top-K", async () => {
  const root = await mkdtemp(join(tmpdir(), "taste-retrieval-"));
  try {
    const approvedId = "a".repeat(64); const pendingId = "b".repeat(64);
    await writeSkillFixture(root, { id: approvedId, skillId: approvedId, versionId: approvedId, version: 1, libraryType: "photo", status: "approved", createdAt: new Date(0).toISOString(), recipe: minimalRecipe("Approved", "warm") });
    await writeSkillFixture(root, { id: pendingId, skillId: pendingId, versionId: pendingId, version: 1, libraryType: "photo", status: "needs_review", createdAt: new Date(0).toISOString(), recipe: minimalRecipe("Pending", "explosive explosive explosive") });
    const result = await retrieveSkills({ root, query: "explosive warm", topK: 1 });
    assert.equal(result.results[0]?.id, approvedId);
    assert.equal(result.diagnostics.eligible, 1);
    assert.ok(result.diagnostics.rejected.some((item) => item.versionId === pendingId && item.reason === "pending"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("active version mismatch is diagnosed and cannot enter ranking", async () => {
  const root = await mkdtemp(join(tmpdir(), "taste-version-"));
  try {
    const oldId = "c".repeat(64); const nextId = "d".repeat(64); const skillId = "e".repeat(64);
    await writeSkillFixture(root, { id: oldId, skillId, versionId: oldId, version: 1, libraryType: "photo", status: "approved", createdAt: new Date(0).toISOString(), recipe: minimalRecipe("Old", "stable") });
    await writeSkillFixture(root, { id: nextId, skillId, versionId: nextId, version: 2, libraryType: "photo", status: "approved", createdAt: new Date(1).toISOString(), recipe: minimalRecipe("Unswitched", "new") });
    await writeActiveSkillVersions(root, { [skillId]: oldId });
    const pool = await buildEligibleSkillPool({ root });
    assert.deepEqual(pool.candidates.map((item) => item.card.versionId), [oldId]);
    assert.ok(pool.diagnostics.rejected.some((item) => item.versionId === nextId && item.reason === "version_mismatch"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("eligibility diagnostics distinguish lifecycle and index rejection reasons", async () => {
  const root = await mkdtemp(join(tmpdir(), "taste-diagnostics-"));
  try {
    const pending = "3".repeat(64); const rejected = "4".repeat(64); const superseded = "5".repeat(64); const orphan = "6".repeat(64); const excluded = "7".repeat(64); const wrongLibrary = "8".repeat(64);
    await writeSkillFixture(root, { id: pending, skillId: pending, versionId: pending, version: 1, status: "needs_review", createdAt: new Date(0).toISOString(), recipe: minimalRecipe("Pending", "pending") });
    await writeSkillFixture(root, { id: rejected, skillId: rejected, versionId: rejected, version: 1, status: "rejected", createdAt: new Date(0).toISOString(), recipe: minimalRecipe("Rejected", "rejected") });
    await writeSkillFixture(root, { id: superseded, skillId: superseded, versionId: superseded, version: 1, status: "superseded", createdAt: new Date(0).toISOString(), recipe: minimalRecipe("Superseded", "old") });
    await writeSkillFixture(root, { id: excluded, skillId: excluded, versionId: excluded, version: 1, status: "approved", createdAt: new Date(0).toISOString(), recipe: minimalRecipe("Excluded", "excluded") });
    await writeSkillFixture(root, { id: wrongLibrary, skillId: wrongLibrary, versionId: wrongLibrary, version: 1, libraryType: "imported_skill", status: "approved", createdAt: new Date(0).toISOString(), recipe: minimalRecipe("Imported", "imported") });
    await mkdir(join(root, "search-documents"), { recursive: true });
    await writeFile(join(root, "search-documents", `${orphan}.json`), JSON.stringify({ id: orphan, skillId: orphan, versionId: orphan, title: "Orphan", searchText: "orphan" }));
    const pool = await buildEligibleSkillPool({ root, library: "photo", excludeIds: [excluded] });
    const reasons = new Map(pool.diagnostics.rejected.map((item) => [item.versionId, item.reason]));
    assert.equal(reasons.get(pending), "pending");
    assert.equal(reasons.get(rejected), "rejected");
    assert.equal(reasons.get(superseded), "superseded");
    assert.equal(reasons.get(orphan), "missing_record");
    assert.equal(reasons.get(excluded), "excluded");
    assert.equal(reasons.get(wrongLibrary), "library_mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an incompatible Skill embedding falls back to keyword ranking", async () => {
  const root = await mkdtemp(join(tmpdir(), "taste-embedding-fallback-"));
  const originalFetch = globalThis.fetch;
  try {
    const id = "9".repeat(64); const recipe = minimalRecipe("Fallback", "linocut");
    await writeSkillFixture(root, { id, skillId: id, versionId: id, version: 1, status: "approved", createdAt: new Date(0).toISOString(), recipe });
    await mkdir(join(root, "embeddings"), { recursive: true });
    await writeFile(join(root, "embeddings", `${id}.json`), JSON.stringify({ schemaVersion: "1.0", skillId: "wrong", versionId: id, requestedModel: "embed-v1", actualModel: "embed-v1", dimensions: 2, createdAt: new Date(0).toISOString(), contentHashes: { intent: "stale", visual: "stale", adaptation: "stale" }, vectors: { intent: [1, 0], visual: [1, 0], adaptation: [1, 0] } }));
    globalThis.fetch = async () => new Response(JSON.stringify({ model: "embed-v1", data: [{ embedding: [1, 0] }] }), { status: 200, headers: { "content-type": "application/json" } });
    const result = await retrieveSkills({ root, query: "linocut", embedding: { endpoint: "https://embedding.example", model: "embed-v1", apiKey: "test" } });
    assert.equal(result.results[0]?.id, id);
    assert.equal(result.retrievalMode, "keyword");
    assert.equal(result.results[0]?.dimensionScores.intent, 0);
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});

test("frozen candidate pools ignore skills added after the snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "taste-snapshot-"));
  try {
    const first = "1".repeat(64); const later = "2".repeat(64);
    await writeSkillFixture(root, { id: first, skillId: first, versionId: first, version: 1, libraryType: "photo", status: "approved", createdAt: new Date(0).toISOString(), recipe: minimalRecipe("Frozen", "editorial") });
    const frozen = await buildEligibleSkillPool({ root });
    await writeSkillFixture(root, { id: later, skillId: later, versionId: later, version: 1, libraryType: "photo", status: "approved", createdAt: new Date(1).toISOString(), recipe: minimalRecipe("Later", "editorial editorial") });
    const ranked = await rankSkillPool({ query: "editorial", topK: 10, pool: frozen });
    assert.deepEqual(ranked.results.map((item) => item.id), [first]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retrieval profile migration is deterministic and preserves approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "taste-migration-"));
  try {
    const id = "f".repeat(64); const recipe = minimalRecipe("Legacy", "print"); delete (recipe as Partial<typeof recipe>).retrievalProfile;
    await writeSkillFixture(root, { id, libraryType: "photo", status: "approved", createdAt: new Date(0).toISOString(), recipe });
    const first = await migrateRetrievalProfiles({ root, dryRun: true }); assert.equal(first.profilesGenerated, 1);
    await migrateRetrievalProfiles({ root, dryRun: false });
    const second = await migrateRetrievalProfiles({ root, dryRun: true }); assert.equal(second.filesChanged, 0);
    const stored = JSON.parse(await readFile(join(root, "recipes", `${id}.json`), "utf8"));
    assert.equal(stored.status, "approved"); assert.equal(stored.skillId, id); assert.equal(stored.recipe.retrievalProfile.reviewStatus, "generated");
    const search = JSON.parse(await readFile(join(root, "search-documents", `${id}.json`), "utf8"));
    assert.ok(!search.searchText.includes("quiet minimal layouts"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
