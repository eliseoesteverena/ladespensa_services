/**
 * src/app/routes/scan.routes.js
 * Endpoint de extracción OCR + resolución de producto.
 *
 * POST /scan-etiqueta
 *   Body: multipart/form-data
 *     imagen: archivo (jpg, jpeg, png, webp) — max 20 MB
 *
 * Flujo:
 *   1. Validar imagen
 *   2. Gemini Vision → datos estructurados
 *   3. product-matcher → acción (exact_match / type_match / create_new)
 *   4. Retornar { extracted, match } al cliente
 *
 * El cliente acumula estos resultados localmente hasta "Finalizar Compra".
 */

import { resolveProduct }  from '../helpers/product-matcher.js';
import { ok, badRequest, serverError, badGateway } from '../helpers/response.js';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES     = 20 * 1024 * 1024;

const GEMINI_MODEL    = 'gemini-2.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ─── Schema de extracción ─────────────────────────────────────────────────────

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    producto:                 { type: 'string',  description: 'Nombre completo tal como aparece en la etiqueta.' },
    marca:                    { type: 'string',  description: 'Marca o fabricante. Vacío si no se ve.' },
    precio:                   { type: 'number',  description: 'Precio de venta final (sin símbolo de moneda).' },
    moneda:                   { type: 'string',  description: 'Código de moneda inferido: ARS, USD, EUR, etc.' },
    unidad_medida:            { type: 'string',  description: 'Unidad del producto.', enum: ['kg', 'gr', 'mg', 'lt', 'ml', 'unidad'] },
    cantidad:                 { type: 'number',  description: 'Cantidad en la unidad indicada. Ej: 500 para 500gr.' },
    precio_por_unidad_medida: { type: 'number',  description: 'Precio de referencia por unidad estándar ($/kg, $/lt) si está en etiqueta.' },
    unidad_precio_referencia: { type: 'string',  description: 'Unidad del precio de referencia. Ej: kg, lt, 100gr.' },
    codigo_barras:            { type: 'string',  description: 'Código de barras o EAN si es visible.' },
    fecha_vencimiento:        { type: 'string',  description: 'Fecha de vencimiento en formato YYYY-MM-DD si es visible.' },
    descripcion_adicional:    { type: 'string',  description: 'Info extra: sabor, variedad, promoción, leyendas.' },
    confianza:                { type: 'string',  description: 'Confianza global de la extracción.', enum: ['alta', 'media', 'baja'] }
  },
  required: ['producto', 'precio', 'unidad_medida', 'confianza']
};

const SYSTEM_PROMPT = `Sos un extractor de datos de etiquetas de precios de supermercado.
Analizá la imagen y extraé únicamente la información que puedas leer con claridad.

REGLAS:
- Extraé SOLO lo que sea visible y legible.
- Si un campo no está presente o no es legible, devolvé string vacío "" o null.
- Para "unidad_medida": si no se menciona ninguna unidad, usá "unidad".
- Para "precio": usá siempre el precio final de venta, nunca el precio tachado ni el precio por kg.
- Para "cantidad": si dice "500g" → cantidad=500, unidad_medida="gr".
- Para "fecha_vencimiento": formato YYYY-MM-DD. Null si no se ve.
- "confianza" refleja qué tan bien se pudo leer la etiqueta en general.
- No inventes datos. Si no se ve, dejá vacío.`;

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleScanEtiqueta(request, ctx, env) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest('El body debe ser multipart/form-data.', null, env.ALLOWED_ORIGINS);
  }

  const imagenFile = formData.get('imagen');

  if (!imagenFile || typeof imagenFile === 'string') {
    return badRequest("Falta el campo 'imagen'.", null, env.ALLOWED_ORIGINS);
  }
  if (!ALLOWED_MIME_TYPES.includes(imagenFile.type)) {
    return badRequest(`Tipo no permitido: ${imagenFile.type}. Permitidos: jpg, png, webp.`, null, env.ALLOWED_ORIGINS);
  }

  const arrayBuffer = await imagenFile.arrayBuffer();

  if (arrayBuffer.byteLength > MAX_SIZE_BYTES) {
    return badRequest('La imagen supera el límite de 20 MB.', null, env.ALLOWED_ORIGINS);
  }

  // ── Extracción con Gemini Vision ──────────────────────────────────────────
  let extracted;
  try {
    extracted = await extractFromImage(arrayBuffer, imagenFile.type, env.GEMINI_API_KEY);
  } catch (err) {
    console.error('[scan] Gemini extraction error:', err);
    return badGateway(`Error en extracción OCR: ${err.message}`, null, env.ALLOWED_ORIGINS);
  }

  // ── Resolución de producto ────────────────────────────────────────────────
  let match;
  try {
    match = await resolveProduct(extracted, ctx.tenantId, env);
  } catch (err) {
    console.error('[scan] product-matcher error:', err);
    // Degradación elegante: la extracción fue exitosa, el matching falló
    match = {
      action:              'create_new',
      productoId:          null,
      productoTipoId:      null,
      nombreTipoSugerido:  extracted.producto,
      marcaSugerida:       extracted.marca ?? null,
      categoriaIdSugerida: null,
      needsReview:         true,
      razon:               `Error en matching: ${err.message}`,
      source:              'error_fallback'
    };
  }

  return ok({ extracted, match }, env.ALLOWED_ORIGINS);
}

// ─── Extracción con Gemini Vision ─────────────────────────────────────────────

async function extractFromImage(arrayBuffer, mimeType, apiKey) {
  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      parts: [
        { text: 'Extraé los datos de esta etiqueta de supermercado.' },
        { inline_data: { mime_type: mimeType, data: arrayBufferToBase64(arrayBuffer) } }
      ]
    }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema:    EXTRACTION_SCHEMA,
      temperature:        0.1,
      maxOutputTokens:    1024
    }
  };

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) throw new Error('Respuesta inesperada de Gemini (sin content).');

  return JSON.parse(text);
}

function arrayBufferToBase64(buffer) {
  const bytes  = new Uint8Array(buffer);
  let   binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
