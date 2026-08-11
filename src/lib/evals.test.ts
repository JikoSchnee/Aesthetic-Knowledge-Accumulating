import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGeneratedImage, validateRaster } from "./image-generation";
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

test("keyword scoring remains deterministic", () => {
  assert.equal(keywordScore("warm poster", "warm editorial poster with warm colors"), 0.75);
  assert.equal(keywordScore("", "anything"), 0);
});
