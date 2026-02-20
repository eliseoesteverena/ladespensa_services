/**
 * src/app/repositories/account.repository.js
 *
 * Acceso de lectura/escritura a las tablas del auth-module (users, tenants)
 * y a workspace_invitations (nuestra tabla).
 *
 * CONVENCIÓN:
 * - Solo leemos/escribimos los campos que nos competen como app.
 * - Nunca tocamos password_hash, tokens de reset, ni auth_logs.
 * - Las operaciones de auth (login, register, etc.) siguen siendo
 *   exclusivas del auth-module.
 */

import { generateId } from '../helpers/id.js';

// ─── Usuario ──────────────────────────────────────────────────────────────────

/**
 * Perfil público del usuario autenticado (sin datos sensibles).
 */
export async function findUserById(db, tenantId, userId) {
  return db.prepare(`
    SELECT
      u.id, u.email, u.role, u.tenant_id,
      u.display_name, u.avatar_url,
      u.is_active, u.email_verified,
      u.created_at, u.updated_at,
      t.name AS tenant_name
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
    WHERE u.id = ? AND u.tenant_id = ?
  `).bind(userId, tenantId).first();
}

/**
 * Actualiza campos de perfil editables por el usuario.
 * Solo display_name y avatar_url — el email y el rol no se cambian aquí.
 */
export async function updateUserProfile(db, tenantId, userId, data) {
  const fields = [];
  const params = [];

  if (data.displayName !== undefined) {
    fields.push('display_name = ?');
    params.push(data.displayName);
  }
  if (data.avatarUrl !== undefined) {
    fields.push('avatar_url = ?');
    params.push(data.avatarUrl);
  }
  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");

  await db.prepare(`
    UPDATE users
    SET ${fields.join(', ')}
    WHERE id = ? AND tenant_id = ?
  `).bind(...params, userId, tenantId).run();
}

/**
 * Actualiza la contraseña del usuario.
 * Recibe el hash ya computado (el servicio es responsable de hashear).
 */
export async function updateUserPassword(db, tenantId, userId, newPasswordHash) {
  await db.prepare(`
    UPDATE users
    SET password_hash = ?,
        updated_at    = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).bind(newPasswordHash, userId, tenantId).run();
}

/**
 * Obtiene el password_hash actual para verificación antes de cambiarlo.
 */
export async function getUserPasswordHash(db, tenantId, userId) {
  const row = await db.prepare(`
    SELECT password_hash FROM users WHERE id = ? AND tenant_id = ?
  `).bind(userId, tenantId).first();
  return row?.password_hash ?? null;
}

// ─── Workspace (tenant) ───────────────────────────────────────────────────────

/**
 * Datos del workspace del tenant autenticado.
 */
export async function findTenantById(db, tenantId) {
  return db.prepare(`
    SELECT
      t.id, t.name, t.plan, t.status, t.max_users,
      t.created_at, t.updated_at,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.is_active = TRUE) AS active_users
    FROM tenants t
    WHERE t.id = ?
  `).bind(tenantId).first();
}

/**
 * Actualiza el nombre del workspace.
 * Solo el owner puede hacer esto (validación en la ruta).
 */
export async function updateTenantName(db, tenantId, name) {
  await db.prepare(`
    UPDATE tenants
    SET name       = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(name, tenantId).run();
}

// ─── Miembros ─────────────────────────────────────────────────────────────────

/**
 * Lista todos los miembros activos del workspace.
 */
export async function listMembers(db, tenantId) {
  const result = await db.prepare(`
    SELECT
      u.id, u.email, u.role, u.display_name, u.avatar_url,
      u.is_active, u.email_verified, u.created_at,
      u.last_login_at
    FROM users u
    WHERE u.tenant_id = ?
    ORDER BY
      CASE u.role
        WHEN 'owner'  THEN 1
        WHEN 'admin'  THEN 2
        WHEN 'member' THEN 3
        WHEN 'viewer' THEN 4
        ELSE 5
      END,
      u.display_name ASC,
      u.email ASC
  `).bind(tenantId).all();

  return result.results ?? [];
}

/**
 * Busca un miembro por ID dentro del tenant.
 */
export async function findMemberById(db, tenantId, userId) {
  return db.prepare(`
    SELECT id, email, role, display_name, avatar_url, is_active, email_verified, created_at
    FROM users
    WHERE id = ? AND tenant_id = ?
  `).bind(userId, tenantId).first();
}

/**
 * Actualiza el rol de un miembro.
 * Solo owner puede hacer esto (validación en la ruta).
 */
export async function updateMemberRole(db, tenantId, userId, newRole) {
  await db.prepare(`
    UPDATE users
    SET role       = ?,
        updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).bind(newRole, userId, tenantId).run();
}

/**
 * Desactiva a un miembro del workspace (soft delete).
 * No elimina el usuario — permite auditar historial de compras.
 */
export async function deactivateMember(db, tenantId, userId) {
  await db.prepare(`
    UPDATE users
    SET is_active  = FALSE,
        updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).bind(userId, tenantId).run();
}

/**
 * Revoca todas las sesiones activas de un usuario.
 * Se llama junto a deactivateMember para forzar logout inmediato.
 */
export async function revokeAllUserSessions(db, tenantId, userId) {
  await db.prepare(`
    UPDATE sessions
    SET revoked_at = datetime('now')
    WHERE user_id = ?
      AND tenant_id = ?
      AND revoked_at IS NULL
  `).bind(userId, tenantId).run();
}

// ─── Sesiones activas ─────────────────────────────────────────────────────────

/**
 * Lista sesiones activas del usuario (desde v_active_sessions del auth-module).
 */
export async function listActiveSessions(db, tenantId, userId) {
  const result = await db.prepare(`
    SELECT jti, created_at, expires_at, user_agent, ip_address
    FROM sessions
    WHERE user_id   = ?
      AND tenant_id = ?
      AND revoked_at IS NULL
      AND expires_at > datetime('now')
    ORDER BY created_at DESC
  `).bind(userId, tenantId).all();

  return result.results ?? [];
}

/**
 * Revoca una sesión específica por JTI.
 * Solo puede revocar sesiones propias.
 */
export async function revokeSession(db, tenantId, userId, jti) {
  const result = await db.prepare(`
    UPDATE sessions
    SET revoked_at = datetime('now')
    WHERE jti       = ?
      AND user_id   = ?
      AND tenant_id = ?
      AND revoked_at IS NULL
  `).bind(jti, userId, tenantId).run();

  return result.meta?.changes > 0;
}

// ─── Invitaciones ─────────────────────────────────────────────────────────────

/**
 * Crea una nueva invitación.
 * @param {string} tokenHash  SHA-256 del token generado (el token crudo no se guarda)
 * @param {string} expiresAt  ISO 8601
 */
export async function createInvitation(db, tenantId, invitedBy, data) {
  const id = generateId();

  await db.prepare(`
    INSERT INTO workspace_invitations
      (id, tenant_id, email, role, token_hash, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    tenantId,
    data.email.toLowerCase().trim(),
    data.role       ?? 'member',
    data.tokenHash,
    invitedBy,
    data.expiresAt
  ).run();

  return id;
}

/**
 * Lista invitaciones pendientes del workspace.
 */
export async function listInvitations(db, tenantId) {
  const result = await db.prepare(`
    SELECT
      wi.id, wi.email, wi.role, wi.expires_at, wi.created_at,
      wi.accepted_at, wi.revoked_at,
      u.display_name AS invited_by_name,
      u.email        AS invited_by_email
    FROM workspace_invitations wi
    JOIN users u ON u.id = wi.invited_by
    WHERE wi.tenant_id = ?
    ORDER BY wi.created_at DESC
  `).bind(tenantId).all();

  return result.results ?? [];
}

/**
 * Busca invitación por token_hash para aceptarla.
 */
export async function findInvitationByToken(db, tokenHash) {
  return db.prepare(`
    SELECT wi.*, t.name AS tenant_name
    FROM workspace_invitations wi
    JOIN tenants t ON t.id = wi.tenant_id
    WHERE wi.token_hash  = ?
      AND wi.accepted_at IS NULL
      AND wi.revoked_at  IS NULL
      AND wi.expires_at  > datetime('now')
  `).bind(tokenHash).first();
}

/**
 * Marca una invitación como aceptada.
 */
export async function acceptInvitation(db, invitationId) {
  await db.prepare(`
    UPDATE workspace_invitations
    SET accepted_at = datetime('now')
    WHERE id = ?
  `).bind(invitationId).run();
}

/**
 * Revoca una invitación (la cancela antes de que sea aceptada).
 */
export async function revokeInvitation(db, tenantId, invitationId) {
  const result = await db.prepare(`
    UPDATE workspace_invitations
    SET revoked_at = datetime('now')
    WHERE id          = ?
      AND tenant_id   = ?
      AND accepted_at IS NULL
      AND revoked_at  IS NULL
  `).bind(invitationId, tenantId).run();

  return result.meta?.changes > 0;
}

/**
 * Verifica si un email ya tiene una invitación pendiente en este tenant.
 */
export async function hasPendingInvitation(db, tenantId, email) {
  const row = await db.prepare(`
    SELECT id FROM workspace_invitations
    WHERE tenant_id  = ?
      AND email      = ?
      AND accepted_at IS NULL
      AND revoked_at  IS NULL
      AND expires_at  > datetime('now')
    LIMIT 1
  `).bind(tenantId, email.toLowerCase().trim()).first();

  return !!row;
}
