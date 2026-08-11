import { NextResponse } from "next/server";
import type { EmbeddingConfig } from "../../../../../src/lib/embeddings";
import { publicEvalRun, readEvalRun, updateEvalRun } from "../../../../../src/lib/evals";

export const runtime = "nodejs";
export const maxDuration = 300;

const active = new Set<string>();

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json(publicEvalRun(await readEvalRun((await params).id))); }
  catch { return NextResponse.json({ error: "找不到 Eval 运行。" }, { status: 404 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { action?: "advance" | "pause" | "resume"; embedding?: EmbeddingConfig };
  if (!body.action || !["advance", "pause", "resume"].includes(body.action)) return NextResponse.json({ error: "无效的 Eval 操作。" }, { status: 400 });
  if (body.action === "advance" && active.has(id)) return NextResponse.json({ error: "该运行已有步骤正在执行。" }, { status: 409 });
  if (body.action === "advance") active.add(id);
  try { return NextResponse.json(publicEvalRun(await updateEvalRun(id, body.action, body.embedding))); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法更新 Eval 运行。" }, { status: 400 }); }
  finally { active.delete(id); }
}
