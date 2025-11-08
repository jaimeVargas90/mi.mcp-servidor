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

// 2. Registrar una herramienta
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
// HERRAMIENTA 1: LISTAR PRODUCTOS
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
          variantId: z.number().nullable(),
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
          variantId: p.variants.length > 0 ? p.variants[0].id : null,
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
// FIN DE LA HERRAMIENTA 1
// ----------------------------------------------------

// ----------------------------------------------------
// HERRAMIENTA 2: BUSCAR PEDIDOS (GraphQL)
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
// FIN DE LA HERRAMIENTA 2
// ----------------------------------------------------

// ----------------------------------------------------
// HERRAMIENTA 3: OBTENER PEDIDO POR ID (REST API)
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
// FIN DE LA HERRAMIENTA 3
// ----------------------------------------------------

// ----------------------------------------------------
// HERRAMIENTA 4: ACTUALIZAR PEDIDO (REST API) -
// ----------------------------------------------------
server.registerTool(
  "updateOrder",
  {
    title: "Actualizar Pedido Shopify (REST)",
    description:
      "Actualiza campos de contacto de un pedido de Shopify (nombre del cliente, teléfono, dirección y datos adicionales). Úsalo para cambiar datos específicos de un cliente asociados a un pedido.",
    inputSchema: {
      id: z
        .string()
        .describe(
          "El ID de GraphQL (ej. 'gid://shopify/Order/123') o el ID numérico (ej. '123') del pedido a actualizar."
        ),
      name: z
        .string()
        .optional()
        .describe("Nuevo nombre completo del cliente."),
      phone: z
        .string()
        .optional()
        .describe("Nuevo número de teléfono/WhatsApp del cliente."),
      address1: z
        .string()
        .optional()
        .describe("Nueva dirección principal del cliente."),
      address2: z
        .string()
        .optional()
        .describe(
          "Nuevos datos adicionales de la dirección (ej. 'Apartamento 201')."
        ),
      city: z.string().optional().describe("Nueva ciudad del cliente."),
      province: z
        .string()
        .optional()
        .describe("Nueva provincia/departamento del cliente."),
      country: z.string().optional().describe("Nuevo país del cliente."),
      zip: z.string().optional().describe("Nuevo código postal del cliente."),
    },
    outputSchema: {
      message: z.string(),
      orderId: z.string(),
      updatedFields: z.record(z.string(), z.string().nullable()).optional(),
      noteAttributesUpdated: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
          })
        )
        .optional(),
      timestamp: z.string().optional(),
      details: z.string().optional(), // Para errores
    },
  },
  async (input) => {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;

    if (!storeUrl || !apiToken) {
      console.error("Error: Las variables de Shopify no están configuradas.");
      const result = {
        message: "Error: El servidor no está configurado para Shopify.",
        orderId: input.id,
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }

    const { id, ...fields } = input;

    try {
      const numericId = id.startsWith("gid://shopify/Order/")
        ? id.split("/").pop()
        : id;

      if (!numericId || !/^\d+$/.test(numericId)) {
        throw new Error(`ID de pedido no válido: ${id}.`);
      }

      // 1. Obtener pedido actual
      const getApiUrl = `https://${storeUrl}/admin/api/2024-04/orders/${numericId}.json`;
      const existingResponse = await fetch(getApiUrl, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
      });

      if (!existingResponse.ok) {
        throw new Error(
          `Error al obtener el pedido existente: ${existingResponse.statusText}`
        );
      }
      const existingData = await existingResponse.json();
      const order = existingData.order;

      if (!order) {
        throw new Error("No se encontró el pedido en Shopify.");
      }

      // 2. Clonamos y actualizamos los note_attributes
      let updatedNotes = order.note_attributes ?? [];

      const replaceNoteValue = (key: string, newValue?: string | null) => {
        if (newValue === undefined) return;
        const index = updatedNotes.findIndex((n: any) => n.name === key);
        if (newValue === null) {
          if (index >= 0) updatedNotes.splice(index, 1);
        } else {
          if (index >= 0) updatedNotes[index].value = newValue;
          else updatedNotes.push({ name: key, value: newValue });
        }
      };

      replaceNoteValue("Nombre(s) y Apellido", fields.name);
      replaceNoteValue("WhatsApp", fields.phone);
      replaceNoteValue("Ingresa tu dirección completa", fields.address1);
      replaceNoteValue("Datos adicionales", fields.address2);
      replaceNoteValue("Ciudad", fields.city);
      replaceNoteValue("Departamento", fields.province);
      replaceNoteValue("País", fields.country);
      replaceNoteValue("Código Postal", fields.zip);

      // 3. Construimos el payload
      const payload: any = {
        order: {
          id: numericId,
          note_attributes: updatedNotes,
          shipping_address: {
            first_name:
              fields.name?.split(" ")[0] ?? order.shipping_address?.first_name,
            last_name:
              fields.name?.split(" ").slice(1).join(" ") ??
              order.shipping_address?.last_name,
            phone: fields.phone ?? order.shipping_address?.phone,
            address1: fields.address1 ?? order.shipping_address?.address1,
            address2: fields.address2 ?? order.shipping_address?.address2,
            city: fields.city ?? order.shipping_address?.city,
            province: fields.province ?? order.shipping_address?.province,
            country: fields.country ?? order.shipping_address?.country,
            zip: fields.zip ?? order.shipping_address?.zip,
          },
        },
      };

      if (Object.keys(payload.order.shipping_address).length === 0) {
        delete payload.order.shipping_address;
      }

      // 4. Ejecutamos el PUT
      const updateApiUrl = `https://${storeUrl}/admin/api/2024-04/orders/${numericId}.json`;
      const response = await fetch(updateApiUrl, {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Error al actualizar el pedido: ${
            response.statusText
          }. Detalles: ${JSON.stringify(errorData)}`
        );
      }

      const result = {
        message: "✅ Pedido actualizado correctamente en Shopify.",
        orderId: numericId,
        updatedFields: fields,
        noteAttributesUpdated: updatedNotes,
        timestamp: new Date().toISOString(),
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    } catch (error) {
      console.error(
        "❌ Error al actualizar pedido:",
        error instanceof Error ? error.message : error
      );

      const result = {
        message: "❌ Error al actualizar el pedido en Shopify.",
        orderId: input.id,
        details: error instanceof Error ? error.message : "Error desconocido",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }
  }
);
// ----------------------------------------------------
// FIN DE LA HERRAMIENTA 4
// ----------------------------------------------------

// ----------------------------------------------------
// HERRAMIENTA 5: CREAR PEDIDO (REST API)
// ----------------------------------------------------
server.registerTool(
  "createOrder",
  {
    title: "Crear Pedido Shopify (REST)",
    description:
      'Crea un nuevo pedido en Shopify con estado de pago "pendiente" (ideal para contra entrega). Requiere el ID de variante del producto y los datos del cliente.',
    inputSchema: {
      variantId: z
        .number()
        .describe("El ID numérico de la VARIANTE del producto (ej. 44...21)."),
      quantity: z
        .number()
        .default(1)
        .describe("Cantidad de unidades del producto."),
      name: z.string().optional().describe("Nombre(s) y Apellido del cliente."),
      phone: z
        .string()
        .optional()
        .describe("Número de WhatsApp del cliente (ej. 300... o +57...)."),
      address1: z
        .string()
        .optional()
        .describe("Dirección principal (ej. 'Calle 20 #30-60')."),
      address2: z
        .string()
        .optional()
        .describe("Datos adicionales de la dirección (ej. 'Apartamento 201')."),
      city: z.string().optional().describe("Ciudad del cliente."),
      province: z
        .string()
        .optional()
        .describe("Provincia/Departamento del cliente."),
      country: z
        .string()
        .optional()
        .default("Colombia")
        .describe("País del cliente."),
      zip: z.string().optional().describe("Código postal."),
    },
    outputSchema: {
      message: z.string(),
      orderId: z.number().optional(),
      orderName: z.string().optional(),
      details: z.string().optional(),
    },
  },
  async (input) => {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;
    if (!storeUrl || !apiToken) {
      console.error("Error: Las variables de Shopify no están configuradas.");
      const result = {
        message: "Error: El servidor no está configurado para Shopify.",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }

    let formattedPhone = input.phone;
    if (formattedPhone) {
      formattedPhone = formattedPhone.replace(/[\s\-\(\)]+/g, "");
      if (formattedPhone.length === 10 && !formattedPhone.startsWith("+")) {
        formattedPhone = `+57${formattedPhone}`;
      } else if (!formattedPhone.startsWith("+")) {
        formattedPhone = `+${formattedPhone}`;
      }
    }

    // Validación de datos
    if (
      !input.name ||
      !formattedPhone ||
      !input.address1 ||
      !input.city ||
      !input.province
    ) {
      const result = {
        message: "❌ Error: Faltan datos del cliente.",
        details:
          "Para crear el pedido, necesito que me pidas el nombre, teléfono, dirección, ciudad y departamento del cliente.",
      };
      return {
        content: [
          { type: "text", text: `${result.message} ${result.details}` },
        ],
        structuredContent: result,
      };
    }

    // Mapeo de note_attributes
    const note_attributes = [
      { name: "Nombre(s) y Apellido", value: input.name! },
      { name: "WhatsApp", value: formattedPhone! },
      { name: "Ingresa tu dirección completa", value: input.address1! },
      { name: "Datos adicionales", value: input.address2 || "" },
      { name: "Ciudad", value: input.city! },
      { name: "Departamento", value: input.province! },
      { name: "País", value: input.country || "Colombia" },
    ];

    // ----- CAMBIO AQUÍ: Separamos el nombre y apellido -----
    const firstName = input.name!.split(" ")[0];
    const lastName = input.name!.split(" ").slice(1).join(" ") || firstName; // Si solo hay un nombre, se repite

    // Construir el payload del nuevo pedido
    const payload = {
      order: {
        financial_status: "pending",
        line_items: [
          {
            variant_id: input.variantId,
            quantity: input.quantity,
          },
        ],
        note_attributes: note_attributes,
        shipping_address: {
          first_name: firstName,
          last_name: lastName,
          phone: formattedPhone!,
          address1: input.address1!,
          address2: input.address2 || "",
          city: input.city!,
          province: input.province!,
          country: input.country || "Colombia",
          zip: input.zip || "",
        },
        phone: formattedPhone!,

        // ----- Añadimos el objeto 'customer' -----
        customer: {
          first_name: firstName,
          last_name: lastName,
          phone: formattedPhone!,
          // Shopify a veces exige un email, si no lo tenemos, podemos omitirlo
          // o crear uno falso, pero el teléfono suele ser suficiente.
        },
      },
    };

    try {
      const apiUrl = `https://${storeUrl}/admin/api/2024-04/orders.json`;
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Error al crear el pedido: ${
            response.statusText
          }. Detalles: ${JSON.stringify(errorData)}`
        );
      }

      const data = await response.json();
      const newOrder = data.order;

      const result = {
        message: "✅ Pedido creado exitosamente en Shopify.",
        orderId: newOrder.id,
        orderName: newOrder.name,
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    } catch (error) {
      console.error(
        "❌ Error al crear pedido:",
        error instanceof Error ? error.message : error
      );

      const result = {
        message: "❌ Error al crear el pedido en Shopify.",
        details: error instanceof Error ? error.message : "Error desconocido",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }
  }
);
// ----------------------------------------------------
// FIN DE LA HERRAMIENTA 5
// ----------------------------------------------------

// ----------------------------------------------------
// HERRAMIENTA 6: CREAR BORRADOR (Paso 1)
// ----------------------------------------------------
server.registerTool(
  "createDraftOrder",
  {
    title: "Crear Borrador de Pedido (Paso 1)",
    description:
      "Crea un BORRADOR de pedido (no una orden real) con los productos y datos del cliente. Este es el primer paso antes de confirmar.",
    inputSchema: {
      variantId: z
        .number()
        .describe("El ID numérico de la VARIANTE del producto."),
      quantity: z.number().default(1).describe("Cantidad de unidades."),
      name: z.string().optional().describe("Nombre(s) y Apellido del cliente."),
      phone: z
        .string()
        .optional()
        .describe("Número de WhatsApp del cliente (ej. 300...)."),
      address1: z.string().optional().describe("Dirección principal."),
      address2: z
        .string()
        .optional()
        .describe("Datos adicionales de la dirección."),
      city: z.string().optional().describe("Ciudad del cliente."),
      province: z
        .string()
        .optional()
        .describe("Provincia/Departamento del cliente."),
      country: z
        .string()
        .optional()
        .default("Colombia")
        .describe("País del cliente."),
      zip: z.string().optional().describe("Código postal."),
    },
    outputSchema: {
      message: z.string(),
      draftOrderId: z.number().optional(), // ID numérico del borrador
      totalPrice: z.string().optional(),
      details: z.string().optional(),
    },
  },
  async (input) => {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;
    if (!storeUrl || !apiToken) {
      const result = {
        message: "Error: El servidor no está configurado para Shopify.",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }

    // Formatear Teléfono
    let formattedPhone = input.phone;
    if (formattedPhone) {
      formattedPhone = formattedPhone.replace(/[\s\-\(\)]+/g, "");
      if (formattedPhone.length === 10 && !formattedPhone.startsWith("+")) {
        formattedPhone = `+57${formattedPhone}`;
      }
    }

    // Validar datos mínimos
    if (
      !input.name ||
      !formattedPhone ||
      !input.address1 ||
      !input.city ||
      !input.province
    ) {
      const result = {
        message: "❌ Error: Faltan datos del cliente.",
        details:
          "Para crear el borrador, necesito que me pidas el nombre, teléfono, dirección, ciudad y departamento del cliente.",
      };
      return {
        content: [
          { type: "text", text: `${result.message} ${result.details}` },
        ],
        structuredContent: result,
      };
    }

    const firstName = input.name!.split(" ")[0];
    const lastName = input.name!.split(" ").slice(1).join(" ") || firstName;

    // Mapeo de los datos de entrada a los note_attributes
    const note_attributes = [
      { name: "Nombre(s) y Apellido", value: input.name! },
      { name: "WhatsApp", value: formattedPhone! },
      { name: "Ingresa tu dirección completa", value: input.address1! },
      { name: "Datos adicionales", value: input.address2 || "" },
      { name: "Ciudad", value: input.city! },
      { name: "Departamento", value: input.province! },
      { name: "País", value: input.country || "Colombia" },
    ];

    // Construir el payload del NUEVO BORRADOR
    const payload = {
      draft_order: {
        // <-- La API de Borradores usa 'draft_order'
        line_items: [
          {
            variant_id: input.variantId,
            quantity: input.quantity,
          },
        ],
        note_attributes: note_attributes,
        shipping_address: {
          first_name: firstName,
          last_name: lastName,
          phone: formattedPhone!,
          address1: input.address1!,
          address2: input.address2 || "",
          city: input.city!,
          province: input.province!,
          country: input.country || "Colombia",
          zip: input.zip || "",
        },
        customer: {
          first_name: firstName,
          last_name: lastName,
          phone: formattedPhone!,
        },
      },
    };

    try {
      const apiUrl = `https://${storeUrl}/admin/api/2024-04/draft_orders.json`;
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Error al crear el borrador: ${
            response.statusText
          }. Detalles: ${JSON.stringify(errorData)}`
        );
      }

      const data = await response.json();
      const newDraftOrder = data.draft_order;

      const result = {
        message: `✅ Borrador de pedido creado. El total es ${newDraftOrder.total_price}. ¿Confirmo el pedido?`,
        draftOrderId: newDraftOrder.id,
        totalPrice: newDraftOrder.total_price,
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    } catch (error) {
      console.error(
        "❌ Error al crear borrador:",
        error instanceof Error ? error.message : error
      );
      const result = {
        message: "❌ Error al crear el borrador en Shopify.",
        details: error instanceof Error ? error.message : "Error desconocido",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }
  }
);

// ----------------------------------------------------
// HERRAMIENTA 7: COMPLETAR BORRADOR (Paso 2)
// ----------------------------------------------------
server.registerTool(
  "completeDraftOrder",
  {
    title: "Completar Borrador de Pedido (Paso 2)",
    description:
      'Toma un ID de borrador de pedido, lo "confirma" y lo convierte en un pedido real con pago pendiente.',
    inputSchema: {
      draftOrderId: z
        .number()
        .describe(
          "El ID numérico del borrador de pedido a completar (ej. 12345)."
        ),
    },
    outputSchema: {
      message: z.string(),
      orderId: z.number().optional(), // ID numérico del pedido REAL
      orderName: z.string().optional(), // ej. #1004
      details: z.string().optional(), // Para errores
    },
  },
  async ({ draftOrderId }) => {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;
    if (!storeUrl || !apiToken) {
      const result = {
        message: "Error: El servidor no está configurado para Shopify.",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }

    try {
      // Este es el endpoint para "completar" el borrador
      const apiUrl = `https://${storeUrl}/admin/api/2024-04/draft_orders/${draftOrderId}/complete.json`;

      const response = await fetch(apiUrl, {
        method: "PUT", // Se usa PUT para completar
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
        // Al completarlo, por defecto queda con 'payment_status: pending'
        // Si quisiéramos marcarlo como pagado, enviaríamos:
        // body: JSON.stringify({ payment_pending: false })
        // Pero como lo queremos pendiente, no enviamos body.
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Error al completar el borrador: ${
            response.statusText
          }. Detalles: ${JSON.stringify(errorData)}`
        );
      }

      const data = await response.json();
      const completedOrder = data.draft_order.order; // La respuesta nos da el pedido real

      const result = {
        message: "✅ Pedido confirmado y creado exitosamente.",
        orderId: completedOrder.id,
        orderName: completedOrder.name, // ej. #1004
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    } catch (error) {
      console.error(
        "❌ Error al completar borrador:",
        error instanceof Error ? error.message : error
      );
      const result = {
        message: "❌ Error al confirmar el borrador en Shopify.",
        details: error instanceof Error ? error.message : "Error desconocido",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }
  }
);
// ----------------------------------------------------
// FIN DE LA HERRAMIENTA 7
// ----------------------------------------------------

// ----------------------------------------------------
//  Configurar Express para "servir" el servidor MCP
// ----------------------------------------------------

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
