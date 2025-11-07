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

    // El "contrato" o Schema actualizado
    outputSchema: {
      products: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          price: z.string(), // El precio de Shopify viene como string
          description: z.string().nullable(),
          imageUrl: z.string().nullable(),
          productUrl: z.string(),
        })
      ),
    },
  },

  async () => {
    // Lee las credenciales de forma segura desde las variables de entorno
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;

    // Validación para asegurarnos de que las variables existan
    if (!storeUrl || !apiToken) {
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

    // La URL de la API de Shopify (CORREGIDO: quité el / extra)
    const apiUrl = `https://${storeUrl}/admin/api/2024-04/products.json?limit=5`;
    const storeBaseUrl = `https://${storeUrl}`; // Para construir la URL del producto

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

      // La lógica de transformación actualizada
      const products = data.products.map((p: any) => {
        // Limpiamos la descripción HTML para que sea texto plano
        const cleanDescription = p.body_html
          ? p.body_html.replace(/<[^>]*>?/gm, "") // Quita etiquetas HTML
          : null;

        return {
          id: p.id,
          title: p.title,

          // Obtenemos el precio de la primera variante
          price: p.variants.length > 0 ? p.variants[0].price : "0.00",

          // Quitamos saltos de línea y limitamos la descripción a 150 caracteres
          description: cleanDescription
            ? cleanDescription.replace(/\s+/g, " ").trim().substring(0, 150) +
              "..."
            : "Sin descripción",

          // Obtenemos la URL de la imagen principal
          imageUrl: p.image ? p.image.src : null,

          // Construimos la URL pública del producto
          productUrl: `${storeBaseUrl}/products/${p.handle}`,
        };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(products, null, 2) }],
        structuredContent: { products },
      };
    } catch (error) {
      // Bloque catch corregido para TypeScript
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
// NUEVA HERRAMIENTA: BUSCAR PEDIDOS
// ----------------------------------------------------
server.registerTool(
  "findShopifyOrders",
  {
    title: "Find Shopify Orders",
    description:
      "Busca pedidos por número de pedido (ej. '#1001'), ID numérico, nombre del cliente o teléfono.",
    inputSchema: {
      query: z
        .string()
        .describe(
          "El número de pedido (#1001), ID (518...888), nombre ('Juan Perez') o teléfono ('+123...89')"
        ),
    },
    outputSchema: {
      orders: z.array(
        z.object({
          id: z.number(),
          name: z.string(), // Este es el número de pedido como #1001
          customerName: z.string().nullable(),
          phone: z.string().nullable(),
          totalPrice: z.string(),
          financialStatus: z.string(),
          orderStatusUrl: z.string().nullable(), // URL para ver el estado
        })
      ),
    },
  },
  async ({ query }) => {
    // Leer credenciales (sin cambios)
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
        structuredContent: {
          error: "El servidor no está configurado para Shopify.",
        },
      };
    }

    const baseUrl = `https://${storeUrl}/admin/api/2024-04`;
    const headers = {
      "X-Shopify-Access-Token": apiToken,
      "Content-Type": "application/json",
    };

    let orders: any[] = [];

    try {
      if (query.startsWith("#")) {
        // Opción 1: Buscar por número de pedido (ej. #1001)
        const response = await fetch(
          `${baseUrl}/orders.json?name=${query}&status=any`,
          { headers }
        );
        const data = await response.json();
        orders = data.orders || [];
      } else if (/^\d+$/.test(query)) {
        // Opción 2: Buscar por ID numérico (ej. 5189388484888)
        const response = await fetch(`${baseUrl}/orders/${query}.json`, {
          headers,
        });
        if (response.ok) {
          const data = await response.json();
          orders = [data.order]; // Devuelve un solo pedido en un array
        }
      } else {
        // Opción 3: Buscar por nombre o teléfono del cliente
        // 1. Encontrar al cliente
        const customerSearchUrl = `${baseUrl}/customers/search.json?query=${encodeURIComponent(
          query
        )}`;
        const custResponse = await fetch(customerSearchUrl, { headers });
        const custData = await custResponse.json();

        if (custData.customers && custData.customers.length > 0) {
          const customerId = custData.customers[0].id;

          // 2. Encontrar pedidos de ese cliente
          const orderSearchUrl = `${baseUrl}/orders.json?customer_id=${customerId}&status=any`;
          const orderResponse = await fetch(orderSearchUrl, { headers });
          const orderData = await orderResponse.json();
          orders = orderData.orders || [];
        }
      }

      // Si no se encontraron pedidos
      if (orders.length === 0 || orders[0] === null) {
        return {
          content: [
            {
              type: "text",
              text: "No se encontraron pedidos para esa búsqueda.",
            },
          ],
          structuredContent: { orders: [] },
        };
      }

      // Formatear la respuesta
      const formattedOrders = orders.map((o: any) => ({
        id: o.id,
        name: o.name,
        customerName: o.customer
          ? `${o.customer.first_name} ${o.customer.last_name}`
          : "N/A",
        phone: o.customer ? o.customer.phone : o.phone || null,
        totalPrice: o.total_price,
        financialStatus: o.financial_status,
        orderStatusUrl: o.order_status_url,
      }));

      return {
        content: [
          { type: "text", text: JSON.stringify(formattedOrders, null, 2) },
        ],
        structuredContent: { orders: formattedOrders },
      };
    } catch (error) {
      console.error("Error al llamar a la API de Shopify:", error);
      let errorMessage = "Ocurrió un error desconocido";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      return {
        content: [
          { type: "text", text: `Error al obtener pedidos: ${errorMessage}` },
        ],
        structuredContent: {
          error: `Error al obtener pedidos: ${errorMessage}`,
        },
      };
    }
  }
);
// ----------------------------------------------------
// FIN DE LA NUEVA HERRAMIENTA
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
