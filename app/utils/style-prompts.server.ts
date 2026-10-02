import prisma from "../db.server";
import {
  DEFAULT_STYLE_PROMPTS,
  STYLE_KEYS,
  isStyleKey,
  type StyleKey,
} from "./prompts.server";

const MAX_PROMPT_LENGTH = 8000;

let tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = prisma
      .$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "ShopStylePrompt" (
          "id" SERIAL PRIMARY KEY,
          "shop" TEXT NOT NULL,
          "styleKey" TEXT NOT NULL,
          "prompt" TEXT NOT NULL,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "ShopStylePrompt_shop_styleKey_key" UNIQUE ("shop", "styleKey")
        )`,
      )
      .then(() => undefined)
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }
  return tableReady;
}

export async function loadStylePromptOverrides(
  shop: string,
): Promise<Partial<Record<StyleKey, string>>> {
  try {
    await ensureTable();
    const rows = await prisma.shopStylePrompt.findMany({ where: { shop } });
    const overrides: Partial<Record<StyleKey, string>> = {};
    for (const row of rows) {
      if (isStyleKey(row.styleKey) && row.prompt.trim()) {
        overrides[row.styleKey] = row.prompt;
      }
    }
    return overrides;
  } catch (error) {
    console.error("[style-prompts] load failed, using defaults", error);
    return {};
  }
}

export async function effectiveStylePrompts(
  shop: string,
): Promise<Record<StyleKey, string>> {
  const overrides = await loadStylePromptOverrides(shop);
  return {
    realism: overrides.realism || DEFAULT_STYLE_PROMPTS.realism,
    classic: overrides.classic || DEFAULT_STYLE_PROMPTS.classic,
    impressionist: overrides.impressionist || DEFAULT_STYLE_PROMPTS.impressionist,
    "bold-expressive":
      overrides["bold-expressive"] || DEFAULT_STYLE_PROMPTS["bold-expressive"],
  };
}

/** Blank or unchanged text removes the shop override so the default is used. */
export async function saveStylePromptOverrides(
  shop: string,
  values: Record<StyleKey, string>,
): Promise<Record<StyleKey, string>> {
  await ensureTable();
  for (const key of STYLE_KEYS) {
    const text = (values[key] || "").trim().slice(0, MAX_PROMPT_LENGTH);
    if (!text || text === DEFAULT_STYLE_PROMPTS[key]) {
      await prisma.shopStylePrompt.deleteMany({ where: { shop, styleKey: key } });
    } else {
      await prisma.shopStylePrompt.upsert({
        where: { shop_styleKey: { shop, styleKey: key } },
        update: { prompt: text },
        create: { shop, styleKey: key, prompt: text },
      });
    }
  }
  return effectiveStylePrompts(shop);
}
