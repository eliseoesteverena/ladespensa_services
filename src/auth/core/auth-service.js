/**
 * Authentication Service
 * Core business logic — agnóstico al dominio de negocio.
 *
 * CORRECCIONES aplicadas:
 *  - _generateId() → crypto.randomUUID() (criptográficamente seguro)
 *  - Roles configurables via config.validRoles (no hardcodeados)
 *  - Defaults de tenant via config.tenantDefaults (no hardcodeados)
 *  - tenantRepo separado de userRepo (inyectado como dependencia nueva)
 *  - Registro tenant+usuario usa D1 batch() → operación atómica
 *  - Logout revoca solo la sesión actual (por jti), no todas las sesiones
 *  - findByEmail() recibe tenantId → modelo email único por tenant
 *  - login() requiere tenant_id en las credenciales para resolver el usuario
 *  - isAccountLocked() e isTenantActive() ahora son síncronos (no async)
 *  - ctx.waitUntil propagado para logging no bloqueante (opcional)
 */
export class AuthService {
  /**
   * @param {object} dependencies
   * @param {import('../persistence/user-repository.js').UserRepository}   dependencies.userRepo
   * @param {import('../persistence/tenant-repository.js').TenantRepository} dependencies.tenantRepo
   * @param {import('../persistence/session-repository.js').SessionRepository} dependencies.sessionRepo
   * @param {import('../persistence/auth-log-repository.js').AuthLogRepository} dependencies.authLogRepo
   * @param {object} dependencies.passwordService
   * @param {object} dependencies.jwtService
   * @param {object} dependencies.refreshTokenService
   * @param {object} [dependencies.config]
   * @param {number}   [dependencies.config.maxFailedAttempts=5]
   * @param {number}   [dependencies.config.lockoutMinutes=15]
   * @param {string[]} [dependencies.config.validRoles]          ← configurable
   * @param {object}   [dependencies.config.tenantDefaults]      ← configurable
   */
  constructor(dependencies) {
    this.userRepo            = dependencies.userRepo;
    this.tenantRepo          = dependencies.tenantRepo;
    this.sessionRepo         = dependencies.sessionRepo;
    this.authLogRepo         = dependencies.authLogRepo;
    this.passwordService     = dependencies.passwordService;
    this.jwtService          = dependencies.jwtService;
    this.refreshTokenService = dependencies.refreshTokenService;

    const cfg = dependencies.config ?? {};

    this.maxFailedAttempts = cfg.maxFailedAttempts ?? 5;
    this.lockoutMinutes    = cfg.lockoutMinutes    ?? 15;

    // ✅ Roles configurables — sin vocabulario de negocio hardcodeado
    this.validRoles = cfg.validRoles ?? ['owner', 'admin', 'member', 'viewer'];

    // ✅ Defaults de tenant configurables
    this.tenantDefaults = {
      plan:     'basic',
      status:   'active',
      maxUsers: 5,
      ...(cfg.tenantDefaults ?? {}),
    };
  }

  // ── PUBLIC API ─────────────────────────────────────────────────────────────

  /**
   * Registrar un nuevo usuario.
   * Soporta dos flujos:
   *   - Self-registration (isSelfRegistration=true): crea tenant + usuario en batch atómico.
   *   - Invite-registration (isSelfRegistration=false): agrega usuario a tenant existente.
   *
   * @param {object} userData
   * @param {string}  userData.email
   * @param {string}  userData.password
   * @param {string}  userData.role
   * @param {string}  [userData.tenantId]          - requerido si !isSelfRegistration
   * @param {string}  [userData.workspaceName]     - requerido si isSelfRegistration
   * @param {boolean} userData.isSelfRegistration
   * @param {object} context
   * @param {string}  context.ip
   * @param {string}  context.userAgent
   * @param {ExecutionContext} [context.ctx]        - CF Workers ctx para waitUntil
   */
  async register(userData, context) {
    const {
      email,
      password,
      role,
      tenantId,
      workspaceName,
      isSelfRegistration,
    } = userData;
    const { ip, userAgent, ctx } = context;

    // Validar rol
    if (!this.validRoles.includes(role)) {
      throw new AuthError(
        `Invalid role. Must be one of: ${this.validRoles.join(', ')}`,
        400
      );
    }

    let finalTenantId = tenantId;

    if (isSelfRegistration) {
      // ── SELF-REGISTRATION ────────────────────────────────────────────────
      finalTenantId = crypto.randomUUID();

      const tenantData = {
        id:          finalTenantId,
        name:        workspaceName,
        legalName:   workspaceName,
        plan:        this.tenantDefaults.plan,
        status:      this.tenantDefaults.status,
        maxUsers:    this.tenantDefaults.maxUsers,
        createdAt:   new Date().toISOString(),
      };

      // Validar contraseña y hashear antes del batch para no tener async dentro
      this._validatePasswordStrength(password);
      const passwordHash = await this.passwordService.hash(password);

      const userId = crypto.randomUUID();
      const now    = new Date().toISOString();

      // ✅ Registro atómico: tenant + usuario en una sola transacción D1 batch
      await this._createTenantAndUser(tenantData, {
        id:            userId,
        tenantId:      finalTenantId,
        email,
        passwordHash,
        role,
        isActive:      true,
        emailVerified: false,
        mfaEnabled:    false,
        failedAttempts: 0,
        createdAt:     now,
        updatedAt:     now,
      });

      this._fireLog(ctx, null, finalTenantId, 'tenant_created', ip, userAgent, {
        workspaceName,
      });
      this._fireLog(ctx, userId, finalTenantId, 'user_registered', ip, userAgent, {
        email,
        role,
        registrationType: 'self',
      });

      return {
        id:             userId,
        email,
        role,
        tenant_id:      finalTenantId,
        workspace_name: workspaceName,
        message:        'User registered successfully',
      };

    } else {
      // ── INVITE-REGISTRATION ──────────────────────────────────────────────
      if (!finalTenantId) {
        throw new AuthError('tenant_id is required for invite registration', 400);
      }

      const tenant = await this.tenantRepo.findById(finalTenantId);
      if (!tenant) {
        throw new AuthError('Invalid tenant', 400);
      }
      if (tenant.status !== 'active') {
        throw new AuthError('Tenant is not active', 403);
      }

      const userCount = await this.tenantRepo.countActiveUsers(finalTenantId);
      if (userCount >= tenant.max_users) {
        throw new AuthError('Tenant user limit reached', 403, {
          max_users:     tenant.max_users,
          current_users: userCount,
        });
      }

      // Verificar email único dentro del tenant
      const existingUser = await this.userRepo.findByEmail(email, finalTenantId);
      if (existingUser) {
        this._fireLog(ctx, null, finalTenantId, 'register_failed', ip, userAgent, {
          email,
          reason: 'email_already_exists',
        });
        throw new AuthError('Email already registered in this workspace', 409);
      }

      this._validatePasswordStrength(password);
      const passwordHash = await this.passwordService.hash(password);

      const userId = crypto.randomUUID();
      const now    = new Date().toISOString();

      await this.userRepo.create({
        id:             userId,
        tenantId:       finalTenantId,
        email,
        passwordHash,
        role,
        isActive:       true,
        emailVerified:  false,
        mfaEnabled:     false,
        failedAttempts: 0,
        createdAt:      now,
        updatedAt:      now,
      });

      this._fireLog(ctx, userId, finalTenantId, 'user_registered', ip, userAgent, {
        email,
        role,
        registrationType: 'invite',
      });

      return {
        id:        userId,
        email,
        role,
        tenant_id: finalTenantId,
        message:   'User registered successfully',
      };
    }
  }

  /**
   * Autenticar usuario con email + password.
   * Requiere tenant_id en las credenciales para resolver al usuario correcto
   * en el modelo email-único-por-tenant.
   *
   * @param {object} credentials
   * @param {string}  credentials.email
   * @param {string}  credentials.password
   * @param {string}  credentials.tenantId  ← requerido (modelo por-tenant)
   * @param {object} context
   */
  async login(credentials, context) {
    const { email, password, tenantId } = credentials;
    const { ip, userAgent, ctx }        = context;

    if (!tenantId) {
      throw new AuthError('tenant_id is required', 400);
    }

    const user = await this.userRepo.findByEmail(email, tenantId);

    if (!user) {
      this._fireLog(ctx, null, tenantId, 'login_failed', ip, userAgent, {
        email,
        reason: 'user_not_found',
      });
      throw new AuthError('Invalid credentials', 401);
    }

    // Verificar tenant activo
    if (!this.userRepo.isTenantActive(user)) {
      this._fireLog(ctx, user.id, user.tenant_id, 'login_failed', ip, userAgent, {
        email,
        reason: 'tenant_suspended',
      });
      throw new AuthError('Account suspended. Contact administrator.', 403);
    }

    // Verificar bloqueo de cuenta
    if (this.userRepo.isAccountLocked(user)) {
      this._fireLog(ctx, user.id, user.tenant_id, 'login_failed', ip, userAgent, {
        email,
        reason: 'account_locked',
      });
      throw new AuthError(`Account locked until ${user.locked_until}`, 403);
    }

    // Verificar contraseña
    const isValidPassword = await this.passwordService.verify(
      password,
      user.password_hash
    );

    if (!isValidPassword) {
      await this._handleFailedLogin(user, email, ip, userAgent, ctx);
      const attemptsRemaining = Math.max(
        0,
        this.maxFailedAttempts - (user.failed_attempts + 1)
      );
      throw new AuthError('Invalid credentials', 401, { attempts_remaining: attemptsRemaining });
    }

    // Reset intentos fallidos
    await this.userRepo.resetFailedAttempts(user.id);

    // Generar tokens
    const { token: accessToken, jti } = await this.jwtService.generate({
      sub:    user.id,
      tenant: user.tenant_id,
      role:   user.role,
      email:  user.email,
    });

    const refreshTokenData = await this.refreshTokenService.generate();

    await this.sessionRepo.create({
      id:               crypto.randomUUID(),
      userId:           user.id,
      tenantId:         user.tenant_id,
      refreshTokenHash: refreshTokenData.hash,
      jti,
      expiresAt:        refreshTokenData.expiresAt,
      createdAt:        new Date().toISOString(),
    });

    this._fireLog(ctx, user.id, user.tenant_id, 'login_success', ip, userAgent, { email });

    return {
      accessToken,
      refreshToken: refreshTokenData.token,
      user: {
        id:         user.id,
        email:      user.email,
        role:       user.role,
        tenantId:   user.tenant_id,
        tenantName: user.tenant_name,
      },
      expiresIn: 28800, // 8 h
    };
  }

  /**
   * Renovar access token con rotación de refresh token.
   * @param {string} refreshToken
   * @param {object} context
   */
  async refresh(refreshToken, context) {
    const { ip, userAgent, ctx } = context;

    const tokenHash = await this.refreshTokenService.hash(refreshToken);
    const session   = await this.sessionRepo.findByRefreshToken(tokenHash);

    if (!session) {
      throw new AuthError('Invalid or expired token', 401);
    }

    // Revocar sesión anterior (token rotation)
    await this.sessionRepo.revoke(session.id);

    // Generar nuevos tokens
    const { token: newAccessToken, jti: newJti } = await this.jwtService.generate({
      sub:    session.user_id,
      tenant: session.tenant_id,
      role:   session.role,
      email:  session.email,
    });

    const newRefreshTokenData = await this.refreshTokenService.generate();

    await this.sessionRepo.create({
      id:               crypto.randomUUID(),
      userId:           session.user_id,
      tenantId:         session.tenant_id,
      refreshTokenHash: newRefreshTokenData.hash,
      jti:              newJti,
      expiresAt:        newRefreshTokenData.expiresAt,
      createdAt:        new Date().toISOString(),
    });

    this._fireLog(ctx, session.user_id, session.tenant_id, 'token_refresh', ip, userAgent, {});

    return {
      accessToken:  newAccessToken,
      refreshToken: newRefreshTokenData.token,
      expiresIn:    28800,
    };
  }

  /**
   * Cerrar sesión del usuario actual (revoca solo la sesión del token presentado).
   * Para revocar TODAS las sesiones del usuario, llamar logoutAll().
   *
   * @param {string} token - access token JWT
   * @param {object} context
   */
  async logout(token, context) {
    const { ip, userAgent, ctx } = context;

    const verification = await this.jwtService.verify(token);
    if (!verification.valid) {
      throw new AuthError('Invalid token', 401);
    }

    const { payload } = verification;

    // ✅ Revoca solo la sesión actual identificada por jti
    await this.sessionRepo.revokeByJti(payload.jti);

    this._fireLog(ctx, payload.sub, payload.tenant, 'logout', ip, userAgent, {});

    return { message: 'Logout successful' };
  }

  /**
   * Cerrar todas las sesiones del usuario (ej. "salir de todos los dispositivos").
   * @param {string} token - access token JWT
   * @param {object} context
   */
  async logoutAll(token, context) {
    const { ip, userAgent, ctx } = context;

    const verification = await this.jwtService.verify(token);
    if (!verification.valid) {
      throw new AuthError('Invalid token', 401);
    }

    const { payload } = verification;

    await this.sessionRepo.revokeAllForUser(payload.sub);

    this._fireLog(ctx, payload.sub, payload.tenant, 'logout_all', ip, userAgent, {});

    return { message: 'All sessions revoked' };
  }

  /**
   * Verificar validez de un access token.
   * @param {string} token
   * @returns {{ valid: boolean, user?: object }}
   */
  async verify(token) {
    const verification = await this.jwtService.verify(token);
    if (!verification.valid) {
      return { valid: false };
    }

    const { payload } = verification;

    // Comprobar que la sesión no fue revocada
    const session = await this.sessionRepo.findByJti(payload.jti);
    if (!session) {
      return { valid: false };
    }

    const user = await this.userRepo.findById(payload.sub);
    if (!user) {
      return { valid: false };
    }

    return {
      valid: true,
      user: {
        id:       user.id,
        email:    user.email,
        role:     user.role,
        tenantId: user.tenant_id,
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Crea tenant + usuario en una sola transacción D1 batch (atómica).
   * Si cualquier INSERT falla, ninguno se persiste.
   */
  async _createTenantAndUser(tenantData, userData) {
    const tenantStmt = this.tenantRepo.db
      .prepare(`
        INSERT INTO tenants (
          id, name, legal_name, plan, status, max_users, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        tenantData.id,
        tenantData.name,
        tenantData.legalName ?? tenantData.name,
        tenantData.plan,
        tenantData.status,
        tenantData.maxUsers,
        tenantData.createdAt,
      );

    const userStmt = this.userRepo.db
      .prepare(`
        INSERT INTO users (
          id, tenant_id, email, password_hash, role,
          is_active, email_verified, mfa_enabled, failed_attempts,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        userData.id,
        userData.tenantId,
        userData.email,
        userData.passwordHash,
        userData.role,
        userData.isActive      ? 1 : 0,
        userData.emailVerified ? 1 : 0,
        userData.mfaEnabled    ? 1 : 0,
        userData.failedAttempts ?? 0,
        userData.createdAt,
        userData.updatedAt,
      );

    // ✅ D1 batch — ambas operaciones son atómicas
    await this.tenantRepo.db.batch([tenantStmt, userStmt]);
  }

  async _handleFailedLogin(user, email, ip, userAgent, ctx) {
    const newAttempts = user.failed_attempts + 1;
    const lockedUntil = newAttempts >= this.maxFailedAttempts
      ? new Date(Date.now() + this.lockoutMinutes * 60 * 1000).toISOString()
      : null;

    await this.userRepo.updateFailedAttempts(user.id, newAttempts, lockedUntil);

    this._fireLog(ctx, user.id, user.tenant_id, 'login_failed', ip, userAgent, {
      email,
      reason:   'invalid_password',
      attempts: newAttempts,
    });
  }

  /**
   * Dispara un log de autenticación.
   * Si se pasa ctx (CF Workers ExecutionContext), usa waitUntil para no
   * bloquear el response al cliente.
   */
  _fireLog(ctx, userId, tenantId, event, ip, userAgent, metadata) {
    const promise = this.authLogRepo.log({
      id:        crypto.randomUUID(),
      userId,
      tenantId,
      event,
      ip,
      userAgent,
      metadata,
      createdAt: new Date().toISOString(),
    });

    if (ctx?.waitUntil) {
      // ✅ No bloqueante: el response al cliente se envía sin esperar el log
      ctx.waitUntil(promise);
    } else {
      // Fallback: await implícito (entornos sin ctx o tests)
      return promise;
    }
  }

  _validatePasswordStrength(password) {
    if (!password || password.length < 8) {
      throw new AuthError('Password must be at least 8 characters', 400);
    }
    const hasUpper   = /[A-Z]/.test(password);
    const hasLower   = /[a-z]/.test(password);
    const hasNumber  = /\d/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

    if (!hasUpper || !hasLower || !hasNumber || !hasSpecial) {
      throw new AuthError(
        'Password must contain uppercase, lowercase, number and special character',
        400
      );
    }
  }
}

export class AuthError extends Error {
  constructor(message, statusCode, data = {}) {
    super(message);
    this.statusCode = statusCode;
    this.data       = data;
  }
}