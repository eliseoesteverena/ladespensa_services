/**
 * Refresh Token Service
 * Handles refresh token generation, rotation, and validation
 */

export class RefreshTokenService {
  constructor(options = {}) {
    this.tokenLength = options.tokenLength || 32;
    this.expiryDays = options.expiryDays || 30;
  }

  /**
   * Generate cryptographically secure refresh token
   */
  async generate() {
    const array = new Uint8Array(this.tokenLength);
    crypto.getRandomValues(array);
    
    const token = Array.from(array, byte => 
      byte.toString(16).padStart(2, '0')
    ).join('');

    const hash = await this._hashToken(token);
    const expiresAt = new Date(Date.now() + this.expiryDays * 24 * 60 * 60 * 1000);

    return {
      token,
      hash,
      expiresAt: expiresAt.toISOString()
    };
  }

  /**
   * Hash token for storage
   */
  async hash(token) {
    return await this._hashToken(token);
  }

  /**
   * Verify token against stored hash
   */
  async verify(token, storedHash) {
    const hash = await this._hashToken(token);
    return hash === storedHash;
  }

  async _hashToken(token) {
    const encoder = new TextEncoder();
    const data = encoder.encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
