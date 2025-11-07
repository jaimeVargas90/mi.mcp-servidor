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
// HERRAMIENTA SHOPIFY MEJORADA (LISTAR PRODUCTOS)
// ----------------------------------------------------
server.registerTool(
  "listShopifyProducts",
  {
    title: "List Shopify Products",
    description:
      "Get a list of the first 5 products from the Shopify store, including price, description, and images.",
    inputSchema: {}, // No necesita parámetros de entrada
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
      // (Manejo de error sin cambios)
      console.error("Error: Las variables de Shopify no están configuradas.");
      return {
        content: [
          {
            type: "text",
            text: "Error: El servidor no está configurado para Shopify.",
          },
        ],
        structuredContent: {
          error: "El servidor no está configurado para Shopify.",
        },
      };
    }

    // CORRECCIÓN: Se quitó una barra '/' extra de la URL
    const apiUrl = `https://${storeUrl}/admin/api/2024-04/products.json?limit=5`;
    const storeBaseUrl = `https://${storeUrl}`;

    try {
      // (Lógica de fetch sin cambios)
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

      // (Lógica de map sin cambios)
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
      // (Manejo de error sin cambios)
      console.error("Error al llamar a la API de Shopify:", error);
      let errorMessage = "Ocurrió un error desconocido";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      return {
        content: [
          { type: "text", text: `Error al obtener productos: ${errorMessage}` },
        ],
        structuredContent: {
          error: `Error al obtener productos: ${errorMessage}`,
        },
      };
    }
  }
);
// ----------------------------------------------------
// FIN DE LA HERRAMIENTA LISTAR PRODUCTOS
// ----------------------------------------------------

// ----------------------------------------------------
// HERRAMIENTA CORREGIDA: BUSCAR PEDIDOS (con GraphQL)
// ----------------------------------------------------
// ----------------------------------------------------
// HERRAMIENTA CORREGIDA OTRA VEZ: BUSCAR PEDIDOS (con GraphQL)
// ----------------------------------------------------
server.registerTool(
  "searchOrders",
  {
    title: "Buscar pedidos en Shopify",
    description:
      "Busca pedidos por nombre, email, teléfono o texto. Si no se da un 'query', devuelve los pedidos más recientes.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "Texto de búsqueda (nombre, email, etc.) o vacío para los más recientes."
        ),
      first: z.number().default(5).describe("Número de pedidos a devolver."),
    },
    outputSchema: {
      orders: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          createdAt: z.string(),
          // ----- CAMBIO 1: Nombres de campo corregidos -----
          financialStatus: z.string().nullable(),
          fulfillmentStatus: z.string().nullable(),
          // ----- FIN CAMBIO 1 -----
          total: z.string().nullable(),
          currency: z.string().nullable(),
          customer: z
            .object({
              firstName: z.string().nullable(),
              lastName: z.string().nullable(),
              email: z.string().nullable(),
              phone: z.string().nullable(),
            })
            .nullable(),
          shippingAddress: z
            .object({
              address1: z.string().nullable(),
              city: z.string().nullable(),
              province: z.string().nullable(),
              country: z.string().nullable(),
            })
            .nullable(),
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

    // ----- CAMBIO 2: Consulta GraphQL corregida -----
    const gqlQuery = `
      query getOrders($first: Int!, $query: String) {
        orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus  # <--- CORREGIDO
              displayFulfillmentStatus # <--- CORREGIDO
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { firstName lastName email phone }
              shippingAddress { address1 city province country }
            }
          }
        }
      }
    `;
    // ----- FIN CAMBIO 2 -----

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

      // ----- CAMBIO 3: Mapeo de datos corregido -----
      const formattedOrders = rawOrders.map((o: any) => ({
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        financialStatus: o.displayFinancialStatus || null, // <--- CORREGIDO
        fulfillmentStatus: o.displayFulfillmentStatus || null, // <--- CORREGIDO
        total: o.totalPriceSet?.shopMoney?.amount || null,
        currency: o.totalPriceSet?.shopMoney?.currencyCode || null,
        customer: o.customer
          ? {
              firstName: o.customer.firstName || null,
              lastName: o.customer.lastName || null,
              email: o.customer.email || null,
              phone: o.customer.phone || null,
            }
          : null,
        shippingAddress: o.shippingAddress
          ? {
              address1: o.shippingAddress.address1 || null,
              city: o.shippingAddress.city || null,
              province: o.shippingAddress.province || null,
              country: o.shippingAddress.country || null,
            }
          : null,
      }));
      // ----- FIN CAMBIO 3 -----

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
// FIN DE LA HERRAMIENTA BUSCAR PEDIDOS
// ----------------------------------------------------

// 3. Configurar Express para "servir" el servidor MCP
const app = express();
app.use(express.json());

// Esta es la ruta donde el cliente (5ire, OpenAI, etc.) se conectará
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
// Railway te dará una variable `PORT` automáticamente.
const port = parseInt(process.env.PORT || "3000");

app
  .listen(port, () => {
    console.log(`Demo MCP Server running on http://localhost:${port}/mcp`);
  })
  .on("error", (error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
