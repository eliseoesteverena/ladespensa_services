/**
 * src/app/routes/auth-support.routes.js
 *
 * Intercepta POST /auth/login antes de que llegue al auth-module.
 * Resuelve el tenant_id internamente a partir del email, de forma
 * transparente — el cliente nunca envía ni recibe tenant_ids.
 *
 * Casos:
 *   0 tenants → 401 genérico (no revela si el email existe)
 *   1 tenant  → llama al auth-module directamente
 *   N tenants → 409 con solo los workspace_names (sin IDs)
 *               el cliente reenvía { email, password, workspace_name }
 *               y el backend resuelve el tenant_id internamente
 */

import { unauthorized, conflict, serverError } from '../helpers/response.js';

/**
 * Interceptor de POST /auth/login
 *
 * @param {Request} request
 * @param {object}  env        — necesita env.DB y env completo para authWorker
 * @param {object}  authWorker — el worker del auth-module
 * @returns {Promise<Response>}
 */
export async function handleLogin(request, env, authWorker) {
  let body;
  try {
    body = await request.json();
  } catch {
    return unauthorized('Credenciales inválidas.');
  }

  const email    = body.email?.toLowerCase().trim();
  const password = body.password;

  if (!email || !password) {
    return unauthorized('Credenciales inválidas.');
  }

  // ── Resolver tenants del email ────────────────────────────────────────────
  let tenants;
  try {
    const result = await env.DB.prepare(`
      SELECT t.id AS tenant_id, t.name AS workspace_name
      FROM users u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email     = ?
        AND u.is_active = TRUE
        AND t.status    = 'active'
      ORDER BY t.name ASC
    `).bind(email).all();

    tenants = result.results ?? [];
  } catch (err) {
    console.error('[handleLogin] DB error:', err);
    return serverError('Error al procesar el login.');
  }

  // ── 0 tenants — respuesta genérica (no revela si el email existe) ─────────
  if (tenants.length === 0) {
    return unauthorized('Credenciales incorrectas.');
  }

  // ── N tenants — pedir al usuario que elija workspace ─────────────────────
  // Solo se devuelven nombres visibles, nunca IDs.
  if (tenants.length > 1 && !body.workspace_name) {
    return conflict(
      'Tu cuenta pertenece a más de un hogar. Indicá a cuál querés ingresar.',
      { workspaces: tenants.map(t => t.workspace_name) },
      env.ALLOWED_ORIGINS
    );
  }

  // ── Resolver tenant_id final ──────────────────────────────────────────────
  let tenantId;

  if (tenants.length === 1) {
    tenantId = tenants[0].tenant_id;
  } else {
    // N tenants y el cliente envió workspace_name
    const chosen = tenants.find(
      t => t.workspace_name.toLowerCase() === body.workspace_name?.toLowerCase().trim()
    );
    if (!chosen) {
      return conflict(
        'Nombre de hogar no reconocido. Indicá uno de los hogares disponibles.',
        { workspaces: tenants.map(t => t.workspace_name) },
        env.ALLOWED_ORIGINS
      );
    }
    tenantId = chosen.tenant_id;
  }

  // ── Delegar al auth-module con el tenant_id resuelto ─────────────────────
  // Reconstruimos el request con el body completo que el auth-module espera.
  const authBody    = JSON.stringify({ email, password, tenant_id: tenantId });
  const authRequest = new Request(request.url, {
    method:  'POST',
    headers: request.headers,
    body:    authBody
  });

  return authWorker.fetch(authRequest, env);
}
