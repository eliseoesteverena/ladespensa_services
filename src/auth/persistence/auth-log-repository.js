/**
 * Auth Log Repository
 * Handles authentication event logging
 */

export class AuthLogRepository {
  constructor(db) {
    this.db = db;
  }

  async log(eventData) {
    const query = `
      INSERT INTO auth_logs (id, user_id, tenant_id, event, ip, user_agent, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
      await this.db
        .prepare(query)
        .bind(
          eventData.id,
          eventData.userId,
          eventData.tenantId,
          eventData.event,
          eventData.ip,
          eventData.userAgent,
          JSON.stringify(eventData.metadata || {}),
          eventData.createdAt
        )
        .run();
    } catch (error) {
      console.error('Error logging auth event:', error);
      // Don't throw - logging failures shouldn't break authentication
    }
  }

  async getRecentFailures(userId, minutes = 15) {
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    
    return await this.db
      .prepare(`
        SELECT COUNT(*) as count 
        FROM auth_logs 
        WHERE user_id = ? 
          AND event = 'login_failed' 
          AND created_at > ?
      `)
      .bind(userId, since)
      .first();
  }

  async getSuspiciousActivity(userId, hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    
    return await this.db
      .prepare(`
        SELECT * 
        FROM auth_logs 
        WHERE user_id = ? 
          AND event IN ('login_failed', 'token_refresh', 'suspicious_activity')
          AND created_at > ?
        ORDER BY created_at DESC
      `)
      .bind(userId, since)
      .all();
  }
}
