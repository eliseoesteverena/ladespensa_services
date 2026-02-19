/**
 * src/app/helpers/product-matcher.js
 * Resolución de productos contra el catálogo del tenant.
 *
 * Dado el output de Gemini Vision (extracción de etiqueta), determina
 * si el producto ya existe, a qué producto_tipo corresponde y qué acción tomar.
 *
 * Fases (con early return para minimizar llamadas externas):
 *   0. Baja confianza de OCR → crear genérico directo (0 llamadas)
 *   1. Código de barras       → query D1 exacta            (0 llamadas)
 *   2. Fuzzy local Jaccard    → si hay ganador claro        (0 llamadas)
 *   3. Gemini texto puro      → solo si hay ambigüedad real (1 llamada, sin imagen)
 *
 * @module product-matcher
 */

import { normalizeProductName, stripQuantities } from './normalize.js';

// ─── Configuración ────────────────────────────────────────────────────────────

const GEMINI_MODEL    = 'gemini-2.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Si el mejor candidato local supera este score → match sin Gemini
const AUTO_MATCH_THRESHOLD = 0.85;

// Máximo de candidatos enviados a Gemini como contexto
const MAX_CANDIDATES_TO_GEMINI = 8;

// ─── Schema de respuesta del paso de matching ─────────────────────────────────

const MATCHING_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    accion: {
      type: 'string',
      enum: ['exact_match', 'type_match', 'create_new'],
      description: [
        'exact_match  → producto idéntico a un candidato (misma marca y presentación).',
        'type_match   → mismo tipo genérico, distinta marca o presentación.',
        'create_new   → no corresponde a ningún candidato.'
      ].join(' ')
    },
    candidato_id: {
      type: 'string',
      description: 'ID del candidato seleccionado. producto_id si exact_match, producto_tipo_id si type_match. Vacío si create_new.'
    },
    nombre_tipo_sugerido: {
      type: 'string',
      description: 'Nombre canónico genérico sin marca ni tamaño. Ej: "Aceite de girasol". Solo si create_new o type_match nuevo.'
    },
    categoria_id_sugerida: {
      type: 'string',
      description: 'ID de categoría del listado provisto. Vacío si ninguna aplica.'
    },
    confianza: {
      type: 'string',
      enum: ['alta', 'media', 'baja']
    },
    razon: {
      type: 'string',
      description: 'Explicación breve de la decisión.'
    }
  },
  required: ['accion', 'confianza', 'razon']
};

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * @typedef {object} MatchResult
 * @property {'exact_match'|'type_match'|'create_new'} action
 * @property {string|null} productoId
 * @property {string|null} productoTipoId
 * @property {string|null} nombreTipoSugerido
 * @property {string|null} marcaSugerida
 * @property {string|null} categoriaIdSugerida
 * @property {boolean}     needsReview
 * @property {string}      razon
 * @property {'barcode'|'local_fuzzy'|'gemini_text'|'low_confidence_bypass'|'error_fallback'} source
 */

/**
 * @param {object} extracted   Output de Gemini Vision ya parseado
 * @param {string} tenantId
 * @param {object} env         Bindings del Worker (env.DB, env.GEMINI_API_KEY)
 * @returns {Promise<MatchResult>}
 */
export async function resolveProduct(extracted, tenantId, env) {
  const { producto, marca, codigo_barras, confianza: extractionConfidence } = extracted;

  // ── Fase 0: baja confianza → crear genérico sin más análisis ─────────────
  if (extractionConfidence === 'baja') {
    return buildResult('create_new', {
      needsReview:         true,
      nombreTipoSugerido:  producto || 'Producto sin identificar',
      marcaSugerida:       marca ?? null,
      razon:               'Extracción de baja confianza — creado como genérico para revisión manual.',
      source:              'low_confidence_bypass'
    });
  }

  // ── Fase 1: código de barras ──────────────────────────────────────────────
  if (codigo_barras) {
    const exact = await findByBarcode(env.DB, tenantId, codigo_barras);
    if (exact) {
      return buildResult('exact_match', {
        productoId:     exact.id,
        productoTipoId: exact.producto_tipo_id,
        needsReview:    false,
        razon:          'Match exacto por código de barras.',
        source:         'barcode'
      });
    }
  }

  // ── Fase 2: fuzzy local ───────────────────────────────────────────────────
  const normalizedName = normalizeProductName(producto, marca);
  const strippedName   = stripQuantities(normalizedName);
  const candidates     = await findCandidates(env.DB, tenantId, strippedName);

  if (candidates.length === 1 && candidates[0].similarity >= AUTO_MATCH_THRESHOLD) {
    const top = candidates[0];
    return buildResult('type_match', {
      productoTipoId:     top.id,
      needsReview:        false,
      nombreTipoSugerido: top.nombre,
      razon:              `Match automático por similitud ${(top.similarity * 100).toFixed(0)}%.`,
      source:             'local_fuzzy'
    });
  }

  // ── Fase 3: Gemini texto puro ─────────────────────────────────────────────
  const categories = await getAllCategories(env.DB);

  const geminiResult = await callGeminiForMatching({
    extracted,
    candidates:  candidates.slice(0, MAX_CANDIDATES_TO_GEMINI),
    categories,
    apiKey:      env.GEMINI_API_KEY
  });

  return interpretGeminiResult(geminiResult, candidates, extractionConfidence);
}

// ─── Fases internas ───────────────────────────────────────────────────────────

async function findByBarcode(db, tenantId, barcode) {
  return db.prepare(`
    SELECT p.id, p.producto_tipo_id
    FROM productos p
    WHERE p.tenant_id = ? AND p.codigo_barras = ? AND p.is_active = TRUE
    LIMIT 1
  `).bind(tenantId, barcode).first();
}

async function findCandidates(db, tenantId, normalizedName) {
  const tokens = getTokens(normalizedName);
  if (tokens.length === 0) return [];

  const filterTokens = tokens.sort((a, b) => b.length - a.length).slice(0, 3);
  const likeClauses  = filterTokens.map(() => `pt.nombre_normalizado LIKE ?`).join(' OR ');

  const result = await db.prepare(`
    SELECT pt.id, pt.nombre, pt.nombre_normalizado, pt.categoria_id, pt.unidad_base_id
    FROM producto_tipos pt
    WHERE pt.tenant_id = ? AND (${likeClauses})
    LIMIT 20
  `).bind(tenantId, ...filterTokens.map(t => `%${t}%`)).all();

  const inputSet = new Set(tokens);

  return (result.results ?? [])
    .map(row => ({
      ...row,
      similarity: jaccard(inputSet, new Set(getTokens(stripQuantities(row.nombre_normalizado))))
    }))
    .filter(r => r.similarity > 0.2)
    .sort((a, b) => b.similarity - a.similarity);
}

// Caché de categorías en memoria del isolate
let _categoriesCache = null;

async function getAllCategories(db) {
  if (_categoriesCache) return _categoriesCache;
  const result = await db.prepare(`
    SELECT c.id, c.nombre, p.nombre AS parent_nombre
    FROM categorias c
    LEFT JOIN categorias p ON c.parent_id = p.id
    ORDER BY p.nombre, c.nombre
  `).all();
  _categoriesCache = result.results ?? [];
  return _categoriesCache;
}

async function callGeminiForMatching({ extracted, candidates, categories, apiKey }) {
  const candidatesText = candidates.length > 0
    ? candidates.map((c, i) =>
        `  ${i + 1}. ID="${c.id}" | Tipo="${c.nombre}" | Similitud=${(c.similarity * 100).toFixed(0)}%`
      ).join('\n')
    : '  (catálogo vacío o sin similitud)';

  const categoriesText = categories
    .map(c => `  ID="${c.id}" | ${c.parent_nombre ? `${c.parent_nombre} > ` : ''}${c.nombre}`)
    .join('\n');

  const prompt = `
Producto escaneado:
  Nombre: "${extracted.producto}"
  Marca: "${extracted.marca || '(sin marca)'}"
  Presentación: "${extracted.cantidad ?? ''}${extracted.unidad_medida ?? ''}"
  Info adicional: "${extracted.descripcion_adicional || ''}"

Tipos existentes en el catálogo (candidatos):
${candidatesText}

Categorías disponibles:
${categoriesText}

Reglas para decidir:
- exact_match: mismo producto, misma marca y presentación.
- type_match: mismo tipo genérico (función), distinta marca o tamaño.
  Ejemplos de mismo tipo: "Aceite girasol El Mirador 1L" y "Aceite girasol Cocinero 900ml".
  Ejemplos de tipo distinto: "Aceite de girasol" ≠ "Aceite de oliva".
- create_new: no corresponde a ningún candidato.
- nombre_tipo_sugerido: genérico sin marca ni tamaño. Ej: "Aceite de girasol".
- categoria_id_sugerida: el ID más específico del listado.
`;

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema:    MATCHING_RESPONSE_SCHEMA,
        temperature:        0.1,
        maxOutputTokens:    512
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini matching HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Respuesta inesperada de Gemini en matching.');

  return JSON.parse(text);
}

function interpretGeminiResult(result, candidates, extractionConfidence) {
  const { accion, candidato_id, nombre_tipo_sugerido, categoria_id_sugerida, confianza, razon } = result;
  const needsReview = confianza !== 'alta' || extractionConfidence !== 'alta';

  if (accion === 'exact_match' && candidato_id) {
    const candidate = candidates.find(c => c.id === candidato_id);
    return buildResult('exact_match', {
      productoId:     candidato_id,
      productoTipoId: candidate?.id ?? null,
      needsReview,
      razon,
      source: 'gemini_text'
    });
  }

  if (accion === 'type_match' && candidato_id) {
    return buildResult('type_match', {
      productoTipoId:     candidato_id,
      nombreTipoSugerido: nombre_tipo_sugerido ?? null,
      categoriaIdSugerida: categoria_id_sugerida ?? null,
      needsReview,
      razon,
      source: 'gemini_text'
    });
  }

  return buildResult('create_new', {
    needsReview:         needsReview || confianza === 'baja',
    nombreTipoSugerido:  nombre_tipo_sugerido ?? null,
    categoriaIdSugerida: categoria_id_sugerida ?? null,
    razon,
    source: 'gemini_text'
  });
}

// ─── Helpers de similitud ─────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'de', 'la', 'el', 'en', 'con', 'sin', 'para', 'por', 'los', 'las',
  'del', 'al', 'un', 'una', 'y', 'o', 'e', 'x', 'pack', 'set'
]);

function getTokens(name) {
  return name.toLowerCase().split(/\s+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter(t => setB.has(t)).length;
  return intersection / (setA.size + setB.size - intersection);
}

// ─── Builder ──────────────────────────────────────────────────────────────────

function buildResult(action, fields) {
  return {
    action,
    productoId:          fields.productoId          ?? null,
    productoTipoId:      fields.productoTipoId      ?? null,
    nombreTipoSugerido:  fields.nombreTipoSugerido  ?? null,
    marcaSugerida:       fields.marcaSugerida        ?? null,
    categoriaIdSugerida: fields.categoriaIdSugerida ?? null,
    needsReview:         fields.needsReview          ?? false,
    razon:               fields.razon               ?? '',
    source:              fields.source              ?? 'unknown'
  };
}
