import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { NextResponse } from "next/server";
import { evalImagesDir, evalRunsDir, listEvalCases, readEvalRun } from "../../../../src/lib/evals";

export const runtime = "nodejs";

const mime = (file: string) => file.endsWith(".png") ? "image/png" : file.endsWith(".webp") ? "image/webp" : "image/jpeg";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    if (query.get("kind") === "case") {
      const item = (await listEvalCases()).find((candidate) => candidate.id === query.get("id"));
      if (!item) throw new Error("not found");
      const bytes = await readFile(join(evalImagesDir(), item.filename));
      return new Response(bytes, { headers: { "content-type": item.mime, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
    }
    const runId = query.get("run") || "";
    const filename = query.get("file") || "";
    if (!filename || basename(filename) !== filename) throw new Error("invalid path");
    const run = await readEvalRun(runId);
    if (!run.cases.some((item) => item.resultFile === filename)) throw new Error("not found");
    const bytes = await readFile(join(evalRunsDir(), run.id, filename));
    return new Response(bytes, { headers: { "content-type": mime(filename), "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
  } catch { return NextResponse.json({ error: "找不到该 Eval 图片。" }, { status: 404 }); }
}
