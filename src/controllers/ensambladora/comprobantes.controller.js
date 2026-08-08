// backend/src/controllers/ensambladora/comprobantes.controller.js
//
// Comprobante + seguimiento por URL pública para revisión/garantía --
// mismo patrón que share_token/getPublicOrder de WorkOrder (ver
// workOrders.controller.js), adaptado a que estas tablas viven en el schema
// del tenant (sin columna tenant_id, ver registerTenantSchemaHooks.js): un
// link público todavía no sabe a qué tenant pertenece, así que hay que
// resolver primero EN QUÉ SCHEMA vive el token antes de poder consultar
// nada con el ORM normal.
const { sequelize, EnsambladoraOrdenRevision, EnsambladoraOrdenGarantia, Tenant } = require('../../models');
const { runWithTenantSchema } = require('../../config/tenantContext');
const { generarComprobantePDF } = require('../../services/ensambladora/comprobantePdfService');

const TABLAS = {
  revision: 'ensambladora_ordenes_revision',
  garantia: 'ensambladora_ordenes_garantia',
};

const MODELOS = {
  revision: EnsambladoraOrdenRevision,
  garantia: EnsambladoraOrdenGarantia,
};

/**
 * Resuelve en qué schema vive un `token` de una tabla dada -- primero en
 * `public` (tenants aún no migrados a schema propio, ver middleware/tenant.js),
 * después iterando el resto de schemas de tenant. Igual criterio que
 * resolveWorkOrderSchemaByToken (workOrders.controller.js).
 */
async function resolveEnsambladoraSchemaByToken(tabla, token) {
  const [publicRows] = await sequelize.query(
    `SELECT id FROM "public"."${tabla}" WHERE share_token = :token LIMIT 1`,
    { replacements: { token } }
  );
  if (publicRows[0]) return { recordId: publicRows[0].id, schemaName: null };

  const [tenants] = await sequelize.query(
    'SELECT schema_name FROM "public"."tenants" WHERE schema_name IS NOT NULL'
  );
  for (const { schema_name } of tenants) {
    const [rows] = await sequelize.query(
      `SELECT id FROM "${schema_name}"."${tabla}" WHERE share_token = :token LIMIT 1`,
      { replacements: { token } }
    );
    if (rows[0]) return { recordId: rows[0].id, schemaName: schema_name };
  }
  return null;
}

function validarTipo(tipo) {
  return TABLAS[tipo] ? null : { success: false, code: 'tipo_invalido', message: 'tipo debe ser "revision" o "garantia"' };
}

/**
 * POST /api/ensambladora/{revisiones,garantias}/:id/share-token (autenticado)
 * Reutiliza el token si ya existe -- mismo criterio que generateShareToken
 * de OT (evita invalidar un link que el cliente ya tiene guardado).
 */
function generarShareToken(tipo) {
  return async (req, res) => {
    const invalido = validarTipo(tipo);
    if (invalido) return res.status(400).json(invalido);

    const Modelo = MODELOS[tipo];
    const registro = await Modelo.findByPk(req.params.id);
    if (!registro) {
      return res.status(404).json({ success: false, code: 'no_encontrado', message: `No existe un registro de ${tipo} con ese id` });
    }

    let token = registro.share_token;
    if (!token) {
      token = require('crypto').randomUUID();
      await registro.update({ share_token: token });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://tu-app.vercel.app';
    const shareUrl = `${frontendUrl}/ensambladora/seguimiento/${tipo}/${token}`;
    const whatsappText = encodeURIComponent(`Hola! Puedes consultar el seguimiento de tu ${tipo === 'garantia' ? 'garantía' : 'revisión'} aquí:\n${shareUrl}`);

    res.json({
      success: true,
      data: { token, share_url: shareUrl, whatsapp_url: `https://wa.me/?text=${whatsappText}` },
    });
  };
}

/**
 * GET /api/public/ensambladora/comprobantes/:tipo/:token -- PÚBLICO, sin auth.
 */
async function getPublicComprobante(req, res) {
  const { tipo, token } = req.params;
  const invalido = validarTipo(tipo);
  if (invalido) return res.status(400).json(invalido);

  const tabla = TABLAS[tipo];
  let resuelto;
  try {
    resuelto = await resolveEnsambladoraSchemaByToken(tabla, token);
  } catch {
    return res.status(503).json({ success: false, message: 'Función no disponible aún' });
  }
  if (!resuelto) {
    return res.status(404).json({ success: false, message: 'No encontrado o enlace inválido' });
  }

  const { recordId, schemaName } = resuelto;

  // Datos del CSA para pintar el header de la página pública -- mismo dato
  // (company_name/phone/logo_url/primary_color) que usa WorkOrderPublicPage
  // vía order.workshop. Solo se puede resolver cuando el token vive en un
  // schema de tenant propio (ver comentario arriba); si no, se muestra sin
  // marca en vez de fallar.
  let workshop = null;
  if (schemaName) {
    const tenant = await Tenant.findOne({
      where: { schema_name: schemaName },
      attributes: ['company_name', 'phone', 'email', 'address', 'logo_url', 'primary_color'],
    });
    if (tenant) {
      workshop = {
        name: tenant.company_name,
        phone: tenant.phone,
        email: tenant.email,
        address: tenant.address,
        logo_url: tenant.logo_url,
        primary_color: tenant.primary_color,
      };
    }
  }

  const cargarRegistro = async () => {
    const Modelo = MODELOS[tipo];
    const registro = await Modelo.findByPk(recordId);
    if (!registro) {
      return res.status(404).json({ success: false, message: 'No encontrado o enlace inválido' });
    }
    res.json({ success: true, data: { ...serializarParaPublico(tipo, registro), workshop } });
  };

  if (schemaName) {
    return runWithTenantSchema(schemaName, cargarRegistro);
  }
  return cargarRegistro();
}

function serializarParaPublico(tipo, registro) {
  if (tipo === 'revision') {
    return {
      tipo,
      vin: registro.vin,
      fecha_realizada: registro.fecha_realizada,
      kilometraje_registrado: registro.kilometraje_registrado,
      valor_mano_obra: registro.valor_mano_obra,
      observaciones: registro.observaciones,
      estado: 'completada', // hoy no hay un paso intermedio -- ver LEEME Fase 3
      piezas: registro.piezas || [],
    };
  }
  return {
    tipo,
    vin: registro.vin,
    estado: registro.cerrada ? 'cerrada' : 'en_proceso',
    fecha_cierre: registro.fecha_cierre,
    items: registro.items || [],
  };
}

/**
 * GET /api/ensambladora/{revisiones,garantias}/:id/pdf (autenticado) --
 * comprobante imprimible para entregarle al cliente en el mostrador.
 */
function generarPdf(tipo) {
  return async (req, res) => {
    const invalido = validarTipo(tipo);
    if (invalido) return res.status(400).json(invalido);

    const Modelo = MODELOS[tipo];
    const registro = await Modelo.findByPk(req.params.id);
    if (!registro) {
      return res.status(404).json({ success: false, code: 'no_encontrado', message: `No existe un registro de ${tipo} con ese id` });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://tu-app.vercel.app';
    const shareUrl = registro.share_token ? `${frontendUrl}/ensambladora/seguimiento/${tipo}/${registro.share_token}` : null;

    // Datos del CSA para la cabecera del PDF -- mismo criterio que el PDF
    // de cotización y el de OT.
    const tenant = await Tenant.findByPk(req.tenant_id, {
      attributes: ['company_name', 'phone', 'email', 'address', 'logo_url', 'tax_id'],
    });

    await generarComprobantePDF(res, { tipo, registro, shareUrl, tenant });
  };
}

module.exports = {
  generarShareTokenRevision: generarShareToken('revision'),
  generarShareTokenGarantia: generarShareToken('garantia'),
  generarPdfRevision: generarPdf('revision'),
  generarPdfGarantia: generarPdf('garantia'),
  getPublicComprobante,
};
