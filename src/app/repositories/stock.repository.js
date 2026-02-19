/**
 * src/app/repositories/stock.repository.js
 * Acceso a D1 para stock y stock_marcas.
 */

import { generateId } from '../helpers/id.js';

// ─── Lectura ──────────────────────────────────────────────────────────────────

export async function findStockByTipo(db, tenantId, productoTipoId) {
  const stock = await db.prepare(`
    SELECT s.*, pt.nombre AS tipo_nombre, um.simbolo AS unidad_simbolo
    FROM stock s
    JOIN producto_tipos   pt ON pt.id = s.producto_tipo_id
    JOIN unidades_medida  um ON um.id = pt.unidad_base_id
    WHERE s.tenant_id = ? AND s.producto_tipo_id = ?
  `).bind(tenantId, productoTipoId).first();

  if (!stock) return null;

  const marcas = await db.prepare(`
    SELECT sm.cantidad, sm.ultima_compra,
           p.id AS producto_id, p.nombre AS producto_nombre, p.marca, p.presentacion
    FROM stock_marcas sm
    JOIN productos p ON p.id = sm.producto_id
    WHERE sm.stock_id = ?
    ORDER BY sm.cantidad DESC
  `).bind(stock.id).all();

  return { ...stock, marcas: marcas.results ?? [] };
}

export async function listStock(db, tenantId, { soloAlertas = false, limit = 100, offset = 0 } = {}) {
  const alertaFilter = soloAlertas ? 'AND s.cantidad_disponible <= s.stock_minimo' : '';

  const result = await db.prepare(`
    SELECT
      s.id, s.producto_tipo_id, s.cantidad_disponible, s.stock_minimo,
      s.ubicacion, s.fecha_vencimiento, s.ultima_actualizacion,
      pt.nombre  AS tipo_nombre,
      c.nombre   AS categoria_nombre,
      um.simbolo AS unidad_simbolo
    FROM stock s
    JOIN producto_tipos   pt ON pt.id = s.producto_tipo_id
    LEFT JOIN categorias   c ON c.id  = pt.categoria_id
    JOIN unidades_medida  um ON um.id = pt.unidad_base_id
    WHERE s.tenant_id = ? ${alertaFilter}
    ORDER BY pt.nombre ASC
    LIMIT ? OFFSET ?
  `).bind(tenantId, limit, offset).all();

  return result.results ?? [];
}

/**
 * Verifica si hay stock suficiente para una lista de ingredientes de receta.
 * Aplica conversión de unidades usando factor_base.
 *
 * @param {Array<{ productoTipoId, cantidad, factorOrigen, factorDestino }>} ingredientes
 */
export async function checkStockParaReceta(db, tenantId, ingredientes) {
  const resultados = [];

  for (const ing of ingredientes) {
    const stock = await db.prepare(`
      SELECT s.cantidad_disponible, pt.nombre AS tipo_nombre
      FROM stock s
      JOIN producto_tipos pt ON pt.id = s.producto_tipo_id
      WHERE s.tenant_id = ? AND s.producto_tipo_id = ?
    `).bind(tenantId, ing.productoTipoId).first();

    const disponible      = stock?.cantidad_disponible ?? 0;
    const requeridoEnBase = ing.cantidad * (ing.factorOrigen / ing.factorDestino);

    resultados.push({
      productoTipoId: ing.productoTipoId,
      tipoNombre:     stock?.tipo_nombre ?? 'Desconocido',
      tieneStock:     disponible >= requeridoEnBase,
      disponible,
      requerido:      requeridoEnBase,
      faltante:       Math.max(0, requeridoEnBase - disponible)
    });
  }

  return resultados;
}

// ─── Escritura ────────────────────────────────────────────────────────────────

/**
 * Upsert de stock para un producto_tipo.
 * Si no existe la fila la crea; si existe suma la cantidad.
 */
export async function incrementStock(db, tenantId, productoTipoId, cantidad, opts = {}) {
  await db.prepare(`
    INSERT INTO stock (id, tenant_id, producto_tipo_id, cantidad_disponible, ubicacion, fecha_vencimiento, ultima_actualizacion)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (tenant_id, producto_tipo_id) DO UPDATE SET
      cantidad_disponible  = stock.cantidad_disponible + excluded.cantidad_disponible,
      ubicacion            = COALESCE(excluded.ubicacion,        stock.ubicacion),
      fecha_vencimiento    = COALESCE(excluded.fecha_vencimiento, stock.fecha_vencimiento),
      ultima_actualizacion = CURRENT_TIMESTAMP
  `).bind(
    generateId(), tenantId, productoTipoId, cantidad,
    opts.ubicacion ?? null, opts.fechaVencimiento ?? null
  ).run();
}

/**
 * Ajuste manual: sobreescribe la cantidad actual del stock.
 */
export async function setStock(db, tenantId, productoTipoId, nuevaCantidad, opts = {}) {
  await db.prepare(`
    UPDATE stock
    SET cantidad_disponible  = ?,
        stock_minimo         = COALESCE(?, stock_minimo),
        ubicacion            = COALESCE(?, ubicacion),
        fecha_vencimiento    = COALESCE(?, fecha_vencimiento),
        ultima_actualizacion = CURRENT_TIMESTAMP
    WHERE tenant_id = ? AND producto_tipo_id = ?
  `).bind(
    nuevaCantidad,
    opts.stockMinimo      ?? null,
    opts.ubicacion        ?? null,
    opts.fechaVencimiento ?? null,
    tenantId, productoTipoId
  ).run();
}

/**
 * Resta cantidad del stock. Lanza StockInsuficienteError si no alcanza.
 */
export async function decrementStock(db, tenantId, productoTipoId, cantidad) {
  const stock = await db.prepare(`
    SELECT id, cantidad_disponible FROM stock
    WHERE tenant_id = ? AND producto_tipo_id = ?
  `).bind(tenantId, productoTipoId).first();

  if (!stock) throw new Error(`Sin registro de stock para tipo ${productoTipoId}.`);

  if (stock.cantidad_disponible < cantidad) {
    throw new StockInsuficienteError(productoTipoId, stock.cantidad_disponible, cantidad);
  }

  await db.prepare(`
    UPDATE stock
    SET cantidad_disponible  = cantidad_disponible - ?,
        ultima_actualizacion = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(cantidad, stock.id).run();
}

// ─── stock_marcas ─────────────────────────────────────────────────────────────

/**
 * Upsert de stock_marcas para un producto específico.
 */
export async function incrementStockMarca(db, stockId, productoId, cantidad) {
  await db.prepare(`
    INSERT INTO stock_marcas (id, stock_id, producto_id, cantidad, ultima_compra)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (stock_id, producto_id) DO UPDATE SET
      cantidad      = stock_marcas.cantidad + excluded.cantidad,
      ultima_compra = CURRENT_TIMESTAMP
  `).bind(generateId(), stockId, productoId, cantidad).run();
}

export async function findStockId(db, tenantId, productoTipoId) {
  const row = await db.prepare(`
    SELECT id FROM stock WHERE tenant_id = ? AND producto_tipo_id = ?
  `).bind(tenantId, productoTipoId).first();
  return row?.id ?? null;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class StockInsuficienteError extends Error {
  constructor(productoTipoId, disponible, requerido) {
    super(`Stock insuficiente para tipo ${productoTipoId}.`);
    this.name           = 'StockInsuficienteError';
    this.productoTipoId = productoTipoId;
    this.disponible     = disponible;
    this.requerido      = requerido;
  }
}
