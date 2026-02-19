/**
 * src/app/routes/stock.routes.js
 *
 * GET    /stock             Lista stock completo (?alertas=true para bajo mínimo)
 * GET    /stock/:tipoId     Stock de un tipo con desglose por marca
 * PATCH  /stock/:tipoId     Ajuste manual de cantidad
 */

import * as StockRepo from '../repositories/stock.repository.js';
import { ok, badRequest, notFound, serverError } from '../helpers/response.js';

// ─────────────────────────────────────────────────────────────────────────────

export async function getStock(request, ctx) {
  const url    = new URL(request.url);
  const params = {
    soloAlertas: url.searchParams.get('alertas') === 'true',
    limit:       parseInt(url.searchParams.get('limit')  ?? '100'),
    offset:      parseInt(url.searchParams.get('offset') ?? '0')
  };

  try {
    const stock = await StockRepo.listStock(ctx.db, ctx.tenantId, params);
    return ok(stock);
  } catch (err) {
    console.error('[GET /stock]', err);
    return serverError();
  }
}

export async function getStockByTipo(request, ctx, tipoId) {
  try {
    const stock = await StockRepo.findStockByTipo(ctx.db, ctx.tenantId, tipoId);
    if (!stock) return notFound('Stock');
    return ok(stock);
  } catch (err) {
    console.error('[GET /stock/:tipoId]', err);
    return serverError();
  }
}

export async function patchStock(request, ctx, tipoId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('El body debe ser JSON válido.');
  }

  if (body.cantidad === undefined || typeof body.cantidad !== 'number' || body.cantidad < 0) {
    return badRequest("'cantidad' es requerida y debe ser un número >= 0.");
  }

  try {
    await StockRepo.setStock(ctx.db, ctx.tenantId, tipoId, body.cantidad, {
      stockMinimo:      body.stock_minimo      ?? null,
      ubicacion:        body.ubicacion         ?? null,
      fechaVencimiento: body.fecha_vencimiento ?? null
    });

    const stock = await StockRepo.findStockByTipo(ctx.db, ctx.tenantId, tipoId);
    return ok(stock);
  } catch (err) {
    console.error('[PATCH /stock/:tipoId]', err);
    return serverError();
  }
}
