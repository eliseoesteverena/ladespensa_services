/**
 * src/app/helpers/id.js
 * Generación de IDs con Web Crypto API nativa de Cloudflare Workers.
 */

export function generateId() {
  return crypto.randomUUID();
}
