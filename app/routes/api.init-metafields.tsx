import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// POST /api/init-metafields — Creates order metafield definitions (call once per shop)
export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const definitions = [
    {
      name: "Original Photo URL",
      namespace: "custom",
      key: "original_photo_url",
      description: "Customer uploaded pet photo URL",
      type: "single_line_text_field",
      ownerType: "ORDER" as const,
      pin: true,
    },
    {
      name: "Painting URL",
      namespace: "custom",
      key: "painting_url",
      description: "AI generated painting URL",
      type: "single_line_text_field",
      ownerType: "ORDER" as const,
      pin: true,
    },
    {
      name: "Painting Style",
      namespace: "custom",
      key: "painting_style",
      description: "Selected painting style",
      type: "single_line_text_field",
      ownerType: "ORDER" as const,
      pin: true,
    },
  ];

  const results = [];

  for (const def of definitions) {
    try {
      const response = await admin.graphql(
        `mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition {
              id
              name
              namespace
              key
              ownerType
              pin
              access {
                admin
                storefront
              }
            }
            userErrors {
              message
              field
              code
            }
          }
        }`,
        {
          variables: {
            definition: {
              name: def.name,
              namespace: def.namespace,
              key: def.key,
              description: def.description,
              type: def.type,
              ownerType: def.ownerType,
              validations: [],
              pin: def.pin,
              access: {
                admin: "MERCHANT_READ",
                storefront: "NONE",
              },
            },
          },
        }
      );

      const json = await response.json();
      const data = json.data?.metafieldDefinitionCreate;

      if (data?.createdDefinition) {
        results.push({
          key: def.key,
          status: "created",
          id: data.createdDefinition.id,
          access: data.createdDefinition.access,
        });
      } else if (data?.userErrors?.length) {
        // If already exists, that's ok
        const isDuplicate = data.userErrors.some(
          (e: { code?: string }) => e.code === "DUPLICATE"
        );
        results.push({
          key: def.key,
          status: isDuplicate ? "already_exists" : "error",
          errors: data.userErrors,
        });
      }
    } catch (error) {
      results.push({
        key: def.key,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return Response.json({
    success: results.every((r) => r.status !== "error"),
    results,
  });
}
