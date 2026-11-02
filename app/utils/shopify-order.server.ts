import {
  BUSINESS_STATUSES,
  normalizeBusinessStatus,
  type BusinessStatus,
} from "./business-status.server";

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/** Carrier names Shopify uses for automatic tracking links. */
export const TRACKING_COMPANIES = ["UPS", "FedEx"] as const;

export function isTrackingCompany(value: string): boolean {
  return (TRACKING_COMPANIES as readonly string[]).includes(value);
}

export async function getOrderBusinessStatus(
  admin: AdminClient,
  orderGid: string,
): Promise<BusinessStatus> {
  return normalizeBusinessStatus(await readOrderBusinessStatusValue(admin, orderGid));
}

/**
 * A fulfilled order is shipped, unless the supplier has already moved it to
 * delivered or archived. Those metafield values stay, because a delivered
 * order is still FULFILLED in Shopify.
 */
export function effectiveBusinessStatus(
  metafieldValue: string | null | undefined,
  displayFulfillmentStatus: string | null | undefined,
): BusinessStatus {
  const status = normalizeBusinessStatus(metafieldValue);
  if (status === "delivered" || status === "archived") return status;
  if ((displayFulfillmentStatus || "").toUpperCase() === "FULFILLED") return "shipped";
  return status;
}

const BLOCKED_FINANCIAL_STATUSES = new Set(["REFUNDED", "VOIDED"]);

/** Why no portrait or review work may happen on this order, or null when it may. */
export function orderBlockReason(order: {
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
}): string | null {
  if (order.cancelledAt) return "This order was cancelled.";
  if (BLOCKED_FINANCIAL_STATUSES.has((order.displayFinancialStatus || "").toUpperCase())) {
    return "This order was refunded.";
  }
  return null;
}

export type OrderGate = {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  customerId: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  /** Raw metafield value. */
  metafieldStatus: string | null;
  businessStatus: BusinessStatus;
  blockReason: string | null;
};

/** Live order state for one order; null when Shopify doesn't return the order. */
export async function fetchOrderGate(
  admin: AdminClient,
  orderGid: string,
): Promise<OrderGate | null> {
  const response = await admin.graphql(
    `#graphql
    query OrderGate($id: ID!) {
      order(id: $id) {
        id
        name
        email
        createdAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        customer { id }
        businessStatus: metafield(namespace: "custom", key: "business_status") {
          value
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await response.json();
  if (json?.errors?.length) {
    throw new Error(json.errors[0].message || "Failed to load Shopify order");
  }
  const order = json?.data?.order;
  if (!order?.id) return null;
  const metafieldStatus = order.businessStatus?.value || null;
  return {
    id: order.id,
    name: order.name || "",
    email: order.email || null,
    createdAt: order.createdAt,
    customerId: order.customer?.id || null,
    cancelledAt: order.cancelledAt || null,
    displayFinancialStatus: order.displayFinancialStatus || null,
    displayFulfillmentStatus: order.displayFulfillmentStatus || null,
    metafieldStatus,
    businessStatus: effectiveBusinessStatus(metafieldStatus, order.displayFulfillmentStatus),
    blockReason: orderBlockReason(order),
  };
}

/** Best-effort: brings a stale metafield in line with the effective status (e.g. fulfilled in Shopify admin). */
export async function syncBusinessStatusMetafield(
  admin: AdminClient,
  shop: string,
  gate: Pick<OrderGate, "id" | "metafieldStatus" | "businessStatus">,
): Promise<void> {
  if (gate.metafieldStatus === gate.businessStatus) return;
  if (gate.businessStatus !== "shipped") return;
  await setOrderBusinessStatus(admin, shop, gate.id, "shipped").catch((err) =>
    console.error("[shopify-order] status sync failed", gate.id, err),
  );
}

/** Raw metafield value; null when the order has never been given a status. */
export async function readOrderBusinessStatusValue(
  admin: AdminClient,
  orderGid: string,
): Promise<string | null> {
  const response = await admin.graphql(
    `#graphql
    query OrderBusinessStatus($id: ID!) {
      order(id: $id) {
        id
        businessStatus: metafield(namespace: "custom", key: "business_status") {
          value
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await response.json();
  return json?.data?.order?.businessStatus?.value || null;
}

/** Shopify rejects a repeated status when the definition has unique values turned on. */
export function isUniqueMetafieldValueError(message: string): boolean {
  return /already assigned to another metafield/i.test(message);
}

/** The choice list on the definition does not include this status yet. */
export function isMissingStatusChoiceError(message: string): boolean {
  return /does not exist in provided choices/i.test(message);
}

function firstGraphqlMessage(json: {
  errors?: Array<{ message?: string }>;
}): string | null {
  const message = json?.errors?.[0]?.message;
  return message || null;
}

/**
 * Order status is shared by many orders. If the definition was saved with unique
 * values, turn that off. Shopify will not disable the capability in place, so
 * the definition is recreated without it and existing values are kept.
 */
export async function ensureBusinessStatusRepeatable(
  admin: AdminClient,
): Promise<{ ok: boolean; message: string }> {
  const found = await admin.graphql(
    `#graphql
    query FindBusinessStatusUnique {
      metafieldDefinitions(
        first: 1
        ownerType: ORDER
        namespace: "custom"
        key: "business_status"
      ) {
        nodes {
          id
          capabilities { uniqueValues { enabled } }
        }
      }
    }`,
  );
  const foundJson = await found.json();
  const foundError = firstGraphqlMessage(foundJson);
  if (foundError) return { ok: false, message: foundError };
  const def = foundJson?.data?.metafieldDefinitions?.nodes?.[0];
  if (!def?.id) return { ok: true, message: "no business_status definition" };
  if (def.capabilities?.uniqueValues?.enabled !== true) {
    return { ok: true, message: "business_status already allows repeated values" };
  }

  const disabled = await admin.graphql(
    `#graphql
    mutation DisableUniqueBusinessStatus($definition: MetafieldDefinitionUpdateInput!) {
      metafieldDefinitionUpdate(definition: $definition) {
        updatedDefinition { capabilities { uniqueValues { enabled } } }
        userErrors { message }
      }
    }`,
    {
      variables: {
        definition: {
          namespace: "custom",
          key: "business_status",
          ownerType: "ORDER",
          capabilities: { uniqueValues: { enabled: false } },
        },
      },
    },
  );
  const disabledJson = await disabled.json();
  const disabledTop = firstGraphqlMessage(disabledJson);
  const updated = disabledJson?.data?.metafieldDefinitionUpdate?.updatedDefinition;
  const disableErrors = disabledJson?.data?.metafieldDefinitionUpdate?.userErrors;
  if (
    !disabledTop &&
    !disableErrors?.length &&
    updated?.capabilities?.uniqueValues?.enabled === false
  ) {
    return { ok: true, message: "unique values disabled" };
  }

  const removed = await admin.graphql(
    `#graphql
    mutation DeleteUniqueBusinessStatus($id: ID!, $deleteAllAssociatedMetafields: Boolean!) {
      metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: $deleteAllAssociatedMetafields) {
        deletedDefinitionId
        userErrors { message }
      }
    }`,
    { variables: { id: def.id, deleteAllAssociatedMetafields: false } },
  );
  const removedJson = await removed.json();
  const deleteTop = firstGraphqlMessage(removedJson);
  const deleteErrors = removedJson?.data?.metafieldDefinitionDelete?.userErrors;
  if (deleteTop || deleteErrors?.length) {
    return {
      ok: false,
      message: deleteTop || deleteErrors[0].message || "Could not update business_status",
    };
  }

  const created = await admin.graphql(
    `#graphql
    mutation RecreateBusinessStatus($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id capabilities { uniqueValues { enabled } } }
        userErrors { message code }
      }
    }`,
    {
      variables: {
        definition: {
          name: "business_status",
          namespace: "custom",
          key: "business_status",
          description: "Order progress shared by every order",
          type: "single_line_text_field",
          ownerType: "ORDER",
          pin: true,
          access: {
            admin: "PUBLIC_READ_WRITE",
            storefront: "PUBLIC_READ",
            customerAccount: "READ",
          },
        },
      },
    },
  );
  const createdJson = await created.json();
  const createTop = firstGraphqlMessage(createdJson);
  if (createTop) return { ok: false, message: createTop };
  const createErrors = createdJson?.data?.metafieldDefinitionCreate?.userErrors;
  if (createErrors?.length) {
    const duplicate = createErrors.some(
      (error: { code?: string }) => error.code === "TAKEN" || error.code === "DUPLICATE",
    );
    if (!duplicate) {
      return { ok: false, message: createErrors[0].message || "Could not recreate business_status" };
    }
  }
  const stillUnique =
    createdJson?.data?.metafieldDefinitionCreate?.createdDefinition?.capabilities?.uniqueValues
      ?.enabled === true;
  if (stillUnique) return { ok: false, message: "business_status is still unique" };
  return { ok: true, message: "business_status recreated without unique values" };
}

const reviewLinkReady = new Set<string>();

/**
 * `custom` is a merchant namespace, so Shopify rejects access.admin other than
 * public read-write. Storefront and customer-account reads stay closed.
 * A definition problem must not block the business-status write.
 */
export async function ensureReviewLinkDefinition(
  admin: AdminClient,
  shop: string,
): Promise<void> {
  if (reviewLinkReady.has(shop)) return;
  try {
    const found = await admin.graphql(
      `#graphql
      query FindReviewLinkDef {
        metafieldDefinitions(
          first: 1
          ownerType: ORDER
          namespace: "custom"
          key: "review_link"
        ) {
          nodes { id }
        }
      }`,
    );
    const foundJson = await found.json();
    const foundError = firstGraphqlMessage(foundJson);
    if (foundError) throw new Error(foundError);
    if (foundJson?.data?.metafieldDefinitions?.nodes?.[0]?.id) {
      reviewLinkReady.add(shop);
      return;
    }

    const create = (access?: { storefront: "NONE"; customerAccount: "NONE" }) =>
      admin.graphql(
        `#graphql
        mutation CreateReviewLink($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { message code }
          }
        }`,
        {
          variables: {
            definition: {
              name: "Order link",
              namespace: "custom",
              key: "review_link",
              description: "7-day link to this order on the account site",
              type: "single_line_text_field",
              ownerType: "ORDER",
              ...(access ? { access } : {}),
            },
          },
        },
      );

    let createdJson = await (await create({ storefront: "NONE", customerAccount: "NONE" })).json();
    let createErrors = createdJson?.data?.metafieldDefinitionCreate?.userErrors || [];
    if (firstGraphqlMessage(createdJson) || createErrors.length) {
      createdJson = await (await create()).json();
      createErrors = createdJson?.data?.metafieldDefinitionCreate?.userErrors || [];
    }
    const createError = firstGraphqlMessage(createdJson);
    if (createError) throw new Error(createError);
    const duplicate = createErrors.some(
      (error: { code?: string }) => error.code === "TAKEN" || error.code === "DUPLICATE",
    );
    if (createErrors.length && !duplicate) {
      throw new Error(createErrors[0].message || "Could not create review_link");
    }
    reviewLinkReady.add(shop);
  } catch (err) {
    console.error("[shopify-order] review_link definition skipped", shop, err);
  }
}

const portraitVersionReady = new Set<string>();

/** Lets Flow read the version that started this review. A definition problem must not block the status write. */
export async function ensurePortraitVersionDefinition(
  admin: AdminClient,
  shop: string,
): Promise<void> {
  if (portraitVersionReady.has(shop)) return;
  try {
    const found = await admin.graphql(
      `#graphql
      query FindPortraitVersionDef {
        metafieldDefinitions(
          first: 1
          ownerType: ORDER
          namespace: "custom"
          key: "portrait_version"
        ) {
          nodes { id }
        }
      }`,
    );
    const foundJson = await found.json();
    const foundError = firstGraphqlMessage(foundJson);
    if (foundError) throw new Error(foundError);
    if (foundJson?.data?.metafieldDefinitions?.nodes?.[0]?.id) {
      portraitVersionReady.add(shop);
      return;
    }

    const create = (access?: { storefront: "NONE"; customerAccount: "NONE" }) =>
      admin.graphql(
        `#graphql
        mutation CreatePortraitVersion($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { message code }
          }
        }`,
        {
          variables: {
            definition: {
              name: "Portrait version",
              namespace: "custom",
              key: "portrait_version",
              description: "Portrait version submitted for the current review",
              type: "single_line_text_field",
              ownerType: "ORDER",
              ...(access ? { access } : {}),
            },
          },
        },
      );

    let createdJson = await (await create({ storefront: "NONE", customerAccount: "NONE" })).json();
    let createErrors = createdJson?.data?.metafieldDefinitionCreate?.userErrors || [];
    if (firstGraphqlMessage(createdJson) || createErrors.length) {
      createdJson = await (await create()).json();
      createErrors = createdJson?.data?.metafieldDefinitionCreate?.userErrors || [];
    }
    const duplicate = createErrors.some(
      (error: { code?: string }) => error.code === "TAKEN" || error.code === "DUPLICATE",
    );
    if (createErrors.length && !duplicate && !firstGraphqlMessage(createdJson)) {
      throw new Error(createErrors[0].message || "Could not create portrait_version");
    }
    portraitVersionReady.add(shop);
  } catch (err) {
    console.error("[shopify-order] portrait_version definition skipped", shop, err);
  }
}

const REVIEW_WAITING_TAG = "review-waiting";
const reviewScheduleReady = new Set<string>();

/**
 * Scheduled Flow for portrait review reminders. Do not use Wait.
 *
 * One workflow per store, trigger Scheduled time, shortest repeat the admin allows.
 * Get order data with query `tag:review-waiting`. For each order:
 * - Continue only when custom.business_status is portrait_review and custom.review_due_at is past.
 * - If custom.review_sent_count is below 3, send the transactional email using custom.review_link,
 *   then set review_sent_count to Run code nextCount and review_due_at to
 *   `{{ scheduledAt | date_plus: "1 day" }}`. Keep those updates in the same run, with no Wait
 *   before them, so the Run code output stays selectable.
 * - If custom.review_sent_count is already 3, Cancel order with Refund off, Reason Other,
 *   notifyCustomer off, and remove the review-waiting tag.
 * The first review email stays on the existing business_status workflow.
 */
async function ensureReviewScheduleDefinitions(
  admin: AdminClient,
  shop: string,
): Promise<void> {
  if (reviewScheduleReady.has(shop)) return;
  const fields = [
    {
      key: "review_due_at",
      name: "Review due at",
      type: "date_time",
      description: "When the next portrait review reminder may be sent",
    },
    {
      key: "review_sent_count",
      name: "Review sent count",
      type: "single_line_text_field",
      description: "How many portrait review reminders have been sent for this round",
    },
  ];
  try {
    for (const field of fields) {
      const found = await admin.graphql(
        `#graphql
        query FindReviewScheduleDef($key: String!) {
          metafieldDefinitions(
            first: 1
            ownerType: ORDER
            namespace: "custom"
            key: $key
          ) {
            nodes { id }
          }
        }`,
        { variables: { key: field.key } },
      );
      const foundJson = await found.json();
      const foundError = firstGraphqlMessage(foundJson);
      if (foundError) throw new Error(foundError);
      if (foundJson?.data?.metafieldDefinitions?.nodes?.[0]?.id) continue;

      const create = (access?: { storefront: "NONE"; customerAccount: "NONE" }) =>
        admin.graphql(
          `#graphql
          mutation CreateReviewScheduleDef($definition: MetafieldDefinitionInput!) {
            metafieldDefinitionCreate(definition: $definition) {
              createdDefinition { id }
              userErrors { message code }
            }
          }`,
          {
            variables: {
              definition: {
                name: field.name,
                namespace: "custom",
                key: field.key,
                description: field.description,
                type: field.type,
                ownerType: "ORDER",
                ...(access ? { access } : {}),
              },
            },
          },
        );
      let createdJson = await (await create({ storefront: "NONE", customerAccount: "NONE" })).json();
      let createErrors = createdJson?.data?.metafieldDefinitionCreate?.userErrors || [];
      if (firstGraphqlMessage(createdJson) || createErrors.length) {
        createdJson = await (await create()).json();
        createErrors = createdJson?.data?.metafieldDefinitionCreate?.userErrors || [];
      }
      const duplicate = createErrors.some(
        (error: { code?: string }) => error.code === "TAKEN" || error.code === "DUPLICATE",
      );
      if (createErrors.length && !duplicate && !firstGraphqlMessage(createdJson)) {
        throw new Error(createErrors[0].message || `Could not create ${field.key}`);
      }
    }
    reviewScheduleReady.add(shop);
  } catch (err) {
    console.error("[shopify-order] review schedule definition skipped", shop, err);
  }
}

function reviewDueAt(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

async function setReviewWaitingTag(
  admin: AdminClient,
  orderGid: string,
  active: boolean,
): Promise<void> {
  const mutation = active ? "tagsAdd" : "tagsRemove";
  try {
    if (active) {
      await admin.graphql(
        `#graphql
        mutation ClearReviewWaiting($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) { userErrors { message } }
        }`,
        { variables: { id: orderGid, tags: [REVIEW_WAITING_TAG] } },
      );
    }
    const response = await admin.graphql(
      `#graphql
      mutation SetReviewWaiting($id: ID!, $tags: [String!]!) {
        ${mutation}(id: $id, tags: $tags) { userErrors { message } }
      }`,
      { variables: { id: orderGid, tags: [REVIEW_WAITING_TAG] } },
    );
    const json = await response.json();
    const errors = json?.data?.[mutation]?.userErrors;
    if (errors?.length) {
      console.error("[shopify-order] review-waiting tag skipped", orderGid, errors[0].message);
    }
  } catch (err) {
    console.error("[shopify-order] review-waiting tag skipped", orderGid, err);
  }
}

async function writeOrderBusinessStatus(
  admin: AdminClient,
  orderGid: string,
  status: BusinessStatus,
  reviewLink: string | null,
  portraitVersion: string | null,
  startReviewSchedule: boolean,
): Promise<void> {
  const metafields = [
    {
      ownerId: orderGid,
      namespace: "custom",
      key: "business_status",
      type: "single_line_text_field",
      value: status,
    },
    ...(reviewLink
      ? [
          {
            ownerId: orderGid,
            namespace: "custom",
            key: "review_link",
            type: "single_line_text_field",
            value: reviewLink,
          },
        ]
      : []),
    ...(portraitVersion
      ? [
          {
            ownerId: orderGid,
            namespace: "custom",
            key: "portrait_version",
            type: "single_line_text_field",
            value: portraitVersion,
          },
        ]
      : []),
    ...(startReviewSchedule
      ? [
          {
            ownerId: orderGid,
            namespace: "custom",
            key: "review_due_at",
            type: "date_time",
            value: reviewDueAt(),
          },
          {
            ownerId: orderGid,
            namespace: "custom",
            key: "review_sent_count",
            type: "single_line_text_field",
            value: "0",
          },
        ]
      : []),
  ];
  const response = await admin.graphql(
    `#graphql
    mutation SetBusinessStatus($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { message field }
      }
    }`,
    { variables: { metafields } },
  );
  const json = await response.json();
  const errors = json?.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(errors[0].message || "Failed to set business_status");
  }
}

const statusChoicesReady = new Set<string>();

/**
 * Older definitions only list the original five statuses. Add delivered and
 * archived when that choice list is present, and leave an open text field alone.
 */
export async function ensureBusinessStatusChoices(
  admin: AdminClient,
  shop: string,
): Promise<{ ok: boolean; message: string }> {
  if (statusChoicesReady.has(shop)) {
    return { ok: true, message: "business_status choices already include every status" };
  }
  const found = await admin.graphql(
    `#graphql
    query FindBusinessStatusChoices {
      metafieldDefinitions(
        first: 1
        ownerType: ORDER
        namespace: "custom"
        key: "business_status"
      ) {
        nodes { validations { name value } }
      }
    }`,
  );
  const foundJson = await found.json();
  const foundError = firstGraphqlMessage(foundJson);
  if (foundError) return { ok: false, message: foundError };
  const validations: Array<{ name?: string; value?: string }> =
    foundJson?.data?.metafieldDefinitions?.nodes?.[0]?.validations || [];
  const choices = validations.find((item) => item.name === "choices");
  if (!choices?.value) {
    statusChoicesReady.add(shop);
    return { ok: true, message: "business_status has no choice list" };
  }
  let current: string[] = [];
  try {
    const parsed = JSON.parse(choices.value) as unknown;
    current = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return { ok: false, message: "business_status choices could not be read" };
  }
  const missing = BUSINESS_STATUSES.filter((status) => !current.includes(status));
  if (!missing.length) {
    statusChoicesReady.add(shop);
    return { ok: true, message: "business_status choices already include every status" };
  }
  const next = [...current];
  for (const status of BUSINESS_STATUSES) {
    if (!next.includes(status)) next.push(status);
  }
  const update = await admin.graphql(
    `#graphql
    mutation ExpandBusinessStatusChoices($definition: MetafieldDefinitionUpdateInput!) {
      metafieldDefinitionUpdate(definition: $definition) {
        updatedDefinition { id }
        userErrors { message }
      }
    }`,
    {
      variables: {
        definition: {
          namespace: "custom",
          key: "business_status",
          ownerType: "ORDER",
          validations: validations.map((item) =>
            item.name === "choices"
              ? { name: "choices", value: JSON.stringify(next) }
              : { name: item.name, value: item.value },
          ),
        },
      },
    },
  );
  const updateJson = await update.json();
  const updateError = firstGraphqlMessage(updateJson);
  if (updateError) return { ok: false, message: updateError };
  const userErrors = updateJson?.data?.metafieldDefinitionUpdate?.userErrors || [];
  if (userErrors.length) {
    return { ok: false, message: userErrors[0].message || "Could not update business_status choices" };
  }
  statusChoicesReady.add(shop);
  return { ok: true, message: "business_status choices updated" };
}

export async function setOrderBusinessStatus(
  admin: AdminClient,
  shop: string,
  orderGid: string,
  status: BusinessStatus,
  portraitVersion: string | null = null,
  previousStatus: BusinessStatus | null = null,
): Promise<void> {
  const { orderReviewLinkValue } = await import("./order-link.server");
  let reviewLink: string | null = null;
  try {
    reviewLink = await orderReviewLinkValue(admin, shop, orderGid, status);
  } catch (err) {
    console.error("[shopify-order] review link skipped", orderGid, err);
  }
  const startReviewSchedule = Boolean(portraitVersion);
  const stopReviewSchedule = previousStatus === "portrait_review" && status !== "portrait_review";
  if (reviewLink) await ensureReviewLinkDefinition(admin, shop);
  if (portraitVersion) await ensurePortraitVersionDefinition(admin, shop);
  if (startReviewSchedule) await ensureReviewScheduleDefinitions(admin, shop);
  await ensureBusinessStatusChoices(admin, shop).catch((err) => {
    console.error("[shopify-order] business status choices skipped", shop, err);
  });
  const write = (link: string | null) =>
    writeOrderBusinessStatus(admin, orderGid, status, link, portraitVersion, startReviewSchedule);
  try {
    await write(reviewLink);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (isMissingStatusChoiceError(message)) {
      statusChoicesReady.delete(shop);
      const expanded = await ensureBusinessStatusChoices(admin, shop);
      if (!expanded.ok) throw err;
      try {
        await write(reviewLink);
      } catch (retryErr) {
        if (!reviewLink) throw retryErr;
        const retryMessage = retryErr instanceof Error ? retryErr.message : "";
        if (isMissingStatusChoiceError(retryMessage)) throw retryErr;
        console.error("[shopify-order] review link write skipped", orderGid, retryErr);
        await write(null);
      }
    } else if (isUniqueMetafieldValueError(message)) {
      const relaxed = await ensureBusinessStatusRepeatable(admin);
      if (!relaxed.ok) throw err;
      try {
        await write(reviewLink);
      } catch (retryErr) {
        if (!reviewLink) throw retryErr;
        console.error("[shopify-order] review link write skipped", orderGid, retryErr);
        await write(null);
      }
    } else if (!reviewLink) {
      throw err;
    } else {
      console.error("[shopify-order] review link write skipped", orderGid, err);
      await write(null);
    }
  }
  if (startReviewSchedule) await setReviewWaitingTag(admin, orderGid, true);
  if (stopReviewSchedule) await setReviewWaitingTag(admin, orderGid, false);
}

export async function enableBusinessStatusCustomerRead(
  admin: AdminClient,
): Promise<{ ok: boolean; message: string }> {
  const find = await admin.graphql(
    `#graphql
    query FindBusinessStatusDef {
      metafieldDefinitions(
        first: 20
        ownerType: ORDER
        namespace: "custom"
        key: "business_status"
      ) {
        nodes { id name namespace key }
      }
    }`,
  );
  const findJson = await find.json();
  const def = findJson?.data?.metafieldDefinitions?.nodes?.[0];
  if (!def?.id) {
    return {
      ok: false,
      message: "custom.business_status definition not found on this shop",
    };
  }

  const update = await admin.graphql(
    `#graphql
    mutation EnableCustomerRead($definition: MetafieldDefinitionUpdateInput!) {
      metafieldDefinitionUpdate(definition: $definition) {
        updatedDefinition { id }
        userErrors { message field }
      }
    }`,
    {
      variables: {
        definition: {
          id: def.id,
          access: {
            customerAccount: "READ",
            admin: "MERCHANT_READ_WRITE",
          },
        },
      },
    },
  );
  const updateJson = await update.json();
  const errors = updateJson?.data?.metafieldDefinitionUpdate?.userErrors;
  if (errors?.length) {
    return { ok: false, message: errors[0].message };
  }
  return { ok: true, message: "customerAccount READ enabled" };
}

type FulfillmentOrderNode = {
  id: string;
  status: string;
  supportedActions?: Array<{ action: string }>;
  lineItems?: { nodes: Array<{ id: string; remainingQuantity: number }> };
};

const DONE_FULFILLMENT_ORDER_STATUSES = new Set(["CLOSED", "CANCELLED"]);

/**
 * Fulfills every remaining fulfillment order on the order. Fulfillment orders
 * can sit at different locations and one fulfillmentCreate call only accepts a
 * single location, so each is fulfilled separately. Safe to call again after a
 * partial failure: closed fulfillment orders are skipped. Throws when nothing
 * was or could be fulfilled (for example, every fulfillment order was cancelled).
 */
export async function createOrderFulfillment(
  admin: AdminClient,
  orderGid: string,
  tracking: { company: string; number: string },
): Promise<{ fulfilledCount: number; alreadyFulfilled: boolean }> {
  const foResponse = await admin.graphql(
    `#graphql
    query OrderFulfillmentOrders($id: ID!) {
      order(id: $id) {
        id
        fulfillmentOrders(first: 20) {
          nodes {
            id
            status
            supportedActions { action }
            lineItems(first: 50) {
              nodes { id remainingQuantity }
            }
          }
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const foJson = await foResponse.json();
  const fulfillmentOrders: FulfillmentOrderNode[] =
    foJson?.data?.order?.fulfillmentOrders?.nodes || [];
  if (!fulfillmentOrders.length) {
    throw new Error("This order has no fulfillment orders");
  }

  const pending = fulfillmentOrders.filter(
    (fo) => !DONE_FULFILLMENT_ORDER_STATUSES.has(fo.status),
  );
  const blocked = pending.filter(
    (fo) =>
      !fo.supportedActions?.some((a) => a.action === "CREATE_FULFILLMENT"),
  );
  if (blocked.length) {
    throw new Error(
      `Fulfillment order is ${blocked[0].status}; release it in Shopify admin before shipping`,
    );
  }

  let fulfilledCount = 0;
  for (const fo of pending) {
    const lineItems = (fo.lineItems?.nodes || [])
      .filter((li) => (li.remainingQuantity || 0) > 0)
      .map((li) => ({ id: li.id, quantity: li.remainingQuantity }));
    if (!lineItems.length) continue;

    const response = await admin.graphql(
      `#graphql
      mutation FulfillOrder($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { message field }
        }
      }`,
      {
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: [
              { fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: lineItems },
            ],
            trackingInfo: {
              company: tracking.company.slice(0, 100),
              number: tracking.number.slice(0, 100),
            },
            // Filling in tracking must not send Shopify's shipping confirmation.
            notifyCustomer: false,
          },
        },
      },
    );
    const json = await response.json();
    const errors = json?.data?.fulfillmentCreate?.userErrors;
    if (errors?.length) {
      throw new Error(errors[0].message || "fulfillmentCreate failed");
    }
    if (!json?.data?.fulfillmentCreate?.fulfillment) {
      throw new Error("fulfillmentCreate returned no fulfillment");
    }
    fulfilledCount += 1;
  }
  if (fulfilledCount > 0) return { fulfilledCount, alreadyFulfilled: false };
  if (fulfillmentOrders.some((fo) => fo.status === "CLOSED")) {
    return { fulfilledCount: 0, alreadyFulfilled: true };
  }
  throw new Error("Nothing left to fulfill on this order. Check it in Shopify admin.");
}

type DeliveryFulfillment = {
  id?: string;
  status?: string | null;
  displayStatus?: string | null;
};

/**
 * Records a delivered shipment event on every successful fulfillment.
 * Already-delivered shipments are left as they are.
 */
export async function markOrderDelivered(admin: AdminClient, orderGid: string): Promise<void> {
  const response = await admin.graphql(
    `#graphql
    query OrderShipments($id: ID!) {
      order(id: $id) {
        id
        fulfillments(first: 10) {
          id
          status
          displayStatus
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await response.json();
  const fulfillments: DeliveryFulfillment[] = json?.data?.order?.fulfillments || [];
  const happenedAt = new Date().toISOString();
  let touched = 0;
  for (const fulfillment of fulfillments) {
    if (!fulfillment.id || fulfillment.status !== "SUCCESS") continue;
    touched += 1;
    if (fulfillment.displayStatus === "DELIVERED") continue;
    const created = await admin.graphql(
      `#graphql
      mutation MarkDelivered($fulfillmentEvent: FulfillmentEventInput!) {
        fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
          fulfillmentEvent { id status }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          fulfillmentEvent: {
            fulfillmentId: fulfillment.id,
            status: "DELIVERED",
            happenedAt,
          },
        },
      },
    );
    const createdJson = await created.json();
    const errors = createdJson?.data?.fulfillmentEventCreate?.userErrors;
    if (errors?.length) {
      throw new Error(errors[0].message || "Could not mark the shipment delivered");
    }
    if (!createdJson?.data?.fulfillmentEventCreate?.fulfillmentEvent) {
      throw new Error(firstGraphqlMessage(createdJson) || "Could not mark the shipment delivered");
    }
  }
  if (!touched) {
    throw new Error("This order has no shipment to mark delivered");
  }
}

/** Closes the order. Shopify admin shows a closed order as archived. */
export async function archiveShopifyOrder(admin: AdminClient, orderGid: string): Promise<void> {
  const found = await admin.graphql(
    `#graphql
    query OrderClosed($id: ID!) {
      order(id: $id) { id closed }
    }`,
    { variables: { id: orderGid } },
  );
  const foundJson = await found.json();
  if (foundJson?.data?.order?.closed) return;

  const response = await admin.graphql(
    `#graphql
    mutation ArchiveOrder($input: OrderCloseInput!) {
      orderClose(input: $input) {
        order { id closedAt }
        userErrors { field message }
      }
    }`,
    { variables: { input: { id: orderGid } } },
  );
  const json = await response.json();
  const errors = json?.data?.orderClose?.userErrors;
  if (errors?.length) {
    throw new Error(errors[0].message || "Could not archive the order");
  }
  if (!json?.data?.orderClose?.order) {
    throw new Error(firstGraphqlMessage(json) || "Could not archive the order");
  }
}

export type CustomerOrderGate = {
  id: string;
  name: string;
  customerId: string | null;
  businessStatus: BusinessStatus;
};

/** One Admin call for many orders: ownership plus current business_status. */
export async function fetchOrderGates(
  admin: AdminClient,
  orderGids: string[],
): Promise<CustomerOrderGate[]> {
  if (!orderGids.length) return [];
  const response = await admin.graphql(
    `#graphql
    query OrderGates($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          name
          displayFulfillmentStatus
          customer { id }
          businessStatus: metafield(namespace: "custom", key: "business_status") {
            value
          }
        }
      }
    }`,
    { variables: { ids: orderGids } },
  );
  const json = await response.json();
  const nodes: Array<{
    id?: string;
    name?: string;
    displayFulfillmentStatus?: string | null;
    customer?: { id: string } | null;
    businessStatus?: { value?: string | null } | null;
  } | null> = json?.data?.nodes || [];
  return nodes.flatMap((node) =>
    node?.id
      ? [
          {
            id: node.id,
            name: node.name || "",
            customerId: node.customer?.id || null,
            businessStatus: effectiveBusinessStatus(
              node.businessStatus?.value,
              node.displayFulfillmentStatus,
            ),
          },
        ]
      : [],
  );
}

export type SupplierQueueOrder = {
  id: string;
  orderName: string;
  email: string | null;
  businessStatus: BusinessStatus;
  placedAt: string;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** Current AI painting for this order, when Shopify has stored one. */
  paintingUrl: string | null;
};

function queuePaintingUrl(node: {
  paintingUrl?: { value?: string | null } | null;
  lineItems?: {
    nodes?: Array<{
      customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
    }> | null;
  } | null;
}): string | null {
  const fromMetafield = node.paintingUrl?.value?.trim();
  if (fromMetafield) return fromMetafield;
  for (const line of node.lineItems?.nodes || []) {
    for (const attr of line.customAttributes || []) {
      const key = attr.key || "";
      const value = attr.value?.trim();
      if (!value) continue;
      if (key === "painting_url" || key === "source_painting_url") return value;
    }
  }
  return null;
}

type TrackingInfo = { company?: string | null; number?: string | null; url?: string | null };

export function trackingFromFulfillments(
  fulfillments: Array<{ trackingInfo?: TrackingInfo[] | null }> | null | undefined,
): { company: string | null; number: string | null; url: string | null } {
  for (const fulfillment of fulfillments || []) {
    const info = (fulfillment.trackingInfo || []).find((item) => item.company || item.number);
    if (info) {
      return {
        company: info.company || null,
        number: info.number || null,
        url: info.url || null,
      };
    }
  }
  return { company: null, number: null, url: null };
}

type QueueTab = "action" | "waiting" | "done";

const OPEN_WORK_QUERY =
  "-status:cancelled -fulfillment_status:fulfilled -financial_status:refunded -financial_status:voided";

const FULFILLED_QUERY = "-status:cancelled fulfillment_status:fulfilled";

type QueuePass = { query: string; reverse: boolean; pages: number };

/**
 * Shipped orders are already fulfilled in Shopify, so the open-work query cannot
 * see them. They stay in the action queue until the supplier marks them delivered.
 * Delivered and archived orders are the done queue.
 */
const QUEUE_TABS: Record<
  QueueTab,
  { statuses: BusinessStatus[]; passes: QueuePass[]; reverse: boolean }
> = {
  action: {
    statuses: ["order_placed", "supplier_modification", "prepare_shipment", "shipped"],
    reverse: false,
    passes: [
      { query: OPEN_WORK_QUERY, reverse: false, pages: 8 },
      { query: FULFILLED_QUERY, reverse: false, pages: 8 },
    ],
  },
  waiting: {
    statuses: ["portrait_review"],
    reverse: false,
    passes: [{ query: OPEN_WORK_QUERY, reverse: false, pages: 8 }],
  },
  done: {
    statuses: ["delivered", "archived"],
    reverse: true,
    passes: [{ query: FULFILLED_QUERY, reverse: true, pages: 4 }],
  },
};

/**
 * Queue rows come from Shopify orders. Status is the order metafield, or shipped once fulfilled.
 * Portrait files and modification notes are not on the order, so callers add those from the database.
 */
export async function listShopifyOrdersForSupplier(
  admin: AdminClient,
  tab: QueueTab,
): Promise<SupplierQueueOrder[]> {
  const config = QUEUE_TABS[tab] || QUEUE_TABS.action;
  const wanted = new Set(config.statuses);
  const rows: SupplierQueueOrder[] = [];
  const seen = new Set<string>();

  for (const pass of config.passes) {
    let cursor: string | null = null;
    for (let page = 0; page < pass.pages; page += 1) {
      const response = await admin.graphql(
        `#graphql
        query SupplierOrderQueue($cursor: String, $query: String, $reverse: Boolean) {
          orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: $reverse) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              name
              email
              createdAt
              cancelledAt
              displayFulfillmentStatus
              businessStatus: metafield(namespace: "custom", key: "business_status") { value }
              paintingUrl: metafield(namespace: "custom", key: "painting_url") { value }
              lineItems(first: 10) {
                nodes {
                  customAttributes { key value }
                }
              }
              fulfillments(first: 5) {
                trackingInfo { company number url }
              }
            }
          }
        }`,
        { variables: { cursor, query: pass.query, reverse: pass.reverse } },
      );
      const json = await response.json();
      if (json?.errors?.length) {
        throw new Error(json.errors[0].message || "Failed to list Shopify orders");
      }
      const connection = json?.data?.orders;
      const nodes: Array<{
        id: string;
        name?: string | null;
        email?: string | null;
        createdAt: string;
        cancelledAt?: string | null;
        displayFulfillmentStatus?: string | null;
        businessStatus?: { value?: string | null } | null;
        paintingUrl?: { value?: string | null } | null;
        lineItems?: {
          nodes?: Array<{
            customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
          }> | null;
        } | null;
        fulfillments?: Array<{ trackingInfo?: TrackingInfo[] | null }> | null;
      }> = connection?.nodes || [];

      for (const node of nodes) {
        if (!node?.id || node.cancelledAt || seen.has(node.id)) continue;
        const businessStatus = effectiveBusinessStatus(
          node.businessStatus?.value,
          node.displayFulfillmentStatus,
        );
        if (!wanted.has(businessStatus)) continue;
        seen.add(node.id);
        const tracking = trackingFromFulfillments(node.fulfillments);
        rows.push({
          id: node.id.split("/").pop() || node.id,
          orderName: node.name || "",
          email: node.email || null,
          businessStatus,
          placedAt: node.createdAt,
          trackingCompany: tracking.company,
          trackingNumber: tracking.number,
          trackingUrl: tracking.url,
          paintingUrl: queuePaintingUrl(node),
        });
      }

      if (!connection?.pageInfo?.hasNextPage) break;
      cursor = connection.pageInfo.endCursor || null;
    }
  }

  const priority: Record<string, number> = {
    supplier_modification: 0,
    prepare_shipment: 1,
    order_placed: 2,
    portrait_review: 3,
    shipped: 4,
    delivered: 5,
    archived: 6,
  };
  return rows.sort((a, b) => {
    const diff = (priority[a.businessStatus] ?? 9) - (priority[b.businessStatus] ?? 9);
    if (diff !== 0) return diff;
    const byDate = a.placedAt.localeCompare(b.placedAt);
    return config.reverse ? -byDate : byDate;
  });
}

export async function fetchOrderDetailForSupplier(
  admin: AdminClient,
  orderGid: string,
) {
  const response = await admin.graphql(
    `#graphql
    query SupplierOrderDetail($id: ID!) {
      order(id: $id) {
        id
        name
        email
        createdAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress {
          name firstName lastName address1 address2 city province zip country phone
        }
        lineItems(first: 20) {
          nodes {
            title
            variantTitle
            quantity
            customAttributes { key value }
          }
        }
        businessStatus: metafield(namespace: "custom", key: "business_status") {
          value
        }
        originalPhoto: metafield(namespace: "custom", key: "original_photo_url") {
          value
        }
        paintingUrl: metafield(namespace: "custom", key: "painting_url") {
          value
        }
        paintingStyle: metafield(namespace: "custom", key: "painting_style") {
          value
        }
        giftMessage: metafield(namespace: "custom", key: "gift_message") {
          value
        }
        fulfillments(first: 5) {
          trackingInfo { company number url }
        }
      }
    }`,
    { variables: { id: orderGid } },
  );
  const json = await response.json();
  return json?.data?.order || null;
}
