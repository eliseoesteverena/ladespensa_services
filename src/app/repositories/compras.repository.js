/**
 * src/app/repositories/compras.repository.js
 * Acceso a D1 para compras y compra_items.
 */

import { generateId } from '../helpers/id.js';

// ─── Lectura ──────────────────────────────────────────────────────────────────

export async function findCompraById(db, tenantId, compraId) {
  const compra = await db.prepare(`
    SELECT * FROM compras WHERE id = ? AND tenant_id = ?
  `).bind(compraId, tenantId).first();

  if (!compra) return null;

  const items = await db.prepare(`
    SELECT
      ci.*,
      p.nombre   AS producto_nombre,
      p.marca    AS producto_marca,
      um.simbolo AS unidad_simbolo
    FROM compra_items ci
    LEFT JOIN productos       p  ON p.id  = ci.producto_id
    LEFT JOIN unidades_medida um ON um.id = ci.unidad_medida_id
    WHERE ci.compra_id = ?
    ORDER BY ci.rowid ASC
  `).bind(compraId).all();

  return { ...compra, items: items.results ?? [] };
}

export async function listCompras(db, tenantId, { userId, desde, hasta, limit = 20, offset = 0 } = {}) {
  const conditions = ['c.tenant_id = ?'];
  const params     = [tenantId];

  if (userId) { conditions.push('c.comprado_por = ?'); params.push(userId); }
  if (desde)  { conditions.push('c.fecha_compra >= ?'); params.push(desde); }
  if (hasta)  { conditions.push('c.fecha_compra <= ?'); params.push(hasta); }

  const result = await db.prepare(`
    SELECT
      c.id, c.estado, c.lugar_compra, c.fecha_compra, c.notas, c.comprado_por,
      ROUND(SUM(ci.precio_total), 2) AS total,
      COUNT(ci.id)                   AS cantidad_items
    FROM compras c
    LEFT JOIN compra_items ci ON ci.compra_id = c.id
    WHERE ${conditions.join(' AND ')}
    GROUP BY c.id
    ORDER BY c.fecha_compra DESC
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all();

  return result.results ?? [];
}

export async function gastosPorCategoria(db, tenantId, { desde, hasta }) {
  const result = await db.prepare(`
    SELECT
      COALESCE(cp.nombre, c.nombre, 'Sin categoría') AS categoria,
      COALESCE(c.nombre, 'Sin categoría')             AS subcategoria,
      ROUND(SUM(ci.precio_total), 2)                  AS total,
      COUNT(DISTINCT co.id)                           AS cantidad_compras
    FROM compra_items ci
    JOIN compras         co ON co.id  = ci.compra_id
    JOIN productos        p ON p.id   = ci.producto_id
    JOIN producto_tipos  pt ON pt.id  = p.producto_tipo_id
    LEFT JOIN categorias  c ON c.id   = pt.categoria_id
    LEFT JOIN categorias cp ON cp.id  = c.parent_id
    WHERE co.tenant_id    = ?
      AND co.fecha_compra BETWEEN ? AND ?
    GROUP BY c.id
    ORDER BY total DESC
  `).bind(tenantId, desde, hasta).all();

  return result.results ?? [];
}

// ─── Escritura ────────────────────────────────────────────────────────────────

export async function insertCompra(db, tenantId, data) {
  const id = generateId();

  await db.prepare(`
    INSERT INTO compras (id, tenant_id, estado, lugar_compra, notas, comprado_por, fecha_compra)
    VALUES (?, ?, 'completada', ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(id, tenantId, data.lugarCompra ?? null, data.notas ?? null, data.compradoPor).run();

  return id;
}

export async function insertCompraItem(db, data) {
  const id = generateId();

  await db.prepare(`
    INSERT INTO compra_items
      (id, compra_id, producto_id, nombre_raw, marca_raw,
       cantidad, unidad_medida_id, precio_unitario, fecha_vencimiento)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.compraId,
    data.productoId       ?? null,
    data.nombreRaw,
    data.marcaRaw         ?? null,
    data.cantidad,
    data.unidadMedidaId,
    data.precioUnitario   ?? 0,
    data.fechaVencimiento ?? null
  ).run();

  return id;
}
