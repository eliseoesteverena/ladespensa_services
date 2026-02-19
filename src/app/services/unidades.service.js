/**
 * src/app/services/unidades.service.js
 * Resolución de símbolos de unidad de medida a IDs de DB.
 *
 * El cliente/OCR envía símbolos como "kg", "gr", "lt".
 * Este service los convierte al id de la tabla unidades_medida.
 *
 * El mapa se cachea en memoria del isolate: se carga una vez desde D1
 * y se reutiliza en todas las requests de esa instancia del worker.
 */

let _cache = null;

/**
 * @param {object} db
 * @param {string} simbolo   — "kg", "gr", "lt", "ml", "unidad", etc.
 * @returns {Promise<string>}  id de unidades_medida
 */
export async function resolveUnidadMedidaId(db, simbolo) {
  const mapa = await getCache(db);
  const norm  = normalizarSimbolo(simbolo);
  return mapa[norm] ?? mapa['u'] ?? Object.values(mapa)[0];
}

/**
 * Retorna los factores de conversión de dos unidades.
 * Necesario para convertir cantidades de receta a unidad base de stock.
 *
 * @returns {Promise<{ factorOrigen: number, factorDestino: number, tipo: string }>}
 */
export async function getFactores(db, desdeId, hastaId) {
  if (desdeId === hastaId) return { factorOrigen: 1, factorDestino: 1, tipo: null };

  const result = await db.prepare(`
    SELECT id, factor_base, tipo FROM unidades_medida WHERE id IN (?, ?)
  `).bind(desdeId, hastaId).all();

  const desde = result.results.find(u => u.id === desdeId);
  const hasta  = result.results.find(u => u.id === hastaId);

  if (!desde || !hasta) throw new Error('Unidad de medida no encontrada.');
  if (desde.tipo !== hasta.tipo) {
    throw new Error(`No se puede convertir entre tipos distintos: ${desde.tipo} → ${hasta.tipo}.`);
  }

  return { factorOrigen: desde.factor_base, factorDestino: hasta.factor_base, tipo: desde.tipo };
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function getCache(db) {
  if (_cache) return _cache;
  const result = await db.prepare(`SELECT id, simbolo FROM unidades_medida`).all();
  _cache = {};
  for (const row of result.results ?? []) {
    _cache[row.simbolo.toLowerCase()] = row.id;
  }
  return _cache;
}

/**
 * Normaliza variantes del OCR al símbolo canónico de la DB.
 * Gemini usa el enum: kg, gr, mg, lt, ml, unidad
 * La DB tiene:        kg, g,  mg, L,  ml, cl, u, doc, pak
 */
function normalizarSimbolo(simbolo) {
  if (!simbolo) return 'u';
  const aliases = {
    'gr': 'g', 'g': 'g',
    'lt': 'L', 'l': 'L', 'lts': 'L', 'litro': 'L', 'litros': 'L',
    'unidad': 'u', 'unidades': 'u', 'un': 'u'
  };
  return aliases[simbolo.toLowerCase().trim()] ?? simbolo.toLowerCase().trim();
}
