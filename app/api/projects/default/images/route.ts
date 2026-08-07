import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxBytes = 20 * 1024 * 1024;

export async function POST(request: Request) {
  const form = await request.formData();
  const images = form.getAll("images").filter((entry): entry is File => entry instanceof File);
  if (!images.length) return NextResponse.json({ error: "No images supplied" }, { status: 400 });

  const dataDir = process.env.TASTE_STUDIO_DATA_DIR || join(process.cwd(), "data");
  const uploadDir = join(dataDir, "uploads", "default");
  const recipeDir = join(dataDir, "recipes");
  await mkdir(uploadDir, { recursive: true });
  const records: Array<{ hash: string; extension: string; filename: string; outcome: "new" | "retry" | "skipped_duplicate"; reason?: string }> = [];

  for (const image of images) {
    if (!supportedTypes.has(image.type) || image.size > maxBytes) {
      return NextResponse.json({ error: `${image.name} must be JPEG, PNG, or WebP and no larger than 20MB.` }, { status: 400 });
    }
    const bytes = Buffer.from(await image.arrayBuffer());
    const hash = createHash("sha256").update(bytes).digest("hex");
    const extension = image.type === "image/jpeg" ? "jpg" : image.type === "image/png" ? "png" : "webp";
    const destination = join(uploadDir, `${hash}.${extension}`);
    try {
      await access(destination);
      try {
        await access(join(recipeDir, `${hash}.json`));
        records.push({ hash, extension, filename: image.name, outcome: "skipped_duplicate", reason: "Exact SHA-256 match already has a generated recipe." });
      } catch {
        records.push({ hash, extension, filename: image.name, outcome: "retry", reason: "Source image exists but prior analysis did not produce a recipe; retrying." });
      }
    } catch {
      await writeFile(destination, bytes);
      records.push({ hash, extension, filename: image.name, outcome: "new" });
    }
  }

  return NextResponse.json({ batchId: randomUUID(), imported: records.filter((record) => record.outcome === "new").length, retried: records.filter((record) => record.outcome === "retry").length, skipped: records.filter((record) => record.outcome === "skipped_duplicate").length, records });
}
