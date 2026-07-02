/**
 * Proxy colombiano para llamadas a DIAN
 * Configurar DIAN_PROXY_URL en variables de entorno
 * Ejemplo: socks5://user:pass@proxy-colombia.com:1080
 * O usar un servicio como brightdata, smartproxy, etc.
 */

let _originalFetch = null;

function setupDianProxy() {
  const proxyUrl = process.env.DIAN_PROXY_URL;
  if (!proxyUrl) return;

  const { HttpsProxyAgent } = require('https-proxy-agent');
  const https = require('https');
  const http = require('http');

  const agent = new HttpsProxyAgent(proxyUrl);

  // Guardar fetch original
  if (!_originalFetch) {
    _originalFetch = globalThis.fetch;
  }

  // Monkey-patch fetch para usar proxy solo en llamadas a DIAN
  globalThis.fetch = async function(url, options = {}) {
    const urlStr = typeof url === 'string' ? url : url.toString();
    
    // Solo aplicar proxy a llamadas a DIAN
    if (urlStr.includes('vpfe-hab.dian.gov.co') || urlStr.includes('vpfe.dian.gov.co')) {
      options.agent = agent;
      // Node.js fetch necesita dispatcher para undici
      if (globalThis[Symbol.for('undici.globalDispatcher.1')]) {
        // undici-based fetch
        const { ProxyAgent } = require('undici');
        const proxyAgent = new ProxyAgent(proxyUrl);
        options.dispatcher = proxyAgent;
      }
    }
    
    return _originalFetch.call(this, url, options);
  };

  console.log(`[DIAN Proxy] Configurado: ${proxyUrl.substring(0, 20)}...`);
}

module.exports = { setupDianProxy };
