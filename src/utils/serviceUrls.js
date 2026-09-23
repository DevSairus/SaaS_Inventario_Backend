// src/utils/serviceUrls.js
//
// Soporte para 2+ URLs de respaldo en variables de entorno tipo
// RUNT_SERVICE_URL / DIAN_SERVICE_URL, separadas por coma. El orden importa:
// se intenta cada una en el orden dado (ej. Raspberry Pi primero, PC de
// respaldo después) y se usa la primera que responda.

function parseServiceUrls(envValue) {
  if (!envValue) return [];
  return envValue.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * Intenta `attemptFn(url)` para cada URL en orden, devolviendo el primer
 * resultado exitoso. Si todas fallan, relanza el error de la última.
 */
async function callWithFailover(urls, attemptFn, logger) {
  let lastErr;
  for (const url of urls) {
    try {
      return await attemptFn(url);
    } catch (err) {
      lastErr = err;
      logger?.warn?.(`[Failover] ${url} falló: ${err.message}`);
    }
  }
  throw lastErr;
}

module.exports = { parseServiceUrls, callWithFailover };
