/**
 * CORS Middleware
 */

export class CorsMiddleware {
  constructor(options = {}) {
    this.allowedOrigins = options.allowedOrigins || ['*'];
    this.allowedMethods = options.allowedMethods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
    this.allowedHeaders = options.allowedHeaders || ['Content-Type', 'Authorization'];
    this.exposedHeaders = options.exposedHeaders || ['Authorization'];
    this.maxAge = options.maxAge || 86400;
  }

  getHeaders(origin = '*') {
    const headers = {
      'Access-Control-Allow-Methods': this.allowedMethods.join(', '),
      'Access-Control-Allow-Headers': this.allowedHeaders.join(', '),
      'Access-Control-Expose-Headers': this.exposedHeaders.join(', '),
      'Access-Control-Max-Age': this.maxAge.toString()
    };

    if (this.allowedOrigins.includes('*')) {
      headers['Access-Control-Allow-Origin'] = '*';
    } else if (this.allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }

    return headers;
  }

  handlePreflight(request) {
    const origin = request.headers.get('Origin') || '*';
    return new Response(null, {
      status: 204,
      headers: this.getHeaders(origin)
    });
  }

  addHeaders(response, request) {
    const origin = request.headers.get('Origin') || '*';
    const corsHeaders = this.getHeaders(origin);
    
    const headers = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      headers.set(key, value);
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
}
