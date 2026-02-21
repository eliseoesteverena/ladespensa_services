/**
 * Auth Routes Handler (DEBUG VERSION)
 * Con logging detallado para rastrear errores
 */
import { AuthError } from '../core/auth-service.js';

export class AuthRoutes {
  constructor(authService) {
    this.authService = authService;
  }

  async handleRegister(request, ctx) {
    console.log('🔵 [AUTH-ROUTES] handleRegister iniciado');
    
    let body;
    try {
      body = await request.json();
      console.log('🔵 [AUTH-ROUTES] Body parseado correctamente');
    } catch {
      console.error('🔴 [AUTH-ROUTES] Error parseando JSON');
      return this._errorResponse('Invalid JSON in request body', 400);
    }

    const { email, password, role, tenant_id, workspace_name } = body;

// 👇 AÑADIR ESTE LOG:
console.log('🔵 [AUTH-ROUTES] Campos extraídos del body:', {
  email: email ? '✓' : '✗',
  password: password ? '✓' : '✗',
  tenant_id: tenant_id || 'null',
  workspace_name: workspace_name || 'UNDEFINED',
  role: role || 'null',
  bodyKeys: Object.keys(body) // 👈 esto te muestra TODOS los campos que llegaron
});

    console.log('🔵 [AUTH-ROUTES] Validando campos requeridos:', {
      hasEmail: !!email,
      hasPassword: !!password,
      hasTenantId: !!tenant_id,
      hasWorkspaceName: !!workspace_name
    });

    if (!email || !password) {
      console.error('🔴 [AUTH-ROUTES] Faltan email o password');
      return this._errorResponse('email and password are required', 400);
    }

    const isSelfRegistration = !tenant_id;
    console.log('🔵 [AUTH-ROUTES] Tipo de registro:', isSelfRegistration ? 'SELF' : 'INVITE');

    if (isSelfRegistration && !workspace_name) {
      console.error('🔴 [AUTH-ROUTES] Falta workspace_name en self-registration');
      return this._errorResponse(
        'workspace_name is required when creating a new account',
        400
      );
    }

    const finalRole = isSelfRegistration
      ? (role ?? 'owner')
      : (role ?? 'member');

    console.log('🔵 [AUTH-ROUTES] Rol final asignado:', finalRole);

    try {
      console.log('🔵 [AUTH-ROUTES] Llamando a authService.register()');
      
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
      
      console.log('🟢 [AUTH-ROUTES] Registro exitoso, user_id:', result.id);
      return this._successResponse(result, 201);
      
    } catch (error) {
      console.error('🔴 [AUTH-ROUTES] Error capturado en handleRegister:', {
        message: error.message,
        statusCode: error.statusCode,
        isAuthError: error instanceof AuthError,
        stack: error.stack?.split('\n').slice(0, 3).join('\n')
      });
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
      console.error('🔴 [AUTH-ROUTES] AuthError:', {
        message: error.message,
        statusCode: error.statusCode,
        data: error.data
      });
      return this._errorResponse(error.message, error.statusCode, error.data);
    }
    console.error('🔴 [AUTH-ROUTES] Error inesperado:', {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 5).join('\n')
    });
    return this._errorResponse('Internal server error', 500);
  }
}
