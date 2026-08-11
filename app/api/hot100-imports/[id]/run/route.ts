import { NextResponse } from "next/server";
import { hot100Summary, runHot100Job } from "../../../../../src/lib/hot100-import";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await request.json().catch(() => ({})) as { vision?: { endpoint?: string; model?: string; apiKey?: string }; retryFailed?: boolean; limit?: number };
  try {
    const result = await runHot100Job(id, body.vision, Boolean(body.retryFailed), Number(body.limit) || 2);
    return NextResponse.json({ handled: result.handled, ...hot100Summary(result.job) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Hot 100 任务运行失败。" }, { status: 400 });
  }
}
