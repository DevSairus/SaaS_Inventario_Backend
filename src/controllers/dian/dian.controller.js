// backend/src/controllers/dian/dian.controller.js
/**
 * Controlador DIAN
 * Endpoints:
 *   GET    /api/dian/config                    → Obtener config DIAN del tenant
 *   PUT    /api/dian/config                    → Guardar config DIAN del tenant
 *   GET    /api/dian/resolutions               → Listar resoluciones del tenant
 *   POST   /api/dian/resolutions               → Crear/actualizar resolución
 *   DELETE /api/dian/resolutions/:id           → Desactivar resolución
 *   POST   /api/dian/send/:saleId              → Enviar factura a DIAN manualmente
 *   POST   /api/dian/send-credit-note/:saleId  → Enviar nota crédito a DIAN
 *   POST   /api/dian/send-debit-note/:saleId   → Enviar nota débito a DIAN
 *   POST   /api/dian/check-status/:saleId      → Re-consultar estado en DIAN
 *   GET    /api/dian/events                    → Log de eventos DIAN
 *   POST   /api/dian/test-connection           → Probar conectividad con DIAN
 *   GET    /api/dian/numbering-range           → Consultar rango de numeración
 *   POST   /api/dian/test-set/:saleId          → Enviar al set de pruebas de habilitación
 *   POST   /api/dian/auto-test                 → Enviar documentos de prueba (solo facturas)
 */

const { Tenant, Sale, SaleItem, Customer, DianResolution, DianEvent } = require('../../models');
const dianService = require('../../services/dian/dianService');
const dianApi = require('../../services/dian/dianApiService');
const logger = require('../../config/logger');
const { Op } = require('sequelize');

/* ─── Helpers ─── */
const ok = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, message, status = 400) => res.status(status).json({ success: false, message });

/* ──────────────────────────────────────────────────────────
 * GET /api/dian/config
 * ────────────────────────────────────────────────────────── */
const getConfig = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id, {
      attributes: ['id', 'company_name', 'tax_id', 'dian_config'],
    });
    if (!tenant) return fail(res, 'Tenant no encontrado', 404);

    const cfg = tenant.dian_config || {};
    // No exponer el certificado ni contraseña al frontend
    const safe = { ...cfg };
    if (safe.certificate_p12_base64) safe.certificate_p12_base64 = '[CONFIGURADO]';
    if (safe.certificate_password) safe.certificate_password = '[CONFIGURADO]';
    if (safe.software_pin) safe.software_pin = safe.software_pin.substring(0, 3) + '***';

    ok(res, { data: safe });
  } catch (e) {
    logger.error('Error getConfig DIAN:', e);
    fail(res, 'Error al obtener configuración DIAN', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * PUT /api/dian/config
 * ────────────────────────────────────────────────────────── */
const updateConfig = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    if (!tenant) return fail(res, 'Tenant no encontrado', 404);

    const current = tenant.dian_config || {};
    const {
      nit, dv, company_name, trade_name,
      address, city, city_code, dept,
      phone, email,
      regime_code, tax_level_code,
      buyer_default_scheme_id, buyer_tax_level_code, buyer_regime_code,
      software_id, software_provider_nit, software_pin,
      technical_key, environment,
      customization_id, test_set_id,
      // Certificado (solo si se envía)
      certificate_p12_base64, certificate_password,
    } = req.body;

    const updated = {
      ...current,
      ...(nit !== undefined && { nit }),
      ...(dv !== undefined && { dv }),
      ...(company_name !== undefined && { company_name }),
      ...(trade_name !== undefined && { trade_name }),
      ...(address !== undefined && { address }),
      ...(city !== undefined && { city }),
      ...(city_code !== undefined && { city_code }),
      ...(dept !== undefined && { dept }),
      ...(phone !== undefined && { phone }),
      ...(email !== undefined && { email }),
      ...(regime_code !== undefined && { regime_code }),
      ...(tax_level_code !== undefined && { tax_level_code }),
      ...(buyer_default_scheme_id !== undefined && { buyer_default_scheme_id }),
      ...(buyer_tax_level_code !== undefined && { buyer_tax_level_code }),
      ...(buyer_regime_code !== undefined && { buyer_regime_code }),
      ...(software_id !== undefined && { software_id }),
      ...(software_provider_nit !== undefined && { software_provider_nit }),
      ...(software_pin !== undefined && { software_pin }),
      ...(technical_key !== undefined && { technical_key }),
      ...(environment !== undefined && { environment }),
      ...(customization_id !== undefined && { customization_id }),
      ...(test_set_id !== undefined && { test_set_id }),
      // Solo actualizar certificado si se envía un valor real
      ...(certificate_p12_base64 && certificate_p12_base64 !== '[CONFIGURADO]' && { certificate_p12_base64 }),
      ...(certificate_password && certificate_password !== '[CONFIGURADO]' && { certificate_password }),
    };

    await tenant.update({ dian_config: updated });

    ok(res, { message: 'Configuración DIAN guardada exitosamente' });
  } catch (e) {
    logger.error('Error updateConfig DIAN:', e);
    fail(res, 'Error al guardar configuración DIAN', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * GET /api/dian/resolutions
 * ────────────────────────────────────────────────────────── */
const getResolutions = async (req, res) => {
  try {
    const resolutions = await DianResolution.findAll({
      where: { tenant_id: req.tenant_id },
      order: [['is_active', 'DESC'], ['created_at', 'DESC']],
    });
    ok(res, { data: resolutions });
  } catch (e) {
    logger.error('Error getResolutions:', e);
    fail(res, 'Error al obtener resoluciones', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/resolutions
 * ────────────────────────────────────────────────────────── */
const createResolution = async (req, res) => {
  try {
    const {
      resolution_number, resolution_date, prefix,
      from_number, to_number, valid_from, valid_to,
      document_type = 'invoice', is_test = true, notes,
    } = req.body;

    if (!resolution_number || !resolution_date || !prefix || !from_number || !to_number || !valid_from || !valid_to) {
      return fail(res, 'Faltan campos obligatorios de la resolución');
    }

    // Desactivar resoluciones anteriores del mismo tipo/pruebas si se crea una nueva activa
    await DianResolution.update(
      { is_active: false },
      { where: { tenant_id: req.tenant_id, document_type, is_test, is_active: true } }
    );

    const resolution = await DianResolution.create({
      tenant_id: req.tenant_id,
      resolution_number,
      resolution_date,
      prefix,
      from_number: parseInt(from_number),
      to_number: parseInt(to_number),
      current_number: parseInt(from_number), // Empieza desde el inicio
      valid_from,
      valid_to,
      document_type,
      is_active: true,
      is_test,
      notes,
    });

    ok(res, { data: resolution, message: 'Resolución creada exitosamente' }, 201);
  } catch (e) {
    logger.error('Error createResolution:', e);
    if (e.name === 'SequelizeUniqueConstraintError') {
      return fail(res, 'Ya existe una resolución activa con ese prefijo. Desactive la anterior primero.');
    }
    fail(res, 'Error al crear resolución', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * DELETE /api/dian/resolutions/:id
 * ────────────────────────────────────────────────────────── */
const deactivateResolution = async (req, res) => {
  try {
    const resolution = await DianResolution.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
    });
    if (!resolution) return fail(res, 'Resolución no encontrada', 404);

    await resolution.update({ is_active: false });
    ok(res, { message: 'Resolución desactivada' });
  } catch (e) {
    fail(res, 'Error al desactivar resolución', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/send/:saleId
 * Reenvío manual de una factura
 * ────────────────────────────────────────────────────────── */
const sendInvoice = async (req, res) => {
  try {
    const sale = await Sale.findOne({
      where: { id: req.params.saleId, tenant_id: req.tenant_id },
      include: [{ model: SaleItem, as: 'items' }],
    });
    if (!sale) return fail(res, 'Venta no encontrada', 404);

    if (sale.document_type !== 'factura') {
      return fail(res, 'Solo se pueden enviar facturas a la DIAN');
    }

    if (['accepted'].includes(sale.dian_status)) {
      return fail(res, 'Esta factura ya fue aceptada por la DIAN');
    }

    const tenant = await Tenant.findByPk(req.tenant_id);
    const result = await dianService.sendInvoiceToDian(sale, tenant);

    ok(res, { data: result, message: result.accepted ? 'Factura aceptada por DIAN' : 'Factura enviada (pendiente de aceptación)' });
  } catch (e) {
    logger.error('Error sendInvoice:', e);
    fail(res, e.message || 'Error al enviar factura a DIAN', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/send-credit-note/:saleId
 * Enviar nota crédito a DIAN (requiere cufe de factura original)
 * ────────────────────────────────────────────────────────── */
const sendCreditNote = async (req, res) => {
  try {
    const sale = await Sale.findOne({
      where: { id: req.params.saleId, tenant_id: req.tenant_id },
      include: [{ model: SaleItem, as: 'items' }],
    });
    if (!sale) return fail(res, 'Documento no encontrado', 404);

    if (sale.document_type !== 'nota_credito') {
      return fail(res, 'El documento no es una nota crédito');
    }
    if (sale.dian_status === 'accepted') {
      return fail(res, 'Esta nota crédito ya fue aceptada por la DIAN');
    }

    const tenant = await Tenant.findByPk(req.tenant_id);
    const result = await dianService.sendCreditNoteToDian(sale, tenant);

    ok(res, { data: result, message: result.accepted ? 'Nota crédito aceptada por DIAN' : 'Nota crédito enviada (pendiente de aceptación)' });
  } catch (e) {
    logger.error('Error sendCreditNote:', e);
    fail(res, e.message || 'Error al enviar nota crédito a DIAN', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/send-debit-note/:saleId
 * Enviar nota débito a DIAN (requiere cufe de factura original)
 * ────────────────────────────────────────────────────────── */
const sendDebitNote = async (req, res) => {
  try {
    const sale = await Sale.findOne({
      where: { id: req.params.saleId, tenant_id: req.tenant_id },
      include: [{ model: SaleItem, as: 'items' }],
    });
    if (!sale) return fail(res, 'Documento no encontrado', 404);

    if (sale.document_type !== 'nota_debito') {
      return fail(res, 'El documento no es una nota débito');
    }
    if (sale.dian_status === 'accepted') {
      return fail(res, 'Esta nota débito ya fue aceptada por la DIAN');
    }

    const tenant = await Tenant.findByPk(req.tenant_id);
    const result = await dianService.sendDebitNoteToDian(sale, tenant);

    ok(res, { data: result, message: result.accepted ? 'Nota débito aceptada por DIAN' : 'Nota débito enviada (pendiente de aceptación)' });
  } catch (e) {
    logger.error('Error sendDebitNote:', e);
    fail(res, e.message || 'Error al enviar nota débito a DIAN', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/check-status/:saleId
 * ────────────────────────────────────────────────────────── */
const checkStatus = async (req, res) => {
  try {
    const sale = await Sale.findOne({
      where: { id: req.params.saleId, tenant_id: req.tenant_id },
    });
    if (!sale) return fail(res, 'Venta no encontrada', 404);

    const tenant = await Tenant.findByPk(req.tenant_id);
    const result = await dianService.checkInvoiceStatus(sale, tenant);

    ok(res, { data: result });
  } catch (e) {
    fail(res, e.message || 'Error al consultar estado DIAN', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * GET /api/dian/events
 * ────────────────────────────────────────────────────────── */
const getEvents = async (req, res) => {
  try {
    const { limit = 50, offset = 0, sale_id } = req.query;
    const where = { tenant_id: req.tenant_id };
    if (sale_id) where.sale_id = sale_id;

    const events = await DianEvent.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      attributes: { exclude: ['request_xml', 'response_raw'] }, // No exponer XML completo en lista
    });
    const total = await DianEvent.count({ where });

    ok(res, { data: events, pagination: { total, limit: parseInt(limit), offset: parseInt(offset) } });
  } catch (e) {
    fail(res, 'Error al obtener eventos DIAN', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/test-connection
 * ────────────────────────────────────────────────────────── */
const testConnection = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    const cfg = tenant.dian_config || {};
    const environment = cfg.environment || 'test';

    if (!cfg.nit || !cfg.software_id) {
      return fail(res, 'Configure primero NIT y Software ID antes de probar conexión');
    }

    const result = await dianApi.getNumberingRange({
      nit: cfg.nit,
      softwareId: cfg.software_id,
      softwarePin: cfg.software_pin,
      environment,
      p12Base64: cfg.certificate_p12_base64,
      password:  cfg.certificate_password,
    });

    // La DIAN puede responder con rangos de numeración (lo que indica conexión OK)
    // incluso si IsValid no viene en el response de GetNumberingRange
    const hasResponse = result.raw && result.raw.length > 100;
    const hasNumberingData = result.raw && (
      result.raw.includes('GetNumberingRangeResult') ||
      result.raw.includes('ResponseDian') ||
      result.raw.includes('NumberRange') ||
      result.raw.includes('ResolutionNumber')
    );
    const connectionOk = hasResponse && !result.isFault;

    if (result.isFault) {
      return fail(res, `Error DIAN: ${result.statusDescription || result.statusMessage}`, 400);
    }

    ok(res, {
      data: {
        ...result,
        connectionOk,
        hasNumberingData,
        environment,
      },
      message: connectionOk
        ? hasNumberingData
          ? '✅ Conexión exitosa con DIAN — rangos de numeración consultados'
          : '✅ Conexión establecida con DIAN (sin resoluciones registradas aún)'
        : 'Respuesta inesperada del servidor DIAN',
    });
  } catch (e) {
    fail(res, `Error al conectar con DIAN: ${e.message}`, 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * GET /api/dian/numbering-range
 * ────────────────────────────────────────────────────────── */
const getNumberingRange = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    const cfg = tenant.dian_config || {};

    if (!cfg.nit || !cfg.software_id) {
      return fail(res, 'Configure NIT y Software ID primero');
    }

    const result = await dianApi.getNumberingRange({
      nit: cfg.nit,
      softwareId: cfg.software_id,
      softwarePin: cfg.software_pin,
      environment: cfg.environment || 'test',
      p12Base64: cfg.certificate_p12_base64,
      password:  cfg.certificate_password,
    });

    ok(res, { data: result });
  } catch (e) {
    fail(res, e.message, 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/test-set/:saleId
 * Envío al set de pruebas para habilitación
 * Requiere test_set_id en dian_config
 * ────────────────────────────────────────────────────────── */
const sendToTestSet = async (req, res) => {
  try {
    const sale = await Sale.findOne({
      where: { id: req.params.saleId, tenant_id: req.tenant_id },
      include: [{ model: SaleItem, as: 'items' }],
    });
    if (!sale) return fail(res, 'Venta no encontrada', 404);

    if (sale.document_type !== 'factura') {
      return fail(res, 'Solo se pueden enviar facturas al set de pruebas');
    }

    const tenant = await Tenant.findByPk(req.tenant_id);
    const cfg = tenant.dian_config || {};

    if (!cfg.test_set_id) {
      return fail(res, 'Configure el test_set_id en la configuración DIAN. Este ID lo suministra la DIAN en el portal de habilitación.');
    }

    // Forzar entorno de pruebas
    const testTenant = {
      ...tenant.toJSON(),
      dian_config: { ...cfg, environment: 'test' },
    };

    const result = await dianService.sendInvoiceToDian(sale, testTenant);

    ok(res, {
      data: result,
      message: result.accepted
        ? '✅ Documento aceptado en el set de pruebas DIAN'
        : '⚠️ Documento enviado al set de pruebas. Revise los errores.',
    });
  } catch (e) {
    fail(res, e.message || 'Error al enviar al set de pruebas', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * GET /api/dian/habilitacion-status
 * Estado del proceso de habilitación
 * ────────────────────────────────────────────────────────── */
const getHabilitacionStatus = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    const cfg = tenant.dian_config || {};

    // Contar documentos enviados al set de pruebas
    const testDocs = await DianEvent.count({
      where: {
        tenant_id: req.tenant_id,
        is_test: true,
        event_type: 'SendTestSetAsync',
        status: 'accepted',
      },
    });

    const resolution = await DianResolution.findOne({
      where: { tenant_id: req.tenant_id, is_active: true, is_test: true },
    });

    const steps = [
      {
        key: 'software_registered',
        label: 'Software registrado en DIAN',
        done: !!(cfg.software_id && cfg.software_provider_nit),
        details: cfg.software_id ? `Software ID: ${cfg.software_id}` : null,
      },
      {
        key: 'certificate_configured',
        label: 'Certificado digital configurado',
        done: !!(cfg.certificate_p12_base64),
        details: cfg.certificate_p12_base64 ? 'Certificado cargado' : null,
      },
      {
        key: 'test_resolution',
        label: 'Resolución de habilitación configurada',
        done: !!resolution,
        details: resolution ? `Prefijo: ${resolution.prefix}, Rango: ${resolution.from_number}-${resolution.to_number}` : null,
      },
      {
        key: 'test_set_id',
        label: 'TestSetId configurado',
        done: !!cfg.test_set_id,
        details: cfg.test_set_id ? `ID: ${cfg.test_set_id}` : null,
      },
      {
        key: 'test_invoices_sent',
        label: `Facturas de prueba enviadas (${testDocs}/2 mínimo)`,
        done: testDocs >= 2,
        details: `${testDocs} documentos aceptados en set de pruebas`,
      },
    ];

    const allDone = steps.every(s => s.done);

    ok(res, {
      data: {
        steps,
        all_complete: allDone,
        ready_for_production: allDone,
        current_environment: cfg.environment || 'test',
      },
    });
  } catch (e) {
    fail(res, 'Error al consultar estado de habilitación', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/send-auto-test
 * Genera y envía documentos de prueba sintéticos al set de pruebas
 * No requiere ventas reales — usa datos ficticios válidos para la DIAN
 * ────────────────────────────────────────────────────────── */
const sendAutoTestDocuments = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    const cfg = tenant.dian_config || {};

    // Log de diagnóstico (sin exponer valores completos)
    logger.info(`[DIAN AutoTest] cfg keys: nit=${!!cfg.nit} software_id=${!!cfg.software_id} software_pin=${!!cfg.software_pin} technical_key=${!!cfg.technical_key} test_set_id=${!!cfg.test_set_id} cert=${!!cfg.certificate_p12_base64}`);
    logger.info(`[DIAN AutoTest] nit=${cfg.nit} software_id=${cfg.software_id?.substring(0,8)}... test_set_id=${cfg.test_set_id?.substring(0,8)}...`);

    // Validaciones
    if (!cfg.nit || !cfg.software_id) {
      return fail(res, 'Configure NIT y Software ID primero');
    }
    if (!cfg.test_set_id) {
      return fail(res, 'Configure el TestSetId (se obtiene en el portal de habilitación DIAN)');
    }
    if (!cfg.technical_key) {
      return fail(res, 'Configure la Llave Técnica (Technical Key) de la DIAN');
    }
    if (!cfg.certificate_p12_base64 || cfg.certificate_p12_base64 === '[CONFIGURADO]') {
      return fail(res, 'Certificado digital no configurado. Cargue el archivo .p12 en la sección de Certificado Digital.');
    }
    if (!cfg.certificate_password || cfg.certificate_password === '[CONFIGURADO]') {
      return fail(res, 'Contraseña del certificado no configurada.');
    }

    const resolution = await DianResolution.findOne({
      where: { tenant_id: req.tenant_id, is_active: true, is_test: true, document_type: 'invoice' },
    });
    if (!resolution) {
      return fail(res, 'No hay resolución de habilitación activa. Registre una resolución de pruebas primero.');
    }

    const { count = 1 } = req.body; // cuántos documentos enviar (1 o 2)
    const numDocs = Math.min(Math.max(parseInt(count) || 1, 1), 2);

    const dianAutoTest = require('../../services/dian/dianAutoTestService');
    const results = await dianAutoTest.sendTestDocuments({
      tenant,
      cfg,
      resolution,
      count: numDocs,
    });

    const allAccepted = results.every(r => r.accepted);
    ok(res, {
      data: results,
      message: allAccepted
        ? `✅ ${numDocs} documento(s) de prueba aceptados por la DIAN`
        : `⚠️ Documentos enviados. ${results.filter(r => r.accepted).length}/${numDocs} aceptados.`,
    });
  } catch (e) {
    logger.error('[DIAN] Error en auto-test:', e);
    fail(res, e.message || 'Error al enviar documentos de prueba', 500);
  }
};


/* ──────────────────────────────────────────────────────────
 * GET /api/dian/diagnose-cert
 * Diagnóstico completo del certificado P12 configurado
 * ────────────────────────────────────────────────────────── */
const diagnoseCert = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    const cfg = tenant.dian_config || {};

    if (!cfg.certificate_p12_base64 || cfg.certificate_p12_base64 === '[CONFIGURADO]') {
      return fail(res, 'No hay certificado configurado. Cargue el archivo .p12 primero.');
    }
    if (!cfg.certificate_password || cfg.certificate_password === '[CONFIGURADO]') {
      return fail(res, 'No hay contraseña del certificado configurada.');
    }

    const { extractFromP12 } = require('../../services/dian/dianWssSigner');

    let certInfo;
    try {
      certInfo = extractFromP12(cfg.certificate_p12_base64, cfg.certificate_password);
    } catch (e) {
      return fail(res, `Error al leer el P12: ${e.message}`);
    }

    const forge = require('node-forge');
    const p12Der  = forge.util.decode64(cfg.certificate_p12_base64);
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12obj  = forge.pkcs12.pkcs12FromAsn1(p12Asn1, cfg.certificate_password);
    const certBags = p12obj.getBags({ bagType: forge.pki.oids.certBag });
    const certs    = certBags[forge.pki.oids.certBag] || [];
    const entityCert = certs.find(b => { const bc = b.cert.getExtension('basicConstraints'); return !bc || !bc.cA; }) || certs[0];

    const subjAttrs = entityCert.cert.subject.attributes.map(a => ({ shortName: a.shortName || a.type, value: a.value }));
    const nitAttr   = entityCert.cert.subject.attributes.find(a => a.shortName === 'SERIALNUMBER' || a.type === '2.5.4.5');
    const cnAttr    = entityCert.cert.subject.attributes.find(a => a.shortName === 'CN');
    const certNit   = nitAttr?.value || 'NO ENCONTRADO';

    const notAfter  = entityCert.cert.validity.notAfter;
    const notBefore = entityCert.cert.validity.notBefore;
    const isExpired = new Date() > notAfter;
    const nitMatch  = cfg.nit && (certNit === cfg.nit || certNit === cfg.nit + '-' + (cfg.dv || ''));

    // Verificar firma interna
    const crypto = require('crypto');
    let signatureOk = false;
    let signatureError = null;
    try {
      const testMsg = Buffer.from('dian-diag-test');
      const keyBags = p12obj.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
      const keyBag  = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
      if (!keyBag) throw new Error('No se encontró clave privada');
      const keyPem  = forge.pki.privateKeyToPem(keyBag.key);
      const certPem = forge.pki.certificateToPem(entityCert.cert);
      const sig = crypto.createSign('RSA-SHA256').update(testMsg).sign(keyPem);
      signatureOk = crypto.createVerify('RSA-SHA256').update(testMsg).verify(certPem, sig);
    } catch (e) {
      signatureError = e.message;
    }

    ok(res, {
      data: {
        // Identidad del certificado
        cn: cnAttr?.value || '?',
        nit_cert: certNit,
        nit_config: cfg.nit || 'NO CONFIGURADO',
        nit_match: nitMatch,
        subject: subjAttrs,
        // Vigencia
        not_before: notBefore,
        not_after: notAfter,
        is_expired: isExpired,
        days_remaining: Math.floor((notAfter - new Date()) / (1000*60*60*24)),
        // Par clave/certificado
        key_cert_match: signatureOk,
        key_cert_error: signatureError,
        // Datos de configuración que deben coincidir con el portal DIAN
        software_id: cfg.software_id || 'NO CONFIGURADO',
        test_set_id: cfg.test_set_id ? cfg.test_set_id.substring(0,8) + '...' : 'NO CONFIGURADO',
        environment: cfg.environment || 'test',
        // Diagnóstico
        issues: [
          !signatureOk && `❌ La clave privada NO corresponde al certificado${signatureError ? ': ' + signatureError : ''}`,
          isExpired && `❌ El certificado está VENCIDO (venció el ${notAfter.toISOString?.() || notAfter})`,
          !nitMatch && `⚠️  NIT del certificado (${certNit}) NO coincide con NIT configurado (${cfg.nit || 'vacío'})`,
          !cfg.software_id && '❌ Software ID no configurado',
          !cfg.test_set_id && '⚠️  TestSetId no configurado',
        ].filter(Boolean),
      }
    });
  } catch (e) {
    logger.error('Error diagnoseCert:', e);
    fail(res, `Error en diagnóstico: ${e.message}`, 500);
  }
};

module.exports = {
  getConfig,
  updateConfig,
  getResolutions,
  createResolution,
  deactivateResolution,
  sendInvoice,
  sendCreditNote,
  sendDebitNote,
  checkStatus,
  getEvents,
  testConnection,
  getNumberingRange,
  sendToTestSet,
  getHabilitacionStatus,
  sendAutoTestDocuments,
  diagnoseCert,
};