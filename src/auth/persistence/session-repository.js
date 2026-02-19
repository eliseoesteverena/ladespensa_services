/**
 * Session Repository
 * Todas las operaciones de base de datos relacionadas con sesiones.
 *
 * CORRECCIONES aplicadas:
 *  - Añadido revokeByJti() — requerido por logout() de sesión única.
 *    El logout ahora revoca solo la sesión del token presentado,
 *    no todas las sesiones del usuario.
 */
export class SessionRepository {
  constructor(db) {
    this.db = db;
  }

  async create(sessionData) {
    const query = `
      INSERT INTO sessions (
        id, user_id, tenant_id, refresh_token_hash, jti,
        ip_address, user_agent, device_fingerprint, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    return this.db
      .prepare(query)
      .bind(
        sessionData.id,
        sessionData.userId,
        sessionData.tenantId,
        sessionData.refreshTokenHash,
        sessionData.jti,
        sessionData.ipAddress         ?? null,
        sessionData.userAgent         ?? null,
        sessionData.deviceFingerprint ?? null,
        sessionData.expiresAt,
        sessionData.createdAt,
      )
      .run();
  }

  async findByRefreshToken(tokenHash) {
    const query = `
      SELECT
        s.*,
        u.email,
        u.role,
        u.tenant_id
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.refresh_token_hash = ?
        AND s.revoked_at IS NULL
        AND datetime(s.expires_at) > datetime('now')
    `;
    return this.db.prepare(query).bind(tokenHash).first();
  }

  async findByJti(jti) {
    return this.db
      .prepare(`
        SELECT id
        FROM sessions
        WHERE jti = ?
          AND revoked_at IS NULL
          AND datetime(expires_at) > datetime('now')
      `)
      .bind(jti)
      .first();
  }

  /** Revoca la sesión identificada por su ID interno. */
  async revoke(sessionId) {
    return this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), sessionId)
      .run();
  }

  /**
   * ✅ Revoca la sesión identificada por su JTI (JWT ID).
   * Usado en logout() para cerrar únicamente la sesión actual.
   * @param {string} jti
   */
  async revokeByJti(jti) {
    return this.db
      .prepare(
        'UPDATE sessions SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL'
      )
      .bind(new Date().toISOString(), jti)
      .run();
  }

  /**
   * Revoca todas las sesiones activas de un usuario.
   * Usado en logoutAll() ("salir de todos los dispositivos").
   * @param {string} userId
   */
  async revokeAllForUser(userId) {
    return this.db
      .prepare(
        'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
      )
      .bind(new Date().toISOString(), userId)
      .run();
  }

  /** Elimina sesiones expiradas. Invocar vía Cron Trigger en wrangler.toml. */
  async cleanupExpired() {
    return this.db
      .prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')")
      .run();
  }
}