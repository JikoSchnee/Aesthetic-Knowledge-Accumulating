import { NextResponse } from "next/server";
import { musicBrainzFetch } from "../../../../src/lib/musicbrainz";

export const runtime = "nodejs";
export const maxDuration = 30;

type Target = "vision" | "embedding" | "github" | "musicbrainz" | "cover-art";
type ConnectionInput = { target?: Target; endpoint?: string; model?: string; apiKey?: string };

function cleanBaseUrl(value: string | undefined) {
  const url = new URL((value || "").trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Endpoint 必须是 HTTP(S) URL。");
  return url.toString().replace(/\/$/, "");
}

async function responseMessage(response: Response) {
  const text = (await response.text()).slice(0, 1_000);
  try {
    const payload = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    return typeof payload.error === "string" ? payload.error : payload.error?.message || payload.message || text;
  } catch { return text.replace(/\s+/g, " ").trim(); }
}

async function ordinaryFetch(url: string, init?: RequestInit) {
  return fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000) });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as ConnectionInput; const startedAt = Date.now();
  try {
    let response: Response; let label = "";
    if (body.target === "vision") {
      const endpoint = cleanBaseUrl(body.endpoint || process.env.VISION_ENDPOINT); const model = (body.model || process.env.VISION_MODEL || "").trim();
      const apiKey = body.apiKey === "env-configured" ? process.env.VISION_API_KEY : body.apiKey || process.env.VISION_API_KEY;
      if (!model || !apiKey) throw new Error("视觉模型、Endpoint 或 API Key 尚未配置完整。");
      label = `${endpoint}/chat/completions`;
      response = await ordinaryFetch(label, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, max_tokens: 1, temperature: 0, messages: [{ role: "user", content: "Reply with OK." }] }) });
    } else if (body.target === "embedding") {
      const endpoint = cleanBaseUrl(body.endpoint); const model = (body.model || "").trim(); const apiKey = (body.apiKey || "").trim();
      if (!model || !apiKey) throw new Error("Embedding 模型、Endpoint 或 API Key 尚未配置完整。");
      label = `${endpoint}/embeddings`;
      response = await ordinaryFetch(label, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, input: "connection test" }) });
    } else if (body.target === "github") {
      label = "https://api.github.com/repos/HipsterVizNinja/random-data/commits/main";
      response = await ordinaryFetch(label, { headers: { accept: "application/vnd.github+json", "user-agent": "TasteSkillStudio" } });
    } else if (body.target === "musicbrainz") {
      const url = new URL("https://musicbrainz.org/ws/2/recording/"); url.searchParams.set("fmt", "json"); url.searchParams.set("limit", "1"); url.searchParams.set("query", "recording:test");
      label = url.origin; response = await musicBrainzFetch(url);
    } else if (body.target === "cover-art") {
      label = "https://coverartarchive.org/release-group/1b022e01-4da6-387b-8658-8678046e4cef";
      response = await ordinaryFetch(label, { headers: { accept: "application/json" } });
    } else throw new Error("未知的连接测试类型。");
    const message = response.ok ? "连接成功，服务已接受请求。" : await responseMessage(response);
    return NextResponse.json({ target: body.target, ok: response.ok, status: response.status, latencyMs: Date.now() - startedAt, message: message || response.statusText || "上游没有返回错误说明。", endpoint: label }, { status: response.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ target: body.target, ok: false, status: null, latencyMs: Date.now() - startedAt, message: error instanceof Error ? error.message : "连接测试失败。" }, { status: 502 });
  }
}
