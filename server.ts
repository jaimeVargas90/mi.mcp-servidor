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
        structuredContent: { products: [] }, // Devuelve array vacío para cumplir schema
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
        structuredContent: { products: [] }, // Devuelve array vacío
      };
    }
  }
);

// ----------------------------------------------------
// HERRAMIENTA 3: BUSCAR PEDIDOS (Por Fecha o #Número)
// (Adaptada para no pedir PII)
// ----------------------------------------------------
server.registerTool(
  "searchOrders",
  {
    title: "Buscar pedidos en Shopify (por # o fecha)",
    description:
      "Busca pedidos por número (ej. '#1001') o fecha (ej. 'created_at:>2025-11-01'). Si query está vacío, trae los más recientes.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "Texto de búsqueda (ej. 'name:#1001' o 'created_at:>2025-11-01') o vacío."
        ),
      first: z.number().default(5).describe("Número de pedidos a devolver."),
    },
    outputSchema: {
      orders: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
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

    // Consulta GraphQL SIN PII (sin customer, sin shippingAddress)
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

      // Mapeo de datos SIN PII
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
// HERRAMIENTA 4: OBTENER PEDIDO POR ID (Nueva)
// (Adaptada para no pedir PII)
// ----------------------------------------------------
server.registerTool(
  "getOrderById",
  {
    title: "Consultar pedido por ID de Shopify",
    description:
      'Obtiene los detalles de un pedido específico usando su ID de GraphQL (ej. "gid://shopify/Order/12345").',
    inputSchema: {
      id: z
        .string()
        .describe(
          "El ID de GraphQL del pedido. Debe empezar con 'gid://shopify/Order/'."
        ),
    },
    // El schema de salida es un solo pedido, o null si no se encuentra
    outputSchema: {
      order: z
        .object({
          id: z.string(),
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
        })
        .nullable(),
    },
  },
  async ({ id }) => {
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
        structuredContent: { order: null }, // Cumple el schema
      };
    }

    const apiUrl = `https://${storeUrl}/admin/api/2024-04/graphql.json`;

    // Consulta GraphQL SIN PII
    const gqlQuery = `
      query getOrderById($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 10) {
            edges {
              node {
                title
                quantity
              }
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
          variables: { id: id }, // Pasamos el ID
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

      const o = data.data?.order; // 'o' es el pedido individual

      if (!o) {
        return {
          content: [
            { type: "text", text: `No se encontró el pedido con ID: ${id}` },
          ],
          structuredContent: { order: null },
        };
      }

      // Mapeo de datos SIN PII
      const formattedOrder = {
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        financialStatus: o.displayFinancialStatus || null,
        fulfillmentStatus: o.displayFulfillmentStatus || null,
        total: o.totalPriceSet?.shopMoney?.amount || null,
        currency: o.totalPriceSet?.shopMoney?.currencyCode || null,
        lineItems:
          o.lineItems?.edges.map((item: any) => ({
            title: item.node.title,
            quantity: item.node.quantity,
          })) || [],
      };

      return {
        content: [
          { type: "text", text: JSON.stringify(formattedOrder, null, 2) },
        ],
        structuredContent: { order: formattedOrder },
      };
    } catch (error) {
      console.error("Error al llamar a la API de Shopify (GraphQL):", error);
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
        structuredContent: { order: null }, // Cumple el schema
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
