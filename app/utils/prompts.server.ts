const STYLE_PROMPTS: Record<string, string> = {
  realism:
    "Create a highly detailed realistic painted portrait of the same pet with faithful anatomy, refined fur detail, natural light, and preserved facial likeness and expression.",
  classic:
    "Create a timeless classical portrait of the same pet with elegant painterly brushwork, warm heirloom lighting, balanced composition, and preserved facial likeness and expression.",
  "classic-oil":
    "Create a timeless classical portrait of the same pet with elegant painterly brushwork, warm heirloom lighting, balanced composition, and preserved facial likeness and expression.",
  impressionist:
    "Create a luminous impressionist portrait of the same pet with soft brushwork, glowing color transitions, and preserved facial likeness and expression.",
  "bold-expressive":
    "Create a bold expressive portrait of the same pet with confident painterly strokes, stronger color movement, contemporary energy, and preserved facial likeness and expression.",
  acrylic:
    "Create a bold expressive portrait of the same pet with confident painterly strokes, stronger color movement, contemporary energy, and preserved facial likeness and expression.",
  "textured-acrylic":
    "Create a bold expressive portrait of the same pet with confident painterly strokes, stronger color movement, contemporary energy, and preserved facial likeness and expression.",
  warm:
    "Create a timeless classical portrait of the same pet with elegant painterly brushwork, warm heirloom lighting, balanced composition, and preserved facial likeness and expression.",
  "warm-painterly":
    "Create a timeless classical portrait of the same pet with elegant painterly brushwork, warm heirloom lighting, balanced composition, and preserved facial likeness and expression.",
};

export function buildPrompt(style: string): string {
  return STYLE_PROMPTS[style] || STYLE_PROMPTS.realism;
}
