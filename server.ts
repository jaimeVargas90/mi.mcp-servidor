// Importa todo lo necesario
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// 1. Crear el servidor MCP
const server = new McpServer({
  name: "demo-server-railway",
  version: "1.0.0",
});

// 2. Registrar una herramienta (Suma)
server.registerTool(
  "add",
  {
    title: "Addition Tool",
    description: "Add two numbers",
    inputSchema: { a: z.number(), b: z.number() },
    outputSchema: { result: z.number() },
  },
  async ({ a, b }) => {
    const output = { result: a + b };
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
);

// ----------------------------------------------------
// HERRAMIENTA 2: LISTAR PRODUCTOS (Sin cambios)
// ----------------------------------------------------
server.registerTool(
  "listShopifyProducts",
  {
    title: "List Shopify Products",
    description:
      "Get a list of the first 5 products from the Shopify store, including price, description, and images.",
    inputSchema: {},
    outputSchema: {
      products: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          price: z.string(),
          description: z.string().nullable(),
          imageUrl: z.string().nullable(),
          productUrl: z.string(),
        })
      ),
    },
  },
  async () => {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;
    if (!storeUrl || !apiToken) {
      console.error("Error: Las variables de Shopify no están configuradas.");
      return {
        content: [
          {
            type: "text",
            text: "Error: El servidor no está configurado para Shopify.",
          },
        ],
        structuredContent: { products: [] },
      };
    }
    const apiUrl = `https://${storeUrl}/admin/api/2024-04/products.json?limit=5`;
    const storeBaseUrl = `https://${storeUrl}`;
    try {
      const response = await fetch(apiUrl, {
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`Error de Shopify: ${response.statusText}`);
      }
      const data = await response.json();
      const products = data.products.map((p: any) => {
        const cleanDescription = p.body_html
          ? p.body_html.replace(/<[^>]*>?/gm, "")
          : null;
        return {
          id: p.id,
          title: p.title,
          price: p.variants.length > 0 ? p.variants[0].price : "0.00",
          description: cleanDescription
            ? cleanDescription.replace(/\s+/g, " ").trim().substring(0, 150) +
              "..."
            : "Sin descripción",
          imageUrl: p.image ? p.image.src : null,
          productUrl: `${storeBaseUrl}/products/${p.handle}`,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(products, null, 2) }],
        structuredContent: { products },
      };
    } catch (error) {
      console.error("Error al llamar a la API de Shopify:", error);
      let errorMessage = "Ocurrió un error desconocido";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      return {
        content: [
          { type: "text", text: `Error al obtener productos: ${errorMessage}` },
        ],
        structuredContent: { products: [] },
      };
    }
  }
);

// ----------------------------------------------------
// HERRAMIENTA 3: BUSCAR PEDIDOS (GraphQL)
// (¡Descripción actualizada!)
// ----------------------------------------------------
server.registerTool(
  "searchOrders",
  {
    title: "Buscar Pedidos (por #Número o Fecha)",
    description:
      "Busca **listas** de pedidos. Úsalo para buscar por **NÚMERO DE PEDIDO (ej. '#1001', '#2507')** o por fecha (ej. 'created_at:>...'). Si la query está vacía, trae los más recientes.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "La consulta. Para números de pedido, usa 'name:#' seguido del número (ej. 'name:#2507')"
        ),
      first: z.number().default(5).describe("Número de pedidos a devolver."),
    },
    outputSchema: {
      orders: z.array(
        z.object({
          id: z.string(), // GID (ej. gid://shopify/Order/6216169488420)
          name: z.string(), // ej. #2507
          createdAt: z.string(),
          financialStatus: z.string().nullable(),
          fulfillmentStatus: z.string().nullable(),
          total: z.string().nullable(),
          currency: z.string().nullable(),
        })
      ),
    },
  },
  async ({ query = "", first = 5 }) => {
    // --- (La lógica de esta herramienta no cambia) ---
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;
    if (!storeUrl || !apiToken) {
      console.error("Error: Las variables de Shopify no están configuradas.");
      return {
        content: [
          {
            type: "text",
            text: "Error: El servidor no está configurado para Shopify.",
          },
        ],
        structuredContent: { orders: [] },
      };
    }
    const apiUrl = `https://${storeUrl}/admin/api/2024-04/graphql.json`;
    const gqlQuery = `
      query getOrders($first: Int!, $query: String) {
        orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
            }
          }
        }
      }
    `;
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: gqlQuery,
          variables: { first, query: query || null },
        }),
      });
      if (!response.ok) {
        throw new Error(`Error de Shopify GraphQL: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.errors) {
        throw new Error(
          `Error en la consulta GraphQL: ${JSON.stringify(data.errors)}`
        );
      }
      const rawOrders = data.data?.orders?.edges?.map((e: any) => e.node) ?? [];
      const formattedOrders = rawOrders.map((o: any) => ({
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        financialStatus: o.displayFinancialStatus || null,
        fulfillmentStatus: o.displayFulfillmentStatus || null,
        total: o.totalPriceSet?.shopMoney?.amount || null,
        currency: o.totalPriceSet?.shopMoney?.currencyCode || null,
      }));
      return {
        content: [
          { type: "text", text: JSON.stringify(formattedOrders, null, 2) },
        ],
        structuredContent: { orders: formattedOrders },
      };
    } catch (error) {
      console.error("Error al llamar a la API de Shopify (GraphQL):", error);
      let errorMessage = "Ocurrió un error desconocido";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      return {
        content: [
          { type: "text", text: `Error al obtener pedidos: ${errorMessage}` },
        ],
        structuredContent: { orders: [] },
      };
    }
  }
);

// ----------------------------------------------------
// HERRAMIENTA 4: OBTENER PEDIDO POR ID (REST API)
// (¡Descripción actualizada!)
// ----------------------------------------------------
server.registerTool(
  "getOrderById",
  {
    title: "Consultar Pedido por ID (con Notas de Cliente)",
    description:
      "Obtiene los detalles y **notas de cliente** de **UN SOLO** pedido. Úsalo *solo* si ya tienes el **ID DE BASE DE DATOS** (un número muy largo como '6216...420' o un ID 'gid://...'). **NO USAR para números de pedido cortos como '#1001'.**",
    inputSchema: {
      id: z
        .string()
        .describe(
          "El ID de GraphQL (ej. 'gid://shopify/Order/123') o el ID numérico (ej. '123')"
        ),
    },
    outputSchema: {
      order: z
        .object({
          id: z.number(),
          name: z.string(),
          createdAt: z.string(),
          financialStatus: z.string().nullable(),
          fulfillmentStatus: z.string().nullable(),
          total: z.string().nullable(),
          currency: z.string().nullable(),
          lineItems: z
            .array(
              z.object({
                title: z.string(),
                quantity: z.number(),
              })
            )
            .nullable(),
          customerNotes: z.record(z.string(), z.string().nullable()).nullable(),
        })
        .nullable(),
    },
  },
  async ({ id }) => {
    // --- (La lógica de esta herramienta no cambia) ---
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;
    if (!storeUrl || !apiToken) {
      console.error("Error: Las variables de Shopify no están configuradas.");
      return {
        content: [
          {
            type: "text",
            text: "Error: El servidor no está configurado para Shopify.",
          },
        ],
        structuredContent: { order: null },
      };
    }

    const numericId = id.split("/").pop();
    if (!numericId || !/^\d+$/.test(numericId)) {
      return {
        content: [
          {
            type: "text",
            text: `ID de pedido no válido: ${id}. Debe ser el ID de base de datos, no el número de pedido.`,
          },
        ],
        structuredContent: { order: null },
      };
    }

    const apiUrl = `https://${storeUrl}/admin/api/2024-04/orders/${numericId}.json`;

    try {
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        // Si no lo encuentra, lanza el error "Not Found" que viste
        throw new Error(`Error de Shopify REST: ${response.statusText}`);
      }
      const data = await response.json();
      const o = data.order;

      if (!o) {
        return {
          content: [
            {
              type: "text",
              text: `No se encontró el pedido con ID: ${numericId}`,
            },
          ],
          structuredContent: { order: null },
        };
      }

      const customerNotes =
        o.note_attributes?.reduce((acc: Record<string, string>, attr: any) => {
          if (attr.name && attr.value) {
            acc[attr.name] = attr.value;
          }
          return acc;
        }, {}) || null;

      const formattedOrder = {
        id: o.id,
        name: o.name,
        createdAt: o.created_at,
        financialStatus: o.financial_status || null,
        fulfillmentStatus: o.fulfillment_status || "UNFULFILLED",
        total: o.total_price || null,
        currency: o.currency || null,
        lineItems:
          o.line_items?.map((item: any) => ({
            title: item.title,
            quantity: item.quantity,
          })) || [],
        customerNotes: customerNotes,
      };

      return {
        content: [
          { type: "text", text: JSON.stringify(formattedOrder, null, 2) },
        ],
        structuredContent: { order: formattedOrder },
      };
    } catch (error) {
      console.error("Error al llamar a la API de Shopify (REST):", error);
      let errorMessage = "Ocurrió un error desconocido";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      return {
        content: [
          {
            type: "text",
            text: `Error al obtener pedido por ID: ${errorMessage}`,
          },
        ],
        structuredContent: { order: null },
      };
    }
  }
);
// ----------------------------------------------------
// FIN DE LA HERRAMIENTA 4
// ----------------------------------------------------

// 3. Configurar Express para "servir" el servidor MCP
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// 4. Iniciar el servidor HTTP
const port = parseInt(process.env.PORT || "3000");

app
  .listen(port, () => {
    console.log(`Demo MCP Server running on http://localhost:${port}/mcp`);
  })
  .on("error", (error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
