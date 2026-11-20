// src/utils/publicBaseUrl.js
//
// URL absoluta del backend para armar enlaces públicos (PDF compartido,
// archivos subidos, media de WhatsApp).
//
// BACKEND_URL a veces se configura sin protocolo
// ("saasinventariobackend-production.up.railway.app"). Un href así es
// RELATIVO: el navegador lo pega detrás de la ruta actual
// (/documento/saasinventario.../api/public/pdf/...) y la SPA cae al
// dashboard. Por eso se normaliza siempre: protocolo, sin "/" ni "/api" final.

function normalizeBaseUrl(raw) {
  let url = String(raw || '').split(',')[0].trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
    url = `${isLocal ? 'http' : 'https'}://${url}`;
  }
  return url.replace(/\/+$/, '').replace(/\/api$/i, '');
}

/** BACKEND_URL normalizada; si falta, se reconstruye del request o localhost. */
function backendBaseUrl(req) {
  const fromEnv = normalizeBaseUrl(process.env.BACKEND_URL);
  if (fromEnv) return fromEnv;
  if (req && typeof req.get === 'function' && req.get('host')) {
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    return normalizeBaseUrl(`${proto}://${req.get('host')}`);
  }
  return `http://localhost:${process.env.PORT || 5001}`;
}

module.exports = { normalizeBaseUrl, backendBaseUrl };
