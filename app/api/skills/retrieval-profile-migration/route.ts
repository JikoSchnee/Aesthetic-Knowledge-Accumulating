import { NextResponse } from "next/server";
import { migrateRetrievalProfiles } from "../../../../src/lib/retrieval-profile-migration";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { dryRun?: boolean };
    return NextResponse.json(await migrateRetrievalProfiles({ dryRun: body.dryRun !== false }));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Retrieval Profile 迁移失败。" }, { status: 400 }); }
}
