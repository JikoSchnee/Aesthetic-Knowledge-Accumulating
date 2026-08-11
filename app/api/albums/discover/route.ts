import { NextResponse } from "next/server";
import { MusicBrainzConfigurationError, MusicBrainzUpstreamError, discoverMusicBrainzAlbums } from "../../../../src/lib/musicbrainz";

export const runtime = "nodejs";

const genres = ["Alternative", "Ambient", "Classical", "Country", "Dance", "Electronic", "Experimental", "Hip-Hop", "Indie", "Jazz", "K-Pop", "Latin", "Metal", "Pop", "Punk", "R&B", "Reggae", "Rock", "Singer-Songwriter", "Soundtrack", "World"];

type ChartAlbum = { id?: string; name?: string; artistName?: string; artworkUrl100?: string; url?: string; releaseDate?: string; genres?: Array<{ name?: string }> };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const selected = (searchParams.get("genres") || "").split(",").map((value) => value.trim()).filter((value) => genres.includes(value));
  const query = searchParams.get("q")?.trim() || "";
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || 40, 100));
  const country = /^[A-Z]{2}$/.test(searchParams.get("country") || "") ? searchParams.get("country")! : "US";
  try {
    if (searchParams.get("mode") === "chart") {
      const response = await fetch(`https://rss.marketingtools.apple.com/api/v2/${country.toLowerCase()}/music/most-played/100/albums.json`, { headers: { accept: "application/json" }, next: { revalidate: 1800 } });
      if (!response.ok) throw new Error("chart unavailable");
      const data = await response.json() as { feed?: { results?: ChartAlbum[] } };
      const albums = (data.feed?.results || []).filter((album) => album.id && album.artworkUrl100).map((album, index) => ({ id: album.id!, title: album.name || "Untitled album", artist: album.artistName || "Unknown artist", genre: album.genres?.map((genre) => genre.name).filter(Boolean).join(" · ") || "Chart", year: album.releaseDate?.slice(0, 4) || "", artwork: album.artworkUrl100!.replace("100x100bb", "600x600bb"), sourceUrl: album.url || "", provider: "apple-music-rss" as const, chartRank: index + 1 }));
      return NextResponse.json({ albums, genres, mode: "chart", country, attribution: "Chart rank, album artwork, and metadata are supplied by Apple Music RSS. Keep source attribution; obtain rights before public or commercial reuse." });
    }
    const albums = await discoverMusicBrainzAlbums({ query, genres: selected, limit });
    return NextResponse.json({ albums, genres, attribution: "专辑元数据来自 MusicBrainz，封面来自 Cover Art Archive。请尊重艺术家与唱片公司的权利。" });
  } catch (error) {
    if (error instanceof MusicBrainzConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    if (error instanceof MusicBrainzUpstreamError) return NextResponse.json({ error: error.message }, { status: 502 });
    return NextResponse.json({ error: "无法连接公开专辑目录，请稍后重试。" }, { status: 502 });
  }
}
