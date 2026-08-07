import { NextResponse } from "next/server";
import { dataRoot, normaliseLibrary, readSkills } from "../../../src/lib/library";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const status = new URL(request.url).searchParams.get("status") || "needs_review";
  const library = normaliseLibrary(new URL(request.url).searchParams.get("library"));
  try {
    const recipes = await readSkills(dataRoot(), library);
    return NextResponse.json(recipes.filter((recipe) => recipe.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  } catch { return NextResponse.json([]); }
}
