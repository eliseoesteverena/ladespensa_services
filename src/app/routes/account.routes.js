/**
 * src/app/routes/account.routes.js
 *
 * GET    /account/me                            Perfil del usuario autenticado
 * PATCH  /account/me                            Actualizar display_name / avatar_url
 * PATCH  /account/me/password                   Cambiar contraseña
 *
 * GET    /account/workspace                     Datos del workspace
 * PATCH  /account/workspace                     Renombrar workspace (owner)
 *
 * GET    /account/workspace/members             Listar miembros
 * PATCH  /account/workspace/members/:userId     Cambiar rol de un miembro
 * DELETE /account/workspace/members/:userId     Eliminar miembro del workspace
 *
 * GET    /account/workspace/invitations         Listar invitaciones (admin+)
 * POST   /account/workspace/invitations         Invitar por email (admin+)
 * DELETE /account/workspace/invitations/:id     Cancelar invitación (admin+)
 *
 * GET    /account/sessions                      Sesiones activas del usuario
 * DELETE /account/sessions/:jti                 Revocar sesión específica
 *
 * ── Públicas (sin JWT) ──
 * GET    /invitations/info?token=               Info de invitación (para mostrar antes del registro)
 * POST   /invitations/accept                    Aceptar invitación (se llama después del registro)
 */

import * as AccountService from '../services/account.service.js';
import {
  ok, created, noContent,
  badRequest, unauthorized, forbidden, notFound, conflict,
  unprocessable, serverError
} from '../helpers/response.js';

// ─── Helper: mapeo de errores de servicio a respuestas HTTP ──────────────────

function handleServiceError(err) {
  switch (err.name) {
    case 'ValidationError': return unprocessable(err.message);
    case 'ForbiddenError':  return forbidden(err.message);
    case 'NotFoundError':   return notFound(err.message);
    case 'ConflictError':   return conflict(err.message);
    case 'AuthError':       return unauthorized(err.message);
    default:
      console.error('[account] Unhandled service error:', err);
      return serverError('Error interno al procesar la solicitud.', err.message);
  }
}

// ─── Perfil ───────────────────────────────────────────────────────────────────

export async function getMe(request, ctx) {
  try {
    const user = await AccountService.getProfile(ctx.db, ctx.tenantId, ctx.userId);
    return ok(user);
  } catch (err) { return handleServiceError(err); }
}

export async function patchMe(request, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return badRequest('El body debe ser JSON válido.'); }

  try {
    const updated = await AccountService.updateProfile(ctx.db, ctx.tenantId, ctx.userId, body);
    return ok(updated);
  } catch (err) { return handleServiceError(err); }
}

export async function patchPassword(request, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return badRequest('El body debe ser JSON válido.'); }

  try {
    await AccountService.changePassword(ctx.db, ctx.tenantId, ctx.userId, body);
    return ok({ message: 'Contraseña actualizada correctamente.' });
  } catch (err) { return handleServiceError(err); }
}

// ─── Workspace ────────────────────────────────────────────────────────────────

export async function getWorkspace(request, ctx) {
  try {
    const workspace = await AccountService.getWorkspace(ctx.db, ctx.tenantId);
    return ok(workspace);
  } catch (err) { return handleServiceError(err); }
}

export async function patchWorkspace(request, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return badRequest('El body debe ser JSON válido.'); }

  try {
    const updated = await AccountService.updateWorkspace(ctx.db, ctx.tenantId, ctx.role, body);
    return ok(updated);
  } catch (err) { return handleServiceError(err); }
}

// ─── Miembros ─────────────────────────────────────────────────────────────────

export async function getMembers(request, ctx) {
  try {
    const members = await AccountService.getMembers(ctx.db, ctx.tenantId);
    return ok(members);
  } catch (err) { return handleServiceError(err); }
}

export async function patchMember(request, ctx, targetUserId) {
  let body;
  try { body = await request.json(); }
  catch { return badRequest('El body debe ser JSON válido.'); }

  if (!body.role) return badRequest("El campo 'role' es requerido.");

  try {
    const updated = await AccountService.updateMember(
      ctx.db, ctx.tenantId, ctx.userId, ctx.role, targetUserId, body
    );
    return ok(updated);
  } catch (err) { return handleServiceError(err); }
}

export async function deleteMember(request, ctx, targetUserId) {
  try {
    await AccountService.removeMember(
      ctx.db, ctx.tenantId, ctx.userId, ctx.role, targetUserId
    );
    return noContent();
  } catch (err) { return handleServiceError(err); }
}

// ─── Sesiones ─────────────────────────────────────────────────────────────────

export async function getSessions(request, ctx) {
  try {
    const sessions = await AccountService.getSessions(ctx.db, ctx.tenantId, ctx.userId);
    return ok(sessions);
  } catch (err) { return handleServiceError(err); }
}

export async function deleteSession(request, ctx, jti) {
  try {
    await AccountService.revokeSession(ctx.db, ctx.tenantId, ctx.userId, jti);
    return noContent();
  } catch (err) { return handleServiceError(err); }
}

// ─── Invitaciones (requieren admin+) ─────────────────────────────────────────

export async function getInvitations(request, ctx) {
  try {
    const invitations = await AccountService.getInvitations(ctx.db, ctx.tenantId, ctx.role);
    return ok(invitations);
  } catch (err) { return handleServiceError(err); }
}

export async function postInvitation(request, ctx, env) {
  let body;
  try { body = await request.json(); }
  catch { return badRequest('El body debe ser JSON válido.'); }

  if (!body.email) return badRequest("El campo 'email' es requerido.");

  try {
    const result = await AccountService.inviteMember(
      ctx.db, ctx.tenantId, ctx.userId, ctx.role, body
    );

    // El token crudo va en la respuesta para que el frontend lo incluya
    // en el email de invitación. En producción esto debería disparar un
    // email desde un servicio de envío (ej: Resend, SendGrid).
    // El link de invitación tiene la forma:
    //   https://app.ladespensa.com/join?token=<token>
    const inviteLink = buildInviteLink(env, result.token);

    return created({
      invitation_id: result.invitationId,
      email:         result.email,
      role:          result.role,
      expires_at:    result.expiresAt,
      invite_link:   inviteLink
    });
  } catch (err) { return handleServiceError(err); }
}

export async function deleteInvitation(request, ctx, invitationId) {
  try {
    await AccountService.cancelInvitation(ctx.db, ctx.tenantId, ctx.role, invitationId);
    return noContent();
  } catch (err) { return handleServiceError(err); }
}

// ─── Invitaciones — rutas públicas ───────────────────────────────────────────

/**
 * GET /invitations/info?token=<token>
 * Retorna info básica de la invitación sin autenticación.
 * El frontend la usa para mostrar "Fuiste invitado por X al workspace Y"
 * antes de que el usuario complete el registro.
 */
export async function getInvitationInfo(request, ctx) {
  const url   = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) return badRequest("El parámetro 'token' es requerido.");

  try {
    const inv = await AccountService.getInvitationByToken(ctx.db, token);
    return ok({
      email:        inv.email,
      role:         inv.role,
      tenant_name:  inv.tenant_name,
      expires_at:   inv.expires_at
    });
  } catch (err) { return handleServiceError(err); }
}

/**
 * POST /invitations/accept
 * Acepta una invitación después de que el usuario se registró.
 * El frontend llama a este endpoint inmediatamente tras un
 * POST /auth/register exitoso con el tenant_id de la invitación.
 *
 * Body: { token: string }
 */
export async function postAcceptInvitation(request, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return badRequest('El body debe ser JSON válido.'); }

  if (!body.token) return badRequest("El campo 'token' es requerido.");

  try {
    const inv = await AccountService.acceptInvitation(ctx.db, body.token);
    return ok({
      message:     'Invitación aceptada. Podés hacer login ahora.',
      tenant_id:   inv.tenant_id,
      tenant_name: inv.tenant_name,
      role:        inv.role
    });
  } catch (err) { return handleServiceError(err); }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function buildInviteLink(env, token) {
  const base = env.APP_FRONTEND_URL ?? 'https://app.ladespensa.com';
  return `${base}/join?token=${token}`;
}
