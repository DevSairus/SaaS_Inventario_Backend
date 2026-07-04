// src/controllers/workshop/runt.controller.js
//
// Proxy seguro hacia la API del RUNT (runtproapi.runt.gov.co).
// La foto/imagen del CAPTCHA nunca se almacena — se retransmite en memoria.
// El documento del propietario nunca se guarda en BD.

const axios  = require('axios');
const logger = require('../../config/logger');

const RUNT_BASE = 'https://runtproapi.runt.gov.co/CYRConsultaVehiculoMS';

// Headers que espera la API del RUNT
const runtHeaders = {
  'Content-Type': 'application/json',
  'Origin':       'https://portalpublico.runt.gov.co',
  'Referer':      'https://portalpublico.runt.gov.co/',
  'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

/* ─── GET /workshop/vehicles/runt/captcha ─────────────────────────────────
   Obtiene un nuevo CAPTCHA del RUNT.
   Respuesta: { id: string, imagen: "data:image/png;base64,..." }
   La imagen viene lista para usar en un <img src="..."> sin procesamiento.
   NUNCA se persiste en ningún lado.
──────────────────────────────────────────────────────────────────────────── */
const getCaptcha = async (req, res) => {
  try {
    const response = await axios.get(
      `${RUNT_BASE}/captcha/libre-captcha/generar`,
      { headers: runtHeaders, timeout: 30000 }
    );

    const { id, imagen, error } = response.data;

    if (error || !id || !imagen) {
      return res.status(502).json({
        success: false,
        message: 'El RUNT no pudo generar el CAPTCHA. Intenta de nuevo.',
      });
    }

    // Solo retransmitimos id e imagen — nada se guarda
    return res.json({ success: true, id, imagen });

  } catch (err) {
    logger.error('RUNT getCaptcha error:', {
      message: err.message,
      code: err.code,
      status: err.response?.status,
      data: JSON.stringify(err.response?.data || '').slice(0, 200),
    });
    return res.status(502).json({
      success: false,
      message: 'No se pudo conectar con el RUNT. Verifica tu conexión.',
    });
  }
};

/* ─── POST /workshop/vehicles/runt/consultar ──────────────────────────────
   Body: { placa, documento, tipoDocumento?, captcha, idLibreCaptcha }
   Respuesta: datos del vehículo mapeados a los campos del sistema.
   El documento del propietario NO se guarda — solo se usa para la consulta.
──────────────────────────────────────────────────────────────────────────── */
const consultarVehiculo = async (req, res) => {
  try {
    const {
      placa,
      documento,
      tipoDocumento = 'C',   // C = Cédula (default)
      captcha,
      idLibreCaptcha,
    } = req.body;

    // Validaciones básicas
    if (!placa)           return res.status(400).json({ success: false, message: 'La placa es requerida' });
    if (!documento)       return res.status(400).json({ success: false, message: 'El documento es requerido' });
    if (!captcha)         return res.status(400).json({ success: false, message: 'El captcha es requerido' });
    if (!idLibreCaptcha)  return res.status(400).json({ success: false, message: 'ID de captcha inválido' });

    const placaUpper = placa.toUpperCase().trim();

    // Payload exacto que espera el RUNT
    const payload = {
      procedencia:           'NACIONAL',
      tipoConsulta:          '1',
      placa:                 placaUpper,
      tipoDocumento,
      documento,
      captcha:               captcha.trim(),
      idLibreCaptcha,
      aseguradora:           '',
      reCaptcha:             null,
      rtm:                   null,
      soat:                  null,
      vin:                   null,
      valueCaptchaEncripted: '',
      verBannerSoat:         true,
      configuracion: {
        tiempoInactividad:     '900',
        tiempoCuentaRegresiva: '10',
      },
    };

    const response = await axios.post(
      `${RUNT_BASE}/auth`,
      payload,
      { headers: runtHeaders, timeout: 30000 }
    );

    // Capturar cookies de sesión que el RUNT establece en /auth
    // (los endpoints secundarios /soat y /rtms las requieren junto con el JWT)
    const setCookieHeader = response.headers['set-cookie'];
    const sessionCookie   = Array.isArray(setCookieHeader)
      ? setCookieHeader.map(c => c.split(';')[0]).join('; ')
      : (setCookieHeader ? setCookieHeader.split(';')[0] : null);

    logger.info('RUNT auth headers: ' + JSON.stringify({
      'set-cookie':    setCookieHeader || '(ninguna)',
      'content-type':  response.headers['content-type'],
    }));

    const data = response.data;

    // CAPTCHA incorrecto u otro error del RUNT
    if (data.error) {
      return res.status(422).json({
        success:  false,
        message:  data.descripcionRespuesta || 'CAPTCHA incorrecto o datos inválidos. Intenta de nuevo.',
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

    // El RUNT devuelve un token de sesión para hacer consultas secundarias
    const sessionToken = data.token;
    logger.info('RUNT token tipo: ' + typeof sessionToken + ' | inicio: ' + String(sessionToken).slice(0, 60));

    // ── Peticiones secundarias: SOAT y RTM ─────────────────────────────
    // El portal del RUNT hace estas llamadas por separado usando el token de /auth.
    // Son opcionales: si fallan, continuamos con los datos del vehículo.
    let soatData     = [];
    let rtmData      = [];

    if (sessionToken) {
      // El RUNT usa 'auth-token' (no Authorization) y requiere x-funcionalidad: SHELL
      const secondaryHeaders = {
        ...runtHeaders,
        'auth-token':      `Bearer ${sessionToken}`,
        'x-funcionalidad': 'SHELL',
      };

      // SOAT
      try {
        const soatRes = await axios.get(
          `${RUNT_BASE}/soat`,
          { headers: secondaryHeaders, timeout: 10000 }
        );
        soatData = Array.isArray(soatRes.data) ? soatRes.data
                 : Array.isArray(soatRes.data?.soat) ? soatRes.data.soat
                 : [];
      } catch (e) {
        logger.warn('RUNT SOAT secundario falló: ' + e.message);
      }

      // RTM
      try {
        const rtmRes = await axios.get(
          `${RUNT_BASE}/rtms`,
          { headers: secondaryHeaders, params: { tipo: 'N' }, timeout: 10000 }
        );
        // El RUNT puede devolver { revisiones: [...] } o directamente el array
        rtmData = Array.isArray(rtmRes.data) ? rtmRes.data
                : Array.isArray(rtmRes.data?.revisiones) ? rtmRes.data.revisiones
                : [];
      } catch (e) {
        logger.warn('RUNT RTM secundario falló: ' + e.message);
      }
    }

    // Mapeamos al modelo de vehículo del sistema
    const FUEL_MAP = {
      GASOLINA: 'gasolina',
      GAS:      'gas',
      ACPM:     'diesel',
      DIESEL:   'diesel',
      ELECTRICO:'electrico',
      HIBRIDO:  'hibrido',
    };

    // ── SOAT: viene de la llamada secundaria a /soat ────────────────────
    //   Campos: numSoat, fechaVencimSoat, estado ("VIGENTE"/"NO VIGENTE")
    //   Prioridad: registro con estado VIGENTE; si no, el primero (más reciente).
    let soat_number = null;
    let soat_expiry = null;
    if (soatData.length > 0) {
      const vigente = soatData.find(s => s.estado === 'VIGENTE') || soatData[0];
      soat_number   = vigente.numSoat || null;
      soat_expiry   = parseRuntDate(vigente.fechaVencimSoat || null);
    }

    // ── RTM: viene de la llamada secundaria a /rtms ──────────────────────
    //   Campos: numeCerti, fechaVencimientoRvt, vigente ("SI"/"NO")
    //   Prioridad: registro con vigente === "SI"; si no, el primero (más reciente).
    let tecnomecanica_number = null;
    let tecnomecanica_expiry = null;
    if (rtmData.length > 0) {
      const vigente = rtmData.find(r => r.vigente === 'SI') || rtmData[0];
      tecnomecanica_number = vigente.numeCerti || null;
      tecnomecanica_expiry = parseRuntDate(vigente.fechaVencimientoRvt || null);
    }

    const vehiculo = {
      plate:                 v.placa,
      brand:                 toTitle(v.marca),
      model:                 toTitle(v.linea),
      year:                  v.modelo ? parseInt(v.modelo) : null,
      color:                 toTitle(v.color),
      vin:                   v.vin           || v.numSerie || null,
      engine_number:         v.numMotor      || null,
      fuel_type:             FUEL_MAP[v.tipoCombustible?.toUpperCase()] || 'gasolina',
      // SOAT (último emitido)
      soat_number,
      soat_expiry,
      // Tecnomecánica (última emitida)
      tecnomecanica_number,
      tecnomecanica_expiry,
      // Datos informativos adicionales
      _runt: {
        clase:              v.clase,
        tipoCarroceria:     v.tipoCarroceria,
        cilindraje:         v.cilindraje,
        numChasis:          v.numChasis,
        numSerie:           v.numSerie,
        estadoAutomotor:    v.estadoAutomotor,
        organismoTransito:  v.organismoTransito,
        gravamenes:         v.gravamenes,
        prendas:            v.prendas,
        numLicencia:        v.numLicencia,
        tipoServicio:       v.tipoServicio,
      },
    };

    // El documento del propietario NO se incluye en la respuesta ni se guarda
    return res.json({ success: true, data: vehiculo });

  } catch (err) {
    // Cualquier respuesta HTTP del RUNT (4xx/5xx) implica captcha consumido
    if (err.response) {
      const status = err.response.status;
      const body   = err.response.data;
      logger.error(`RUNT consultarVehiculo HTTP ${status}:`, JSON.stringify(body));

      const runtMsg = body?.descripcionRespuesta || body?.message || body?.error
        || 'CAPTCHA incorrecto o sesión expirada.';

      return res.status(422).json({
        success:   false,
        message:   `${runtMsg} Solicita un nuevo CAPTCHA e intenta de nuevo.`,
        runtError: true,
      });
    }

    // Error de red / timeout
    logger.error('RUNT consultarVehiculo error:', err.message);
    return res.status(502).json({
      success:   false,
      message:   'No se pudo conectar con el RUNT. Verifica tu conexión e intenta de nuevo.',
      runtError: true,
    });
  }
};

// Helper: fecha RUNT → "YYYY-MM-DD" (Postgres DATEONLY)
// El RUNT devuelve timestamps con offset: "2026-09-19T00:00:00.000-05:00"
// Se extrae solo la parte YYYY-MM-DD del string SIN convertir timezone,
// porque la fecha ya viene correcta en la zona horaria colombiana.
function parseRuntDate(str) {
  if (!str) return null;
  // ISO con timezone: tomar los primeros 10 chars directamente (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  // Formato DD/MM/YYYY o DD-MM-YYYY
  const m = str.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// Helper: "AZUL PETROLEO" → "Azul Petroleo"
function toTitle(str) {
  if (!str) return null;
  return str
    .toLowerCase()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

module.exports = { getCaptcha, consultarVehiculo };