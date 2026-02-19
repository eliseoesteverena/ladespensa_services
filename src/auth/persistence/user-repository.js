/**
 * User Repository
 * Todas las operaciones de base de datos relacionadas con usuarios.
 *
 * CORRECCIONES aplicadas:
 *  - Métodos de tenant (getTenantById, createTenant, countActiveUsers)
 *    movidos a TenantRepository (separación de responsabilidades).
 *  - findByEmail() ahora recibe tenantId como segundo parámetro,
 *    reflejando el modelo decidido: email único POR tenant (no global).
 *    El índice global idx_users_email_global fue eliminado del schema.
 *  - findByEmailGlobal() disponible para flujos donde se necesita
 *    buscar sin conocer el tenantId aún (ej: login con email solo).
 */
export class UserRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * Busca un usuario por email dentro de un tenant específico.
   * Modelo: email único POR tenant → mismo email puede existir en tenants distintos.
   *
   * @param {string} email
   * @param {string} tenantId
   * @returns {Promise<object|null>}
   */
  async findByEmail(email, tenantId) {
    const query = `
      SELECT
        u.*,
        t.name   AS tenant_name,
        t.status AS tenant_status
      FROM users u
      JOIN tenants t ON u.tenant_id = t.id
      WHERE u.email     = ?
        AND u.tenant_id = ?
    `;
    return this.db.prepare(query).bind(email, tenantId).first();
  }

  /**
   * Busca usuarios por email sin filtrar por tenant.
   * Útil en el flujo de login cuando el usuario provee solo email+password
   * y aún no se conoce su tenant_id (p. ej. en un login de tenant único o
   * cuando el frontend envía el tenant_id junto con las credenciales).
   *
   * Si tu flujo de login siempre recibe tenant_id, usa findByEmail() directamente.
   *
   * @param {string} email
   * @returns {Promise<object[]>}  — puede haber más de un resultado
   */
  async findByEmailGlobal(email) {
    const query = `
      SELECT
        u.*,
        t.name   AS tenant_name,
        t.status AS tenant_status
      FROM users u
      JOIN tenants t ON u.tenant_id = t.id
      WHERE u.email = ?
    `;
    const result = await this.db.prepare(query).bind(email).all();
    return result?.results ?? [];
  }

  /**
   * Busca un usuario por su ID.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    return this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(id)
      .first();
  }

  /**
   * Crea un nuevo usuario.
   * @param {object} userData
   */
  async create(userData) {
    const query = `
      INSERT INTO users (
        id, tenant_id, email, password_hash, role,
        is_active, email_verified, mfa_enabled, failed_attempts,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    return this.db
      .prepare(query)
      .bind(
        userData.id,
        userData.tenantId,
        userData.email,
        userData.passwordHash,
        userData.role,
        userData.isActive      ? 1 : 0,
        userData.emailVerified ? 1 : 0,
        userData.mfaEnabled    ? 1 : 0,
        userData.failedAttempts ?? 0,
        userData.createdAt,
        userData.updatedAt,
      )
      .run();
  }

  /**
   * Incrementa el contador de intentos fallidos y opcionalmente bloquea la cuenta.
   * @param {string}      userId
   * @param {number}      attempts
   * @param {string|null} lockedUntil - ISO 8601 o null
   */
  async updateFailedAttempts(userId, attempts, lockedUntil = null) {
    return this.db
      .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .bind(attempts, lockedUntil, userId)
      .run();
  }

  /**
   * Resetea el contador de fallos y actualiza last_login_at.
   * @param {string} userId
   */
  async resetFailedAttempts(userId) {
    return this.db
      .prepare(
        'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'
      )
      .bind(new Date().toISOString(), userId)
      .run();
  }

  /**
   * Determina si la cuenta está bloqueada por intentos fallidos.
   * @param {object} user - fila de la tabla users
   * @returns {boolean}
   */
  isAccountLocked(user) {
    if (!user.locked_until) return false;
    return new Date(user.locked_until) > new Date();
  }

  /**
   * Determina si el tenant del usuario está activo.
   * Requiere que el user object incluya tenant_status (del JOIN en findByEmail).
   * @param {object} user
   * @returns {boolean}
   */
  isTenantActive(user) {
    return user.tenant_status === 'active';
  }
}