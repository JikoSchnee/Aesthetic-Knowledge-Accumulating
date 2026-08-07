export const TYPOGRAPHY_SCHEMA_VERSION = "1.1";

export type TypographyRole = {
  role: string;
  hierarchyLevel: number;
  classification: string;
  anatomy: { width: string; weight: string; contrast: string; xHeight: string; terminals: string; corners: string; counters: string; strokeCharacter: string };
  typesetting: { case: string; alignment: string; tracking: string; leading: string; lineBreakPattern: string; density: string };
  composition: { position: string; scale: string; rotation: string; warp: string; overlap: string; relationshipToImage: string };
  treatment: { fill: string; outline: string; shadow: string; depth: string; texture: string; distortion: string };
};

export type TypographyAndGraphicLanguage = {
  presence: "dominant" | "supporting" | "none";
  constructionMode: "font-based" | "modified-font" | "custom-lettering" | "illustrated-type" | "none";
  baseSkeleton: string;
  letterConstructionRules: string[];
  characterSpecificRedesigns: string[];
  recommendedProductionMethod: "real-font" | "variable-font" | "svg-outline" | "hand-lettering" | "none";
  fontRequired: boolean;
  roles: TypographyRole[];
  pairingStrategy: string;
  graphicDevices: string[];
  substitutionGuidance: { preserve: string[]; avoid: string[]; candidateDirections: Array<{ nameOrCategory: string; reason: string; confidence: "low" | "medium" | "high" }> };
  twoStageComposition: { backgroundInstruction: string; overlayInstruction: string };
  verificationChecks: string[];
  confidence: "low" | "medium" | "high";
};

export const typographyContract = `"typographyAndGraphicLanguage":{"presence":"dominant|supporting|none","constructionMode":"font-based|modified-font|custom-lettering|illustrated-type|none","baseSkeleton":"string","letterConstructionRules":["string"],"characterSpecificRedesigns":["string"],"recommendedProductionMethod":"real-font|variable-font|svg-outline|hand-lettering|none","fontRequired":true,"roles":[{"role":"display|subtitle|body|metadata|caption|logo-like","hierarchyLevel":1,"classification":"string","anatomy":{"width":"string","weight":"string","contrast":"string","xHeight":"string","terminals":"string","corners":"string","counters":"string","strokeCharacter":"string"},"typesetting":{"case":"string","alignment":"string","tracking":"string","leading":"string","lineBreakPattern":"string","density":"string"},"composition":{"position":"string","scale":"string","rotation":"string","warp":"string","overlap":"string","relationshipToImage":"string"},"treatment":{"fill":"string","outline":"string","shadow":"string","depth":"string","texture":"string","distortion":"string"}}],"pairingStrategy":"string","graphicDevices":["string"],"substitutionGuidance":{"preserve":["string"],"avoid":["string"],"candidateDirections":[{"nameOrCategory":"approximate font name or category","reason":"string","confidence":"low|medium|high"}]},"twoStageComposition":{"backgroundInstruction":"how to generate the image without final text","overlayInstruction":"how to add original text later with real fonts or custom vector lettering"},"verificationChecks":["string"],"confidence":"low|medium|high"}`;

export const typographyRules = `Analyze typographic form and layout without transcribing or preserving source wording, logos, or brand identity. First classify constructionMode. Use font-based only for reproducible typesetting; use modified-font when a font skeleton is visibly altered; use custom-lettering for individually drawn glyphs; use illustrated-type when letters and imagery or materials are inseparable. For custom-lettering and illustrated-type set fontRequired false, describe construction rules, and prefer svg-outline or hand-lettering instead of inventing an exact font. Treat named fonts as approximate candidates only; observable anatomy and typesetting evidence are authoritative. Return 2 to 4 candidate directions when typography is present. When presence is none, use constructionMode and production method none, return empty roles and candidates, and still provide safe two-stage instructions and verification checks.`;

export function isTypography(value: unknown): value is TypographyAndGraphicLanguage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TypographyAndGraphicLanguage>;
  if (!item.presence || !["dominant", "supporting", "none"].includes(item.presence) || !item.constructionMode || !["font-based", "modified-font", "custom-lettering", "illustrated-type", "none"].includes(item.constructionMode) || !item.recommendedProductionMethod || !["real-font", "variable-font", "svg-outline", "hand-lettering", "none"].includes(item.recommendedProductionMethod) || typeof item.fontRequired !== "boolean" || typeof item.baseSkeleton !== "string" || !Array.isArray(item.letterConstructionRules) || !Array.isArray(item.characterSpecificRedesigns) || !Array.isArray(item.roles) || !item.substitutionGuidance || !item.twoStageComposition || !Array.isArray(item.verificationChecks) || !item.verificationChecks.length || !["low", "medium", "high"].includes(item.confidence || "")) return false;
  if (item.presence !== "none" && !item.roles.length) return false;
  if (item.presence === "none" && (item.constructionMode !== "none" || item.recommendedProductionMethod !== "none")) return false;
  if (item.constructionMode === "font-based" && !item.fontRequired) return false;
  if (["custom-lettering", "illustrated-type"].includes(item.constructionMode) && item.fontRequired) return false;
  const candidates = item.substitutionGuidance.candidateDirections;
  if (!Array.isArray(candidates) || (item.presence === "none" ? candidates.length !== 0 : candidates.length < 2 || candidates.length > 4)) return false;
  if (typeof item.twoStageComposition.backgroundInstruction !== "string" || typeof item.twoStageComposition.overlayInstruction !== "string") return false;
  return item.roles.every((role) => role && typeof role.role === "string" && Number.isFinite(role.hierarchyLevel) && role.anatomy && role.typesetting && role.composition && role.treatment) && candidates.every((candidate) => candidate && typeof candidate.nameOrCategory === "string" && typeof candidate.reason === "string" && ["low", "medium", "high"].includes(candidate.confidence));
}

export function flattenText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(flattenText);
  return [];
}

export function typographyText(value: unknown) { return flattenText(value).join(" · "); }
