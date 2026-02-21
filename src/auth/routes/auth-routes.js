/**
 * Auth Routes Handler (FIXED)
 * Métodos *WithBody() para recibir el body ya parseado desde el worker
 */
import { AuthError } from '../core/auth-service.js';

export class AuthRoutes {
  constructor(authService) {
    this.authService = authService;
  }

  // ══════════════════════════════════════════════════════════════════════
  // NUEVOS MÉTODOS — reciben el body ya parseado
  // ══════════════════════════════════════════════════════════════════════

  async handleRegisterWithBody(body, request, ctx) {
    const { email, password, role, tenant_id, workspace_name } = body;

    if (!email || !password) {
      return this._errorResponse('email and password are required', 400);
    }

    const isSelfRegistration = !tenant_id;

    if (isSelfRegistration && !workspace_name) {
      return this._errorResponse(
        'workspace_name is required when creating a new account',
        400
      );
    }

    const finalRole = isSelfRegistration
      ? (role ?? 'owner')
      : (role ?? 'member');

    try {
      const result = await this.authService.register(
        {
          email,
          password,
          role:              finalRole,
          tenantId:          tenant_id ?? null,
          workspaceName:     workspace_name ?? null,
          isSelfRegistration,
        },
        this._getContext(request, ctx)
      );
      
      return this._successResponse(result, 201);
      
    } catch (error) {
      console.error('🔴 [AUTH-ROUTES] Error en register:', error.message);
      return this._handleError(error);
    }
  }

  async handleLoginWithBody(body, request, ctx) {
    const { email, password, tenant_id } = body;

    if (!email || !password) {
      return this._errorResponse('email and password are required', 400);
    }

    if (!tenant_id) {
      return this._errorResponse('tenant_id is required', 400);
    }

    try {
      const result = await this.authService.login(
        { email, password, tenantId: tenant_id },
        this._getContext(request, ctx)
      );
      return this._successResponse(result);
    } catch (error) {
      return this._handleError(error);
    }
  }

  async handleRefreshWithBody(body, request, ctx) {
    const { refresh_token } = body;
    if (!refresh_token) {
      return this._errorResponse('refresh_token is required', 400);
    }

    try {
      const result = await this.authService.refresh(
        refresh_token,
        this._getContext(request, ctx)
      );
      return this._successResponse(result);
    } catch (error) {
      return this._handleError(error);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // MÉTODOS ORIGINALES — mantienen retrocompatibilidad (leen el body ellos)
  // ══════════════════════════════════════════════════════════════════════

  async handleRegister(request, ctx) {
    let body;
    try {
      body = await request.json();
    } catch {
      return this._errorResponse('Invalid JSON in request body', 400);
    }
    return this.handleRegisterWithBody(body, request, ctx);
  }

  async handleLogin(request, ctx) {
    let body;
    try {
      body = await request.json();
    } catch {
      return this._errorResponse('Invalid JSON in request body', 400);
    }
    return this.handleLoginWithBody(body, request, ctx);
  }

  async handleRefresh(request, ctx) {
    let body;
    try {
      body = await request.json();
    } catch {
      return this._errorResponse('Invalid JSON in request body', 400);
    }
    return this.handleRefreshWithBody(body, request, ctx);
  }

  async handleLogout(request, ctx) {
    const token = this._extractToken(request);
    if (!token) {
      return this._errorResponse('No authorization token', 401);
    }

    try {
      const result = await this.authService.logout(
        token,
        this._getContext(request, ctx)
      );
      return this._successResponse(result);
    } catch (error) {
      return this._handleError(error);
    }
  }

  async handleLogoutAll(request, ctx) {
    const token = this._extractToken(request);
    if (!token) {
      return this._errorResponse('No authorization token', 401);
    }

    try {
      const result = await this.authService.logoutAll(
        token,
        this._getContext(request, ctx)
      );
      return this._successResponse(result);
    } catch (error) {
      return this._handleError(error);
    }
  }

  async handleVerify(request) {
    const token = this._extractToken(request);
    if (!token) {
      return this._successResponse({ valid: false }, 401);
    }

    try {
      const result = await this.authService.verify(token);
      return this._successResponse(result, result.valid ? 200 : 401);
    } catch (error) {
      return this._handleError(error);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════

  _extractToken(request) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return null;
    return authHeader.replace(/^Bearer\s+/i, '');
  }

  _getContext(request, ctx = null) {
    return {
      ip: (
        request.headers.get('cf-connecting-ip') ??
        request.headers.get('x-forwarded-for') ??
        'unknown'
      ),
      userAgent: request.headers.get('user-agent') ?? 'unknown',
      ctx,
    };
  }

  _successResponse(data, status = 200) {
    return { status, data };
  }

  _errorResponse(message, status = 400, data = {}) {
    return { status, data: { error: message, ...data } };
  }

  _handleError(error) {
    if (error instanceof AuthError) {
      return this._errorResponse(error.message, error.statusCode, error.data);
    }
    console.error('🔴 [AUTH-ROUTES] Unexpected error:', error.message);
    return this._errorResponse('Internal server error', 500);
  }
}
