/**
 * src/app/repositories/product.repository.js
 * Acceso a D1 para producto_tipos y productos.
 * Toda la SQL del dominio de productos vive aquí.
 */

import { normalizeProductName } from '../helpers/normalize.js';
import { generateId }           from '../helpers/id.js';

// ─── producto_tipos ───────────────────────────────────────────────────────────

export async function findTipoById(db, tenantId, tipoId) {
  return db.prepare(`
    SELECT pt.*, c.nombre AS categoria_nombre, um.simbolo AS unidad_simbolo
    FROM producto_tipos pt
    LEFT JOIN categorias      c  ON c.id  = pt.categoria_id
    LEFT JOIN unidades_medida um ON um.id = pt.unidad_base_id
    WHERE pt.id = ? AND pt.tenant_id = ?
  `).bind(tipoId, tenantId).first();
}

/**
 * Crea un nuevo producto_tipo.
 *
 * @param {object} data
 * @param {string} data.nombre
 * @param {string} data.unidadBaseId
 * @param {string} [data.categoriaId]
 * @param {boolean} [data.verificado]   false = creado por Gemini con baja confianza
 * @param {string} data.createdBy
 */
export async function createTipo(db, tenantId, data) {
  const id                = generateId();
  const nombreNormalizado = normalizeProductName(data.nombre);

  await db.prepare(`
    INSERT INTO producto_tipos
      (id, tenant_id, nombre, nombre_normalizado, categoria_id, unidad_base_id, verificado, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    tenantId,
    data.nombre,
    nombreNormalizado,
    data.categoriaId  ?? null,
    data.unidadBaseId,
    data.verificado   ?? true,
    data.createdBy
  ).run();

  return findTipoById(db, tenantId, id);
}

export async function verifyTipo(db, tenantId, tipoId) {
  await db.prepare(`
    UPDATE producto_tipos
    SET verificado = TRUE, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND tenant_id = ?
  `).bind(tipoId, tenantId).run();
}

export async function listTipos(db, tenantId, { categoriaId, soloNoVerificados, limit = 50, offset = 0 } = {}) {
  const conditions = ['pt.tenant_id = ?'];
  const params     = [tenantId];

  if (categoriaId)        { conditions.push('pt.categoria_id = ?');   params.push(categoriaId); }
  if (soloNoVerificados)  { conditions.push('pt.verificado = FALSE'); }

  const result = await db.prepare(`
    SELECT pt.id, pt.nombre, pt.verificado, pt.categoria_id,
           c.nombre AS categoria_nombre, um.simbolo AS unidad_simbolo
    FROM producto_tipos pt
    LEFT JOIN categorias      c  ON c.id  = pt.categoria_id
    LEFT JOIN unidades_medida um ON um.id = pt.unidad_base_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY pt.nombre ASC
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all();

  return result.results ?? [];
}

// ─── productos ────────────────────────────────────────────────────────────────

export async function findByBarcode(db, tenantId, codigoBarras) {
  return db.prepare(`
    SELECT p.*, pt.nombre AS tipo_nombre, pt.unidad_base_id
    FROM productos p
    JOIN producto_tipos pt ON pt.id = p.producto_tipo_id
    WHERE p.tenant_id = ? AND p.codigo_barras = ? AND p.is_active = TRUE
    LIMIT 1
  `).bind(tenantId, codigoBarras).first();
}

export async function findProductoById(db, tenantId, productoId) {
  return db.prepare(`
    SELECT p.*, pt.nombre AS tipo_nombre, pt.unidad_base_id, pt.categoria_id
    FROM productos p
    JOIN producto_tipos pt ON pt.id = p.producto_tipo_id
    WHERE p.id = ? AND p.tenant_id = ?
  `).bind(productoId, tenantId).first();
}

/**
 * Crea un nuevo producto bajo un tipo existente.
 *
 * @param {object} data
 * @param {string} data.productoTipoId
 * @param {string} data.nombre
 * @param {string} [data.marca]
 * @param {string} [data.presentacion]
 * @param {string} [data.codigoBarras]
 * @param {number} [data.precioPromedio]
 * @param {string} data.createdBy
 */
export async function createProducto(db, tenantId, data) {
  const id = generateId();

  await db.prepare(`
    INSERT INTO productos
      (id, tenant_id, producto_tipo_id, nombre, marca, presentacion,
       codigo_barras, precio_promedio, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    tenantId,
    data.productoTipoId,
    data.nombre,
    data.marca          ?? null,
    data.presentacion   ?? null,
    data.codigoBarras   ?? null,
    data.precioPromedio ?? 0,
    data.createdBy
  ).run();

  return findProductoById(db, tenantId, id);
}

export async function listProductosByTipo(db, tenantId, tipoId) {
  const result = await db.prepare(`
    SELECT p.id, p.nombre, p.marca, p.presentacion, p.codigo_barras, p.precio_promedio
    FROM productos p
    WHERE p.tenant_id = ? AND p.producto_tipo_id = ? AND p.is_active = TRUE
    ORDER BY p.marca ASC
  `).bind(tenantId, tipoId).all();

  return result.results ?? [];
}

/**
 * Busca candidatos de producto_tipo para matching fuzzy.
 * Filtra con LIKE sobre tokens; el rankeo Jaccard lo hace product-matcher en memoria.
 */
export async function findTipoCandidates(db, tenantId, tokens) {
  if (!tokens?.length) return [];

  const filterTokens = tokens.sort((a, b) => b.length - a.length).slice(0, 3);
  const likeClauses  = filterTokens.map(() => `pt.nombre_normalizado LIKE ?`).join(' OR ');

  const result = await db.prepare(`
    SELECT pt.id, pt.nombre, pt.nombre_normalizado, pt.categoria_id, pt.unidad_base_id
    FROM producto_tipos pt
    WHERE pt.tenant_id = ? AND (${likeClauses})
    LIMIT 20
  `).bind(tenantId, ...filterTokens.map(t => `%${t}%`)).all();

  return result.results ?? [];
}
