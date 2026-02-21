/**
 * Auth Routes Handler
 * Capa HTTP — traduce requests a llamadas al AuthService.
 *
 * CORRECCIONES aplicadas:
 *  - Roles válidos eliminados del handler: la validación ocurre en AuthService
 *    (configurado desde fuera), esta capa solo hace validación de presencia.
 *  - company_name → workspace_name (término neutro, agnóstico al negocio).
 *  - handleLogin() pasa tenantId al servicio (modelo email-por-tenant).
 *  - handleLogoutAll() expuesto como ruta opcional.
 *  - _getContext() propaga ctx (ExecutionContext de CF Workers) para waitUntil.
 */
import { AuthError } from '../core/auth-service.js';

export class AuthRoutes {
  constructor(authService) {
    this.authService = authService;
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async handleRegister(request, ctx) {
    let body;
    try {
      body = await request.json();
    } catch {
      return this._errorResponse('Invalid JSON in request body', 400);
    }

    const { email, password, role, tenant_id, workspace_name } = body;

    if (!email || !password) {
      return this._errorResponse('email and password are required', 400);
    }

    // Sin tenant_id → self-registration (crear workspace nuevo)
    // Con tenant_id → invite-registration (unirse a workspace existente)
    const isSelfRegistration = !tenant_id;

    if (isSelfRegistration && !workspace_name) {
      return this._errorResponse(
        'workspace_name is required when creating a new account',
        400
      );
    }

    // El rol por defecto para self-registration es el primero de validRoles
    // (normalmente 'owner'). Para invite, usa el rol enviado o el segundo (ej. 'member').
    // La validación real del rol ocurre en AuthService.
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
      return this._handleError(error);
    }
  }

  async handleLogin(request, ctx) {
    let body;
    try {
      body = await request.json();
    } catch {
      return this._errorResponse('Invalid JSON in request body', 400);
    }

    const { email, password, tenant_id } = body;

    if (!email || !password) {
      return this._errorResponse('email and password are required', 400);
    }

    // tenant_id requerido en modelo email-por-tenant.
    // Si tu despliegue es single-tenant, setea un TENANT_ID fijo en env
    // y el worker puede inyectarlo aquí antes de llamar al handler.
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

  async handleRefresh(request, ctx) {
    let body;
    try {
      body = await request.json();
    } catch {
      return this._errorResponse('Invalid JSON in request body', 400);
    }

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

  /** Cierra TODAS las sesiones del usuario (todos los dispositivos). */
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

  // ── Private helpers ────────────────────────────────────────────────────────

  _extractToken(request) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return null;
    return authHeader.replace(/^Bearer\s+/i, '');
  }

  /**
   * Construye el context que se pasa al AuthService.
   * Incluye ctx (ExecutionContext) para habilitar waitUntil en logs.
   */
  _getContext(request, ctx = null) {
    return {
      ip: (
        request.headers.get('cf-connecting-ip') ??
        request.headers.get('x-forwarded-for') ??
        'unknown'
      ),
      userAgent: request.headers.get('user-agent') ?? 'unknown',
      ctx,   // ✅ propagado para waitUntil no bloqueante
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
    console.error('Unexpected error in AuthRoutes:', error);
    return this._errorResponse('Internal server error', 500);
  }
}