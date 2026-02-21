/**
 * Cloudflare Worker — Auth Service
 * Entry point con dependency injection y manejo de rutas.
 *
 * CORRECCIONES aplicadas:
 *  - TenantRepository importado e inyectado en AuthService.
 *  - _initializeDependencies() movido fuera de fetch() con lazy init
 *    para no recrear instancias stateless en cada request.
 *  - RateLimitMiddleware recibe env.AUTH_RATE_LIMIT_KV y se aplica
 *    en las rutas sensibles (/login, /register).
 *  - CORS origins desde env.ALLOWED_ORIGINS (no más wildcard hardcodeado).
 *  - JWT issuer/audience desde env.JWT_ISSUER y env.JWT_AUDIENCE.
 *  - Roles y tenantDefaults configurables desde env.
 *  - ctx propagado a AuthRoutes para waitUntil no bloqueante.
 *  - Handler scheduled() para limpieza diaria de sesiones expiradas.
 *  - /logout-all como ruta separada de /logout.
 *  - Rutas sin prefijo duplicado: basePath configurable via env.AUTH_BASE_PATH.
 *
 * VARIABLES DE ENTORNO requeridas (ver wrangler.toml):
 *   JWT_SECRET         — secret HMAC para firmar tokens (wrangler secret put)
 *   JWT_ISSUER         — issuer del JWT (ej. "mi-app")
 *   JWT_AUDIENCE       — audience del JWT (ej. "mi-api")
 *   ALLOWED_ORIGINS    — orígenes CORS separados por coma (ej. "https://app.com")
 *   AUTH_BASE_PATH     — prefijo de rutas (ej. "/auth" o "") [opcional, default: ""]
 *
 * BINDINGS requeridos:
 *   DB                     — D1 database
 *   AUTH_RATE_LIMIT_KV     — KV namespace para rate limiting
 */

import { UserRepository }     from './persistence/user-repository.js';
import { TenantRepository }   from './persistence/tenant-repository.js';
import { SessionRepository }  from './persistence/session-repository.js';
import { AuthLogRepository }  from './persistence/auth-log-repository.js';
import { PasswordService }    from './crypto/password.js';
import { JWTService }         from './crypto/jwt.js';
import { RefreshTokenService } from './crypto/refresh-token.js';
import { AuthService }        from './core/auth-service.js';
import { AuthRoutes }         from './routes/auth-routes.js';
import { CorsMiddleware }     from './middleware/cors.js';
import { RateLimitMiddleware } from './middleware/rate-limit.js';

// ── Lazy init ─────────────────────────────────────────────────────────────────
// Las dependencias stateless (crypto services, middleware de config) se crean
// una sola vez por isolate. Los repositories que dependen de env.DB se
// instancian por request porque D1 es per-request en Workers.
let _staticDeps = null;

function getStaticDeps(env) {
  if (_staticDeps) return _staticDeps;

  const passwordService     = new PasswordService();
  const jwtService          = new JWTService(env.JWT_SECRET, {
    issuer:   env.JWT_ISSUER   ?? 'auth-service',
    audience: env.JWT_AUDIENCE ?? 'api-client',
  });
  const refreshTokenService = new RefreshTokenService({
    tokenLength: 32,
    expiryDays:  30,
  });

  // ✅ CORS desde env — nunca wildcard en producción para auth
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['*']; // solo para desarrollo local

  const cors = new CorsMiddleware({
    allowedOrigins,
    allowedMethods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  _staticDeps = { passwordService, jwtService, refreshTokenService, cors };
  return _staticDeps;
}

/** Construye todas las dependencias para un request (repositories son per-request). */
function buildDeps(env) {
  const { passwordService, jwtService, refreshTokenService, cors } = getStaticDeps(env);

  // Repositories (usan env.DB que es per-request en D1)
  const userRepo    = new UserRepository(env.DB);
  const tenantRepo  = new TenantRepository(env.DB);
  const sessionRepo = new SessionRepository(env.DB);
  const authLogRepo = new AuthLogRepository(env.DB);

  // ✅ Rate limiter con KV real
  const rateLimit = new RateLimitMiddleware({
    kv:          env.AUTH_RATE_LIMIT_KV,
    windowMs:    15 * 60 * 1000, // 15 min
    maxRequests: 100,
  });

  // Parsear roles válidos desde env (ej. "owner,admin,member,viewer")
  const validRoles = env.VALID_ROLES
    ? env.VALID_ROLES.split(',').map(r => r.trim())
    : ['owner', 'admin', 'member', 'viewer'];

  const authService = new AuthService({
    userRepo,
    tenantRepo,
    sessionRepo,
    authLogRepo,
    passwordService,
    jwtService,
    refreshTokenService,
    config: {
      maxFailedAttempts: Number(env.MAX_FAILED_ATTEMPTS ?? 5),
      lockoutMinutes:    Number(env.LOCKOUT_MINUTES    ?? 15),
      validRoles,
      tenantDefaults: {
        plan:     env.DEFAULT_TENANT_PLAN     ?? 'basic',
        status:   env.DEFAULT_TENANT_STATUS   ?? 'active',
        maxUsers: Number(env.DEFAULT_MAX_USERS ?? 5),
      },
    },
  });

  const authRoutes = new AuthRoutes(authService);

  return { authRoutes, cors, rateLimit, jwtService };
}

// ── Worker export ─────────────────────────────────────────────────────────────
export default {

  async fetch(request, env, ctx) {
    const { authRoutes, cors, rateLimit, jwtService } = buildDeps(env);

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const base   = env.AUTH_BASE_PATH ?? '';

    // Preflight CORS
    if (method === 'OPTIONS') {
      return cors.handlePreflight(request);
    }

    try {
      let response;

      // ── Health check ────────────────────────────────────────────────────
      if (path === `${base}/health` && method === 'GET') {
        response = jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
        return cors.addHeaders(response, request);
      }

      // ── Rutas públicas con rate limiting ────────────────────────────────
      const isPublicAuthRoute =
        (path === `${base}/register` || path === `${base}/login`) && method === 'POST';

      if (isPublicAuthRoute) {
        // ✅ Rate limit aplicado en las rutas más sensibles
        const rl = await rateLimit.checkLimit(request);
        if (!rl.allowed) {
          response = rateLimit.rateLimitResponse(rl.resetAt);
          return cors.addHeaders(response, request);
        }
      }

      // ── Auth routes ─────────────────────────────────────────────────────
      if (path === `${base}/register` && method === 'POST') {
        const result = await authRoutes.handleRegister(request, ctx);
        response = jsonResponse(result.data, result.status);
      }
      else if (path === `${base}/login` && method === 'POST') {
        const result = await authRoutes.handleLogin(request, ctx);
        response = jsonResponse(result.data, result.status);
      }
      else if (path === `${base}/refresh` && method === 'POST') {
        const result = await authRoutes.handleRefresh(request, ctx);
        response = jsonResponse(result.data, result.status);
      }
      else if (path === `${base}/logout` && method === 'POST') {
        const result = await authRoutes.handleLogout(request, ctx);
        response = jsonResponse(result.data, result.status);
      }
      else if (path === `${base}/logout-all` && method === 'POST') {
        const result = await authRoutes.handleLogoutAll(request, ctx);
        response = jsonResponse(result.data, result.status);
      }
      else if (path === `${base}/verify` && method === 'GET') {
        const result = await authRoutes.handleVerify(request);
        response = jsonResponse(result.data, result.status);
      }

      // ── Rutas protegidas /api/* ──────────────────────────────────────────
      // Aquí va la lógica de tu proyecto. El middleware de verificación
      // decodifica el JWT y lo pone en request.authContext.
      else if (path.startsWith(`${base}/api/`)) {
        const token = extractToken(request);
        if (!token) {
          response = jsonResponse({ error: 'No authorization token' }, 401);
          return cors.addHeaders(response, request);
        }
        const verification = await jwtService.verify(token);
        if (!verification.valid) {
          response = jsonResponse({ error: 'Invalid or expired token' }, 401);
          return cors.addHeaders(response, request);
        }
        // → aquí tu router de negocio puede usar verification.payload
        response = jsonResponse({ error: 'Route not found', path, method }, 404);
      }

      // ── 404 ─────────────────────────────────────────────────────────────
      else {
        response = jsonResponse({ error: 'Route not found', path, method }, 404);
      }

      return cors.addHeaders(response, request);

    } catch (error) {
      console.error('Worker error:', error.message);
      console.error(error.stack);
      const errResponse = jsonResponse(
        { error: 'Internal server error', message: error.message },
        500
      );
      return cors.addHeaders(errResponse, request);
    }
  },

  /**
   * ✅ Scheduled handler — limpieza diaria de sesiones expiradas.
   * Configurar en wrangler.toml:
   *   [triggers]
   *   crons = ["0 3 * * *"]
   */
  async scheduled(_event, env, ctx) {
    const sessionRepo = new SessionRepository(env.DB);
    ctx.waitUntil(sessionRepo.cleanupExpired());
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractToken(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  return authHeader.replace(/^Bearer\s+/i, '');
}