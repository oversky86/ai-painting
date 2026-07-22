const STYLE_PROMPTS: Record<string, string> = {
  "classic-oil":
    "Transform this pet photo into a classic oil painting in the style of Dutch Golden Age masters. Use rich, warm tones with visible brushstrokes, dramatic lighting from the left side, and a dark, textured background. The pet should appear noble and dignified, as if sitting for a formal portrait in a grand hall.",
  impressionist:
    "Transform this pet photo into an impressionist painting inspired by Claude Monet and Pierre-Auguste Renoir. Use loose, visible brushstrokes with vibrant, natural light. Emphasize soft color transitions, dappled sunlight effects, and a dreamy garden or outdoor setting. The pet should appear gentle and full of life.",
};

export function buildPrompt(style: string): string {
  return STYLE_PROMPTS[style] || STYLE_PROMPTS["classic-oil"];
}
