import assert from "node:assert/strict";
import { test } from "node:test";
import { EVAL_MAX_CONCURRENCY, EVAL_MAX_RETRIES, evalConcurrency, evalTextInstruction, evalTextSuggestion, isEvalRetryDue, scheduleEvalRetry, type EvalCaseRun } from "./evals";
import { GenerationTransientError, isGenerationTransientError, resolveGeneratedImage, validateRaster } from "./image-generation";
import { IMAGE_GENERATION_DEFAULTS, templateForFalModel, validateImageGenerationSettings, visibleImageGenerationSettings } from "./image-generation-settings";
import { keywordScore } from "./retrieval";

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
