import { basename, dirname, extname, posix } from "node:path";
import { ALLOWED_SKILL_EXTENSIONS, buildSkillCandidates, MAX_SKILL_FILES, MAX_SKILL_FILE_BYTES, MAX_SKILL_TOTAL_BYTES, safeSkillPath, validateSkillDocument, type GitHubRemoteSource, type RejectedSkillDocument, type SkillCandidate, type SkillDocument } from "./skill-intake";

const API_ROOT = "https://api.github.com";
const RAW_ROOT = "https://raw.githubusercontent.com";
const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "taste-skill-studio" };

type ParsedGitHubUrl = { originalUrl: string; owner: string; repo: string; mode: "repo" | "tree" | "blob"; parts: string[] };
type GitHubTreeItem = { path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number };
type GitHubTree = { sha: string; truncated: boolean; tree: GitHubTreeItem[] };
type CommitResult = { sha: string; commit?: { tree?: { sha?: string } } };

export class GitHubImportError extends Error {
  constructor(message: string, public status = 400, public details?: Record<string, unknown>) { super(message); }
}

export function parseGitHubSkillUrl(input: string): ParsedGitHubUrl {
  let url: URL;
  try { url = new URL(input); } catch { throw new GitHubImportError("请输入有效的 GitHub HTTPS 链接。"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port) throw new GitHubImportError("仅支持 https://github.com 上的公开仓库链接。");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 2) throw new GitHubImportError("GitHub 链接需要包含 owner 和 repository。");
  const owner = segments[0]; const repo = segments[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new GitHubImportError("GitHub owner 或 repository 格式无效。");
  if (segments.length === 2) return { originalUrl: url.toString(), owner, repo, mode: "repo", parts: [] };
  if ((segments[2] !== "tree" && segments[2] !== "blob") || segments.length < 4) throw new GitHubImportError("仅支持仓库首页、tree 子目录或 blob/SKILL.md（recipe.json）链接。");
  return { originalUrl: url.toString(), owner, repo, mode: segments[2], parts: segments.slice(3) };
}

function apiUrl(path: string) { return `${API_ROOT}${path}`; }
function encodePath(path: string) { return path.split("/").map(encodeURIComponent).join("/"); }

async function githubJson<T>(path: string, allowMissing = false): Promise<T | undefined> {
  let response: Response;
  try { response = await fetch(apiUrl(path), { headers, redirect: "error", cache: "no-store" }); }
  catch { throw new GitHubImportError("无法连接 GitHub。请检查网络后重试。", 502); }
  if (allowMissing && (response.status === 404 || response.status === 422)) return undefined;
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining"); const reset = response.headers.get("x-ratelimit-reset");
    if (response.status === 403 || response.status === 429) {
      const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : undefined;
      throw new GitHubImportError(`GitHub API 限流或拒绝访问。剩余额度：${remaining ?? "未知"}${resetAt ? `，重置时间：${resetAt}` : ""}。`, 429, { rateLimitRemaining: remaining, rateLimitReset: resetAt });
    }
    if (response.status === 404) throw new GitHubImportError("仓库、版本或路径不存在。当前版本仅支持公开 GitHub 仓库。", 404);
    throw new GitHubImportError(`GitHub API 请求失败（HTTP ${response.status}）。`, response.status);
  }
  return response.json() as Promise<T>;
}

async function resolveRef(parsed: ParsedGitHubUrl, defaultBranch: string) {
  if (parsed.mode === "repo") {
    const commit = await githubJson<CommitResult>(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(defaultBranch)}`);
    return { inputRef: defaultBranch, targetPath: "", commit: commit! };
  }
  const parts = parsed.parts;
  // Most GitHub URLs use a one-segment branch such as main. Resolve that in
  // one request; only fan out when it is not a valid ref, preserving support
  // for branch names that contain slashes without exhausting shared-IP quota.
  const tries = [1, ...Array.from({ length: Math.max(0, parts.length - 1) }, (_, index) => parts.length - index).filter((count) => count > 1)];
  for (const count of tries) {
    const ref = parts.slice(0, count).join("/");
    const commit = await githubJson<CommitResult>(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(ref)}`, true);
    if (commit) return { inputRef: ref, targetPath: parts.slice(count).join("/"), commit };
  }
  throw new GitHubImportError("无法解析链接中的分支、标签或 commit。", 404);
}

async function scopedTree(owner: string, repo: string, treeSha: string, scope: string) {
  let currentSha = treeSha;
  for (const segment of scope.split("/").filter(Boolean)) {
    const current = await githubJson<GitHubTree>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(currentSha)}`);
    const next = current!.tree.find((item) => item.type === "tree" && item.path === segment);
    if (!next) throw new GitHubImportError(`GitHub 目录不存在：${scope}`, 404);
    currentSha = next.sha;
  }
  const tree = await githubJson<GitHubTree>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(currentSha)}?recursive=1`);
  return { ...tree!, tree: tree!.tree.map((item) => ({ ...item, path: scope ? `${scope}/${item.path}` : item.path })) };
}

async function readRaw(owner: string, repo: string, sha: string, path: string) {
  const url = `${RAW_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/${encodePath(path)}`;
  let response: Response;
  try { response = await fetch(url, { redirect: "error", cache: "no-store" }); }
  catch { throw new GitHubImportError(`下载中断：${path}`, 502); }
  if (!response.ok) throw new GitHubImportError(`无法读取固定 commit 中的文档：${path}（HTTP ${response.status}）。`, response.status);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_SKILL_FILE_BYTES) throw new GitHubImportError(`文档超过 2MB：${path}`, 413);
  const reader = response.body?.getReader(); if (!reader) return response.text();
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_SKILL_FILE_BYTES) { await reader.cancel(); throw new GitHubImportError(`文档超过 2MB：${path}`, 413); } chunks.push(value); }
  const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

function selectTreeDocuments(tree: GitHubTreeItem[], scope: string) {
  const allowed = tree.filter((item) => item.type === "blob" && ALLOWED_SKILL_EXTENSIONS.has(extname(item.path).toLowerCase()));
  const markers = allowed.filter((item) => ["skill.md", "recipe.json", "manifest.json"].includes(basename(item.path).toLowerCase()));
  if (!markers.length) throw new GitHubImportError("目标位置没有找到 SKILL.md 或兼容的 recipe.json。", 422);
  const roots = markers.filter((item) => basename(item.path).toLowerCase() === "skill.md").map((item) => dirname(item.path) === "." ? "" : dirname(item.path));
  if (!roots.length) return allowed;
  return allowed.filter((item) => roots.some((root) => !root || item.path === root || item.path.startsWith(`${root}/`)) || basename(item.path).toLowerCase() === "manifest.json" || (scope && item.path === `${scope}/manifest.json`));
}

export async function fetchGitHubSkillDocuments(input: string) {
  const parsed = parseGitHubSkillUrl(input);
  const repository = await githubJson<{ default_branch: string; private: boolean; html_url: string }>(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`);
  if (repository!.private) throw new GitHubImportError("当前版本仅支持公开 GitHub 仓库。", 404);
  const resolved = await resolveRef(parsed, repository!.default_branch);
  let targetPath = resolved.targetPath ? safeSkillPath(resolved.targetPath) : "";
  if (parsed.mode === "blob") {
    const name = basename(targetPath).toLowerCase();
    if (name !== "skill.md" && name !== "recipe.json") throw new GitHubImportError("blob 链接必须指向 SKILL.md 或 recipe.json。", 422);
    targetPath = dirname(targetPath) === "." ? "" : dirname(targetPath);
  }
  const commitSha = resolved.commit.sha; const treeSha = resolved.commit.commit?.tree?.sha;
  if (!treeSha) throw new GitHubImportError("GitHub commit 没有可读取的 tree。", 502);
  let tree = await githubJson<GitHubTree>(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  if (tree!.truncated) {
    if (!targetPath) throw new GitHubImportError("仓库 tree 过大。请粘贴更具体的 Skill tree 或 blob 链接。", 413);
    tree = await scopedTree(parsed.owner, parsed.repo, treeSha, targetPath);
  }
  const scopedItems = tree!.tree.filter((item) => !targetPath || item.path === targetPath || item.path.startsWith(`${targetPath}/`));
  const selected = selectTreeDocuments(scopedItems, targetPath);
  if (selected.length > MAX_SKILL_FILES) throw new GitHubImportError(`目标包含超过 ${MAX_SKILL_FILES} 个允许文档，请粘贴更具体的 Skill 目录链接。`, 413);
  const rejected: RejectedSkillDocument[] = []; const documents: SkillDocument[] = []; let total = 0;
  for (const item of selected) {
    if ((item.size || 0) > MAX_SKILL_FILE_BYTES) { rejected.push({ file: item.path, reason: "Text file exceeds 2MB." }); continue; }
    const content = await readRaw(parsed.owner, parsed.repo, commitSha, item.path);
    const localPath = targetPath ? item.path.slice(targetPath.length + 1) : item.path;
    const result = validateSkillDocument(localPath, content);
    if (result.rejected) { rejected.push(result.rejected); continue; }
    total += result.bytes || 0; if (total > MAX_SKILL_TOTAL_BYTES) throw new GitHubImportError("Skill documents exceed the 20MB extracted limit.", 413);
    documents.push(result.document!);
  }
  const discovered = buildSkillCandidates(documents);
  if (!discovered.length) throw new GitHubImportError("目标位置没有可导入的审美 Skill。", 422);
  const fetchedAt = new Date().toISOString();
  const candidates: SkillCandidate[] = discovered.map((candidate) => {
    const repoRoot = posix.join(targetPath, candidate.sourceRoot).replace(/^\.$/, "");
    const remoteSource: GitHubRemoteSource = { provider: "github", originalUrl: parsed.originalUrl, owner: parsed.owner, repo: parsed.repo, skillRoot: repoRoot, inputRef: resolved.inputRef, commitSha, commitUrl: `https://github.com/${parsed.owner}/${parsed.repo}/commit/${commitSha}`, fetchedAt, upstreamKey: `github:${parsed.owner}/${parsed.repo}:${repoRoot}` };
    return { ...candidate, remoteSource };
  });
  return { candidates, rejected, repository: { owner: parsed.owner, repo: parsed.repo, targetPath, inputRef: resolved.inputRef, commitSha, commitUrl: `https://github.com/${parsed.owner}/${parsed.repo}/commit/${commitSha}`, skillCount: candidates.length, documentCount: documents.length } };
}
