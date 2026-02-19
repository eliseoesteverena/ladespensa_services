/**
 * src/app/helpers/normalize.js
 * Normalización de nombres de productos para búsqueda fuzzy.
 *
 * El nombre_normalizado que se guarda en producto_tipos debe pasar
 * siempre por normalizeProductName — tanto al insertar como al buscar —
 * para garantizar consistencia de matching.
 */

/**
 * Normaliza un nombre para guardar en DB y para búsqueda.
 * - Lowercase
 * - Elimina acentos y diacríticos
 * - Solo caracteres alfanuméricos y espacios
 * - Colapsa espacios múltiples
 * - Incorpora la marca si no está ya contenida en el nombre
 *
 * @param {string}      nombre
 * @param {string|null} marca
 * @returns {string}
 */
export function normalizeProductName(nombre, marca = null) {
  let base = nombre ?? '';

  if (marca && !base.toLowerCase().includes(marca.toLowerCase())) {
    base = `${base} ${marca}`;
  }

  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Versión más agresiva para comparación de tipos (no usar para guardar en DB).
 * Elimina cantidades y unidades para que "leche entera 1L" y "leche entera 500ml"
 * sean tratados como el mismo tipo al calcular similitud.
 *
 * @param {string} normalizedName   - Ya pasado por normalizeProductName
 * @returns {string}
 */
export function stripQuantities(normalizedName) {
  return normalizedName
    .replace(/\b\d+(\.\d+)?\s*(kg|gr|g|mg|lt|l|ml|cl|u|un|unidad|doc|pak)\b/gi, '')
    .replace(/\b\d+\s*x\s*\d+\b/gi, '')
    .replace(/\b\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
