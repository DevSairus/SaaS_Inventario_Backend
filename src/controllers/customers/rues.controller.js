// src/controllers/customers/rues.controller.js
//
// Proxy hacia el portal RUES (Registro Único Empresarial y Social - Confecámaras).
// Consulta empresas por NIT — sin CAPTCHA, respuesta JSON.
// Solo aplica para personas jurídicas (NIT). Para personas naturales
// se muestra un mensaje claro al frontend.

const axios  = require('axios');
const logger = require('../../config/logger');

const RUES_BASE = 'https://www.rues.org.co';

const ruesHeaders = {
  'Accept':          'application/json, text/javascript, */*; q=0.01',
  'Content-Type':    'application/x-www-form-urlencoded; charset=UTF-8',
  'Origin':          'https://www.rues.org.co',
  'Referer':         'https://www.rues.org.co/RM',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
};

/* ─── GET /api/customers/rues/:nit ──────────────────────────────────────────
   Consulta una empresa por NIT en RUES.
   El NIT puede venir con o sin DV (ej: "900072256" o "900072256-1").
   Respuesta: datos mapeados al modelo Customer.
─────────────────────────────────────────────────────────────────────────────── */
const consultarNit = async (req, res) => {
  let { nit } = req.params;

  // Aceptar NIT con o sin DV ("900072256-1" → nit="900072256", dv="1")
  nit = nit.toString().trim();
  const [nitBase, dvParam] = nit.split('-');

  if (!/^\d{5,15}$/.test(nitBase)) {
    return res.status(400).json({
      success: false,
      message: 'NIT inválido. Ingresa solo números, con o sin dígito de verificación (ej: 900072256 o 900072256-1).',
    });
  }

  try {
    // ── Paso 1: buscar el NIT — devuelve lista de matrículas ────────────────
    const searchRes = await axios.get(
      `${RUES_BASE}/RM`,
      {
        headers: ruesHeaders,
        params: {
          prmNit: nitBase,
          ...(dvParam ? { prmDv: dvParam } : {}),
        },
        timeout: 12000,
      }
    );

    const searchData = searchRes.data;

    // Sin resultados
    if (!searchData || (Array.isArray(searchData) && searchData.length === 0)) {
      return res.status(404).json({
        success:  false,
        message:  'NIT no encontrado en RUES. Verifica que sea una empresa registrada en cámara de comercio.',
        esPersona: false,
      });
    }

    // ── Tomar el primer registro (matrícula más reciente / principal) ─────────
    const empresa = Array.isArray(searchData) ? searchData[0] : searchData;

    // Calcular DV si no vino en el NIT
    const dv = dvParam || calcularDV(nitBase);
    const taxId = `${nitBase}-${dv}`;

    // ── Mapeo al modelo Customer ─────────────────────────────────────────────
    const cliente = {
      customer_type: 'company',
      full_name:     toTitle(empresa.razon_social || empresa.razonSocial || ''),
      business_name: toTitle(empresa.razon_social || empresa.razonSocial || ''),
      tax_id:        taxId,
      city:          toTitle(empresa.municipio   || empresa.ciudad || ''),
      state:         toTitle(empresa.departamento || ''),
      address:       toTitle(empresa.direccion   || empresa.dir_comercial || ''),
      // Datos informativos adicionales
      _rues: {
        matricula:          empresa.matricula     || empresa.nro_matricula || null,
        categoria:          empresa.categoria     || null,
        tipo:               empresa.tipo_empresa  || empresa.tipo || null,
        estado:             empresa.estado        || null,
        fechaMatricula:     empresa.fecha_matricula || null,
        fechaRenovacion:    empresa.fecha_renovacion || null,
        camaraComercio:     empresa.camara_comercio || empresa.camara || null,
        actividadEconomica: empresa.actividad_economica || empresa.cod_ciiu_act_econ_pri || null,
      },
    };

    logger.info(`RUES consultado: ${taxId} - ${cliente.business_name}`);
    return res.json({ success: true, data: cliente });

  } catch (err) {
    if (err.response) {
      const status = err.response.status;

      if (status === 404) {
        return res.status(404).json({
          success:  false,
          message:  'NIT no encontrado en RUES.',
        });
      }
      if (status === 403 || status === 429) {
        logger.warn(`RUES HTTP ${status} — posible rate limit`);
        return res.status(503).json({
          success: false,
          message: 'RUES no disponible en este momento. Intenta de nuevo en unos segundos.',
        });
      }

      logger.error(`RUES HTTP ${status}:`, JSON.stringify(err.response.data).slice(0, 200));
      return res.status(502).json({
        success: false,
        message: 'Error consultando RUES. Intenta de nuevo.',
      });
    }

    logger.error('RUES error de red:', err.message);
    return res.status(502).json({
      success: false,
      message: 'No se pudo conectar con RUES. Verifica tu conexión.',
    });
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Calcula el dígito de verificación de un NIT colombiano
function calcularDV(nit) {
  const primos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const str = nit.toString().padStart(15, '0');
  let suma = 0;
  for (let i = 0; i < 15; i++) {
    suma += parseInt(str[i]) * primos[i];
  }
  const residuo = suma % 11;
  return residuo < 2 ? residuo.toString() : (11 - residuo).toString();
}

function toTitle(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

module.exports = { consultarNit };