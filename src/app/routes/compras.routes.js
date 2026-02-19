/**
 * src/app/routes/compras.routes.js
 *
 * POST   /compras           Registra compra completa (Finalizar Compra)
 * GET    /compras           Lista compras del tenant
 * GET    /compras/gastos    Resumen de gastos por categoría y período
 * GET    /compras/:id       Detalle de una compra con sus items
 */

import { finalizarCompra }   from '../services/compras.service.js';
import * as ComprasRepo      from '../repositories/compras.repository.js';
import { ok, created, badRequest, notFound, serverError } from '../helpers/response.js';

// ─────────────────────────────────────────────────────────────────────────────

export async function postCompra(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('El body debe ser JSON válido.');
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return badRequest("'items' debe ser un array con al menos un elemento.");
  }

  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    if (!item.extracted?.producto)     return badRequest(`Item [${i}]: falta 'extracted.producto'.`);
    if (!item.match?.action)           return badRequest(`Item [${i}]: falta 'match.action'.`);
    if (!item.unidad_simbolo && !item.extracted?.unidad_medida) {
      return badRequest(`Item [${i}]: falta 'unidad_simbolo' o 'extracted.unidad_medida'.`);
    }
  }

  try {
    const result = await finalizarCompra(ctx.db, ctx.tenantId, ctx.userId, {
      lugarCompra: body.lugar_compra ?? null,
      notas:       body.notas       ?? null,
      items:       body.items
    });

    return created({
      compra_id:        result.compraId,
      items_insertados: result.itemsInsertados,
      tipos_afectados:  result.tiposAfectados
    });

  } catch (err) {
    console.error('[POST /compras]', err);
    return serverError('Error al registrar la compra.', err.message);
  }
}

export async function getCompras(request, ctx) {
  const url    = new URL(request.url);
  const params = {
    desde:  url.searchParams.get('desde')  ?? null,
    hasta:  url.searchParams.get('hasta')  ?? null,
    limit:  parseInt(url.searchParams.get('limit')  ?? '20'),
    offset: parseInt(url.searchParams.get('offset') ?? '0')
  };

  try {
    const compras = await ComprasRepo.listCompras(ctx.db, ctx.tenantId, params);
    return ok(compras);
  } catch (err) {
    console.error('[GET /compras]', err);
    return serverError();
  }
}

export async function getCompraById(request, ctx, compraId) {
  try {
    const compra = await ComprasRepo.findCompraById(ctx.db, ctx.tenantId, compraId);
    if (!compra) return notFound('Compra');
    return ok(compra);
  } catch (err) {
    console.error('[GET /compras/:id]', err);
    return serverError();
  }
}

export async function getGastos(request, ctx) {
  const url   = new URL(request.url);
  const desde = url.searchParams.get('desde');
  const hasta = url.searchParams.get('hasta');

  if (!desde || !hasta) {
    return badRequest("Los parámetros 'desde' y 'hasta' son requeridos (YYYY-MM-DD).");
  }

  try {
    const gastos = await ComprasRepo.gastosPorCategoria(ctx.db, ctx.tenantId, { desde, hasta });
    return ok(gastos);
  } catch (err) {
    console.error('[GET /compras/gastos]', err);
    return serverError();
  }
}
