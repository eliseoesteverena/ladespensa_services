/**
 * src/app/helpers/response.js
 * Respuestas HTTP estandarizadas.
 *
 * Envelope:
 *   { success: true,  data: {...} }
 *   { success: false, error: { code, message, details? } }
 *
 * Los headers CORS leen ALLOWED_ORIGINS del env cuando está disponible.
 * En los helpers que no reciben env se usa '*' como fallback seguro
 * para desarrollo — en producción ALLOWED_ORIGINS siempre estará seteado.
 */

// ─── Éxito ────────────────────────────────────────────────────────────────────

export function ok(data, origins) {
  return json({ success: true, data }, 200, origins);
}

export function created(data, origins) {
  return json({ success: true, data }, 201, origins);
}

export function noContent(origins) {
  return new Response(null, { status: 204, headers: corsHeaders(origins) });
}

// ─── Error ────────────────────────────────────────────────────────────────────

export function badRequest(message, details, origins) {
  return error('BAD_REQUEST', message, details, 400, origins);
}

export function unauthorized(message = 'No autenticado.', origins) {
  return error('UNAUTHORIZED', message, null, 401, origins);
}

export function forbidden(message = 'Sin permisos para esta acción.', origins) {
  return error('FORBIDDEN', message, null, 403, origins);
}

export function notFound(resource = 'Recurso', origins) {
  return error('NOT_FOUND', `${resource} no encontrado.`, null, 404, origins);
}

export function conflict(message, details, origins) {
  return error('CONFLICT', message, details, 409, origins);
}

export function unprocessable(message, details, origins) {
  return error('UNPROCESSABLE', message, details, 422, origins);
}

export function serverError(message = 'Error interno del servidor.', details, origins) {
  return error('INTERNAL_ERROR', message, details, 500, origins);
}

export function badGateway(message, details, origins) {
  return error('BAD_GATEWAY', message, details, 502, origins);
}

// ─── CORS preflight ───────────────────────────────────────────────────────────

export function corsPreflightResponse(origins) {
  return new Response(null, { status: 204, headers: corsHeaders(origins) });
}

// ─── Internals ────────────────────────────────────────────────────────────────

function json(body, status, origins) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...corsHeaders(origins)
    }
  });
}

function error(code, message, details, status, origins) {
  const body = { success: false, error: { code, message } };
  if (details != null) body.error.details = details;
  return json(body, status, origins);
}

export function corsHeaders(origins) {
  return {
    'Access-Control-Allow-Origin':  origins ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}
