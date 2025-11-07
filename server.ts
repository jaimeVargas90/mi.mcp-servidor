// Importa todo lo necesario
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// 1. Crear el servidor MCP (Sin cambios)
const server = new McpServer({
  name: "demo-server-railway",
  version: "1.0.0",
});

// 2. Registrar una herramienta (La original, sin cambios)
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
// INICIO DE LA NUEVA HERRAMIENTA SHOPIFY
// ----------------------------------------------------
server.registerTool(
  "listShopifyProducts",
  {
    title: "List Shopify Products",
    description: "Get a list of the first 5 products from the Shopify store",
    inputSchema: {}, // No necesita parámetros de entrada
    outputSchema: {
      products: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
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

    // La URL de la API de Shopify. Asegúrate de que tu storeUrl no tenga 'https://'
    // Ejemplo: mi-tienda.myshopify.com
    const apiUrl = `https://${storeUrl}/admin/api/2024-04/products.json?limit=5`;

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

      // Simplificamos la respuesta para el LLM
      const products = data.products.map((p: any) => ({
        id: p.id,
        title: p.title,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(products, null, 2) }],
        structuredContent: { products },
      };
    } catch (error) {
      console.error("Error al llamar a la API de Shopify:", error);

      // Creamos un mensaje de error seguro
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
// FIN DE LA NUEVA HERRAMIENTA SHOPIFY
// ----------------------------------------------------

// 3. Configurar Express (Sin cambios)
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

// 4. Iniciar el servidor HTTP (Sin cambios)
const port = parseInt(process.env.PORT || "3000");

app
  .listen(port, () => {
    console.log(`Demo MCP Server running on http://localhost:${port}/mcp`);
  })
  .on("error", (error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
