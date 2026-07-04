// src/controllers/workshop/runt.controller.js
//
// Proxy seguro hacia la API del RUNT (runtproapi.runt.gov.co).
// Si RUNT_PROXY_URL está configurado, redirige las peticiones a través de un proxy local (ngrok).
// La foto/imagen del CAPTCHA nunca se almacena — se retransmite en memoria.

const axios  = require('axios');
const logger = require('../../config/logger');

const RUNT_BASE = 'https://runtproapi.runt.gov.co/CYRConsultaVehiculoMS';
const PROXY_URL = process.env.RUNT_PROXY_URL;  // ej: https://abc123.ngrok.io
const PROXY_TOKEN = process.env.RUNT_PROXY_TOKEN || 'pitrunt2026';

const runtHeaders = {
  'Content-Type': 'application/json',
  'Origin':       'https://portalpublico.runt.gov.co',
  'Referer':      'https://portalpublico.runt.gov.co/',
  'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

// Si hay proxy, las peticiones van al proxy local en vez de al RUNT directo
function getUrl(path) {
  return PROXY_URL ? `${PROXY_URL}${path}` : `${RUNT_BASE}${path}`;
}

function getRequestHeaders(extra = {}) {
  const headers = { ...runtHeaders, ...extra };
  if (PROXY_URL) headers['x-proxy-token'] = PROXY_TOKEN;
  return headers;
}

/* ─── GET /workshop/vehicles/runt/captcha ───────────────────────────────── */
const getCaptcha = async (req, res) => {
  try {
    const url = PROXY_URL ? `${PROXY_URL}/captcha` : `${RUNT_BASE}/captcha/libre-captcha/generar`;
    const response = await axios.get(url, {
      headers: getRequestHeaders(),
      timeout: 30000
    });

    const { id, imagen, error } = response.data;

    if (error || !id || !imagen) {
      return res.status(502).json({
        success: false,
        message: 'El RUNT no pudo generar el CAPTCHA. Intenta de nuevo.',
      });
    }

    return res.json({ success: true, id, imagen });

  } catch (err) {
    logger.error('RUNT getCaptcha error:', {
      message: err.message,
      code: err.code,
      status: err.response?.status,
    });
    return res.status(502).json({
      success: false,
      message: 'No se pudo conectar con el RUNT. Verifica tu conexión.',
    });
  }
};

/* ─── POST /workshop/vehicles/runt/consultar ────────────────────────────── */
const consultarVehiculo = async (req, res) => {
  try {
    const {
      placa, documento,
      tipoDocumento = 'C',
      captcha, idLibreCaptcha,
    } = req.body;

    if (!placa)           return res.status(400).json({ success: false, message: 'La placa es requerida' });
    if (!documento)       return res.status(400).json({ success: false, message: 'El documento es requerido' });
    if (!captcha)         return res.status(400).json({ success: false, message: 'El captcha es requerido' });
    if (!idLibreCaptcha)  return res.status(400).json({ success: false, message: 'ID de captcha inválido' });

    const placaUpper = placa.toUpperCase().trim();

    const payload = {
      procedencia: 'NACIONAL', tipoConsulta: '1',
      placa: placaUpper, tipoDocumento, documento,
      captcha: captcha.trim(), idLibreCaptcha,
      aseguradora: '', reCaptcha: null, rtm: null, soat: null, vin: null,
      valueCaptchaEncripted: '', verBannerSoat: true,
      configuracion: { tiempoInactividad: '900', tiempoCuentaRegresiva: '10' },
    };

    const authUrl = PROXY_URL ? `${PROXY_URL}/auth` : `${RUNT_BASE}/auth`;
    const response = await axios.post(authUrl, payload, {
      headers: getRequestHeaders(),
      timeout: 30000
    });

    const setCookieHeader = response.headers['set-cookie'];
    const sessionCookie = Array.isArray(setCookieHeader)
      ? setCookieHeader.map(c => c.split(';')[0]).join('; ')
      : (setCookieHeader ? setCookieHeader.split(';')[0] : null);

    const data = response.data;

    if (data.error) {
      return res.status(422).json({
        success: false,
        message: data.descripcionRespuesta || 'CAPTCHA incorrecto o datos inválidos.',
        runtError: true,
      });
    }

    const v = data.infoVehiculo;
    if (!v) {
      return res.status(404).json({
        success: false,
        message: 'El RUNT no encontró información para esta placa y documento.',
      });
    }

    const sessionToken = data.token;

    // Peticiones secundarias: SOAT y RTM
    let soatData = [], rtmData = [];

    if (sessionToken) {
      const secondaryHeaders = getRequestHeaders({
        'auth-token': `Bearer ${sessionToken}`,
        'x-funcionalidad': 'SHELL',
      });

      // SOAT
      try {
        const soatUrl = PROXY_URL ? `${PROXY_URL}/soat` : `${RUNT_BASE}/soat`;
        const soatRes = await axios.get(soatUrl, { headers: secondaryHeaders, timeout: 10000 });
        soatData = Array.isArray(soatRes.data) ? soatRes.data
                 : Array.isArray(soatRes.data?.soat) ? soatRes.data.soat : [];
      } catch (e) {
        logger.warn('RUNT SOAT falló: ' + e.message);
      }

      // RTM
      try {
        const rtmUrl = PROXY_URL ? `${PROXY_URL}/rtms` : `${RUNT_BASE}/rtms`;
        const rtmRes = await axios.get(rtmUrl, {
          headers: secondaryHeaders,
          params: PROXY_URL ? { tipo: 'N' } : { tipo: 'N' },
          timeout: 10000
        });
        rtmData = Array.isArray(rtmRes.data) ? rtmRes.data
                : Array.isArray(rtmRes.data?.revisiones) ? rtmRes.data.revisiones : [];
      } catch (e) {
        logger.warn('RUNT RTM falló: ' + e.message);
      }
    }

    const FUEL_MAP = {
      GASOLINA: 'gasolina', GAS: 'gas', ACPM: 'diesel',
      DIESEL: 'diesel', ELECTRICO: 'electrico', HIBRIDO: 'hibrido',
    };

    let soat_number = null, soat_expiry = null;
    if (soatData.length > 0) {
      const vigente = soatData.find(s => s.estado === 'VIGENTE') || soatData[0];
      soat_number = vigente.numSoat || null;
      soat_expiry = parseRuntDate(vigente.fechaVencimSoat || null);
    }

    let tecnomecanica_number = null, tecnomecanica_expiry = null;
    if (rtmData.length > 0) {
      const vigente = rtmData.find(r => r.vigente === 'SI') || rtmData[0];
      tecnomecanica_number = vigente.numeCerti || null;
      tecnomecanica_expiry = parseRuntDate(vigente.fechaVencimientoRvt || null);
    }

    const vehiculo = {
      plate: v.placa, brand: toTitle(v.marca), model: toTitle(v.linea),
      year: v.modelo ? parseInt(v.modelo) : null, color: toTitle(v.color),
      vin: v.vin || v.numSerie || null, engine_number: v.numMotor || null,
      fuel_type: FUEL_MAP[v.tipoCombustible?.toUpperCase()] || 'gasolina',
      soat_number, soat_expiry,
      tecnomecanica_number, tecnomecanica_expiry,
      _runt: {
        clase: v.clase, tipoCarroceria: v.tipoCarroceria,
        cilindraje: v.cilindraje, numChasis: v.numChasis,
        numSerie: v.numSerie, estadoAutomotor: v.estadoAutomotor,
        organismoTransito: v.organismoTransito, gravamenes: v.gravamenes,
        prendas: v.prendas, numLicencia: v.numLicencia, tipoServicio: v.tipoServicio,
      },
    };

    return res.json({ success: true, data: vehiculo });

  } catch (err) {
    if (err.response) {
      const body = err.response.data;
      const runtMsg = body?.descripcionRespuesta || body?.message || body?.error
        || 'CAPTCHA incorrecto o sesión expirada.';
      return res.status(422).json({
        success: false, message: `${runtMsg} Solicita un nuevo CAPTCHA.`, runtError: true,
      });
    }
    logger.error('RUNT consultarVehiculo error:', err.message);
    return res.status(502).json({
      success: false, message: 'No se pudo conectar con el RUNT.', runtError: true,
    });
  }
};

function parseRuntDate(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const m = str.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function toTitle(str) {
  if (!str) return null;
  return str.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

module.exports = { getCaptcha, consultarVehiculo };
