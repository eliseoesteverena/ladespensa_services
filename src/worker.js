/**
 * src/worker.js
 * Entry point único del worker. Router principal.
 *
 * Responsabilidad exclusiva: recibir el request, decidir a qué bloque
 * pertenece y delegar. Sin lógica de negocio.
 *
 * Prefijos de ruta:
 *   /auth/*          → auth-module (worker.js del módulo, export default)
 *   /invitations/*   → públicas — info y aceptación de invitaciones (sin JWT)
 *   /*               → app — JWT requerido en todas
 *
 * Variables de entorno (ver wrangler.toml y .dev.vars.example):
 *   DB                  D1 binding
 *   JWT_SECRET          Secret HMAC compartido con auth-module
 *   GEMINI_API_KEY      Google AI Studio
 *   AUTH_RATE_LIMIT_KV  KV binding para rate limiting del auth-module
 *   APP_FRONTEND_URL    URL base del frontend (para links de invitación)
 */

// ── Auth-module ───────────────────────────────────────────────────────────────
import authWorker from './auth/worker.js';

// ── Auth support (intercepta /auth/login antes del auth-module) ───────────────
import { handleLogin } from './app/routes/auth-support.routes.js';

// ── App middleware ────────────────────────────────────────────────────────────
import { verifyAuth }          from './app/middleware/auth.js';
import { corsPreflightResponse,
         notFound,
         serverError }         from './app/helpers/response.js';

// ── Account routes ────────────────────────────────────────────────────────────
import {
  getMe, patchMe, patchPassword,
  getWorkspace, patchWorkspace,
  getMembers, patchMember, deleteMember,
  getSessions, deleteSession,
  getInvitations, postInvitation, deleteInvitation,
  getInvitationInfo, postAcceptInvitation
}                              from './app/routes/account.routes.js';

// ── Domain routes ─────────────────────────────────────────────────────────────
import { handleScanEtiqueta }  from './app/routes/scan.routes.js';
import {
  postCompra, getCompras, getCompraById, getGastos
}                              from './app/routes/compras.routes.js';
import {
  getStock, getStockByTipo, patchStock
}                              from './app/routes/stock.routes.js';

// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();
    const path   = url.pathname.replace(/\/$/, '') || '/';

    // CORS preflight — siempre antes de cualquier otra lógica
    if (method === 'OPTIONS') {
      return corsPreflightResponse(env.ALLOWED_ORIGINS);
    }

    // ── Auth (/auth/*) ────────────────────────────────────────────────────────
    if (path.startsWith('/auth')) {
      // Interceptar /auth/login — resolvemos el tenant_id internamente
      // antes de delegar al auth-module. El cliente nunca envía ni recibe
      // tenant_ids.
      if (method === 'POST' && path === '/auth/login') {
        return handleLogin(request, env, authWorker);
      }

      // El resto de rutas /auth/* van directo al auth-module.
      const strippedPath    = path.slice(5) || '/';
      const rewrittenUrl    = new URL(request.url);
      rewrittenUrl.pathname = strippedPath;
      return authWorker.fetch(new Request(rewrittenUrl.toString(), request), env, ctx);
    }

    // ── Invitaciones públicas (/invitations/*) — sin JWT ─────────────────────
    if (path.startsWith('/invitations')) {
      const publicCtx = { db: env.DB };
      if (method === 'GET'  && path === '/invitations/info')   return getInvitationInfo(request, publicCtx);
      if (method === 'POST' && path === '/invitations/accept') return postAcceptInvitation(request, publicCtx);
      return notFound('Ruta');
    }

    // ── App (/*) — JWT requerido ──────────────────────────────────────────────
    const authResult = await verifyAuth(request, env);
    if (authResult instanceof Response) return authResult;

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

  async scheduled(event, env, ctx) {
    return authWorker.scheduled?.(event, env, ctx);
  }
};

// ─── Router de la app ─────────────────────────────────────────────────────────

function routeApp(request, env, appCtx, method, path) {

  // ── Account / perfil ──────────────────────────────────────────────────────
  if (method === 'GET'   && path === '/account/me')            return getMe(request, appCtx);
  if (method === 'PATCH' && path === '/account/me')            return patchMe(request, appCtx);
  if (method === 'PATCH' && path === '/account/me/password')   return patchPassword(request, appCtx);

  // ── Account / workspace ───────────────────────────────────────────────────
  if (method === 'GET'   && path === '/account/workspace')     return getWorkspace(request, appCtx);
  if (method === 'PATCH' && path === '/account/workspace')     return patchWorkspace(request, appCtx);

  // ── Account / miembros ────────────────────────────────────────────────────
  if (method === 'GET' && path === '/account/workspace/members') return getMembers(request, appCtx);

  const memberMatch = path.match(/^\/account\/workspace\/members\/([^/]+)$/);
  if (memberMatch) {
    const [, targetUserId] = memberMatch;
    if (method === 'PATCH')  return patchMember(request, appCtx, targetUserId);
    if (method === 'DELETE') return deleteMember(request, appCtx, targetUserId);
  }

  // ── Account / invitaciones ────────────────────────────────────────────────
  if (method === 'GET'  && path === '/account/workspace/invitations') return getInvitations(request, appCtx);
  if (method === 'POST' && path === '/account/workspace/invitations') return postInvitation(request, appCtx, env);

  const invMatch = path.match(/^\/account\/workspace\/invitations\/([^/]+)$/);
  if (invMatch) {
    const [, invitationId] = invMatch;
    if (method === 'DELETE') return deleteInvitation(request, appCtx, invitationId);
  }

  // ── Account / sesiones ────────────────────────────────────────────────────
  if (method === 'GET' && path === '/account/sessions') return getSessions(request, appCtx);

  const sessionMatch = path.match(/^\/account\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const [, jti] = sessionMatch;
    if (method === 'DELETE') return deleteSession(request, appCtx, jti);
  }

  // ── Scan ──────────────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/scan-etiqueta') {
    return handleScanEtiqueta(request, appCtx, env);
  }

  // ── Compras ───────────────────────────────────────────────────────────────
  if (method === 'GET'  && path === '/compras/gastos') return getGastos(request, appCtx);
  if (method === 'POST' && path === '/compras')         return postCompra(request, appCtx);
  if (method === 'GET'  && path === '/compras')         return getCompras(request, appCtx);

  const compraMatch = path.match(/^\/compras\/([^/]+)$/);
  if (compraMatch) {
    const [, compraId] = compraMatch;
    if (method === 'GET') return getCompraById(request, appCtx, compraId);
  }

  // ── Stock ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/stock') return getStock(request, appCtx);

  const stockMatch = path.match(/^\/stock\/([^/]+)$/);
  if (stockMatch) {
    const [, tipoId] = stockMatch;
    if (method === 'GET')   return getStockByTipo(request, appCtx, tipoId);
    if (method === 'PATCH') return patchStock(request, appCtx, tipoId);
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  return notFound('Ruta');
}
