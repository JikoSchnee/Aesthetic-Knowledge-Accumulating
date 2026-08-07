import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type SelectedAlbum = { id: string; title: string; artist: string; genre: string; year?: string; artwork: string; sourceUrl?: string };

export async function POST(request: Request) {
  const { albums } = await request.json() as { albums?: SelectedAlbum[] };
  if (!albums?.length) return NextResponse.json({ error: "请至少选择一张封面。" }, { status: 400 });
  const dataDir = process.env.TASTE_STUDIO_DATA_DIR || join(process.cwd(), "data");
  const uploadDir = join(dataDir, "uploads", "default");
  const recipeDir = join(dataDir, "recipes");
  await mkdir(uploadDir, { recursive: true });
  const records: Array<{ hash: string; extension: string; filename: string; outcome: "new" | "retry" | "skipped_duplicate"; source: object; reason?: string }> = [];
  for (const album of albums) {
    try {
      const response = await fetch(album.artwork, { headers: { accept: "image/jpeg,image/*" } });
      if (!response.ok) throw new Error(`封面下载失败（${response.status}）`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("封面文件无效或超过 20MB");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const filename = `${album.artist} — ${album.title}.jpg`;
      const destination = join(uploadDir, `${hash}.jpg`);
      let outcome: "new" | "retry" | "skipped_duplicate" = "new";
      try { await access(destination); try { await access(join(recipeDir, `${hash}.json`)); outcome = "skipped_duplicate"; } catch { outcome = "retry"; } } catch { await writeFile(destination, bytes); }
      records.push({ hash, extension: "jpg", filename, outcome, source: { kind: "album_cover", provider: "iTunes Search API", albumId: album.id, title: album.title, artist: album.artist, genre: album.genre, year: album.year, sourceUrl: album.sourceUrl, artworkUrl: album.artwork }, ...(outcome === "skipped_duplicate" ? { reason: "该封面已在本地生成过配方。" } : {}) });
    } catch (error) { records.push({ hash: `failed-${album.id}`, extension: "jpg", filename: `${album.artist} — ${album.title}`, outcome: "skipped_duplicate", source: album, reason: error instanceof Error ? error.message : "封面下载失败" }); }
  }
  return NextResponse.json({ batchId: randomUUID(), records });
}
