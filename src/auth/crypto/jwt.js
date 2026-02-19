/**
 * JWT Service
 * Handles token generation and validation with standard claims.
 *
 * CORRECCIONES aplicadas:
 *  - FIX CRÍTICO: _base64UrlEncode(signature) usaba spread operator
 *    String.fromCharCode(...new Uint8Array()) que falla con payloads
 *    grandes (Maximum call stack exceeded). Reemplazado por loop for..of.
 */
export class JWTService {
  constructor(secret, options = {}) {
    if (!secret) {
      throw new Error('JWT secret is required');
    }
    this.secret    = secret;
    this.issuer    = options.issuer   || 'auth-service';
    this.audience  = options.audience || 'api-client';
    this.algorithm = 'HS256';
  }

  /**
   * Generate JWT with standard claims.
   * @param {object} payload   - { sub, tenant, role, email, ... }
   * @param {number} expiresInHours
   * @returns {{ token: string, jti: string, expiresAt: number }}
   */
  async generate(payload, expiresInHours = 8) {
    const now = Math.floor(Date.now() / 1000);

    const claims = {
      ...payload,
      iat: now,
      exp: now + expiresInHours * 3600,
      iss: this.issuer,
      aud: this.audience,
      jti: this._generateJti(),
    };

    const header = { alg: this.algorithm, typ: 'JWT' };

    const encodedHeader  = this._base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this._base64UrlEncode(JSON.stringify(claims));
    const signingInput   = `${encodedHeader}.${encodedPayload}`;

    const signatureBuffer = await this._sign(signingInput);

    // ✅ FIX: loop for..of en lugar de spread operator para evitar
    //    "Maximum call stack size exceeded" con buffers grandes.
    const bytes = new Uint8Array(signatureBuffer);
    let binaryStr = '';
    for (const b of bytes) binaryStr += String.fromCharCode(b);

    const encodedSignature = this._base64UrlEncode(binaryStr);

    return {
      token:     `${encodedHeader}.${encodedPayload}.${encodedSignature}`,
      jti:       claims.jti,
      expiresAt: claims.exp,
    };
  }

  /**
   * Verify and decode JWT.
   * @param {string} token
   * @returns {{ valid: boolean, payload?: object, error?: string }}
   */
  async verify(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return { valid: false, error: 'Invalid token format' };
      }

      const [encodedHeader, encodedPayload, encodedSignature] = parts;

      // Verify signature
      const signingInput  = `${encodedHeader}.${encodedPayload}`;
      const sigBytes      = this._base64UrlDecode(encodedSignature);
      const isValidSig    = await this._verifySignature(signingInput, sigBytes);

      if (!isValidSig) {
        return { valid: false, error: 'Invalid signature' };
      }

      // Decode payload
      const payload = JSON.parse(
        atob(encodedPayload.replace(/-/g, '+').replace(/_/g, '/'))
      );

      // Validate standard claims
      const now = Math.floor(Date.now() / 1000);
      if (!payload.exp || payload.exp < now) {
        return { valid: false, error: 'Token expired' };
      }
      if (!payload.iss || payload.iss !== this.issuer) {
        return { valid: false, error: 'Invalid issuer' };
      }
      if (!payload.aud || payload.aud !== this.audience) {
        return { valid: false, error: 'Invalid audience' };
      }
      if (!payload.jti) {
        return { valid: false, error: 'Missing jti claim' };
      }

      return { valid: true, payload };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  async _sign(data) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return crypto.subtle.sign('HMAC', key, encoder.encode(data));
  }

  async _verifySignature(data, signature) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    return crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));
  }

  _base64UrlEncode(str) {
    return btoa(str)
      .replace(/=/g,  '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  _base64UrlDecode(str) {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  }

  _generateJti() {
    const random = crypto.getRandomValues(new Uint8Array(16));
    const hex    = Array.from(random, b => b.toString(16).padStart(2, '0')).join('');
    return `${Date.now()}-${hex}`;
  }
}