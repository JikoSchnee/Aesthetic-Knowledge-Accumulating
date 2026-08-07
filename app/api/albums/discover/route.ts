import { NextResponse } from "next/server";

export const runtime = "nodejs";

const genres = ["Alternative", "Ambient", "Classical", "Country", "Dance", "Electronic", "Experimental", "Hip-Hop", "Indie", "Jazz", "K-Pop", "Latin", "Metal", "Pop", "Punk", "R&B", "Reggae", "Rock", "Singer-Songwriter", "Soundtrack", "World"];

type Album = { collectionId?: number; collectionName?: string; artistName?: string; primaryGenreName?: string; releaseDate?: string; artworkUrl100?: string; collectionViewUrl?: string };
type ChartAlbum = { id?: string; name?: string; artistName?: string; artworkUrl100?: string; url?: string; releaseDate?: string; genres?: Array<{ name?: string }> };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get("genres") || "").split(",").map((value) => value.trim()).filter((value) => genres.includes(value));
  const selected = requested.length ? requested : genres;
  const perGenre = Math.max(4, Math.min(Number(searchParams.get("perGenre")) || 10, 25));
  const country = /^[A-Z]{2}$/.test(searchParams.get("country") || "") ? searchParams.get("country")! : "US";
  try {
    if (searchParams.get("mode") === "chart") {
      const response = await fetch(`https://rss.marketingtools.apple.com/api/v2/${country.toLowerCase()}/music/most-played/100/albums.json`, { headers: { accept: "application/json" }, next: { revalidate: 1800 } });
      if (!response.ok) throw new Error("chart unavailable");
      const data = await response.json() as { feed?: { results?: ChartAlbum[] } };
      const albums = (data.feed?.results || []).filter((album) => album.id && album.artworkUrl100).map((album, index) => ({ id: album.id!, title: album.name || "Untitled album", artist: album.artistName || "Unknown artist", genre: album.genres?.map((genre) => genre.name).filter(Boolean).join(" · ") || "Chart", year: album.releaseDate?.slice(0, 4) || "", artwork: album.artworkUrl100!.replace("100x100bb", "600x600bb"), sourceUrl: album.url || "", chartRank: index + 1 }));
      return NextResponse.json({ albums, genres, mode: "chart", country, attribution: "Chart rank, album artwork, and metadata are supplied by Apple Music RSS. Keep source attribution; obtain rights before public or commercial reuse." });
    }
    const groups = await Promise.all(selected.map(async (genre) => {
      const url = new URL("https://itunes.apple.com/search");
      url.searchParams.set("term", genre);
      url.searchParams.set("entity", "album");
      url.searchParams.set("attribute", "genreIndex");
      url.searchParams.set("limit", String(perGenre));
      url.searchParams.set("country", country);
      const response = await fetch(url, { headers: { accept: "application/json" }, next: { revalidate: 3600 } });
      if (!response.ok) return [] as Album[];
      return ((await response.json()) as { results?: Album[] }).results || [];
    }));
    const seen = new Set<number>();
    const albums = groups.flat().filter((album) => album.collectionId && album.artworkUrl100 && !seen.has(album.collectionId) && Boolean(seen.add(album.collectionId))).map((album) => ({
      id: String(album.collectionId), title: album.collectionName || "Untitled album", artist: album.artistName || "Unknown artist", genre: album.primaryGenreName || "Uncategorized", year: album.releaseDate?.slice(0, 4) || "", artwork: album.artworkUrl100!.replace("100x100bb", "600x600bb"), sourceUrl: album.collectionViewUrl || ""
    }));
    return NextResponse.json({ albums, genres, attribution: "Album artwork and metadata are supplied by the iTunes Search API. Keep source attribution; obtain rights before public or commercial reuse." });
  } catch {
    return NextResponse.json({ error: "无法连接公开专辑目录，请稍后重试。" }, { status: 502 });
  }
}
