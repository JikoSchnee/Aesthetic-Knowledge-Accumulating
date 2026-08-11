import { NextResponse } from "next/server";
import { createHot100Job, currentHot100Job, ensureHot100Worker, hot100Summary } from "../../../src/lib/hot100-import";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  try {
    await ensureHot100Worker();
    const job = await currentHot100Job();
    return job ? NextResponse.json(hot100Summary(job)) : new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取 Hot 100 任务。" }, { status: 500 });
  }
}

export async function POST() {
  try {
    const job = await createHot100Job();
    return NextResponse.json(hot100Summary(job), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建 Hot 100 导入任务。" }, { status: 502 });
  }
}
