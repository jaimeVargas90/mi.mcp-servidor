import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// +++ CACHÉ +++
// Almacén de caché en memoria y tiempo de vida (5 minutos)
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000;

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
      "Get a list of the first 5 products from the Shopify store, including price, description, images, and variantId.",
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
    const cacheKey = "listProducts";
    const cachedData = cache.get(cacheKey);

    // 1. Si está en caché y no ha expirado, devolverlo al instante
    if (cachedData && Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log("Devolviendo listShopifyProducts desde la CACHÉ...");
      return {
        content: [
          { type: "text", text: JSON.stringify(cachedData.data, null, 2) },
        ],
        structuredContent: { products: cachedData.data },
      };
    }

    console.log("Generando listShopifyProducts (sin caché)...");

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

      // 2. Guardar el nuevo resultado en la caché
      cache.set(cacheKey, {
        data: products,
        timestamp: Date.now(),
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
        // Asegurarse de que tenga el + si no es el caso de 10 dígitos
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

    const firstName = input.name!.split(" ")[0];
    const lastName = input.name!.split(" ").slice(1).join(" ") || firstName;

    // 1. Buscar al cliente por número de teléfono
    let customerPayload: any;
    try {
      const searchUrl = `https://${storeUrl}/admin/api/2024-04/customers/search.json?query=phone:${encodeURIComponent(
        formattedPhone
      )}`;
      const customerResponse = await fetch(searchUrl, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
      });

      if (customerResponse.ok) {
        const customerData = await customerResponse.json();
        if (customerData.customers && customerData.customers.length > 0) {
          // Cliente ENCONTRADO: Usar su ID
          const customerId = customerData.customers[0].id;
          console.log(`Cliente encontrado con ID: ${customerId}. Asociando...`);
          customerPayload = { id: customerId };
        } else {
          // Cliente NO ENCONTRADO: Crear uno nuevo
          console.log("Cliente no encontrado. Creando uno nuevo...");
          customerPayload = {
            first_name: firstName,
            last_name: lastName,
            phone: formattedPhone!,
          };
        }
      } else {
        // Si la búsqueda falla, intentamos crear uno nuevo (comportamiento anterior)
        console.warn(
          "Búsqueda de cliente falló. Intentando crear uno nuevo..."
        );
        customerPayload = {
          first_name: firstName,
          last_name: lastName,
          phone: formattedPhone!,
        };
      }
    } catch (error) {
      console.error("Error buscando cliente, se intentará crear:", error);
      // Si hay un error de red, intentamos crear uno nuevo
      customerPayload = {
        first_name: firstName,
        last_name: lastName,
        phone: formattedPhone!,
      };
    }

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
        // Usamos el payload de cliente determinado dinámicamente
        customer: customerPayload,
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
        // Lanzamos el error para que sea capturado por el bloque catch
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
// HERRAMIENTA 6: CREAR BORRADOR (Paso 1) - CORREGIDA
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

    // --- CORRECCIÓN: Normalizar el objeto 'result' ---
    if (!storeUrl || !apiToken) {
      const result = {
        message: "Error: El servidor no está configurado para Shopify.",
        draftOrderId: undefined,
        totalPrice: undefined,
        details: undefined,
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
      } else if (!formattedPhone.startsWith("+")) {
        formattedPhone = `+${formattedPhone}`;
      }
    }

    // --- CORRECCIÓN: Normalizar el objeto 'result' ---
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
        draftOrderId: undefined,
        totalPrice: undefined,
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

    // 1. Buscar al cliente por número de teléfono
    let customerPayload: any;
    try {
      const searchUrl = `https://${storeUrl}/admin/api/2024-04/customers/search.json?query=phone:${encodeURIComponent(
        formattedPhone
      )}`;
      const customerResponse = await fetch(searchUrl, {
        method: "GET",
        headers: {
          // --- CORRECCIÓN: Añadir '!' a apiToken ---
          "X-Shopify-Access-Token": apiToken!,
          "Content-Type": "application/json",
        },
      });

      if (customerResponse.ok) {
        const customerData = await customerResponse.json();
        if (customerData.customers && customerData.customers.length > 0) {
          const customerId = customerData.customers[0].id;
          console.log(`Cliente encontrado con ID: ${customerId}. Asociando...`);
          customerPayload = { id: customerId };
        } else {
          console.log("Cliente no encontrado. Creando uno nuevo...");
          customerPayload = {
            first_name: firstName,
            last_name: lastName,
            phone: formattedPhone!,
          };
        }
      } else {
        console.warn(
          "Búsqueda de cliente falló. Intentando crear uno nuevo..."
        );
        customerPayload = {
          first_name: firstName,
          last_name: lastName,
          phone: formattedPhone!,
        };
      }
    } catch (error) {
      console.error("Error buscando cliente, se intentará crear:", error);
      customerPayload = {
        first_name: firstName,
        last_name: lastName,
        phone: formattedPhone!,
      };
    }

    // Construir el payload del NUEVO BORRADOR
    const payload = {
      draft_order: {
        // +++ LÓGICA DE DROPI AÑADIDA +++
        line_items: [
          {
            variant_id: input.variantId,
            quantity: input.quantity,
            fulfillment_service: "fulfillment-dropi",
          },
        ],
        // +++ LÓGICA DE PAGO AÑADIDA +++
        payment_terms: {
          payment_terms_type: "due_on_receipt",
        },

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
        customer: customerPayload,
      },
    };

    try {
      const apiUrl = `https://${storeUrl}/admin/api/2024-04/draft_orders.json`;
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          // --- CORRECCIÓN: Añadir '!' a apiToken ---
          "X-Shopify-Access-Token": apiToken!,
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

      // --- CORRECCIÓN: Normalizar el objeto 'result' ---
      const result = {
        message: `✅ Borrador de pedido creado. El total es ${newDraftOrder.total_price}. ¿Confirmo el pedido?`,
        draftOrderId: newDraftOrder.id,
        totalPrice: newDraftOrder.total_price,
        details: undefined,
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

      // --- CORRECCIÓN: Normalizar el objeto 'result' ---
      const result = {
        message: "❌ Error al crear el borrador en Shopify.",
        draftOrderId: undefined,
        totalPrice: undefined,
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
// FIN DE LA HERRAMIENTA 6
// ----------------------------------------------------

// ----------------------------------------------------
// NUEVA HERRAMIENTA 7: OBTENER BORRADOR POR ID
// ----------------------------------------------------
server.registerTool(
  "getDraftOrderById",
  {
    title: "Obtener Borrador de Pedido por ID",
    description:
      "Obtiene los detalles completos de un ÚNICO borrador de pedido (productos, notas, etc.) usando su ID numérico.",
    inputSchema: {
      id: z
        .number()
        .describe("El ID numérico del borrador de pedido (ej. 112233)"),
    },
    outputSchema: {
      draftOrder: z
        .object({
          id: z.number(),
          createdAt: z.string(),
          totalPrice: z.string(),
          customerName: z.string().nullable(),
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
      const result = {
        message: "Error: El servidor no está configurado para Shopify.",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: { draftOrder: null },
      };
    }

    try {
      // Usamos el endpoint para un solo borrador
      const apiUrl = `https://${storeUrl}/admin/api/2024-04/draft_orders/${id}.json`;

      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Error al obtener borrador: ${
            response.statusText
          }. Detalles: ${JSON.stringify(errorData)}`
        );
      }

      const data = await response.json();
      const draft = data.draft_order; // El objeto se llama 'draft_order'

      if (!draft) {
        const result = {
          message: `Borrador de pedido con ID ${id} no encontrado.`,
        };
        return {
          content: [{ type: "text", text: result.message }],
          structuredContent: { draftOrder: null },
        };
      }

      // Reutilizamos la lógica para encontrar el nombre del cliente
      let customerName: string | null = null;
      if (draft.note_attributes && draft.note_attributes.length > 0) {
        const nameAttr = draft.note_attributes.find(
          (attr: any) => attr.name === "Nombre(s) y Apellido"
        );
        if (nameAttr) customerName = nameAttr.value;
      }
      if (!customerName && draft.customer) {
        customerName = `${draft.customer.first_name || ""} ${
          draft.customer.last_name || ""
        }`.trim();
      }

      // Formateamos la respuesta
      const formattedDraft = {
        id: draft.id,
        createdAt: draft.created_at,
        totalPrice: draft.total_price,
        customerName: customerName || "Sin cliente",
        lineItems:
          draft.line_items?.map((item: any) => ({
            title: item.title,
            quantity: item.quantity,
          })) || [],
      };

      return {
        content: [
          { type: "text", text: JSON.stringify(formattedDraft, null, 2) },
        ],
        structuredContent: { draftOrder: formattedDraft },
      };
    } catch (error) {
      console.error(
        "❌ Error al obtener borrador por ID:",
        error instanceof Error ? error.message : error
      );
      const result = {
        message: "❌ Error al consultar el borrador de pedido.",
        details: error instanceof Error ? error.message : "Error desconocido",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: { draftOrder: null },
      };
    }
  }
);
// ----------------------------------------------------
// FIN DE LA HERRAMIENTA 7
// ----------------------------------------------------

// ----------------------------------------------------
// HERRAMIENTA 8: COMPLETAR BORRADOR (Paso 2) - CORREGIDA
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
      // Endpoint para "completar" el borrador
      const completeApiUrl = `https://${storeUrl}/admin/api/2024-04/draft_orders/${draftOrderId}/complete.json`;

      const completeResponse = await fetch(completeApiUrl, {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": apiToken!,
          "Content-Type": "application/json",
        },
        // --- ¡ESTE ES EL CAMBIO CRÍTICO! ---
        // 'false' le dice a Shopify: "Marca este pedido como 'Pagado' inmediatamente".
        body: JSON.stringify({ payment_pending: false }),
      });

      if (!completeResponse.ok) {
        const errorData = await completeResponse.json();
        if (JSON.stringify(errorData).includes("has been paid")) {
          throw new Error(
            "Este borrador de pedido ya fue completado y pagado anteriormente."
          );
        }
        throw new Error(
          `Error al completar el borrador: ${
            completeResponse.statusText
          }. Detalles: ${JSON.stringify(errorData)}`
        );
      }

      const completeData = await completeResponse.json();
      const newOrderId = completeData.draft_order?.order_id;

      if (!newOrderId) {
        throw new Error(
          "El borrador se marcó como completo, pero Shopify no devolvió un ID de pedido nuevo. Es posible que ya estuviera completado."
        );
      }

      // Ahora, obtenemos los detalles del pedido REAL que acabamos de crear
      const getOrderApiUrl = `https://${storeUrl}/admin/api/2024-04/orders/${newOrderId}.json`;
      const getOrderResponse = await fetch(getOrderApiUrl, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": apiToken!,
          "Content-Type": "application/json",
        },
      });

      if (!getOrderResponse.ok) {
        throw new Error(
          `Pedido ${newOrderId} creado, pero no se pudo obtener su nombre.`
        );
      }

      const orderData = await getOrderResponse.json();
      const newOrder = orderData.order;

      const result = {
        message: `✅ Pedido confirmado y creado exitosamente. El nuevo número de pedido es ${newOrder.name}.`,
        orderId: newOrder.id,
        orderName: newOrder.name,
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
// FIN DE LA HERRAMIENTA 8
// ----------------------------------------------------

// ----------------------------------------------------
// NUEVA HERRAMIENTA 9: ACTUALIZAR BORRADOR (Paso 1.5 - Edición)
// ----------------------------------------------------
server.registerTool(
  "updateDraftOrder",
  {
    title: "Actualizar Borrador de Pedido (Edición)",
    description:
      "Modifica los datos de un BORRADOR de pedido existente (ej. cambiar dirección, teléfono) ANTES de completarlo.",
    inputSchema: {
      draftOrderId: z
        .number()
        .describe("El ID numérico del BORRADOR de pedido a actualizar."),
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
      country: z.string().optional().describe("País del cliente."),
      zip: z.string().optional().describe("Código postal."),
    },
    outputSchema: {
      message: z.string(),
      draftOrderId: z.number().optional(),
      details: z.string().optional(),
    },
  },
  async ({ draftOrderId, ...fields }) => {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;

    // --- CORRECCIÓN 1: Normalizar el objeto 'result' ---
    if (!storeUrl || !apiToken) {
      const result = {
        message: "Error: El servidor no está configurado para Shopify.",
        draftOrderId: undefined,
        details: undefined,
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }

    try {
      // 1. Obtener el borrador actual para no perder datos
      const getApiUrl = `https://${storeUrl}/admin/api/2024-04/draft_orders/${draftOrderId}.json`;
      const getResponse = await fetch(getApiUrl, {
        method: "GET",
        // --- CORRECCIÓN 2: Añadir '!' a apiToken ---
        headers: { "X-Shopify-Access-Token": apiToken! },
      });
      if (!getResponse.ok)
        throw new Error("No se pudo obtener el borrador existente.");
      const { draft_order: existingDraft } = await getResponse.json();

      // Formatear teléfono si se proporciona uno nuevo
      let formattedPhone = fields.phone;
      if (formattedPhone) {
        formattedPhone = formattedPhone.replace(/[\s\-\(\)]+/g, "");
        if (formattedPhone.length === 10 && !formattedPhone.startsWith("+")) {
          formattedPhone = `+57${formattedPhone}`;
        } else if (!formattedPhone.startsWith("+")) {
          formattedPhone = `+${formattedPhone}`;
        }
      }

      const newName = fields.name;
      const firstName = newName
        ? newName.split(" ")[0]
        : existingDraft.customer?.first_name;
      const lastName = newName
        ? newName.split(" ").slice(1).join(" ") || firstName
        : existingDraft.customer?.last_name;

      // Asignar fulfillment_service a los line_items existentes
      const updatedLineItems = existingDraft.line_items.map((item: any) => ({
        id: item.id,
        variant_id: item.variant_id,
        quantity: item.quantity,
        fulfillment_service: "fulfillment-dropi", // El handle de tu app Dropi
      }));

      // 2. Construir el payload de actualización
      const payload = {
        draft_order: {
          id: draftOrderId,
          line_items: updatedLineItems,
          // Añadir los términos de pago "Pago tras la recepción"
          payment_terms: {
            payment_terms_type: "due_on_receipt",
          },
          shipping_address: {
            first_name: firstName,
            last_name: lastName,
            phone: formattedPhone || existingDraft.shipping_address?.phone,
            address1:
              fields.address1 || existingDraft.shipping_address?.address1,
            address2:
              fields.address2 || existingDraft.shipping_address?.address2,
            city: fields.city || existingDraft.shipping_address?.city,
            province:
              fields.province || existingDraft.shipping_address?.province,
            country: fields.country || existingDraft.shipping_address?.country,
            zip: fields.zip || existingDraft.shipping_address?.zip,
          },
          customer: {
            id: existingDraft.customer?.id,
            first_name: firstName,
            last_name: lastName,
            phone: formattedPhone || existingDraft.customer?.phone,
          },
          // También actualizamos las notas
          note_attributes: (existingDraft.note_attributes || []).map(
            (attr: any) => {
              if (attr.name === "Nombre(s) y Apellido" && fields.name)
                return { ...attr, value: fields.name };
              if (attr.name === "WhatsApp" && formattedPhone)
                return { ...attr, value: formattedPhone };
              if (
                attr.name === "Ingresa tu dirección completa" &&
                fields.address1
              )
                return { ...attr, value: fields.address1 };
              if (attr.name === "Datos adicionales" && fields.address2)
                return { ...attr, value: fields.address2 };
              if (attr.name === "Ciudad" && fields.city)
                return { ...attr, value: fields.city };
              if (attr.name === "Departamento" && fields.province)
                return { ...attr, value: fields.province };
              return attr;
            }
          ),
        },
      };

      // 3. Enviar la actualización (PUT)
      const updateApiUrl = `https://${storeUrl}/admin/api/2024-04/draft_orders/${draftOrderId}.json`;
      const response = await fetch(updateApiUrl, {
        method: "PUT",
        headers: {
          // --- CORRECCIÓN 2: Añadir '!' a apiToken ---
          "X-Shopify-Access-Token": apiToken!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Error al actualizar el borrador: ${JSON.stringify(errorData)}`
        );
      }

      const data = await response.json();
      const updatedDraft = data.draft_order;

      // --- CORRECCIÓN 1: Normalizar el objeto 'result' ---
      const result = {
        message: `✅ Borrador ${draftOrderId} actualizado. El total es ${updatedDraft.total_price}. ¿Confirmo el pedido?`,
        draftOrderId: updatedDraft.id,
        details: undefined,
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    } catch (error) {
      console.error("❌ Error al actualizar borrador:", error);

      // --- CORRECCIÓN 1: Normalizar el objeto 'result' ---
      const result = {
        message: "❌ Error al actualizar el borrador en Shopify.",
        draftOrderId: undefined,
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
// FIN DE LA HERRAMIENTA 9
// ----------------------------------------------------

// ----------------------------------------------------
// NUEVA HERRAMIENTA 10: ELIMINAR BORRADOR (Cancelación)
// ----------------------------------------------------
server.registerTool(
  "deleteDraftOrder",
  {
    title: "Eliminar Borrador de Pedido (Cancelación)",
    description:
      "Elimina permanentemente un BORRADOR de pedido si el cliente ya no lo desea. Esto no se puede deshacer.",
    inputSchema: {
      draftOrderId: z
        .number()
        .describe(
          "El ID numérico del BORRADOR de pedido a eliminar (ej. 12345)."
        ),
    },
    outputSchema: {
      message: z.string(),
      deletedDraftId: z.number(),
      details: z.string().optional(), // Para errores
    },
  },
  async ({ draftOrderId }) => {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;
    if (!storeUrl || !apiToken) {
      const result = {
        message: "Error: El servidor no está configurado para Shopify.",
        deletedDraftId: draftOrderId,
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    }

    try {
      const apiUrl = `https://{storeUrl}/admin/api/2024-04/draft_orders/{draftOrderId}.json`;

      const response = await fetch(apiUrl, {
        method: "DELETE", // Se usa DELETE para eliminar
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          `Error al eliminar el borrador: ${JSON.stringify(errorData)}`
        );
      }

      // Si Shopify devuelve 200 OK con un body vacío, fue exitoso.
      const result = {
        message: `✅ Borrador de pedido ${draftOrderId} eliminado correctamente.`,
        deletedDraftId: draftOrderId,
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    } catch (error) {
      console.error("❌ Error al eliminar borrador:", error);
      const result = {
        message: "❌ Error al eliminar el borrador en Shopify.",
        deletedDraftId: draftOrderId,
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
// FIN DE LA HERRAMIENTA 10
// ----------------------------------------------------

// ----------------------------------------------------
// NUEVA HERRAMIENTA 11: BUSCAR BORRADORES POR TELÉFONO
// ----------------------------------------------------
server.registerTool(
  "findDraftOrdersByPhone",
  {
    title: "Buscar Borradores de Pedido por Teléfono",
    description:
      "Busca borradores de pedido 'abiertos' (pendientes) asociados a un número de teléfono de cliente.",
    inputSchema: {
      phone: z
        .string()
        .describe(
          "El número de teléfono/WhatsApp del cliente (ej. 300... o +57...)."
        ),
    },
    outputSchema: {
      draftOrders: z.array(
        z.object({
          id: z.number(), // ID del borrador
          name: z.string(), // Nombre del borrador (ej. #D301)
          totalPrice: z.string(),
          createdAt: z.string(),
        })
      ),
    },
  },
  async ({ phone }) => {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiToken = process.env.SHOPIFY_API_TOKEN;
    if (!storeUrl || !apiToken) {
      const result = {
        message: "Error: El servidor no está configurado para Shopify.",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: { draftOrders: [] },
      };
    }

    // 1. Formatear el teléfono (reutilizamos la lógica)
    let formattedPhone = phone;
    if (formattedPhone) {
      formattedPhone = formattedPhone.replace(/[\s\-\(\)]+/g, "");
      if (formattedPhone.length === 10 && !formattedPhone.startsWith("+")) {
        formattedPhone = `+57${formattedPhone}`;
      } else if (!formattedPhone.startsWith("+")) {
        formattedPhone = `+${formattedPhone}`;
      }
    }

    try {
      // 2. Buscar al cliente por número de teléfono
      const searchUrl = `https://${storeUrl}/admin/api/2024-04/customers/search.json?query=phone:${encodeURIComponent(
        formattedPhone
      )}`;
      const customerResponse = await fetch(searchUrl, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
      });

      if (!customerResponse.ok) {
        throw new Error("Error al buscar el cliente por teléfono.");
      }

      const customerData = await customerResponse.json();
      if (!customerData.customers || customerData.customers.length === 0) {
        // No se encontró el cliente, por lo tanto no hay borradores.
        return {
          content: [
            {
              type: "text",
              text: "No se encontró ningún cliente con ese teléfono.",
            },
          ],
          structuredContent: { draftOrders: [] },
        };
      }

      const customerId = customerData.customers[0].id;

      // 3. Buscar borradores de pedido 'abiertos' para ese cliente
      const draftApiUrl = `https://${storeUrl}/admin/api/2024-04/draft_orders.json?customer_id=${customerId}&status=open`;
      const draftResponse = await fetch(draftApiUrl, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": apiToken,
          "Content-Type": "application/json",
        },
      });

      if (!draftResponse.ok) {
        throw new Error(
          "Cliente encontrado, pero falló la búsqueda de sus borradores."
        );
      }

      const draftData = await draftResponse.json();
      const openDrafts = draftData.draft_orders || [];

      // 4. Formatear la salida
      const formattedDrafts = openDrafts.map((d: any) => ({
        id: d.id,
        name: d.name, // ej. #D301
        totalPrice: d.total_price,
        createdAt: d.created_at,
      }));

      const message =
        formattedDrafts.length > 0
          ? `Se encontraron ${
              formattedDrafts.length
            } borradores abiertos: ${JSON.stringify(formattedDrafts, null, 2)}`
          : "El cliente no tiene borradores de pedido abiertos.";

      return {
        content: [{ type: "text", text: message }],
        structuredContent: { draftOrders: formattedDrafts },
      };
    } catch (error) {
      console.error("❌ Error al buscar borradores por teléfono:", error);
      const result = {
        message: "❌ Error al buscar los borradores de pedido.",
        details: error instanceof Error ? error.message : "Error desconocido",
      };
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: { draftOrders: [] },
      };
    }
  }
);
// ----------------------------------------------------
// FIN DE LA HERRAMIENTA 11
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
