import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type AlbumProvider = "musicbrainz-caa" | "apple-music-rss";
type SelectedAlbum = { id: string; title: string; artist: string; genre: string; year?: string; artwork: string; sourceUrl?: string; provider: AlbumProvider; releaseGroupId?: string; chartRank?: number };

const extensionByMime = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

function validateAlbum(album: SelectedAlbum) {
  if (!album || !["musicbrainz-caa", "apple-music-rss"].includes(album.provider)) return "无效的专辑封面来源。";
  let artwork: URL;
  try { artwork = new URL(album.artwork); } catch { return "无效的封面地址。"; }
  if (artwork.protocol !== "https:") return "封面地址必须使用 HTTPS。";
  if (album.provider === "musicbrainz-caa") {
    if (artwork.hostname !== "coverartarchive.org" || !/^\/release-group\/[0-9a-f-]+\/front-1200$/i.test(artwork.pathname)) return "MusicBrainz 封面必须来自 Cover Art Archive 的 release group 正面封面。";
    if (!album.releaseGroupId || album.releaseGroupId !== album.id) return "MusicBrainz 封面缺少有效的 release group ID。";
  }
  if (album.provider === "apple-music-rss" && !(artwork.hostname.endsWith(".mzstatic.com") || artwork.hostname.endsWith(".itunes.apple.com"))) return "Apple Music 热榜封面地址无效。";
  return undefined;
}

export async function POST(request: Request) {
  const { albums } = await request.json() as { albums?: SelectedAlbum[] };
  if (!albums?.length) return NextResponse.json({ error: "请至少选择一张封面。" }, { status: 400 });
  for (const album of albums) {
    const error = validateAlbum(album);
    if (error) return NextResponse.json({ error }, { status: 400 });
  }
  const dataDir = process.env.TASTE_STUDIO_DATA_DIR || join(process.cwd(), "data");
  const uploadDir = join(dataDir, "uploads", "default");
  const recipeDir = join(dataDir, "recipes");
  await mkdir(uploadDir, { recursive: true });
  const records: Array<{ hash: string; extension: string; filename: string; outcome: "new" | "retry" | "skipped_duplicate"; source: object; reason?: string }> = [];
  for (const album of albums) {
    try {
      const response = await fetch(album.artwork, { headers: { accept: "image/jpeg,image/*" } });
      if (!response.ok) throw new Error(`封面下载失败（${response.status}）`);
      const mime = response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() || "";
      const extension = extensionByMime.get(mime);
      if (!extension) throw new Error("封面格式不受支持，仅支持 JPEG、PNG 或 WebP");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("封面文件无效或超过 20MB");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const filename = `${album.artist} — ${album.title}.${extension}`;
      const destination = join(uploadDir, `${hash}.${extension}`);
      let outcome: "new" | "retry" | "skipped_duplicate" = "new";
      try { await access(destination); try { await access(join(recipeDir, `${hash}.json`)); outcome = "skipped_duplicate"; } catch { outcome = "retry"; } } catch { await writeFile(destination, bytes); }
      records.push({ hash, extension, filename, outcome, source: { kind: "album_cover", provider: album.provider, albumId: album.id, releaseGroupId: album.releaseGroupId, chartRank: album.chartRank, title: album.title, artist: album.artist, genre: album.genre, year: album.year, sourceUrl: album.sourceUrl, artworkUrl: album.artwork }, ...(outcome === "skipped_duplicate" ? { reason: "该封面已在本地生成过配方。" } : {}) });
    } catch (error) { records.push({ hash: `failed-${album.id}`, extension: "jpg", filename: `${album.artist} — ${album.title}`, outcome: "skipped_duplicate", source: album, reason: error instanceof Error ? error.message : "封面下载失败" }); }
  }
  return NextResponse.json({ batchId: randomUUID(), records });
}
