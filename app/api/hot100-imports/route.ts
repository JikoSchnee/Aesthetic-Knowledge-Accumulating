import { NextResponse } from "next/server";
import { createHot100Job, hot100Summary } from "../../../src/lib/hot100-import";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  try {
    const job = await createHot100Job();
    return NextResponse.json(hot100Summary(job), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建 Hot 100 导入任务。" }, { status: 502 });
  }
}
