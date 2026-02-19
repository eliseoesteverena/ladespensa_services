/**
 * Tenant Repository
 * Todas las operaciones de base de datos relacionadas con tenants.
 *
 * NUEVO: Separado de UserRepository para cumplir Single Responsibility.
 * Proyectos sin multi-tenancy pueden omitir este archivo y pasar
 * un TenantRepository stub al AuthService.
 */
export class TenantRepository {
    constructor(db) {
      this.db = db;
    }
  
    /**
     * Busca un tenant por su ID.
     * @param {string} tenantId
     * @returns {Promise<object|null>}
     */
    async findById(tenantId) {
      return this.db
        .prepare('SELECT * FROM tenants WHERE id = ?')
        .bind(tenantId)
        .first();
    }
  
    /**
     * Crea un nuevo tenant.
     * CORRECCIÓN: bug original tenía 7 columnas y 8 placeholders.
     * Ahora coinciden exactamente: 7 columnas, 7 placeholders, 7 bind args.
     *
     * @param {object} tenantData
     * @param {string} tenantData.id
     * @param {string} tenantData.name
     * @param {string} [tenantData.legalName]
     * @param {string} [tenantData.plan]
     * @param {string} [tenantData.status]
     * @param {number} [tenantData.maxUsers]
     * @param {string} tenantData.createdAt
     */
    async create(tenantData) {
      // ✅ FIX: 7 columnas ↔ 7 placeholders ↔ 7 argumentos en bind()
      const query = `
        INSERT INTO tenants (
          id, name, legal_name, plan, status, max_users, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      return this.db
        .prepare(query)
        .bind(
          tenantData.id,
          tenantData.name,
          tenantData.legalName ?? tenantData.name,
          tenantData.plan      ?? 'basic',
          tenantData.status    ?? 'active',
          tenantData.maxUsers  ?? 5,
          tenantData.createdAt,
        )
        .run();
    }
  
    /**
     * Cuenta usuarios activos de un tenant.
     * Usado para verificar el límite max_users antes de registrar.
     * @param {string} tenantId
     * @returns {Promise<number>}
     */
    async countActiveUsers(tenantId) {
      const result = await this.db
        .prepare(
          'SELECT COUNT(*) as count FROM users WHERE tenant_id = ? AND is_active = 1'
        )
        .bind(tenantId)
        .first();
      return result?.count ?? 0;
    }
  
    /**
     * Actualiza el estado de un tenant.
     * @param {string} tenantId
     * @param {string} status - 'active' | 'suspended' | 'trial' | 'cancelled'
     */
    async updateStatus(tenantId, status) {
      return this.db
        .prepare('UPDATE tenants SET status = ? WHERE id = ?')
        .bind(status, tenantId)
        .run();
    }
  }