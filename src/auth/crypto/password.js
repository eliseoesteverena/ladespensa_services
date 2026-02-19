/**
 * Password Hashing Module
 * Compatible con Cloudflare Workers - sin CLI, sin bundler
 *
 * OPCIÓN A (recomendada): Web Crypto API nativa — cero dependencias
 * OPCIÓN B: bcryptjs via CDN ESM — drop-in bcrypt compatible
 *
 * Para cambiar de opción, ver comentarios en PasswordService constructor
 */

// ─── OPCIÓN B: bcryptjs desde jsDelivr (ESM, compatible Workers) ──────────────
// Descomentar si preferís bcrypt real. jsDelivr sirve ESM sin bundler.
// import bcrypt from 'https://cdn.jsdelivr.net/npm/bcryptjs@2.4.3/+esm';


// ─── OPCIÓN A: PBKDF2 via Web Crypto API ──────────────────────────────────────
// Nativa en Cloudflare Workers. Sin imports, sin CDN, sin bundler.
// PBKDF2-SHA256 con 600_000 iteraciones (recomendación OWASP 2024)
// Formato de hash: pbkdf2$iterations$salt(hex)$hash(hex)

const PBKDF2_ITERATIONS = 100_000; // Cloudflare Workers límite máximo soportado
const PBKDF2_HASH       = 'SHA-256';
const SALT_BYTES        = 16;

async function pbkdf2Hash(password) {
  const enc      = new TextEncoder();
  const salt     = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMat   = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits     = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: PBKDF2_HASH, salt, iterations: PBKDF2_ITERATIONS },
    keyMat, 256
  );
  const hashHex  = bufToHex(new Uint8Array(bits));
  const saltHex  = bufToHex(salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${saltHex}$${hashHex}`;
}

async function pbkdf2Verify(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const [, iterStr, saltHex, expectedHex] = parts;
  const iterations = parseInt(iterStr, 10);
  const salt       = hexToBuf(saltHex);
  const enc        = new TextEncoder();

  const keyMat = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: PBKDF2_HASH, salt, iterations },
    keyMat, 256
  );
  const actualHex = bufToHex(new Uint8Array(bits));

  // Comparación en tiempo constante (evita timing attacks)
  return timingSafeEqual(actualHex, expectedHex);
}

function bufToHex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
// ──────────────────────────────────────────────────────────────────────────────


export class PasswordService {
  /**
   * @param {object} options
   * @param {number} [options.saltRounds=12]   - Solo usado con bcryptjs (Opción B)
   * @param {'pbkdf2'|'bcrypt'} [options.mode] - 'pbkdf2' (default) | 'bcrypt'
   */
  constructor(options = {}) {
    this.saltRounds = options.saltRounds || 12;
    // Cambiá a 'bcrypt' si descomentaste el import de bcryptjs arriba
    this.mode = options.mode || 'pbkdf2';
  }

  /**
   * Hashea una contraseña
   * @param {string} password
   * @returns {Promise<string>} hash almacenable
   */
  async hash(password) {
    if (!password || password.length < 1) {
      throw new Error('La contraseña no puede estar vacía');
    }

    // bcrypt tiene límite de 72 bytes por diseño
    const pwd = this.mode === 'bcrypt' ? password.slice(0, 72) : password;

    if (this.mode === 'bcrypt') {
      // ── Opción B ──
      // Requiere descomentar el import de bcryptjs al inicio del archivo
      if (typeof bcrypt === 'undefined') {
        throw new Error(
          'bcryptjs no está importado. Descomentar el import CDN al inicio del archivo.'
        );
      }
      return await bcrypt.hash(pwd, this.saltRounds);
    }

    // ── Opción A (default) ──
    return await pbkdf2Hash(pwd);
  }

  /**
   * Verifica una contraseña contra su hash
   * @param {string} password
   * @param {string} hash
   * @returns {Promise<boolean>}
   */
  async verify(password, hash) {
    if (!password || !hash) return false;

    if (this._isBcryptHash(hash)) {
      if (typeof bcrypt === 'undefined') {
        throw new Error(
          'Hash bcrypt detectado pero bcryptjs no está importado. Descomentar el import CDN.'
        );
      }
      return await bcrypt.compare(password, hash);
    }

    if (this._isPbkdf2Hash(hash)) {
      return await pbkdf2Verify(password, hash);
    }

    return false; // formato desconocido
  }

  // ── Helpers de detección ────────────────────────────────────────────────────

  _isBcryptHash(hash) {
    return typeof hash === 'string' && (
      hash.startsWith('$2a$') ||
      hash.startsWith('$2b$') ||
      hash.startsWith('$2y$')
    );
  }

  _isPbkdf2Hash(hash) {
    return typeof hash === 'string' && hash.startsWith('pbkdf2$');
  }
}