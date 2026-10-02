export const STYLE_KEYS = [
  "realism",
  "classic",
  "impressionist",
  "bold-expressive",
] as const;

export type StyleKey = (typeof STYLE_KEYS)[number];

export const STYLE_LABELS: Record<StyleKey, string> = {
  realism: "Realism",
  classic: "Classic",
  impressionist: "Impressionist",
  "bold-expressive": "Bold & Expressive",
};
