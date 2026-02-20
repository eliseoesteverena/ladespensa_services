/**
 * src/app/services/account.service.js
 * Lógica de negocio para gestión de cuenta y workspace.
 *
 * Responsabilidades:
 * - Validar reglas de negocio antes de llamar al repo
 * - Hashear contraseñas (misma primitiva que el auth-module: PBKDF2-SHA256)
 * - Generar y hashear tokens de invitación
 * - Definir qué puede hacer cada rol
 */

import * as AccountRepo from '../repositories/account.repository.js';

// ─── Reglas de roles ──────────────────────────────────────────────────────────

// Jerarquía de roles — índice mayor = más privilegios
const ROLE_HIERARCHY = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function roleLevel(role) {
  return ROLE_HIERARCHY[role] ?? -1;
}

export function canManageRole(actorRole, targetRole) {
  // Solo puede asignar roles estrictamente inferiores al propio
  return roleLevel(actorRole) > roleLevel(targetRole);
}

export function canManageMember(actorRole, targetRole) {
  // Owner puede gestionar a todos. Admin puede gestionar member/viewer.
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return roleLevel(targetRole) < roleLevel('admin');
  return false;
}

// Roles asignables en invitación (nunca se puede invitar como owner)
const INVITABLE_ROLES = new Set(['admin', 'member', 'viewer']);

// ─── Perfil de usuario ────────────────────────────────────────────────────────

export async function getProfile(db, tenantId, userId) {
  const user = await AccountRepo.findUserById(db, tenantId, userId);
  if (!user) throw new NotFoundError('Usuario');
  return user;
}

export async function updateProfile(db, tenantId, userId, data) {
  const updates = {};

  if (data.display_name !== undefined) {
    const name = data.display_name?.trim() ?? '';
    if (name.length > 80) throw new ValidationError('display_name no puede superar 80 caracteres.');
    updates.displayName = name || null;
  }
  if (data.avatar_url !== undefined) {
    if (data.avatar_url && !isValidUrl(data.avatar_url)) {
      throw new ValidationError('avatar_url debe ser una URL válida.');
    }
    updates.avatarUrl = data.avatar_url || null;
  }

  if (Object.keys(updates).length === 0) {
    throw new ValidationError('No hay campos para actualizar.');
  }

  await AccountRepo.updateUserProfile(db, tenantId, userId, updates);
  return AccountRepo.findUserById(db, tenantId, userId);
}

export async function changePassword(db, tenantId, userId, data) {
  if (!data.current_password || !data.new_password) {
    throw new ValidationError('Se requieren current_password y new_password.');
  }
  if (!isStrongPassword(data.new_password)) {
    throw new ValidationError(
      'La nueva contraseña debe tener mínimo 8 caracteres, una mayúscula, una minúscula, un número y un carácter especial.'
    );
  }
  if (data.current_password === data.new_password) {
    throw new ValidationError('La nueva contraseña debe ser diferente a la actual.');
  }

  // Verificar contraseña actual
  const currentHash = await AccountRepo.getUserPasswordHash(db, tenantId, userId);
  if (!currentHash) throw new NotFoundError('Usuario');

  const currentValid = await verifyPbkdf2(data.current_password, currentHash);
  if (!currentValid) throw new AuthError('La contraseña actual es incorrecta.');

  // Hashear nueva y guardar
  const newHash = await hashPbkdf2(data.new_password);
  await AccountRepo.updateUserPassword(db, tenantId, userId, newHash);
}

// ─── Workspace ────────────────────────────────────────────────────────────────

export async function getWorkspace(db, tenantId) {
  const tenant = await AccountRepo.findTenantById(db, tenantId);
  if (!tenant) throw new NotFoundError('Workspace');
  return tenant;
}

export async function updateWorkspace(db, tenantId, actorRole, data) {
  if (actorRole !== 'owner') {
    throw new ForbiddenError('Solo el owner puede modificar el workspace.');
  }

  const name = data.name?.trim() ?? '';
  if (!name || name.length < 2 || name.length > 80) {
    throw new ValidationError('El nombre del workspace debe tener entre 2 y 80 caracteres.');
  }

  await AccountRepo.updateTenantName(db, tenantId, name);
  return AccountRepo.findTenantById(db, tenantId);
}

// ─── Miembros ─────────────────────────────────────────────────────────────────

export async function getMembers(db, tenantId) {
  return AccountRepo.listMembers(db, tenantId);
}

export async function updateMember(db, tenantId, actorId, actorRole, targetUserId, data) {
  if (actorId === targetUserId) {
    throw new ValidationError('No podés modificar tu propio rol. Pedile a otro admin u owner.');
  }

  const target = await AccountRepo.findMemberById(db, tenantId, targetUserId);
  if (!target) throw new NotFoundError('Miembro');

  if (!canManageMember(actorRole, target.role)) {
    throw new ForbiddenError(`El rol '${actorRole}' no puede gestionar miembros con rol '${target.role}'.`);
  }

  const newRole = data.role;
  if (!newRole || !ROLE_HIERARCHY.hasOwnProperty(newRole)) {
    throw new ValidationError(`Rol inválido: '${newRole}'. Roles válidos: ${Object.keys(ROLE_HIERARCHY).join(', ')}.`);
  }
  if (newRole === 'owner') {
    throw new ForbiddenError('No se puede asignar el rol owner a través de este endpoint.');
  }
  if (!canManageRole(actorRole, newRole)) {
    throw new ForbiddenError(`El rol '${actorRole}' no puede asignar el rol '${newRole}'.`);
  }

  await AccountRepo.updateMemberRole(db, tenantId, targetUserId, newRole);
  return AccountRepo.findMemberById(db, tenantId, targetUserId);
}

export async function removeMember(db, tenantId, actorId, actorRole, targetUserId) {
  if (actorId === targetUserId) {
    throw new ValidationError('No podés eliminarte a vos mismo del workspace.');
  }

  const target = await AccountRepo.findMemberById(db, tenantId, targetUserId);
  if (!target) throw new NotFoundError('Miembro');
  if (target.role === 'owner') {
    throw new ForbiddenError('No se puede eliminar al owner del workspace.');
  }
  if (!canManageMember(actorRole, target.role)) {
    throw new ForbiddenError(`El rol '${actorRole}' no puede eliminar miembros con rol '${target.role}'.`);
  }

  // Soft delete + revocar sesiones activas
  await Promise.all([
    AccountRepo.deactivateMember(db, tenantId, targetUserId),
    AccountRepo.revokeAllUserSessions(db, tenantId, targetUserId)
  ]);
}

// ─── Sesiones ─────────────────────────────────────────────────────────────────

export async function getSessions(db, tenantId, userId) {
  return AccountRepo.listActiveSessions(db, tenantId, userId);
}

export async function revokeSession(db, tenantId, userId, jti) {
  const revoked = await AccountRepo.revokeSession(db, tenantId, userId, jti);
  if (!revoked) throw new NotFoundError('Sesión');
}

// ─── Invitaciones ─────────────────────────────────────────────────────────────

export async function inviteMember(db, tenantId, actorId, actorRole, data) {
  if (roleLevel(actorRole) < roleLevel('admin')) {
    throw new ForbiddenError('Se requiere rol admin u owner para invitar miembros.');
  }

  const email = data.email?.toLowerCase().trim();
  if (!email || !isValidEmail(email)) {
    throw new ValidationError('Email inválido.');
  }

  const role = data.role ?? 'member';
  if (!INVITABLE_ROLES.has(role)) {
    throw new ValidationError(`Rol inválido para invitación: '${role}'. Opciones: admin, member, viewer.`);
  }
  if (!canManageRole(actorRole, role)) {
    throw new ForbiddenError(`El rol '${actorRole}' no puede invitar con rol '${role}'.`);
  }

  // Verificar si ya es miembro activo
  const members = await AccountRepo.listMembers(db, tenantId);
  const alreadyMember = members.some(m => m.email === email && m.is_active);
  if (alreadyMember) {
    throw new ConflictError(`${email} ya es miembro activo del workspace.`);
  }

  // Verificar si ya tiene invitación pendiente
  const hasPending = await AccountRepo.hasPendingInvitation(db, tenantId, email);
  if (hasPending) {
    throw new ConflictError(`Ya existe una invitación pendiente para ${email}.`);
  }

  // Generar token y su hash
  const token     = generateSecureToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const invitationId = await AccountRepo.createInvitation(db, tenantId, actorId, {
    email,
    role,
    tokenHash,
    expiresAt
  });

  // Retornamos el token crudo — el caller (ruta) lo incluye en el email
  // El token no se almacena en DB, solo su hash
  return { invitationId, email, role, token, expiresAt };
}

export async function getInvitations(db, tenantId, actorRole) {
  if (roleLevel(actorRole) < roleLevel('admin')) {
    throw new ForbiddenError('Se requiere rol admin u owner para ver las invitaciones.');
  }
  return AccountRepo.listInvitations(db, tenantId);
}

export async function cancelInvitation(db, tenantId, actorRole, invitationId) {
  if (roleLevel(actorRole) < roleLevel('admin')) {
    throw new ForbiddenError('Se requiere rol admin u owner para cancelar invitaciones.');
  }
  const cancelled = await AccountRepo.revokeInvitation(db, tenantId, invitationId);
  if (!cancelled) throw new NotFoundError('Invitación');
}

/**
 * Acepta una invitación por token (endpoint público — no requiere JWT).
 * Retorna los datos del workspace para que el frontend redirija al registro.
 */
export async function getInvitationByToken(db, token) {
  const tokenHash  = await hashToken(token);
  const invitation = await AccountRepo.findInvitationByToken(db, tokenHash);
  if (!invitation) {
    throw new NotFoundError('Invitación inválida, expirada o ya utilizada.');
  }
  return invitation;
}

export async function acceptInvitation(db, token) {
  const tokenHash  = await hashToken(token);
  const invitation = await AccountRepo.findInvitationByToken(db, tokenHash);
  if (!invitation) {
    throw new NotFoundError('Invitación inválida, expirada o ya utilizada.');
  }
  await AccountRepo.acceptInvitation(db, invitation.id);
  return invitation;
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────
// PBKDF2-SHA256 — misma configuración que el auth-module para compatibilidad.
// Formato: pbkdf2:100000:<salt_hex>:<hash_hex>

async function hashPbkdf2(password) {
  const salt       = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return `pbkdf2:100000:${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

async function verifyPbkdf2(password, stored) {
  const [, iterStr, saltHex, hashHex] = stored.split(':');
  const salt        = fromHex(saltHex);
  const iterations  = parseInt(iterStr, 10);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return toHex(new Uint8Array(bits)) === hashHex;
}

async function hashToken(token) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(bits));
}

function generateSecureToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

// ─── Validadores ─────────────────────────────────────────────────────────────

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

function isStrongPassword(pwd) {
  return pwd.length >= 8
    && /[A-Z]/.test(pwd)
    && /[a-z]/.test(pwd)
    && /[0-9]/.test(pwd)
    && /[!@#$%^&*(),.?":{}|<>]/.test(pwd);
}

// ─── Errores de dominio ───────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; }
}
export class ForbiddenError extends Error {
  constructor(msg) { super(msg); this.name = 'ForbiddenError'; }
}
export class NotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'NotFoundError'; }
}
export class ConflictError extends Error {
  constructor(msg) { super(msg); this.name = 'ConflictError'; }
}
export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; }
}
