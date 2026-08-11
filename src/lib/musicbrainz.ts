const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2/release-group/";
const COVER_ART_ARCHIVE_BASE_URL = "https://coverartarchive.org/release-group";
const MIN_REQUEST_INTERVAL_MS = 1_100;
const CACHE_SECONDS = 60 * 60;

type MusicBrainzArtistCredit = { name?: string; artist?: { name?: string }; joinphrase?: string };
type MusicBrainzTag = { name?: string; count?: number };
type MusicBrainzReleaseGroup = {
  id: string;
  title?: string;
  "artist-credit"?: MusicBrainzArtistCredit[];
  "first-release-date"?: string;
  tags?: MusicBrainzTag[];
};

export type MusicBrainzAlbum = {
  id: string;
  title: string;
  artist: string;
  genre: string;
  year: string;
  artwork: string;
  sourceUrl: string;
  provider: "musicbrainz-caa";
  releaseGroupId: string;
};

export class MusicBrainzConfigurationError extends Error {}
export class MusicBrainzUpstreamError extends Error {}

let nextRequestAt = 0;
let requestQueue = Promise.resolve();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveRequestSlot() {
  const previous = requestQueue;
  let release!: () => void;
  requestQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const waitFor = Math.max(0, nextRequestAt - Date.now());
  if (waitFor) await sleep(waitFor);
  nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
  release();
}

function contactUserAgent() {
  const contact = process.env.MUSICBRAINZ_CONTACT?.trim();
  if (!contact) {
    throw new MusicBrainzConfigurationError("尚未配置 MUSICBRAINZ_CONTACT。请在 .env.local 中填写维护者邮箱或网址后重试。");
  }
  return `TasteSkillStudio/0.1.0 (${contact})`;
}

function escapeLucene(value: string) {
  return value.replace(/[+\-!(){}\[\]^"~*?:\\/]|&&|\|\|/g, "\\$&");
}

function quotedField(field: string, value: string) {
  return `${field}:"${escapeLucene(value)}"`;
}

export async function musicBrainzFetch(url: URL) {
  const userAgent = contactUserAgent();
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await reserveRequestSlot();
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": userAgent },
      next: { revalidate: CACHE_SECONDS }
    });
    if (response.ok) return response;
    lastStatus = response.status;
    if (response.status !== 503 || attempt === 2) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 1_000 * (attempt + 1));
  }
  throw new MusicBrainzUpstreamError(lastStatus === 503 ? "MusicBrainz 当前限流或暂时不可用，请稍后重试。" : `MusicBrainz 请求失败（${lastStatus || "网络错误"}）。`);
}

function artistName(credits: MusicBrainzArtistCredit[] | undefined) {
  if (!credits?.length) return "Unknown artist";
  return credits.map((credit) => `${credit.name || credit.artist?.name || "Unknown artist"}${credit.joinphrase || ""}`).join("");
}

function chooseGenre(tags: MusicBrainzTag[] | undefined, requestedGenres: string[]) {
  const names = (tags || []).map((tag) => tag.name).filter((name): name is string => Boolean(name));
  const requested = requestedGenres.find((genre) => names.some((tag) => tag.toLowerCase() === genre.toLowerCase()));
  return requested || names.slice(0, 2).join(" · ") || "Uncategorized";
}

export function coverArtUrl(releaseGroupId: string) {
  return `${COVER_ART_ARCHIVE_BASE_URL}/${releaseGroupId}/front-1200`;
}

export async function hasFrontCover(releaseGroupId: string) {
  try {
    const response = await fetch(coverArtUrl(releaseGroupId), {
      method: "HEAD",
      redirect: "follow",
      next: { revalidate: CACHE_SECONDS }
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function filterWithCoverArt(groups: MusicBrainzReleaseGroup[], requestedGenres: string[]) {
  const matches: MusicBrainzAlbum[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, groups.length) }, async () => {
    while (cursor < groups.length) {
      const group = groups[cursor++];
      if (!await hasFrontCover(group.id)) continue;
      matches.push({
        id: group.id,
        title: group.title || "Untitled album",
        artist: artistName(group["artist-credit"]),
        genre: chooseGenre(group.tags, requestedGenres),
        year: group["first-release-date"]?.slice(0, 4) || "",
        artwork: coverArtUrl(group.id),
        sourceUrl: `https://musicbrainz.org/release-group/${group.id}`,
        provider: "musicbrainz-caa",
        releaseGroupId: group.id
      });
    }
  });
  await Promise.all(workers);
  return matches;
}

export async function discoverMusicBrainzAlbums({ query, genres, limit }: { query?: string; genres?: string[]; limit: number }) {
  const clauses = ["primarytype:album"];
  const cleanQuery = query?.trim();
  const cleanGenres = (genres || []).map((genre) => genre.trim()).filter(Boolean);
  if (cleanQuery) {
    clauses.push(`(${quotedField("release", cleanQuery)} OR ${quotedField("artist", cleanQuery)})`);
  }
  if (cleanGenres.length) {
    clauses.push(`(${cleanGenres.map((genre) => quotedField("tag", genre)).join(" OR ")})`);
  }
  if (!cleanQuery && !cleanGenres.length) return [];

  const url = new URL(MUSICBRAINZ_BASE_URL);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("query", clauses.join(" AND "));
  const response = await musicBrainzFetch(url);
  const payload = await response.json() as { "release-groups"?: MusicBrainzReleaseGroup[] };
  return filterWithCoverArt(payload["release-groups"] || [], cleanGenres);
}

export async function findOriginalAlbumForRecording(song: string, performer: string) {
  const searchUrl = new URL("https://musicbrainz.org/ws/2/recording/");
  searchUrl.searchParams.set("fmt", "json");
  searchUrl.searchParams.set("limit", "5");
  searchUrl.searchParams.set("query", `(${quotedField("recording", song)} AND ${quotedField("artist", performer)})`);
  const searchResponse = await musicBrainzFetch(searchUrl);
  const searchPayload = await searchResponse.json() as { recordings?: Array<{ id?: string; score?: string | number; title?: string }> };
  const candidate = searchPayload.recordings?.find((recording) => recording.id);
  if (!candidate?.id) return undefined;

  const lookupUrl = new URL(`https://musicbrainz.org/ws/2/recording/${candidate.id}`);
  lookupUrl.searchParams.set("fmt", "json");
  lookupUrl.searchParams.set("inc", "releases+release-groups+artist-credits");
  const lookupResponse = await musicBrainzFetch(lookupUrl);
  const recording = await lookupResponse.json() as {
    releases?: Array<{
      id?: string; title?: string; status?: string; date?: string; country?: string;
      "release-group"?: { id?: string; title?: string; "primary-type"?: string; "secondary-types"?: string[] };
    }>;
  };
  const excludedTypes = new Set(["Compilation", "Live", "Remix"]);
  const releases = (recording.releases || []).filter((release) => {
    const group = release["release-group"];
    return release.status === "Official" && group?.id && group["primary-type"] === "Album" && !(group["secondary-types"] || []).some((type) => excludedTypes.has(type));
  }).sort((left, right) => {
    const date = (left.date || "9999-99-99").localeCompare(right.date || "9999-99-99");
    if (date) return date;
    if (left.country === "US" && right.country !== "US") return -1;
    if (right.country === "US" && left.country !== "US") return 1;
    return (left.id || "").localeCompare(right.id || "");
  });
  const release = releases[0];
  if (!release?.["release-group"]?.id) return { recordingId: candidate.id, recordingScore: Number(candidate.score || 0), noAlbum: true as const };
  const group = release["release-group"];
  return {
    recordingId: candidate.id,
    recordingScore: Number(candidate.score || 0),
    releaseGroupId: group.id,
    albumTitle: group.title || release.title || "Untitled album",
    releaseId: release.id,
    releaseDate: release.date || "",
    country: release.country || "",
    noAlbum: false as const
  };
}
