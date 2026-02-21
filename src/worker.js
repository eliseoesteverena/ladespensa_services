/**
 * Cloudflare Worker — Auth Service (FIXED)
 * Body parseado una sola vez y pasado a los handlers
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

  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['*'];

  const cors = new CorsMiddleware({
    allowedOrigins,
    allowedMethods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  _staticDeps = { passwordService, jwtService, refreshTokenService, cors };
  return _staticDeps;
}

function buildDeps(env) {
  const { passwordService, jwtService, refreshTokenService, cors } = getStaticDeps(env);

  const userRepo    = new UserRepository(env.DB);
  const tenantRepo  = new TenantRepository(env.DB);
  const sessionRepo = new SessionRepository(env.DB);
  const authLogRepo = new AuthLogRepository(env.DB);

  const rateLimit = new RateLimitMiddleware({
    kv:          env.AUTH_RATE_LIMIT_KV,
    windowMs:    15 * 60 * 1000,
    maxRequests: 100,
  });

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

export default {

  async fetch(request, env, ctx) {
    const { authRoutes, cors, rateLimit, jwtService } = buildDeps(env);

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const base   = env.AUTH_BASE_PATH ?? '';

    if (method === 'OPTIONS') {
      return cors.handlePreflight(request);
    }

    try {
      let response;

      if (path === `${base}/health` && method === 'GET') {
        response = jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
        return cors.addHeaders(response, request);
      }

      const isPublicAuthRoute =
        (path === `${base}/register` || path === `${base}/login`) && method === 'POST';

      if (isPublicAuthRoute) {
        const rl = await rateLimit.checkLimit(request);
        if (!rl.allowed) {
          response = rateLimit.rateLimitResponse(rl.resetAt);
          return cors.addHeaders(response, request);
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // REGISTER — leer body UNA SOLA VEZ y pasarlo al handler
      // ═══════════════════════════════════════════════════════════════════
      if (path === `${base}/register` && method === 'POST') {
        let body;
        try {
          body = await request.json();
          console.log('🔵 [REGISTER] Body parseado:', {
            email: body.email ? 'presente' : 'ausente',
            password: body.password ? 'presente' : 'ausente',
            workspace_name: body.workspace_name || 'ausente',
            tenant_id: body.tenant_id || 'ausente'
          });
        } catch (parseError) {
          console.error('🔴 [REGISTER] Error parseando JSON:', parseError.message);
          response = jsonResponse({ error: 'Invalid JSON in request body' }, 400);
          return cors.addHeaders(response, request);
        }

        try {
          // ✅ Pasar el body ya parseado
          const result = await authRoutes.handleRegisterWithBody(body, request, ctx);
          console.log('🟢 [REGISTER] Registro exitoso');
          response = jsonResponse(result.data, result.status);
        } catch (error) {
          console.error('🔴 [REGISTER] Error:', error.message);
          const errorBody = {
            error: error.message || 'Registration failed',
            ...(error.data || {})
          };
          response = jsonResponse(errorBody, error.statusCode || 500);
        }
      }
      else if (path === `${base}/login` && method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          response = jsonResponse({ error: 'Invalid JSON in request body' }, 400);
          return cors.addHeaders(response, request);
        }
        const result = await authRoutes.handleLoginWithBody(body, request, ctx);
        response = jsonResponse(result.data, result.status);
      }
      else if (path === `${base}/refresh` && method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          response = jsonResponse({ error: 'Invalid JSON in request body' }, 400);
          return cors.addHeaders(response, request);
        }
        const result = await authRoutes.handleRefreshWithBody(body, request, ctx);
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
        response = jsonResponse({ error: 'Route not found', path, method }, 404);
      }
      else {
        response = jsonResponse({ error: 'Route not found', path, method }, 404);
      }

      return cors.addHeaders(response, request);

    } catch (error) {
      console.error('🔴 [WORKER] Error no capturado:', error.message, error.stack);
      const errResponse = jsonResponse(
        { error: 'Internal server error', message: error.message },
        500
      );
      return cors.addHeaders(errResponse, request);
    }
  },

  async scheduled(_event, env, ctx) {
    const sessionRepo = new SessionRepository(env.DB);
    ctx.waitUntil(sessionRepo.cleanupExpired());
  },
};

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
