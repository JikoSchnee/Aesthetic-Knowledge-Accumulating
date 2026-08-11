import { NextResponse } from "next/server";
import { hot100Summary, readHot100Job, updateHot100Job } from "../../../../src/lib/hot100-import";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const job = await readHot100Job(id);
  return job ? NextResponse.json(hot100Summary(job)) : NextResponse.json({ error: "找不到 Hot 100 导入任务。" }, { status: 404 });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await request.json().catch(() => ({})) as { action?: "pause" | "resume" | "configure"; concurrency?: number };
  if (body.action !== "pause" && body.action !== "resume" && body.action !== "configure") return NextResponse.json({ error: "无效的任务操作。" }, { status: 400 });
  try { return NextResponse.json(hot100Summary(await updateHot100Job(id, body.action, body.concurrency))); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法更新任务。" }, { status: 404 }); }
}
