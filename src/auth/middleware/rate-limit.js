/**
 * Rate Limiting Middleware
 * Implementación real con Cloudflare KV — ventana deslizante por IP.
 *
 * CORRECCIONES aplicadas:
 *  - FIX CRÍTICO: el stub siempre retornaba allowed:true. Implementación
 *    real con sliding window usando KV (env.AUTH_RATE_LIMIT_KV).
 *  - Se expone getRateLimitKV(env) para que worker.js pueda pasar el binding.
 *
 * BINDING REQUERIDO en wrangler.toml:
 *   [[kv_namespaces]]
 *   binding = "AUTH_RATE_LIMIT_KV"
 *   id      = "<your-kv-namespace-id>"
 *
 * CÓMO FUNCIONA (sliding window):
 *  - Cada request escribe un timestamp en KV con TTL = windowMs.
 *  - Se leen todos los timestamps del prefijo ip:<identifier>:
 *  - Si hay >= maxRequests en la ventana → bloqueado.
 *  - Cada entrada caduca automáticamente vía TTL de KV.
 */
export class RateLimitMiddleware {
  /**
   * @param {object} options
   * @param {KVNamespace} options.kv         - Cloudflare KV namespace binding
   * @param {number}      options.windowMs   - Ventana en ms (default: 15 min)
   * @param {number}      options.maxRequests - Máximo de requests en la ventana
   */
  constructor(options = {}) {
    if (!options.kv) {
      throw new Error(
        'RateLimitMiddleware requiere options.kv (KV namespace binding). ' +
        'Asegurate de pasar env.AUTH_RATE_LIMIT_KV desde worker.js.'
      );
    }
    this.kv          = options.kv;
    this.windowMs    = options.windowMs    ?? 15 * 60 * 1000; // 15 min
    this.maxRequests = options.maxRequests ?? 100;
  }

  /**
   * Verifica el rate limit para un identificador (IP u otro).
   * @param {Request} request
   * @param {string}  [identifier]  - Si se omite, usa la IP del request
   * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
   */
  async checkLimit(request, identifier = null) {
    const key    = `rl:${identifier ?? this._getIdentifier(request)}`;
    const now    = Date.now();
    const cutoff = now - this.windowMs;
    const resetAt = now + this.windowMs;

    // Obtener timestamps actuales del KV
    let timestamps = [];
    try {
      const raw = await this.kv.get(key, { type: 'json' });
      if (Array.isArray(raw)) {
        // Filtrar solo los que están dentro de la ventana activa
        timestamps = raw.filter(ts => ts > cutoff);
      }
    } catch {
      // Si KV falla, permitir el request (fail-open) para no bloquear auth
      return { allowed: true, remaining: this.maxRequests, resetAt };
    }

    if (timestamps.length >= this.maxRequests) {
      return {
        allowed:   false,
        remaining: 0,
        resetAt:   timestamps[0] + this.windowMs, // cuándo expira el más antiguo
      };
    }

    // Registrar este request
    timestamps.push(now);
    const ttlSeconds = Math.ceil(this.windowMs / 1000);
    try {
      await this.kv.put(key, JSON.stringify(timestamps), {
        expirationTtl: ttlSeconds,
      });
    } catch {
      // Fallo silencioso — no bloquear auth por un error de KV
    }

    return {
      allowed:   true,
      remaining: this.maxRequests - timestamps.length,
      resetAt,
    };
  }

  /**
   * Respuesta 429 estándar con header Retry-After.
   * @param {number} resetAt  - timestamp ms en que se libera el rate limit
   * @returns {Response}
   */
  rateLimitResponse(resetAt) {
    const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
    return new Response(
      JSON.stringify({ error: 'Too many requests', retry_after: retryAfter }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After':  String(retryAfter),
          'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
        },
      }
    );
  }

  _getIdentifier(request) {
    return (
      request.headers.get('cf-connecting-ip') ??
      request.headers.get('x-forwarded-for') ??
      'unknown'
    );
  }
}