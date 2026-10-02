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

/** Used when the shop has not saved a custom system prompt for that style. */
export const DEFAULT_STYLE_PROMPTS: Record<StyleKey, string> = {
  realism:
    "Convert the photo into a pure oil painting artwork in modern realistic style, built on the structural and light-shadow logic of real objects. Only retain the main subject, remove redundant distracting elements. It features photo-realistic detail restoration paired with the exclusive artistic texture of hand-painted oil works. Natural layered brushstrokes or thick impasto textures can be retained as required by creation. It discards the heavy dark backdrops typical of classical oil paintings, utilizing clean, soft color schemes and minimalist, heavily blurred backgrounds to emphasize the main subject. While maintaining rigorous realistic modeling, it preserves the handmade expressive quality of painting. The result achieves lifelike realistic visuals yet differs from plain digital photos, carrying a unique artistic ambiance formed by canvas texture and stacked paint layers, perfectly suited for tracing and copying by most painters.",
  classic:
    "masterpiece, top-tier museum antique oil painting, 19th century European realistic classical oil painting, extremely massive rough impasto thick paint brushstrokes, heavy uneven mottled paint texture, distinct broken wide mottled brush marks, prominent jagged patchy stacked paint layers, obvious rough visible canvas weave grain, heavily piled uneven raised paint surface, classic Rembrandt chiaroscuro soft studio diffused lighting, the main subject from reference picture is the absolute core focus, occupies most of the picture frame, fully retain the complete full body of the subject without any cropping, strictly do not modify the original color of hair, fur, feather, skin or scale, keep all original facial features, eyes, nose, lip contours, body skeleton shape, all natural texture markings, all clothing, collars, ornaments and accessories 100% consistent with reference image, subject complete and intact with no partial cut-off, stable balanced classical portrait composition, pure dark muted gradient solid color background, completely empty background without any extra physical objects, no landscapes, furniture, plants, decorative ornaments, dark earth tone background perfectly harmonized with the inherent color tone of the main subject, unified low-saturation vintage dark color palette, soft hazy dark mottled smudged background, natural shallow depth of field blurring, realistic delicate texture of human skin / fluffy animal fur / bird feather / creature scale fully sculpted by large broken mottled impasto brush strokes, multi-layer delicate soft gradient shadow layering, authentic aged vintage oil painting surface texture, subtle faded antique matte tone, 16K ultra high definition, fine painting detail rendering, cinematic texture",
  impressionist:
    "Uploaded reference image is the absolute main subject of the picture, all entities including characters, pets and other subjects keep their whole body intact without cropping, strictly lock the original outline, retain natural skin/fur color, complete set of clothes and all ornaments, zero changes to the shape, color and accessories of all subjects; the main entity occupies over 90% of the frame, all visual attention focuses on the main subject; intensified authentic Monet Impressionist oil painting style, tiny, short and jumping brushstrokes, multi-layer thin oil paint glazing, optical color theory of atmospheric perspective, warm golden flowing natural afternoon sunlight, soft diffused light filtered through thin air mist, gentle blending and diffusion of warm and cool tones, translucent overlapping paint layers, rough uneven linen canvas texture, uneven stacked paint texture; prominent oil painting style, clear and distinguishable brush marks, suitable and convenient for painters to copy and study; no physical objects in the background, no flowers, trees, buildings or streams, the background is only composed of soft hazy gradient color blocks in Monet's style, moderately increased color saturation with bright and transparent hues, the tone of color blocks naturally matches and coordinates with the original skin/fur and clothing colors of the main subject, extremely blurred diffused soft-focus fog texture, vague soft boundaries without sharp outlines, all color blocks smudge and blend layer by layer, unified and harmonious overall tone, the background is extremely weakened and will not compete with the main subject; 8K ultra HD, museum gallery oil painting texture, intact clear facial features of all subjects, no distortion or warping, realistic original form with pure Monet oil painting aesthetic, soft quiet warm and healing overall tone",
  "bold-expressive":
    "Henri Matisse Fauvism oil painting, master composition, the subject from the reference image is the absolute core of the picture, occupying most of the frame, fully displaying the complete subject without cropping, 100% faithfully restoring the subject's original body shape, skin/fur color, physical features and all costume and accessory details with zero deviation, seamless and smooth color block transition, no thick and harsh outline lines, soft edge fusion, bright and pure high-saturation solid color palette, authentic Henri Matisse Fauvism texture, thick textured brush strokes, natural canvas grain texture, ultra-high detail, 8K ultra HD, soft and mild color contrast, pure oil painting effect, vivid and elegant Fauvism artistic texture",
};

const STYLE_ALIASES: Record<string, StyleKey> = {
  realism: "realism",
  realistic: "realism",
  classic: "classic",
  "classic-oil": "classic",
  warm: "classic",
  "warm-painterly": "classic",
  impressionist: "impressionist",
  "bold-expressive": "bold-expressive",
  bold: "bold-expressive",
  acrylic: "bold-expressive",
  "textured-acrylic": "bold-expressive",
};

export function normalizeStyleKey(style: string | null | undefined): StyleKey {
  const key = (style || "")
    .trim()
    .toLowerCase()
    .replace(/[$&\s_]+/g, "-")
    .replace(/-+/g, "-");
  return STYLE_ALIASES[key] || "realism";
}

export function isStyleKey(value: string): value is StyleKey {
  return (STYLE_KEYS as readonly string[]).includes(value);
}

/**
 * Buyer words come first. The style system prompt is appended after them.
 * With no buyer words, only the system prompt is sent.
 */
export function composeGenerationPrompt(
  userPrompt: string | null | undefined,
  systemPrompt: string,
): string {
  const user = (userPrompt || "").trim();
  const system = systemPrompt.trim();
  if (user && system) return `${user}\n\n${system}`;
  return user || system;
}

export function resolveSystemPrompt(
  style: string | null | undefined,
  overrides?: Partial<Record<StyleKey, string>> | null,
): string {
  const key = normalizeStyleKey(style);
  const custom = overrides?.[key]?.trim();
  return custom || DEFAULT_STYLE_PROMPTS[key];
}

export function buildGenerationPrompt(
  style: string | null | undefined,
  userPrompt: string | null | undefined,
  overrides?: Partial<Record<StyleKey, string>> | null,
): string {
  return composeGenerationPrompt(userPrompt, resolveSystemPrompt(style, overrides));
}
