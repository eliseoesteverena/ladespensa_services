/**
 * src/worker.js
 * Entry point único del worker. Router principal.
 *
 * Responsabilidad exclusiva: recibir el request, decidir a qué bloque
 * pertenece (auth vs app) y delegar. Sin lógica de negocio.
 *
 * Prefijos de ruta:
 *   /auth/*   → auth-module (worker.js del módulo, que tiene export default).
 *   /*        → app (nuestras rutas). JWT requerido en todas.
 *
 * Variables de entorno requeridas (ver wrangler.toml y .dev.vars.example):
 *   DB                  D1 binding
 *   JWT_SECRET          Secret HMAC compartido con auth-module
 *   GEMINI_API_KEY      Google AI Studio
 *   AUTH_RATE_LIMIT_KV  KV binding para rate limiting del auth-module
 *   AUTH_BASE_PATH      Debe ser "/auth" (configurado en wrangler.toml)
 */

// ── Auth-module ───────────────────────────────────────────────────────────────
// Importamos el worker.js del auth-module, que sí tiene `export default`
// con la forma { fetch, scheduled } esperada por Cloudflare Workers.
// auth-routes.js solo tiene named exports internos — no se importa directamente.
import authWorker from './auth/worker.js';

// ── App middleware ────────────────────────────────────────────────────────────
import { verifyAuth }            from './app/middleware/auth.js';
import { corsPreflightResponse,
         notFound,
         serverError }           from './app/helpers/response.js';

// ── App routes ────────────────────────────────────────────────────────────────
import { handleScanEtiqueta }    from './app/routes/scan.routes.js';
import {
  postCompra,
  getCompras,
  getCompraById,
  getGastos
}                                from './app/routes/compras.routes.js';
import {
  getStock,
  getStockByTipo,
  patchStock
}                                from './app/routes/stock.routes.js';

// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();
    // Normalizar: quitar trailing slash salvo en "/"
    const path   = url.pathname.replace(/\/$/, '') || '/';

    // ── CORS preflight — responder siempre, antes de cualquier otra cosa ─────
    if (method === 'OPTIONS') {
      return corsPreflightResponse(env.ALLOWED_ORIGINS);
    }

    // ── Bloque AUTH (/auth/*) ─────────────────────────────────────────────────
    // Se delega completamente a auth-routes.js del auth-module.
    // Reescribimos el path quitando el prefijo /auth antes de pasar el request,
    // porque auth-routes espera rutas sin prefijo (/login, /register, etc.).
    if (path.startsWith('/auth')) {
      const strippedPath = path.slice(5) || '/';          // "/auth/login" → "/login"
      const rewrittenUrl = new URL(request.url);
      rewrittenUrl.pathname = strippedPath;
      const rewrittenRequest = new Request(rewrittenUrl.toString(), request);
      return authWorker.fetch(rewrittenRequest, env, ctx);
    }

    // ── Bloque APP (/*) ───────────────────────────────────────────────────────
    // Todas las rutas de la app requieren JWT válido.
    const authResult = await verifyAuth(request, env);
    if (authResult instanceof Response) return authResult;  // 401 si inválido

    const appCtx = {
      db:       env.DB,
      tenantId: authResult.tenantId,
      userId:   authResult.userId,
      role:     authResult.role
    };

    try {
      return routeApp(request, env, appCtx, method, path);
    } catch (err) {
      console.error('[worker] Unhandled error:', err);
      return serverError('Error inesperado del servidor.');
    }
  },

  // ── Cron trigger: limpieza de sesiones expiradas (delegado al auth-module) ──
  async scheduled(event, env, ctx) {
    return authWorker.scheduled?.(event, env, ctx);
  }
};

// ─── Router de la app ─────────────────────────────────────────────────────────

function routeApp(request, env, ctx, method, path) {

  // ── Scan ────────────────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/scan-etiqueta') {
    return handleScanEtiqueta(request, ctx, env);
  }

  // ── Compras ─────────────────────────────────────────────────────────────────
  // /compras/gastos debe evaluarse ANTES que /compras/:id
  if (method === 'GET'  && path === '/compras/gastos') return getGastos(request, ctx);
  if (method === 'POST' && path === '/compras')         return postCompra(request, ctx);
  if (method === 'GET'  && path === '/compras')         return getCompras(request, ctx);

  const compraMatch = path.match(/^\/compras\/([^/]+)$/);
  if (compraMatch) {
    const [, compraId] = compraMatch;
    if (method === 'GET') return getCompraById(request, ctx, compraId);
  }

  // ── Stock ────────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/stock') return getStock(request, ctx);

  const stockMatch = path.match(/^\/stock\/([^/]+)$/);
  if (stockMatch) {
    const [, tipoId] = stockMatch;
    if (method === 'GET')   return getStockByTipo(request, ctx, tipoId);
    if (method === 'PATCH') return patchStock(request, ctx, tipoId);
  }

  // ── 404 ──────────────────────────────────────────────────────────────────────
  return notFound('Ruta');
}