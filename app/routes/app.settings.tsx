import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { STYLE_KEYS, STYLE_LABELS, type StyleKey } from "../utils/style-keys";
import {
  effectiveStylePrompts,
  saveStylePromptOverrides,
} from "../utils/style-prompts.server";

type SettingsIntent = "limits" | "prompts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const settings = await prisma.shopRateLimit.findUnique({ where: { shop } });
    return {
      dailyLimitLoggedIn: settings?.dailyLimitLoggedIn ?? 5,
      dailyLimitAnonymous: settings?.dailyLimitAnonymous ?? 3,
      stylePrompts: await effectiveStylePrompts(shop),
    };
  } catch {
    return {
      dailyLimitLoggedIn: 5,
      dailyLimitAnonymous: 3,
      stylePrompts: await effectiveStylePrompts(shop),
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "limits") {
      const dailyLimitLoggedIn = parseInt(formData.get("dailyLimitLoggedIn") as string) || 5;
      const dailyLimitAnonymous = parseInt(formData.get("dailyLimitAnonymous") as string) || 3;
      await prisma.shopRateLimit.upsert({
        where: { shop },
        update: { dailyLimitLoggedIn, dailyLimitAnonymous },
        create: { shop, dailyLimitLoggedIn, dailyLimitAnonymous },
      });
      return { success: true, intent, dailyLimitLoggedIn, dailyLimitAnonymous };
    }

    if (intent === "prompts") {
      const stylePrompts = Object.fromEntries(
        STYLE_KEYS.map((key) => [key, String(formData.get(`prompt_${key}`) || "")]),
      ) as Record<StyleKey, string>;
      const savedPrompts = await saveStylePromptOverrides(shop, stylePrompts);
      return { success: true, intent, stylePrompts: savedPrompts };
    }

    return { success: false, error: "Unknown settings section" };
  } catch (error) {
    console.error("[settings] Save failed:", error);
    return {
      success: false,
      intent: intent === "limits" || intent === "prompts" ? intent : undefined,
      error: "Failed to save settings",
    };
  }
};

const LIMITS_MODAL_ID = "save-limits-modal";
const PROMPTS_MODAL_ID = "save-prompts-modal";

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const limitsFormRef = useRef<HTMLFormElement>(null);
  const promptsFormRef = useRef<HTMLFormElement>(null);
  const confirmedSaveRef = useRef(false);
  const saveLockedRef = useRef(false);
  const [view, setView] = useState<SettingsIntent>("limits");

  const isSaving = fetcher.state === "submitting";
  const savedIntent = fetcher.data?.success ? fetcher.data.intent : undefined;
  const dailyLimitLoggedIn =
    fetcher.data?.intent === "limits" && fetcher.data.dailyLimitLoggedIn != null
      ? fetcher.data.dailyLimitLoggedIn
      : data.dailyLimitLoggedIn;
  const dailyLimitAnonymous =
    fetcher.data?.intent === "limits" && fetcher.data.dailyLimitAnonymous != null
      ? fetcher.data.dailyLimitAnonymous
      : data.dailyLimitAnonymous;
  const stylePrompts =
    fetcher.data?.intent === "prompts" && fetcher.data.stylePrompts
      ? fetcher.data.stylePrompts
      : data.stylePrompts;

  useEffect(() => {
    if (fetcher.state === "idle") saveLockedRef.current = false;
  }, [fetcher.state]);

  const openSaveConfirm = (intent: SettingsIntent) => {
    if (isSaving || saveLockedRef.current) return;
    shopify.modal.show(intent === "limits" ? LIMITS_MODAL_ID : PROMPTS_MODAL_ID);
  };

  const confirmSave = (intent: SettingsIntent) => {
    if (isSaving || saveLockedRef.current) return;
    const form = intent === "limits" ? limitsFormRef.current : promptsFormRef.current;
    if (!form) return;
    saveLockedRef.current = true;
    confirmedSaveRef.current = true;
    shopify.modal.hide(intent === "limits" ? LIMITS_MODAL_ID : PROMPTS_MODAL_ID);
    form.requestSubmit();
    if (confirmedSaveRef.current) {
      confirmedSaveRef.current = false;
      saveLockedRef.current = false;
    }
  };

  const onSubmit = (intent: SettingsIntent) => (event: React.FormEvent<HTMLFormElement>) => {
    if (confirmedSaveRef.current) {
      confirmedSaveRef.current = false;
      return;
    }
    event.preventDefault();
    openSaveConfirm(intent);
  };

  return (
    <s-page heading="Generation settings">
      <s-button-group gap="none" accessibilityLabel="Generation settings">
        <s-button
          slot="secondary-actions"
          variant="secondary"
          type="button"
          icon={view === "limits" ? "check" : undefined}
          aria-pressed={view === "limits"}
          onClick={() => setView("limits")}
        >
          Daily Image Generation Limits
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          type="button"
          icon={view === "prompts" ? "check" : undefined}
          aria-pressed={view === "prompts"}
          onClick={() => setView("prompts")}
        >
          Style system prompt
        </s-button>
      </s-button-group>

      <div hidden={view !== "limits"}>
        <fetcher.Form method="post" ref={limitsFormRef} onSubmit={onSubmit("limits")}>
          <input type="hidden" name="intent" value="limits" />
          <s-section heading="Daily Image Generation Limits">
            <s-paragraph>
              Configure how many images each buyer can generate per day.
              These limits help control AI generation costs.
            </s-paragraph>
            <s-stack direction="block" gap="base">
              <s-text-field
                name="dailyLimitLoggedIn"
                label="Logged-in customer daily limit"
                value={String(dailyLimitLoggedIn)}
                details="Maximum images per day for logged-in customers"
              />
              <s-text-field
                name="dailyLimitAnonymous"
                label="Anonymous visitor daily limit"
                value={String(dailyLimitAnonymous)}
                details="Maximum images per day for anonymous visitors (tracked by IP)"
              />
              <s-button
                type="button"
                onClick={() => openSaveConfirm("limits")}
                {...(isSaving && view === "limits" ? { loading: true } : {})}
              >
                Save limits
              </s-button>
              {savedIntent === "limits" && (
                <s-banner tone="success">Daily limits saved.</s-banner>
              )}
              {fetcher.data?.intent === "limits" && fetcher.data.error && (
                <s-banner tone="critical">{fetcher.data.error}</s-banner>
              )}
            </s-stack>
          </s-section>
        </fetcher.Form>
      </div>

      <div hidden={view !== "prompts"}>
        <fetcher.Form method="post" ref={promptsFormRef} onSubmit={onSubmit("prompts")}>
          <input type="hidden" name="intent" value="prompts" />
          <s-section heading="Style system prompt">
            <s-paragraph>
              Each style has a system prompt. Words the buyer enters are placed first,
              then this prompt. If the buyer leaves the field empty, only the system
              prompt is sent. Clear a box and save to restore its default.
            </s-paragraph>
            <s-stack direction="block" gap="base">
              {STYLE_KEYS.map((key) => (
                <s-text-area
                  key={`${key}-${savedIntent === "prompts" ? "saved" : "edit"}`}
                  name={`prompt_${key}`}
                  label={STYLE_LABELS[key]}
                  defaultValue={stylePrompts[key]}
                  rows={6}
                  maxLength={8000}
                  minLength={0}
                  details="Leave blank and save to use the default prompt."
                />
              ))}
              <s-button
                type="button"
                onClick={() => openSaveConfirm("prompts")}
                {...(isSaving && view === "prompts" ? { loading: true } : {})}
              >
                Save prompts
              </s-button>
              {savedIntent === "prompts" && (
                <s-banner tone="success">Style prompts saved.</s-banner>
              )}
              {fetcher.data?.intent === "prompts" && fetcher.data.error && (
                <s-banner tone="critical">{fetcher.data.error}</s-banner>
              )}
            </s-stack>
          </s-section>
        </fetcher.Form>
      </div>

      <s-modal id={LIMITS_MODAL_ID} heading="Save daily limits?" size="small-100">
        <s-paragraph>This updates the daily image generation limits for this store.</s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => confirmSave("limits")}
          {...(isSaving ? { loading: true } : {})}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor={LIMITS_MODAL_ID}
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal id={PROMPTS_MODAL_ID} heading="Save style prompts?" size="small-100">
        <s-paragraph>This updates the style system prompts for this store.</s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => confirmSave("prompts")}
          {...(isSaving ? { loading: true } : {})}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor={PROMPTS_MODAL_ID}
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>

      {view === "limits" ? (
        <s-section slot="aside" heading="How it works">
          <s-paragraph>When a buyer generates an image, the system checks:</s-paragraph>
          <s-unordered-list>
            <s-list-item>
              <strong>Logged-in customers</strong>: Limited by customer ID
            </s-list-item>
            <s-list-item>
              <strong>Anonymous visitors</strong>: Limited by IP address
            </s-list-item>
            <s-list-item>Counter resets daily at UTC midnight</s-list-item>
            <s-list-item>
              If the database is unreachable, the default limit (10/day) is used
            </s-list-item>
          </s-unordered-list>
        </s-section>
      ) : (
        <s-section slot="aside" heading="How prompts are sent">
          <s-paragraph>
            The buyer&apos;s words go first. The system prompt for the selected style follows.
            An empty buyer field sends only the system prompt.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>Each style is saved on its own</s-list-item>
            <s-list-item>Clear a box and save to restore that style&apos;s default</s-list-item>
            <s-list-item>Saving prompts does not change the daily limits</s-list-item>
          </s-unordered-list>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
