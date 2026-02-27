/**
 * src/app/middleware/auth.js
 * Verifica el JWT emitido por el auth-module.
 *
 * Reutiliza el mismo algoritmo HS256 que auth-module/crypto/jwt.js
 * pero implementado aquí de forma independiente con Web Crypto API,
 * evitando acoplamiento de imports al core del módulo de auth.
 *
 * Si la verificación es exitosa retorna { userId, tenantId, role }.
 * Si falla retorna una Response 401 lista para devolver al cliente.
 */

import { unauthorized } from '../helpers/response.js';

/**
 * @param {Request} request
 * @param {object}  env     — Necesita env.JWT_SECRET y env.ALLOWED_ORIGINS
 * @returns {Promise<{ userId, tenantId, role } | Response>}
 */
export async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization') ?? '';

  if (!authHeader.startsWith('Bearer ')) {
    return unauthorized('Token no provisto o formato inválido.', env.ALLOWED_ORIGINS);
  }

  const token = authHeader.slice(7).trim();

  let payload;
  try {
    payload = await verifyJWT(token, env.JWT_SECRET);
  } catch (err) {
    return unauthorized(err.message, env.ALLOWED_ORIGINS);
  }

  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    return unauthorized('Token expirado.', env.ALLOWED_ORIGINS);
  }

  // El auth-module usa nombres de claims propios (no el estándar RFC 7519).
  // Según su documentación, /verify retorna { id, email, role, tenantId },
  // lo que indica que el JWT emite 'userId' en lugar de 'sub'.
  // Soportamos todas las variantes conocidas para máxima compatibilidad.
  const userId   = payload.sub ?? payload.userId ?? payload.user_id ?? payload.id;
  const tenantId = payload.tenantId ?? payload.tenant_id;

  if (!userId || !tenantId) {
    return unauthorized('Token con claims incompletos.', env.ALLOWED_ORIGINS);
  }

  return {
    userId,
    tenantId,
    role: payload.role ?? 'member'
  };
}

// ─── Verificación HS256 con Web Crypto API ────────────────────────────────────

async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Formato de token inválido.');

  const [headerB64, payloadB64, signatureB64] = parts;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64urlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );

  if (!valid) throw new Error('Firma de token inválida.');

  return JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
}

function base64urlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded  = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  const binary  = atob(padded);
  const bytes   = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
