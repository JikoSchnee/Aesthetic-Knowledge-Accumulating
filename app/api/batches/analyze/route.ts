import { access, readFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { dedupeText, findDuplicateCandidates, type RecipeLike } from "../../../../src/lib/dedupe";
import { TYPOGRAPHY_SCHEMA_VERSION } from "../../../../src/lib/typography";
import { imageRecipePrompt as recipePrompt, parseValidRecipe } from "../../../../src/lib/recipe-schema";
import { readSkills } from "../../../../src/lib/library";
import { applyRetrievalProfile } from "../../../../src/lib/skill-governance";

export const runtime = "nodejs";
export const maxDuration = 300;

type RecordInput = { hash: string; extension: string; filename?: string; outcome?: "new" | "retry" | "skipped_duplicate"; source?: Record<string, unknown> };

export async function POST(request: Request) {
  const body = await request.json() as { batchId: string; records: RecordInput[]; model: string; endpoint: string; apiKey: string; concurrency?: number; stream?: boolean };
  const apiKey = !body.apiKey || body.apiKey === "env-configured" ? process.env.VISION_API_KEY || "" : body.apiKey;
  const endpoint = body.endpoint || process.env.VISION_ENDPOINT || "";
  const model = body.model || process.env.VISION_MODEL || "";
  if (!apiKey || !endpoint || !model || !body.records?.length) return NextResponse.json({ error: "Missing analysis configuration or records." }, { status: 400 });
  const dataDir = process.env.TASTE_STUDIO_DATA_DIR || join(process.cwd(), "data");
  const recipeDir = join(dataDir, "recipes");
  await mkdir(recipeDir, { recursive: true });
  const completed: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ hash: string; filename: string; reason: string }> = [];
  const existing: RecipeLike[] = await readSkills(dataDir, "all") as unknown as RecipeLike[];

  const analyzeRecord = async (record: RecordInput) => {
    if (record.outcome === "skipped_duplicate") { skipped.push(record.hash); return; }
    try {
    try { await access(join(recipeDir, `${record.hash}.json`)); skipped.push(record.hash); return; } catch { /* New source image. */ }
    const image = await readFile(join(dataDir, "uploads", "default", `${record.hash}.${record.extension}`));
    const mime = record.extension === "jpg" ? "image/jpeg" : `image/${record.extension}`;
    const requestModel = (strict = false) => fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: strict ? 0 : 0.3, response_format: { type: "json_object" }, messages: [{ role: "system", content: strict ? `${recipePrompt} This is a retry. Return the JSON object only: no Markdown fence, no explanation, and no text before or after it.` : recipePrompt }, { role: "user", content: [{ type: "text", text: "Create one independent English visual recipe for this image." }, { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } }] }] })
    });
    const response = await requestModel();
    if (!response.ok) {
      const detail = (await response.text()).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 280);
      throw new Error(`模型请求失败（HTTP ${response.status}）：${detail || "服务商未返回详情"}`);
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型没有返回配方内容。");
    let recipe: RecipeLike["recipe"];
    try { recipe = parseValidRecipe(content); } catch {
      const retry = await requestModel(true);
      if (!retry.ok) throw new Error(`模型重试失败（HTTP ${retry.status}）。`);
      const retryPayload = await retry.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      try { recipe = parseValidRecipe(retryPayload.choices?.[0]?.message?.content); } catch { throw new Error("模型连续两次未返回有效的配方 JSON 或字体设计板块。请更换支持结构化输出的视觉模型后重试。"); }
    }
    recipe = applyRetrievalProfile(recipe as Record<string, unknown>) as RecipeLike["recipe"];
    const duplicateCandidates = findDuplicateCandidates(recipe as RecipeLike["recipe"], existing);
    const stored = { id: record.hash, skillId: record.hash, versionId: record.hash, version: 1, libraryType: "photo", batchId: body.batchId, status: "needs_review", providerModel: model, createdAt: new Date().toISOString(), recipeSchemaVersion: "1.2", typographySchemaVersion: TYPOGRAPHY_SCHEMA_VERSION, typographyStatus: "ready", typographyModel: model, typographyUpdatedAt: new Date().toISOString(), source: { kind: "photo", filename: record.filename || "", hash: record.hash, ...record.source }, dedupeText: dedupeText(recipe as RecipeLike["recipe"]), duplicateCandidates, duplicateDecision: duplicateCandidates.length ? "pending" : "not_required", recipe };
    await writeFile(join(recipeDir, `${record.hash}.json`), JSON.stringify(stored, null, 2));
    existing.push(stored);
    completed.push(record.hash);
    } catch (error) {
      failed.push({ hash: record.hash, filename: record.filename || record.hash, reason: error instanceof Error ? error.message.slice(0, 300) : "Unknown analysis failure." });
    }
  };

  if (body.stream) {
    const encoder = new TextEncoder();
    const response = new ReadableStream({
      async start(controller) {
        const emit = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        try {
          emit({ type: "start", total: body.records.length });
          for (let index = 0; index < body.records.length; index += 1) {
            await analyzeRecord(body.records[index]);
            emit({ type: "progress", completed: index + 1, total: body.records.length, analyzed: completed.length, skipped: skipped.length, failed: failed.length });
          }
          emit({ type: "complete", batchId: body.batchId, status: "needs_review", analyzed: completed.length, skipped: skipped.length, failed });
        } catch (error) {
          emit({ type: "error", error: error instanceof Error ? error.message : "模型分析失败" });
        } finally {
          controller.close();
        }
      }
    });
    return new Response(response, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  }

  for (const record of body.records) {
    await analyzeRecord(record);
  }
  return NextResponse.json({ batchId: body.batchId, status: "needs_review", analyzed: completed.length, skipped: skipped.length, failed });
}
