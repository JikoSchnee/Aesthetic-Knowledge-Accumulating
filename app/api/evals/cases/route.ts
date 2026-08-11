import { NextResponse } from "next/server";
import { addEvalCases, listEvalCases } from "../../../../src/lib/evals";

export const runtime = "nodejs";

export async function GET() { return NextResponse.json(await listEvalCases()); }

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const images = form.getAll("images").filter((item): item is File => item instanceof File);
    if (!images.length) return NextResponse.json({ error: "请选择至少一张 Eval 图片。" }, { status: 400 });
    return NextResponse.json(await addEvalCases(images));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法添加 Eval 图片。" }, { status: 400 }); }
}
