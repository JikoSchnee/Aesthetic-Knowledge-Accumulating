"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import type { EmbeddingConfig } from "../src/lib/embeddings";
import "./eval.css";

type Library = "all" | "photo" | "imported_skill";
type EvalCase = { id: string; filename: string; mime: string; size: number; createdAt: string };
type Match = { id: string; title: string; libraryType: "photo" | "imported_skill"; score: number; matchReason: string };
type CaseRun = { caseId: string; filename: string; stage: string; matches?: Match[]; prompt?: string; resultFile?: string; error?: string; remoteId?: string; remoteState?: string; timings: Record<string, number> };
type EvalRun = { id: string; createdAt: string; updatedAt: string; status: "running" | "paused" | "completed"; config: GenerationSettings & { topK: number; library: Library }; cases: CaseRun[]; progress: { completed: number; failed: number; total: number; percent: number } };
type GenerationSettings = { provider: "openrouter" | "fal"; model: string; endpoint: string; apiKey: string; outputFormat: "png" | "jpeg" | "webp"; falInputTemplate: string; falResultPath: string; presets?: Array<{ id: string; label: string }> };

const falModelOptions = [
  { id: "fal-ai/flux-pro/kontext", label: "FLUX.1 Kontext Pro" },
  { id: "fal-ai/flux-2/edit", label: "FLUX.2 Edit" },
  { id: "fal-ai/flux/dev/image-to-image", label: "FLUX.1 Dev Image-to-Image" },
  { id: "fal-ai/bytedance/seedream/v4.5/edit", label: "Seedream 4.5 Edit" },
  { id: "fal-ai/nano-banana/edit", label: "Nano Banana Edit" },
  { id: "openai/gpt-image-2/edit", label: "GPT Image 2 Edit" }
];
const defaultGeneration: GenerationSettings = { provider: "openrouter", model: "google/gemini-2.5-flash-image", endpoint: "https://openrouter.ai/api/v1", apiKey: "", outputFormat: "png", falInputTemplate: "", falResultPath: "images.0.url", presets: falModelOptions };
const stageLabel: Record<string, string> = { pending_analysis: "等待视觉分析", pending_retrieval: "等待检索", pending_generation: "等待提交生图", waiting_generation: "远程生成中", completed: "已完成", failed: "失败" };
const elapsed = (timings: Record<string, number>) => Object.entries(timings).map(([key, value]) => `${key} ${(value / 1000).toFixed(1)}s`).join(" · ") || "尚未开始";

function ModelControl({ settings, onChange }: { settings: GenerationSettings; onChange: (model: string) => void }) {
  if (settings.provider !== "fal") return <input value={settings.model} onChange={(event) => onChange(event.target.value)}/>;
  const presets = settings.presets?.length ? settings.presets : falModelOptions;
  const custom = !presets.some((item) => item.id === settings.model);
  return <>
    <select value={custom ? "__custom__" : settings.model} onChange={(event) => onChange(event.target.value === "__custom__" ? "" : event.target.value)}>
      {presets.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
      <option value="__custom__">自定义 Endpoint ID…</option>
    </select>
    {custom && <input value={settings.model} placeholder="owner/model 或 owner/model/path" onChange={(event) => onChange(event.target.value)}/>}
  </>;
}

export function EvalStudio({ embedding, onOpenSettings }: { embedding: EmbeddingConfig; onOpenSettings: () => void }) {
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [activeRun, setActiveRun] = useState<EvalRun>();
  const [topK, setTopK] = useState(3);
  const [library, setLibrary] = useState<Library>("all");
  const [generation, setGeneration] = useState<GenerationSettings>(defaultGeneration);
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const advancing = useRef(false);

  const loadCases = async () => { const response = await fetch("/api/evals/cases", { cache: "no-store" }); const next = response.ok ? await response.json() as EvalCase[] : []; setCases(next); setSelected((current) => current.size ? new Set([...current].filter((id) => next.some((item) => item.id === id))) : new Set(next.map((item) => item.id))); };
  const loadRuns = async () => { const response = await fetch("/api/evals/runs", { cache: "no-store" }); const next = response.ok ? await response.json() as EvalRun[] : []; setRuns(next); setActiveRun((current) => current ? next.find((item) => item.id === current.id) || current : next[0]); };
  const loadSettings = async () => { const response = await fetch("/api/settings/image-generation", { cache: "no-store" }); if (response.ok) setGeneration(await response.json() as GenerationSettings); };
  useEffect(() => { void Promise.all([loadCases(), loadRuns(), loadSettings()]); }, []);

  useEffect(() => {
    if (!activeRun || activeRun.status !== "running") return;
    const timer = window.setTimeout(async () => {
      if (advancing.current) return;
      advancing.current = true;
      try {
        const response = await fetch(`/api/evals/runs/${activeRun.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "advance", embedding }) });
        const result = await response.json() as EvalRun & { error?: string };
        if (!response.ok) throw new Error(result.error || "Eval 步骤失败。");
        setActiveRun(result);
        setRuns((current) => current.map((item) => item.id === result.id ? result : item));
      } catch (error) { setMessage(error instanceof Error ? error.message : "Eval 步骤失败。"); }
      finally { advancing.current = false; }
    }, activeRun.cases.some((item) => item.stage === "waiting_generation") ? 1800 : 250);
    return () => window.clearTimeout(timer);
  }, [activeRun, embedding]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []); if (!files.length) return;
    setUploading(true); setMessage("");
    try { const form = new FormData(); files.forEach((file) => form.append("images", file)); const response = await fetch("/api/evals/cases", { method: "POST", body: form }); const result = await response.json() as { error?: string; added?: EvalCase[]; duplicates?: string[] }; if (!response.ok) throw new Error(result.error || "上传失败。"); await loadCases(); setMessage(`已加入 ${result.added?.length || 0} 张${result.duplicates?.length ? `，跳过 ${result.duplicates.length} 张重复图片` : ""}。`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "上传失败。"); }
    finally { setUploading(false); event.target.value = ""; }
  };
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const saveGenerationSelection = async () => {
    const response = await fetch("/api/settings/image-generation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(generation) });
    const result = await response.json() as GenerationSettings & { error?: string };
    if (!response.ok) throw new Error(result.error || "无法保存生图配置。");
    setGeneration(result);
  };
  const create = async () => {
    if (!selected.size || creating) return; setCreating(true); setMessage("正在创建不可变运行记录…");
    try { await saveGenerationSelection(); const response = await fetch("/api/evals/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseIds: [...selected], topK, library }) }); const result = await response.json() as EvalRun & { error?: string }; if (!response.ok) throw new Error(result.error || "无法创建运行。"); setActiveRun(result); setRuns((current) => [result, ...current]); setMessage("运行已创建，正在逐步分析、检索和生成。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "无法创建运行。"); }
    finally { setCreating(false); }
  };
  const action = async (nextAction: "pause" | "resume") => { if (!activeRun) return; const response = await fetch(`/api/evals/runs/${activeRun.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: nextAction }) }); const result = await response.json() as EvalRun & { error?: string }; if (!response.ok) { setMessage(result.error || "无法更新运行。"); return; } setActiveRun(result); setRuns((current) => current.map((item) => item.id === result.id ? result : item)); };
  const providerChange = (provider: "openrouter" | "fal") => setGeneration((current) => ({ ...current, provider, endpoint: provider === "fal" ? "https://queue.fal.run" : "https://openrouter.ai/api/v1", model: provider === "fal" ? "fal-ai/flux-pro/kontext" : "google/gemini-2.5-flash-image" }));
  const activeCaseMap = new Map(cases.map((item) => [item.id, item]));

  return <div className="page eval-page">
    <section className="eval-control">
      <div className="eval-intro"><span className="eyebrow">FIXED IMAGE SET / RESUMABLE RUNS</span><h2>让同一批图片，反复检验你的 Skill。</h2><p>原图只进入临时分析；每次运行保存检索依据、模型任务和结果，不污染正式审美库。</p></div>
      <div className="eval-config-grid">
        <label>生图 Provider<select value={generation.provider} onChange={(event) => providerChange(event.target.value as "openrouter" | "fal")}><option value="openrouter">OpenRouter</option><option value="fal">fal.ai</option></select></label>
        <label>模型 / Endpoint ID<ModelControl settings={generation} onChange={(model) => setGeneration((current) => ({ ...current, model }))}/></label>
        <label>Skill 范围<select value={library} onChange={(event) => setLibrary(event.target.value as Library)}><option value="all">全部已批准 Skill</option><option value="photo">仅照片审美库</option><option value="imported_skill">仅外部 Skill 库</option></select></label>
        <label>Top K<div className="eval-range"><input type="range" min="1" max="10" value={topK} onChange={(event) => setTopK(Number(event.target.value))}/><b>{topK}</b></div></label>
      </div>
      <div className="eval-actions"><label className="eval-upload">{uploading ? "正在写入…" : "+ 添加 Eval 图片"}<input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={upload} disabled={uploading}/></label><button className="text-btn" onClick={onOpenSettings}>完整生图 API 配置 →</button><button className="ink-btn" onClick={create} disabled={!selected.size || creating || !generation.apiKey}>{creating ? "正在创建…" : `运行 ${selected.size} 个 Case →`}</button></div>
      {message && <p className="eval-message">{message}</p>}
    </section>

    <section className="eval-cases"><div className="section-label"><span>EVAL CASES / eval-cases/images</span><small>{selected.size} SELECTED · {cases.length} TOTAL</small></div>{cases.length ? <div className="eval-case-strip">{cases.map((item) => <label key={item.id} className={selected.has(item.id) ? "selected" : ""}><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)}/><img src={`/api/evals/assets?kind=case&id=${item.id}`} alt={item.filename}/><span>{item.filename}</span><small>{(item.size / 1024 / 1024).toFixed(1)} MB · {item.id.slice(0, 8)}</small></label>)}</div> : <div className="eval-empty"><b>＋</b><p>目录还是空的。添加第一批固定测试图。</p></div>}</section>

    <section className="eval-run-layout">
      <aside className="eval-history"><div className="section-label"><span>RUN HISTORY</span><small>{runs.length}</small></div>{runs.map((run) => <button key={run.id} className={activeRun?.id === run.id ? "active" : ""} onClick={() => setActiveRun(run)}><b>{new Date(run.createdAt).toLocaleString()}</b><span>{run.config.provider} · {run.config.model}</span><small>{run.progress.completed}/{run.progress.total} 完成 · {run.progress.failed} 失败</small></button>)}</aside>
      <div className="eval-run-detail">{activeRun ? <><header><div><span className="eyebrow">RUN {activeRun.id.slice(0, 12).toUpperCase()}</span><h3>{activeRun.status === "completed" ? "运行记录已封存" : activeRun.status === "paused" ? "运行已暂停" : "测试正在推进"}</h3><p>{activeRun.config.provider} / {activeRun.config.model} · Top {activeRun.config.topK}</p></div><div className="eval-progress-ring" style={{ "--progress": `${activeRun.progress.percent * 3.6}deg` } as React.CSSProperties}><b>{activeRun.progress.percent}%</b></div><button className="text-btn" onClick={() => action(activeRun.status === "paused" ? "resume" : "pause")} disabled={activeRun.status === "completed"}>{activeRun.status === "paused" ? "恢复" : "暂停"}</button></header><div className="eval-progress"><i style={{ width: `${activeRun.progress.percent}%` }}/></div><div className="eval-results">{activeRun.cases.map((item, index) => <article key={item.caseId} className={`eval-result ${item.stage}`}><div className="eval-result-head"><span>CASE {String(index + 1).padStart(2, "0")}</span><b>{item.filename}</b><em>{stageLabel[item.stage] || item.stage}</em></div><div className="eval-pair"><figure><img src={`/api/evals/assets?kind=case&id=${item.caseId}`} alt="Eval 原图"/><figcaption>SOURCE / SEMANTICS LOCKED</figcaption></figure><figure className={!item.resultFile ? "waiting" : ""}>{item.resultFile ? <img src={`/api/evals/assets?run=${activeRun.id}&file=${encodeURIComponent(item.resultFile)}`} alt="生成结果"/> : <div><b>{item.stage === "failed" ? "×" : "…"}</b><span>{item.error || stageLabel[item.stage]}</span></div>}<figcaption>GENERATED / {activeRun.config.provider.toUpperCase()}</figcaption></figure></div>{item.matches?.length ? <div className="eval-match-list">{item.matches.map((match, rank) => <div key={match.id}><b>0{rank + 1}</b><span>{match.title}<small>{match.libraryType === "photo" ? "照片库" : "Skill 库"} · {match.matchReason}</small></span><em>{match.score.toFixed(3)}</em></div>)}</div> : null}<footer><span>{elapsed(item.timings)}</span>{item.remoteState && <small>REMOTE {item.remoteState.toUpperCase()}{item.remoteId ? ` · ${item.remoteId.slice(0, 12)}` : ""}</small>}</footer></article>)}</div></> : <div className="eval-empty"><b>◎</b><p>创建一次运行后，这里会显示检索轨迹和生成结果。</p></div>}</div>
    </section>
  </div>;
}

export function ImageGenerationSettingsPanel() {
  const [values, setValues] = useState<GenerationSettings>(defaultGeneration);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { fetch("/api/settings/image-generation", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).then((next) => next && setValues(next)).catch(() => undefined); }, []);
  const providerChange = (provider: "openrouter" | "fal") => setValues((current) => ({ ...current, provider, endpoint: provider === "fal" ? "https://queue.fal.run" : "https://openrouter.ai/api/v1", model: provider === "fal" ? "fal-ai/flux-pro/kontext" : "google/gemini-2.5-flash-image" }));
  const save = async () => { setSaving(true); setMessage(""); try { const response = await fetch("/api/settings/image-generation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); const result = await response.json() as GenerationSettings & { error?: string }; if (!response.ok) throw new Error(result.error || "保存失败。"); setValues(result); setMessage("✓ 生图配置已保存到 .env"); } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败。"); } finally { setSaving(false); } };
  return <section className="embedding-sheet generation-settings"><div className="embedding-head"><div><span className="eyebrow">IMAGE GENERATION</span><h3>Eval 生图 Provider</h3><p>密钥只保存在服务端；fal.ai 使用可恢复 Queue 任务。</p></div><div className="embedding-count"><b>{values.provider === "fal" ? "FAL" : "OR"}</b><small>{values.apiKey ? "KEY READY" : "NO KEY"}</small></div></div><div className="settings-sheet embedding-fields"><div className="settings-field"><label>Provider</label><select value={values.provider} onChange={(event) => providerChange(event.target.value as "openrouter" | "fal")}><option value="openrouter">OpenRouter Images</option><option value="fal">fal.ai Queue</option></select></div><div className="settings-field"><label>模型 / Endpoint ID</label><ModelControl settings={values} onChange={(model) => setValues((current) => ({ ...current, model }))}/></div><div className="settings-field full"><label>{values.provider === "fal" ? "Queue API Endpoint" : "API Endpoint"}</label><input value={values.endpoint} readOnly={values.provider === "fal"} onChange={(event) => setValues((current) => ({ ...current, endpoint: event.target.value }))}/>{values.provider === "fal" && <small>fal.ai SDK 固定通过 Queue API 提交；无需拼接模型 ID。</small>}</div><div className="settings-field"><label>API Key</label><div className="key-input"><input type="password" value={values.apiKey} placeholder={values.apiKey === "env-configured" ? "已保存在 .env；更换时粘贴新 Key" : "粘贴生图 API Key"} onChange={(event) => setValues((current) => ({ ...current, apiKey: event.target.value }))}/><span>{values.apiKey ? "● 已配置" : "○ 未输入"}</span></div></div><div className="settings-field"><label>输出格式</label><select value={values.outputFormat} onChange={(event) => setValues((current) => ({ ...current, outputFormat: event.target.value as GenerationSettings["outputFormat"] }))}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></div>{values.provider === "fal" && <><div className="settings-field full"><label>自定义输入 JSON 模板</label><textarea value={values.falInputTemplate} onChange={(event) => setValues((current) => ({ ...current, falInputTemplate: event.target.value }))}/><small>内置预设会自动使用模型字段；自定义 Endpoint 才需要调整。允许：{`{{prompt}} · {{image_url}} · {{image_urls}}`}</small></div><div className="settings-field"><label>结果图片 JSON 路径</label><input value={values.falResultPath} onChange={(event) => setValues((current) => ({ ...current, falResultPath: event.target.value }))}/></div></>}<footer><small>{message || "OpenRouter 使用同步 Images API；fal.ai 保存 request_id 后轮询。"}</small><button className="ink-btn" onClick={save} disabled={saving}>{saving ? "正在保存…" : "保存生图配置"}</button></footer></div></section>;
}
