/**
 * src/app/services/compras.service.js
 * Orquesta la transacción completa de "Finalizar Compra".
 *
 * Flujo:
 *   1. Para cada item: resolver producto_tipo y producto en DB
 *      según la acción del product-matcher (create_new / type_match / exact_match)
 *   2. Construir todos los statements del batch
 *   3. Ejecutar db.batch() — atómico: todo o nada
 *
 * D1 batch ref: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 */

import * as ProductRepo from '../repositories/product.repository.js';
import { generateId }   from '../helpers/id.js';
import { resolveUnidadMedidaId, getFactores } from './unidades.service.js';

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {string} tenantId
 * @param {string} userId
 * @param {object} payload
 * @param {string} [payload.lugarCompra]
 * @param {string} [payload.notas]
 * @param {Array}  payload.items
 * @returns {Promise<{ compraId, itemsInsertados, tiposAfectados }>}
 */
export async function finalizarCompra(db, tenantId, userId, payload) {
  const { lugarCompra, notas, items } = payload;

  if (!items?.length) throw new Error('La compra debe tener al menos un ítem.');

  // ── Paso 1: Resolver productos (puede crear tipos/productos nuevos) ────────
  // Se hace fuera del batch porque necesitamos los IDs resultantes
  // para construir los statements del batch.
  const resolvedItems = await resolveAllItems(db, tenantId, userId, items);

  // ── Paso 2: Construir batch y ejecutar ────────────────────────────────────
  const compraId   = generateId();
  const statements = buildBatch(db, { compraId, tenantId, userId, lugarCompra, notas, resolvedItems });

  await db.batch(statements);

  return {
    compraId,
    itemsInsertados: resolvedItems.length,
    tiposAfectados:  [...new Set(resolvedItems.map(i => i.productoTipoId))].length
  };
}

// ─── Resolución de items ──────────────────────────────────────────────────────

async function resolveAllItems(db, tenantId, userId, items) {
  const resolved = [];

  for (const item of items) {
    const { match, extracted } = item;

    let productoTipoId = match.productoTipoId;
    let productoId     = match.productoId;

    // Resolver símbolo de unidad a ID de DB
    const simbolo        = item.unidad_simbolo ?? extracted.unidad_medida ?? 'u';
    const unidadMedidaId = await resolveUnidadMedidaId(db, simbolo);

    if (match.action === 'create_new') {
      const tipo = await ProductRepo.createTipo(db, tenantId, {
        nombre:       match.nombreTipoSugerido ?? extracted.producto,
        unidadBaseId: unidadMedidaId,
        categoriaId:  match.categoriaIdSugerida ?? null,
        verificado:   !match.needsReview,
        createdBy:    userId
      });

      const producto = await ProductRepo.createProducto(db, tenantId, {
        productoTipoId: tipo.id,
        nombre:         extracted.producto,
        marca:          extracted.marca         ?? null,
        presentacion:   buildPresentacion(extracted),
        codigoBarras:   extracted.codigo_barras ?? null,
        precioPromedio: item.precio_unitario    ?? extracted.precio ?? 0,
        createdBy:      userId
      });

      productoTipoId = tipo.id;
      productoId     = producto.id;

    } else if (match.action === 'type_match') {
      const producto = await ProductRepo.createProducto(db, tenantId, {
        productoTipoId: match.productoTipoId,
        nombre:         extracted.producto,
        marca:          extracted.marca         ?? null,
        presentacion:   buildPresentacion(extracted),
        codigoBarras:   extracted.codigo_barras ?? null,
        precioPromedio: item.precio_unitario    ?? extracted.precio ?? 0,
        createdBy:      userId
      });

      productoId = producto.id;
    }
    // exact_match: productoTipoId y productoId ya vienen del match

    // Obtener unidad base del tipo para convertir la cantidad al stock
    const tipo             = await ProductRepo.findTipoById(db, tenantId, productoTipoId);
    const cantidad         = item.cantidad ?? extracted.cantidad ?? 1;
    const cantidadEnBase   = await convertir(db, cantidad, unidadMedidaId, tipo.unidad_base_id);

    resolved.push({
      // Para compra_items
      productoId,
      nombreRaw:        extracted.producto,
      marcaRaw:         extracted.marca         ?? null,
      cantidad,
      unidadMedidaId,
      precioUnitario:   item.precio_unitario    ?? extracted.precio ?? 0,
      fechaVencimiento: extracted.fecha_vencimiento ?? null,
      // Para stock
      productoTipoId,
      cantidadEnBase
    });
  }

  return resolved;
}

// ─── Construcción del batch ───────────────────────────────────────────────────

/**
 * Genera todos los prepared statements en el orden correcto:
 *   compra → items → stock (upsert) → stock_marcas (upsert) → precio promedio
 */
function buildBatch(db, { compraId, tenantId, userId, lugarCompra, notas, resolvedItems }) {
  const stmts = [];

  // 1. Cabecera de compra
  stmts.push(
    db.prepare(`
      INSERT INTO compras (id, tenant_id, estado, lugar_compra, notas, comprado_por, fecha_compra)
      VALUES (?, ?, 'completada', ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(compraId, tenantId, lugarCompra ?? null, notas ?? null, userId)
  );

  for (const item of resolvedItems) {
    // 2. compra_items
    stmts.push(
      db.prepare(`
        INSERT INTO compra_items
          (id, compra_id, producto_id, nombre_raw, marca_raw,
           cantidad, unidad_medida_id, precio_unitario, fecha_vencimiento)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        generateId(), compraId,
        item.productoId, item.nombreRaw, item.marcaRaw,
        item.cantidad, item.unidadMedidaId,
        item.precioUnitario, item.fechaVencimiento ?? null
      )
    );

    // 3. stock — upsert por producto_tipo
    stmts.push(
      db.prepare(`
        INSERT INTO stock (id, tenant_id, producto_tipo_id, cantidad_disponible, ultima_actualizacion)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (tenant_id, producto_tipo_id) DO UPDATE SET
          cantidad_disponible  = stock.cantidad_disponible + excluded.cantidad_disponible,
          ultima_actualizacion = CURRENT_TIMESTAMP
      `).bind(generateId(), tenantId, item.productoTipoId, item.cantidadEnBase)
    );

    // 4. stock_marcas — upsert usando subquery para obtener stock.id en el mismo batch
    stmts.push(
      db.prepare(`
        INSERT INTO stock_marcas (id, stock_id, producto_id, cantidad, ultima_compra)
        SELECT ?, s.id, ?, ?, CURRENT_TIMESTAMP
        FROM stock s
        WHERE s.tenant_id = ? AND s.producto_tipo_id = ?
        ON CONFLICT (stock_id, producto_id) DO UPDATE SET
          cantidad      = stock_marcas.cantidad + excluded.cantidad,
          ultima_compra = CURRENT_TIMESTAMP
      `).bind(generateId(), item.productoId, item.cantidadEnBase, tenantId, item.productoTipoId)
    );

    // 5. precio promedio — media móvil simple
    stmts.push(
      db.prepare(`
        UPDATE productos
        SET precio_promedio = ROUND((precio_promedio + ?) / 2.0, 2),
            updated_at      = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ?
      `).bind(item.precioUnitario, item.productoId, tenantId)
    );
  }

  return stmts;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function convertir(db, cantidad, desdeId, hastaId) {
  if (desdeId === hastaId) return cantidad;
  const { factorOrigen, factorDestino } = await getFactores(db, desdeId, hastaId);
  return parseFloat((cantidad * (factorOrigen / factorDestino)).toFixed(4));
}

function buildPresentacion(extracted) {
  if (!extracted.cantidad || !extracted.unidad_medida) return null;
  return `${extracted.cantidad}${extracted.unidad_medida}`;
}
