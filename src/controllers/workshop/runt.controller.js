// src/controllers/workshop/runt.controller.js
//
// Proxy hacia la API del RUNT.
// Si RUNT_SERVICE_URL está configurado, redirige a un servidor remoto (Raspberry Pi / VPS).
// Si no, intenta conexión directa (funciona en Vercel/localhost).

const axios  = require('axios');
const logger = require('../../config/logger');

const RUNT_BASE = 'https://runtproapi.runt.gov.co/CYRConsultaVehiculoMS';
const RUNT_SERVICE_URL = process.env.RUNT_SERVICE_URL;  // ej: http://tu-ip:4445
const RUNT_API_KEY     = process.env.RUNT_API_KEY || 'pitbox-runt-2026';

const runtHeaders = {
  'Content-Type': 'application/json',
  'Origin':       'https://portalpublico.runt.gov.co',
  'Referer':      'https://portalpublico.runt.gov.co/',
  'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

// Llama al servicio RUNT remoto (misma lógica que DIAN)
async function callRemoteRunt(path, body = null) {
  const url = `${RUNT_SERVICE_URL}${path}`;
  logger.info(`[RUNT Proxy] → ${url}`);

  const opts = {
    method: body ? 'POST' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': RUNT_API_KEY },
    timeout: 30000,
  };
  if (body) opts.body = JSON.stringify(body);

  const response = await fetch(url, opts);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`RUNT Service ${response.status}: ${err}`);
  }
  return response.json();
}

/* ─── GET /workshop/vehicles/runt/captcha ───────────────────────────────── */
const getCaptcha = async (req, res) => {
  try {
    let data;

    if (RUNT_SERVICE_URL) {
      // Via servicio remoto (Raspberry Pi / VPS)
      data = await callRemoteRunt('/api/runt/captcha');
    } else {
      // Conexión directa
      const response = await axios.get(
        `${RUNT_BASE}/captcha/libre-captcha/generar`,
        { headers: runtHeaders, timeout: 30000 }
      );
      data = response.data;
    }

    if (data.error || !data.id || !data.imagen) {
      return res.status(502).json({
        success: false,
        message: 'El RUNT no pudo generar el CAPTCHA. Intenta de nuevo.',
      });
    }

    return res.json({ success: true, id: data.id, imagen: data.imagen });

  } catch (err) {
    logger.error('RUNT getCaptcha error:', { message: err.message, code: err.code });
    return res.status(502).json({
      success: false,
      message: 'No se pudo conectar con el RUNT. Verifica tu conexión.',
    });
  }
};

/* ─── POST /workshop/vehicles/runt/consultar ────────────────────────────── */
const consultarVehiculo = async (req, res) => {
  try {
    const { placa, documento, tipoDocumento = 'C', captcha, idLibreCaptcha } = req.body;

    if (!placa)          return res.status(400).json({ success: false, message: 'La placa es requerida' });
    if (!documento)      return res.status(400).json({ success: false, message: 'El documento es requerido' });
    if (!captcha)        return res.status(400).json({ success: false, message: 'El captcha es requerido' });
    if (!idLibreCaptcha) return res.status(400).json({ success: false, message: 'ID de captcha inválido' });

    const placaUpper = placa.toUpperCase().trim();

    const payload = {
      procedencia: 'NACIONAL', tipoConsulta: '1',
      placa: placaUpper, tipoDocumento, documento,
      captcha: captcha.trim(), idLibreCaptcha,
      aseguradora: '', reCaptcha: null, rtm: null, soat: null, vin: null,
      valueCaptchaEncripted: '', verBannerSoat: true,
      configuracion: { tiempoInactividad: '900', tiempoCuentaRegresiva: '10' },
    };

    let data;
    let sessionCookie = null;

    if (RUNT_SERVICE_URL) {
      // Via servicio remoto
      data = await callRemoteRunt('/api/runt/auth', payload);
    } else {
      // Conexión directa
      const response = await axios.post(`${RUNT_BASE}/auth`, payload, {
        headers: runtHeaders, timeout: 30000
      });
      data = response.data;
      const setCookieHeader = response.headers['set-cookie'];
      sessionCookie = Array.isArray(setCookieHeader)
        ? setCookieHeader.map(c => c.split(';')[0]).join('; ')
        : (setCookieHeader ? setCookieHeader.split(';')[0] : null);
    }

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
        success: false, message: 'El RUNT no encontró información para esta placa y documento.',
      });
    }

    const sessionToken = data.token;

    // Peticiones secundarias: SOAT y RTM
    let soatData = [], rtmData = [];

    if (sessionToken) {
      const secondaryHeaders = {
        ...runtHeaders,
        'auth-token': `Bearer ${sessionToken}`,
        'x-funcionalidad': 'SHELL',
      };

      // SOAT
      try {
        let soatRes;
        if (RUNT_SERVICE_URL) {
          soatRes = { data: await callRemoteRunt('/api/runt/soat', { extraHeaders: secondaryHeaders }) };
        } else {
          soatRes = await axios.get(`${RUNT_BASE}/soat`, { headers: secondaryHeaders, timeout: 10000 });
        }
        soatData = Array.isArray(soatRes.data) ? soatRes.data
                 : Array.isArray(soatRes.data?.soat) ? soatRes.data.soat : [];
      } catch (e) {
        logger.warn('RUNT SOAT falló: ' + e.message);
      }

      // RTM
      try {
        let rtmRes;
        if (RUNT_SERVICE_URL) {
          rtmRes = { data: await callRemoteRunt('/api/runt/rtms', { extraHeaders: secondaryHeaders, params: { tipo: 'N' } }) };
        } else {
          rtmRes = await axios.get(`${RUNT_BASE}/rtms`, {
            headers: secondaryHeaders, params: { tipo: 'N' }, timeout: 10000
          });
        }
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

    const VEHICLE_TYPE_MAP = {
      AUTOMOVIL: 'automovil',
      CAMIONETA: 'camioneta',
      CAMPERO: 'camioneta',
      PICKUP: 'camioneta',
      MOTOCICLETA: 'motocicleta',
      MOTOCICLO: 'motocicleta',
      CARGA: 'camion',
      CAMION: 'camion',
      BUS: 'camion',
      BUSETA: 'camion',
      MICROBUS: 'camion',
      REMOLQUE: 'camion',
      SEMIRREMOLQUE: 'camion',
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
      vehicle_type: VEHICLE_TYPE_MAP[v.clase?.toUpperCase()] || 'automovil',
      soat_number, soat_expiry, tecnomecanica_number, tecnomecanica_expiry,
      _runt: {
        clase: v.clase, tipoCarroceria: v.tipoCarroceria, cilindraje: v.cilindraje,
        numChasis: v.numChasis, numSerie: v.numSerie, estadoAutomotor: v.estadoAutomotor,
        organismoTransito: v.organismoTransito, gravamenes: v.gravamenes,
        prendas: v.prendas, numLicencia: v.numLicencia, tipoServicio: v.tipoServicio,
      },
    };

    return res.json({ success: true, data: vehiculo });

  } catch (err) {
    if (err.response) {
      const body = err.response.data;
      const runtMsg = body?.descripcionRespuesta || body?.message || body?.error || 'CAPTCHA incorrecto o sesión expirada.';
      return res.status(422).json({ success: false, message: `${runtMsg} Solicita un nuevo CAPTCHA.`, runtError: true });
    }
    logger.error('RUNT consultarVehiculo error:', err.message);
    return res.status(502).json({ success: false, message: 'No se pudo conectar con el RUNT.', runtError: true });
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
