import { useEffect, useRef } from "react";
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

  const dailyLimitLoggedIn = parseInt(formData.get("dailyLimitLoggedIn") as string) || 5;
  const dailyLimitAnonymous = parseInt(formData.get("dailyLimitAnonymous") as string) || 3;
  const stylePrompts = Object.fromEntries(
    STYLE_KEYS.map((key) => [key, String(formData.get(`prompt_${key}`) || "")]),
  ) as Record<StyleKey, string>;

  try {
    await prisma.shopRateLimit.upsert({
      where: { shop },
      update: { dailyLimitLoggedIn, dailyLimitAnonymous },
      create: { shop, dailyLimitLoggedIn, dailyLimitAnonymous },
    });
    const savedPrompts = await saveStylePromptOverrides(shop, stylePrompts);
    return {
      success: true,
      dailyLimitLoggedIn,
      dailyLimitAnonymous,
      stylePrompts: savedPrompts,
    };
  } catch (error) {
    console.error("[settings] Save failed:", error);
    return { success: false, error: "Failed to save settings" };
  }
};

const SAVE_CONFIRM_MODAL_ID = "save-settings-modal";

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);
  const confirmedSaveRef = useRef(false);
  const saveLockedRef = useRef(false);

  const isSaving = fetcher.state === "submitting";

  useEffect(() => {
    if (fetcher.state === "idle") saveLockedRef.current = false;
  }, [fetcher.state]);

  const saved = fetcher.data?.success;
  const stylePrompts = fetcher.data?.stylePrompts || data.stylePrompts;

  const openSaveConfirm = () => {
    if (isSaving || saveLockedRef.current) return;
    shopify.modal.show(SAVE_CONFIRM_MODAL_ID);
  };

  const confirmSave = () => {
    if (isSaving || saveLockedRef.current) return;
    const form = formRef.current;
    if (!form) return;
    saveLockedRef.current = true;
    confirmedSaveRef.current = true;
    shopify.modal.hide(SAVE_CONFIRM_MODAL_ID);
    form.requestSubmit();
    if (confirmedSaveRef.current) {
      confirmedSaveRef.current = false;
      saveLockedRef.current = false;
    }
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    if (confirmedSaveRef.current) {
      confirmedSaveRef.current = false;
      return;
    }
    event.preventDefault();
    openSaveConfirm();
  };

  return (
    <s-page heading="Generation settings">
      <fetcher.Form method="post" ref={formRef} onSubmit={onSubmit}>
        <s-section heading="Daily Image Generation Limits">
          <s-paragraph>
            Configure how many images each buyer can generate per day.
            These limits help control AI generation costs.
          </s-paragraph>

          <s-stack direction="block" gap="base">
            <s-text-field
              name="dailyLimitLoggedIn"
              label="Logged-in customer daily limit"
              value={String(fetcher.data?.dailyLimitLoggedIn ?? data.dailyLimitLoggedIn)}
              details="Maximum images per day for logged-in customers"
            />

            <s-text-field
              name="dailyLimitAnonymous"
              label="Anonymous visitor daily limit"
              value={String(fetcher.data?.dailyLimitAnonymous ?? data.dailyLimitAnonymous)}
              details="Maximum images per day for anonymous visitors (tracked by IP)"
            />
          </s-stack>
        </s-section>

        <s-section heading="Style system prompts">
          <s-paragraph>
            Each style has a system prompt. Words the buyer enters are placed first,
            then this prompt. If the buyer leaves the field empty, only the system
            prompt is sent. Clear a box and save to restore its default.
          </s-paragraph>
          <s-stack direction="block" gap="base">
            {STYLE_KEYS.map((key) => (
              <s-text-area
                key={`${key}-${saved ? "saved" : "edit"}`}
                name={`prompt_${key}`}
                label={STYLE_LABELS[key]}
                defaultValue={stylePrompts[key]}
                rows={6}
                maxLength={8000}
                minLength={0}
                details="Leave blank and save to use the default prompt."
              />
            ))}
          </s-stack>
          <s-button
            type="button"
            onClick={openSaveConfirm}
            {...(isSaving ? { loading: true } : {})}
          >
            Save settings
          </s-button>
          {saved && (
            <s-banner tone="success">
              Settings saved.
            </s-banner>
          )}
          {fetcher.data?.error && (
            <s-banner tone="critical">
              {fetcher.data.error}
            </s-banner>
          )}
        </s-section>
      </fetcher.Form>

      <s-modal id={SAVE_CONFIRM_MODAL_ID} heading="Save changes?" size="small-100">
        <s-paragraph>This will update the store configuration.</s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={confirmSave}
          {...(isSaving ? { loading: true } : {})}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor={SAVE_CONFIRM_MODAL_ID}
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>

      <s-section slot="aside" heading="How it works">
        <s-paragraph>
          When a buyer generates an image, the system checks:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <strong>Logged-in customers</strong>: Limited by customer ID
          </s-list-item>
          <s-list-item>
            <strong>Anonymous visitors</strong>: Limited by IP address
          </s-list-item>
          <s-list-item>
            Counter resets daily at UTC midnight
          </s-list-item>
          <s-list-item>
            If the database is unreachable, the default limit (10/day) is used
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
