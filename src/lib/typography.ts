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

export function typographyValidationErrors(value: unknown, path = "typographyAndGraphicLanguage"): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
  const item = value as Partial<TypographyAndGraphicLanguage>;
  const errors: string[] = [];
  if (!item.presence || !["dominant", "supporting", "none"].includes(item.presence)) errors.push(`${path}.presence must be dominant, supporting, or none`);
  if (!item.constructionMode || !["font-based", "modified-font", "custom-lettering", "illustrated-type", "none"].includes(item.constructionMode)) errors.push(`${path}.constructionMode is invalid`);
  if (!item.recommendedProductionMethod || !["real-font", "variable-font", "svg-outline", "hand-lettering", "none"].includes(item.recommendedProductionMethod)) errors.push(`${path}.recommendedProductionMethod is invalid`);
  if (typeof item.fontRequired !== "boolean") errors.push(`${path}.fontRequired must be boolean`);
  if (typeof item.baseSkeleton !== "string") errors.push(`${path}.baseSkeleton must be a string`);
  if (!Array.isArray(item.letterConstructionRules)) errors.push(`${path}.letterConstructionRules must be an array`);
  if (!Array.isArray(item.characterSpecificRedesigns)) errors.push(`${path}.characterSpecificRedesigns must be an array`);
  if (!Array.isArray(item.roles)) errors.push(`${path}.roles must be an array`);
  if (!item.substitutionGuidance || typeof item.substitutionGuidance !== "object") errors.push(`${path}.substitutionGuidance must be an object`);
  if (!item.twoStageComposition || typeof item.twoStageComposition !== "object") errors.push(`${path}.twoStageComposition must be an object`);
  if (!Array.isArray(item.verificationChecks) || !item.verificationChecks.length) errors.push(`${path}.verificationChecks must contain at least one item`);
  if (!["low", "medium", "high"].includes(item.confidence || "")) errors.push(`${path}.confidence must be low, medium, or high`);
  if (Array.isArray(item.roles)) {
    if (item.presence !== "none" && !item.roles.length) errors.push(`${path}.roles must contain at least one role when typography is present`);
    item.roles.forEach((role, index) => {
      if (!role || typeof role.role !== "string" || !Number.isFinite(role.hierarchyLevel) || !role.anatomy || !role.typesetting || !role.composition || !role.treatment) errors.push(`${path}.roles[${index}] is incomplete`);
    });
  }
  if (item.presence === "none" && item.constructionMode !== "none") errors.push(`${path}.constructionMode must be none when presence is none`);
  if (item.presence === "none" && item.recommendedProductionMethod !== "none") errors.push(`${path}.recommendedProductionMethod must be none when presence is none`);
  if (item.constructionMode === "font-based" && item.fontRequired !== true) errors.push(`${path}.fontRequired must be true for font-based typography`);
  if (["custom-lettering", "illustrated-type"].includes(item.constructionMode || "") && item.fontRequired !== false) errors.push(`${path}.fontRequired must be false for ${item.constructionMode}`);
  const candidates = item.substitutionGuidance?.candidateDirections;
  if (!Array.isArray(candidates)) errors.push(`${path}.substitutionGuidance.candidateDirections must be an array`);
  else {
    if (item.presence === "none" && candidates.length !== 0) errors.push(`${path}.substitutionGuidance.candidateDirections must be empty when presence is none`);
    if (item.presence !== "none" && (candidates.length < 2 || candidates.length > 4)) errors.push(`${path}.substitutionGuidance.candidateDirections must contain 2 to 4 items when typography is present`);
    candidates.forEach((candidate, index) => {
      if (!candidate || typeof candidate.nameOrCategory !== "string" || typeof candidate.reason !== "string" || !["low", "medium", "high"].includes(candidate.confidence)) errors.push(`${path}.substitutionGuidance.candidateDirections[${index}] is incomplete`);
    });
  }
  if (item.twoStageComposition && typeof item.twoStageComposition.backgroundInstruction !== "string") errors.push(`${path}.twoStageComposition.backgroundInstruction must be a string`);
  if (item.twoStageComposition && typeof item.twoStageComposition.overlayInstruction !== "string") errors.push(`${path}.twoStageComposition.overlayInstruction must be a string`);
  return errors;
}

export function isTypography(value: unknown): value is TypographyAndGraphicLanguage {
  return typographyValidationErrors(value).length === 0;
}

export function flattenText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(flattenText);
  return [];
}

export function typographyText(value: unknown) { return flattenText(value).join(" · "); }
