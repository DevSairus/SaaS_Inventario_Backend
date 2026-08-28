// backend/src/controllers/dian/dian.controller.js
/**
 * Controlador DIAN
 * Endpoints:
 *   GET    /api/dian/config                    → Obtener config DIAN del tenant
 *   PUT    /api/dian/config                    → Guardar config DIAN del tenant
 *   GET    /api/dian/resolutions               → Listar resoluciones del tenant
 *   POST   /api/dian/resolutions               → Crear resolución
 *   PUT    /api/dian/resolutions/:id           → Editar resolución
 *   DELETE /api/dian/resolutions/:id           → Desactivar resolución
 *   POST   /api/dian/resolutions/:id/reactivate → Reactivar resolución
 *   DELETE /api/dian/resolutions/:id/permanent  → Eliminar resolución definitivamente
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

const { Tenant, Branch, Sale, SaleItem, Customer, DianResolution, DianEvent } = require('../../models');
const dianService = require('../../services/dian/dianService');
const dianKit = require('../../services/dian/dianKitAdapter');
const logger = require('../../config/logger');
const { Op } = require('sequelize');
const { DIVIPOLA_DEPARTMENTS, DIVIPOLA_CITIES } = require('../../data/divipola-colombia');

/* ─── Helpers ─── */
const ok = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, message, status = 400) => res.status(status).json({ success: false, message });

// Factura Electrónica y Documento Soporte son documentos ORIGINALES: la DIAN
// les otorga su propia resolución de numeración (número, fecha, vigencia).
// Notas crédito/débito NO -- son ajustes que reutilizan la numeración de la
// factura que referencian, así que solo definen prefijo y rango propios.
const REQUIRES_DIAN_RESOLUTION = ['invoice', 'support_document'];

// Envío a DIAN: si falló porque al cliente le faltan datos DIAN (ciudad
// DIVIPOLA, tipo de identificación — ver customerDianReadiness.js), se
// responde 422 con el detalle estructurado para que el frontend pueda abrir
// el modal de "completar datos" en vez de solo mostrar un toast genérico.
// Cualquier otro error (SDK, DIAN, red) sigue el camino de siempre.
const failDianSend = (res, e, fallbackMessage) => {
  logger.error(fallbackMessage, e);
  if (e.code === 'DIAN_CUSTOMER_INCOMPLETE') {
    return res.status(422).json({
      success: false,
      code: e.code,
      message: e.message,
      customerId: e.customerId,
      missingFields: e.missingFields,
    });
  }
  if (e.code === 'DIAN_SUPPLIER_INCOMPLETE') {
    return res.status(422).json({
      success: false,
      code: e.code,
      message: e.message,
      supplierId: e.supplierId,
      missingFields: e.missingFields,
    });
  }
  fail(res, e.message || fallbackMessage, 500);
};

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
      ...(software_id !== undefined && { software_id: software_id?.trim() }),
      ...(software_provider_nit !== undefined && { software_provider_nit }),
      ...(software_pin !== undefined && { software_pin }),
      ...(technical_key !== undefined && { technical_key: technical_key?.trim() }),
      ...(environment !== undefined && { environment }),
      ...(customization_id !== undefined && { customization_id }),
      ...(test_set_id !== undefined && { test_set_id: test_set_id?.trim() }),
      // Solo actualizar certificado si se envía un valor real
      ...(certificate_p12_base64 && certificate_p12_base64 !== '[CONFIGURADO]' && { certificate_p12_base64 }),
      ...(certificate_password && certificate_password !== '[CONFIGURADO]' && { certificate_password }),
    };

    await tenant.update({ dian_config: updated });

    // La instancia de DianKit (certificado cargado, ambiente, NIT, etc.) se
    // cachea en memoria por tenant — si no se invalida acá, los envíos
    // siguientes seguían usando la configuración vieja aunque ya se hubiera
    // guardado una nueva (ej. cambiar de Pruebas a Producción sin reiniciar
    // el backend), causando rechazos DIAN por ambiente/resolución
    // inconsistentes (ProfileExecutionID, FAB05b, etc.).
    dianKit.invalidateKit(req.tenant_id);

    ok(res, { message: 'Configuración DIAN guardada exitosamente' });
  } catch (e) {
    logger.error('Error updateConfig DIAN:', e);
    fail(res, 'Error al guardar configuración DIAN', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * GET /api/dian/resolutions
 * ────────────────────────────────────────────────────────── */
// No se expone technical_key en crudo al frontend — mismo criterio que
// tenant.dian_config.technical_key en getConfig(). Se reemplaza por un
// indicador '[CONFIGURADO]' cuando la resolución trae su propia clave, para
// que el formulario pueda mostrar "ya configurada" sin filtrar el valor.
const maskResolution = (r) => {
  const plain = r.toJSON ? r.toJSON() : { ...r };
  if (plain.technical_key) plain.technical_key = '[CONFIGURADO]';
  return plain;
};

const getResolutions = async (req, res) => {
  try {
    const where = { tenant_id: req.tenant_id };
    if (req.query.branch_id) where.branch_id = req.query.branch_id;

    const resolutions = await DianResolution.findAll({
      where,
      order: [['is_active', 'DESC'], ['created_at', 'DESC']],
    });
    ok(res, { data: resolutions.map(maskResolution) });
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
      branch_id,
      resolution_number, resolution_date, prefix,
      from_number, to_number, current_number, valid_from, valid_to,
      document_type = 'invoice', is_test = true, notes,
      // Clave técnica / test set propios de ESTA resolución — solo
      // relevantes cuando la habilitación DIAN de este tipo de documento es
      // distinta a la de facturación de venta (ej. Documento Soporte).
      // Opcionales: si no vienen, el envío cae al valor global de
      // tenant.dian_config (ver dianKitAdapter.js#createInvoice).
      technical_key, test_set_id,
    } = req.body;

    // Un espacio de más al copiar/pegar desde el portal/correo de la DIAN
    // (ej. test_set_id con un trailing space) hace que la DIAN rechace el
    // envío por "TestSetId no reconocido" sin ningún otro indicio del motivo.
    const technicalKeyTrimmed = technical_key?.trim();
    const testSetIdTrimmed = test_set_id?.trim();

    if (!branch_id) {
      return fail(res, 'branch_id es obligatorio: cada resolución pertenece a una sede');
    }

    if (!prefix || !from_number || !to_number) {
      return fail(res, 'Faltan campos obligatorios: prefijo, desde y hasta');
    }

    if (REQUIRES_DIAN_RESOLUTION.includes(document_type) && (!resolution_number || !resolution_date || !valid_from || !valid_to)) {
      return fail(res, 'Faltan campos obligatorios de la resolución (número, fecha, vigencia)');
    }

    if (prefix.length > 4) {
      return fail(res, 'El prefijo no puede tener más de 4 caracteres (regla DIAN)');
    }

    const branch = await Branch.findOne({ where: { id: branch_id, tenant_id: req.tenant_id } });
    if (!branch) return fail(res, 'Sede no encontrada', 404);

    // Desactivar resoluciones anteriores del mismo tipo/pruebas EN ESA SEDE si se crea una nueva activa
    await DianResolution.update(
      { is_active: false },
      { where: { tenant_id: req.tenant_id, branch_id, document_type, is_test, is_active: true } }
    );

    // El consecutivo inicial normalmente es from_number, pero si la
    // numeración ya se venía usando en otro sistema (facturación anterior,
    // otro software), se puede indicar en qué número va actualmente.
    const startNumber = current_number !== undefined && current_number !== null && current_number !== ''
      ? parseInt(current_number)
      : parseInt(from_number);

    if (startNumber < parseInt(from_number) || startNumber > parseInt(to_number)) {
      return fail(res, 'El consecutivo actual debe estar dentro del rango autorizado (Desde-Hasta)');
    }

    const resolution = await DianResolution.create({
      tenant_id: req.tenant_id,
      branch_id,
      resolution_number: resolution_number || null,
      resolution_date: resolution_date || null,
      prefix,
      from_number: parseInt(from_number),
      to_number: parseInt(to_number),
      current_number: startNumber,
      valid_from: valid_from || null,
      valid_to: valid_to || null,
      document_type,
      is_active: true,
      is_test,
      notes,
      ...(technicalKeyTrimmed && technicalKeyTrimmed !== '[CONFIGURADO]' && { technical_key: technicalKeyTrimmed }),
      ...(testSetIdTrimmed !== undefined && { test_set_id: testSetIdTrimmed }),
    });

    ok(res, { data: maskResolution(resolution), message: 'Resolución creada exitosamente' }, 201);
  } catch (e) {
    logger.error('Error createResolution:', e);
    if (e.name === 'SequelizeUniqueConstraintError') {
      return fail(res, 'Ya existe una resolución activa con ese prefijo. Desactive la anterior primero.');
    }
    fail(res, 'Error al crear resolución', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * PUT /api/dian/resolutions/:id
 * Editar una resolución existente (datos, rango, consecutivo actual)
 * ────────────────────────────────────────────────────────── */
const updateResolution = async (req, res) => {
  try {
    const resolution = await DianResolution.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
    });
    if (!resolution) return fail(res, 'Resolución no encontrada', 404);

    const {
      resolution_number, resolution_date, prefix,
      from_number, to_number, current_number,
      valid_from, valid_to, notes,
      technical_key, test_set_id,
    } = req.body;
    const technicalKeyTrimmed = technical_key?.trim();
    const testSetIdTrimmed = test_set_id?.trim();

    if (prefix !== undefined && prefix.length > 4) {
      return fail(res, 'El prefijo no puede tener más de 4 caracteres (regla DIAN)');
    }

    const nextFrom = from_number !== undefined ? parseInt(from_number) : resolution.from_number;
    const nextTo = to_number !== undefined ? parseInt(to_number) : resolution.to_number;
    const currentProvided = current_number !== undefined && current_number !== null && current_number !== '';
    const nextCurrent = currentProvided ? parseInt(current_number) : resolution.current_number;

    // Solo se valida el rango si el usuario efectivamente escribió un nuevo
    // consecutivo. Dejar "Consecutivo actual" en blanco significa "no
    // tocarlo" — no debe bloquear el guardado por un valor que ya traía la
    // resolución (ej. quedó fuera de rango por un consumo indebido de
    // numeración en un intento anterior, o porque solo se está editando el
    // rango Desde/Hasta sin cambiar el consecutivo).
    if (currentProvided && (nextCurrent < nextFrom || nextCurrent > nextTo)) {
      return fail(res, `El consecutivo actual (${nextCurrent}) debe estar dentro del rango autorizado (${nextFrom}-${nextTo})`);
    }

    await resolution.update({
      ...(resolution_number !== undefined && { resolution_number }),
      ...(resolution_date !== undefined && { resolution_date }),
      ...(prefix !== undefined && { prefix }),
      from_number: nextFrom,
      to_number: nextTo,
      current_number: nextCurrent,
      ...(valid_from !== undefined && { valid_from }),
      ...(valid_to !== undefined && { valid_to }),
      ...(notes !== undefined && { notes }),
      // '' o '[CONFIGURADO]' (placeholder que vuelve del frontend sin
      // tocar) significan "no cambiar" — mismo criterio que
      // tenant.dian_config.technical_key en updateConfig().
      ...(technicalKeyTrimmed && technicalKeyTrimmed !== '[CONFIGURADO]' && { technical_key: technicalKeyTrimmed }),
      ...(testSetIdTrimmed !== undefined && testSetIdTrimmed !== '' && { test_set_id: testSetIdTrimmed }),
    });

    ok(res, { data: maskResolution(resolution), message: 'Resolución actualizada exitosamente' });
  } catch (e) {
    logger.error('Error updateResolution:', e);
    fail(res, 'Error al actualizar resolución', 500);
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
 * POST /api/dian/resolutions/:id/reactivate
 * Reactiva una resolución desactivada (desactiva cualquier otra activa
 * del mismo tipo/sede, igual que al crear una nueva)
 * ────────────────────────────────────────────────────────── */
const reactivateResolution = async (req, res) => {
  try {
    const resolution = await DianResolution.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
    });
    if (!resolution) return fail(res, 'Resolución no encontrada', 404);

    await DianResolution.update(
      { is_active: false },
      {
        where: {
          tenant_id: req.tenant_id,
          branch_id: resolution.branch_id,
          document_type: resolution.document_type,
          is_test: resolution.is_test,
          is_active: true,
          id: { [Op.ne]: resolution.id },
        },
      }
    );

    await resolution.update({ is_active: true });
    ok(res, { data: maskResolution(resolution), message: 'Resolución reactivada' });
  } catch (e) {
    logger.error('Error reactivateResolution:', e);
    fail(res, 'Error al reactivar resolución', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * DELETE /api/dian/resolutions/:id/permanent
 * Elimina definitivamente una resolución del registro
 * ────────────────────────────────────────────────────────── */
const deleteResolution = async (req, res) => {
  try {
    const resolution = await DianResolution.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
    });
    if (!resolution) return fail(res, 'Resolución no encontrada', 404);

    await resolution.destroy();
    ok(res, { message: 'Resolución eliminada permanentemente' });
  } catch (e) {
    logger.error('Error deleteResolution:', e);
    fail(res, 'Error al eliminar resolución', 500);
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
    failDianSend(res, e, 'Error sendInvoice:');
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
    failDianSend(res, e, 'Error sendCreditNote:');
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
    failDianSend(res, e, 'Error sendDebitNote:');
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
 * POST /api/dian/send-support-document/purchase/:purchaseId
 * ────────────────────────────────────────────────────────── */
const sendSupportDocumentPurchase = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    const result = await dianService.sendSupportDocumentForPurchase(
      req.params.purchaseId, tenant, req.user.id
    );
    ok(res, { data: result, message: result.accepted ? 'Documento Soporte aceptado por DIAN' : 'Documento Soporte enviado (pendiente de aceptación)' });
  } catch (e) {
    failDianSend(res, e, 'Error sendSupportDocumentPurchase:');
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/send-support-document/expense/:expenseId
 * Body opcional `seller` — datos ad-hoc del vendedor cuando el gasto no
 * tiene supplier_id (ver dianService.js#sendSupportDocumentForExpense).
 * ────────────────────────────────────────────────────────── */
const sendSupportDocumentExpense = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    const adHocSeller = req.body?.seller || null;
    const result = await dianService.sendSupportDocumentForExpense(
      req.params.expenseId, tenant, req.user.id, adHocSeller
    );
    ok(res, { data: result, message: result.accepted ? 'Documento Soporte aceptado por DIAN' : 'Documento Soporte enviado (pendiente de aceptación)' });
  } catch (e) {
    failDianSend(res, e, 'Error sendSupportDocumentExpense:');
  }
};

/* ──────────────────────────────────────────────────────────
 * GET /api/dian/support-document/purchase/:purchaseId
 * GET /api/dian/support-document/expense/:expenseId
 * Estado guardado localmente (no re-consulta DIAN — para eso está
 * check-status-support-document, mismo patrón que checkStatus/factura).
 * ────────────────────────────────────────────────────────── */
const getSupportDocumentStatus = (sourceType) => async (req, res) => {
  try {
    const { SupportDocument } = require('../../models');
    const sourceId = sourceType === 'purchase' ? req.params.purchaseId : req.params.expenseId;
    const sourceColumn = sourceType === 'purchase' ? 'purchase_id' : 'expense_id';

    const supportDocument = await SupportDocument.findOne({
      where: { tenant_id: req.tenant_id, [sourceColumn]: sourceId },
    });
    if (!supportDocument) return ok(res, { data: null });

    ok(res, { data: supportDocument });
  } catch (e) {
    logger.error('Error getSupportDocumentStatus:', e);
    fail(res, 'Error al consultar el Documento Soporte', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/check-status-support-document/purchase/:purchaseId
 * POST /api/dian/check-status-support-document/expense/:expenseId
 * Re-consulta el estado en la DIAN (mismo criterio que checkStatus).
 * ────────────────────────────────────────────────────────── */
const checkSupportDocumentStatus = (sourceType) => async (req, res) => {
  try {
    const sourceId = sourceType === 'purchase' ? req.params.purchaseId : req.params.expenseId;
    const tenant = await Tenant.findByPk(req.tenant_id);
    const result = await dianService.checkSupportDocumentStatus(sourceType, sourceId, tenant);
    ok(res, { data: result });
  } catch (e) {
    fail(res, e.message || 'Error al consultar estado DIAN', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/support-document/:supportDocumentId/adjustment
 * Crear Nota de Ajuste (tipo 95, crédito o débito) sobre un Documento
 * Soporte ya aceptado por la DIAN y enviarla.
 *
 * Body:
 *   adjustment_type: 'credit' | 'debit'   ← requerido
 *   reason: string                        ← requerido
 *   items: [{ description, quantity, unit_price, tax_percentage }]  ← opcional
 *   amount: number                        ← opcional, alternativa a items
 *
 * Si se envía `items`, se calcula subtotal/IVA por línea (mismo criterio que
 * createAndSendDebitNote). Si se envía `amount` sin `items`, se toma como
 * subtotal de una sola línea sin IVA. Uno de los dos es obligatorio.
 *
 * Vendedor ad-hoc (Fase 5): si el origen es un gasto (`expense`) sin
 * proveedor real vinculado, se usa `SupportDocument.seller_snapshot` -- los
 * datos del vendedor ad-hoc capturados en el envío original del Documento
 * Soporte (ver AdHocSellerModal / dianService.js#sendSupportDocumentToDian),
 * que desde esa fase se persisten junto con el documento. Solo falla si
 * NINGUNO de los dos existe (proveedor real O snapshot) -- caso que solo
 * debería darse en Documentos Soporte generados ANTES de la Fase 5.
 * ────────────────────────────────────────────────────────── */
const createSupportDocumentAdjustment = async (req, res) => {
  const { sequelize: seq } = require('../../config/database');
  const { SupportDocument, SupportDocumentAdjustment, Purchase, PurchaseItem, Supplier, Expense } = require('../../models');
  const transaction = await seq.transaction();
  try {
    const { supportDocumentId } = req.params;
    const tenantId = req.tenant_id;
    const { adjustment_type, reason, items, amount } = req.body;

    if (!['credit', 'debit'].includes(adjustment_type)) {
      await transaction.rollback();
      return fail(res, "adjustment_type debe ser 'credit' o 'debit'");
    }
    if (!reason) {
      await transaction.rollback();
      return fail(res, 'El motivo es obligatorio');
    }

    const supportDocument = await SupportDocument.findOne({
      where: { id: supportDocumentId, tenant_id: tenantId },
      include: [
        { model: Purchase, as: 'purchase', include: [{ model: Supplier, as: 'supplier' }] },
        { model: Expense, as: 'expense', include: [{ model: Supplier, as: 'supplier' }] },
      ],
      transaction,
    });
    if (!supportDocument) { await transaction.rollback(); return fail(res, 'Documento Soporte no encontrado', 404); }
    if (supportDocument.dian_status !== 'accepted' || !supportDocument.cuds) {
      await transaction.rollback();
      return fail(res, 'El Documento Soporte debe estar aceptado por la DIAN antes de generar una Nota de Ajuste.');
    }

    const source = supportDocument.source_type === 'purchase' ? supportDocument.purchase : supportDocument.expense;
    const supplier = source?.supplier;
    if (!supplier && !supportDocument.seller_snapshot) {
      await transaction.rollback();
      return fail(res, 'Esta Nota de Ajuste no se puede generar: el Documento Soporte original no tiene un proveedor real asociado ni datos de vendedor guardados. Vincula un proveedor primero.');
    }

    // Calcular ítems de la nota de ajuste — mismo criterio que createAndSendDebitNote
    const noteItems = [];
    let noteSubtotal = 0;
    let noteTax = 0;

    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        const qty = parseFloat(item.quantity) || 1;
        const price = parseFloat(item.unit_price) || 0;
        const taxPct = parseFloat(item.tax_percentage) || 0;
        const subtot = qty * price;
        const tax = subtot * taxPct / 100;

        noteSubtotal += subtot;
        noteTax += tax;
        noteItems.push({
          id: String(noteItems.length + 1),
          description: item.description || 'Ajuste',
          quantity: qty,
          unit_code: 'EA',
          unit_price: price,
          subtotal: subtot,
          tax_amount: tax,
          tax_rate: taxPct,
        });
      }
    } else if (amount && parseFloat(amount) > 0) {
      const amt = parseFloat(amount);
      noteSubtotal = amt;
      noteItems.push({
        id: '1',
        description: reason || 'Ajuste al Documento Soporte',
        quantity: 1,
        unit_code: 'EA',
        unit_price: amt,
        subtotal: amt,
        tax_amount: 0,
        tax_rate: 0,
      });
    } else {
      await transaction.rollback();
      return fail(res, 'Debe especificar ítems o un monto para la Nota de Ajuste');
    }

    const noteTotal = noteSubtotal + noteTax;

    const adjustment = await SupportDocumentAdjustment.create({
      tenant_id: tenantId,
      support_document_id: supportDocument.id,
      adjustment_type,
      reason,
      items: noteItems,
      subtotal: noteSubtotal,
      tax_amount: noteTax,
      total_amount: noteTotal,
      dian_status: 'pending',
      created_by: req.user.id,
    }, { transaction });

    await transaction.commit();

    const tenant = await Tenant.findByPk(tenantId);
    // Prioriza el proveedor real vigente (datos más al día que el snapshot
    // si el proveedor se editó desde el envío original) -- el snapshot es
    // solo el fallback para cuando no hay Supplier vinculado (vendedor
    // ad-hoc, ver nota de Fase 5 arriba).
    const seller = supplier ? dianKit.buildSellerFromSupplier(supplier) : supportDocument.seller_snapshot;
    const retentions = {
      retefuente_rate: source.retefuente_rate, retefuente_amount: source.retefuente_amount,
      reteiva_rate: source.reteiva_rate, reteiva_amount: source.reteiva_amount,
      reteica_rate: source.reteica_rate, reteica_amount: source.reteica_amount,
    };

    setImmediate(async () => {
      try {
        await dianService.sendSupportDocumentAdjustmentToDian(adjustment, supportDocument, seller, tenant, retentions);
        logger.info(`[DIAN] Nota de Ajuste creada para Documento Soporte ${supportDocument.id}`);
      } catch (err) {
        logger.error(`[DIAN] Error enviando Nota de Ajuste de ${supportDocument.id}:`, err.message);
      }
    });

    ok(res, {
      data: adjustment,
      message: 'Nota de Ajuste creada. Envío a DIAN en proceso.',
    }, 201);
  } catch (e) {
    if (transaction && !transaction.finished) await transaction.rollback();
    logger.error('Error createSupportDocumentAdjustment:', e);
    fail(res, e.message || 'Error al crear la Nota de Ajuste', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * GET /api/dian/support-document/:supportDocumentId/adjustments
 * ────────────────────────────────────────────────────────── */
const listSupportDocumentAdjustments = async (req, res) => {
  try {
    const { SupportDocumentAdjustment } = require('../../models');
    const adjustments = await SupportDocumentAdjustment.findAll({
      where: { support_document_id: req.params.supportDocumentId, tenant_id: req.tenant_id },
      order: [['created_at', 'DESC']],
    });
    ok(res, { data: adjustments });
  } catch (e) {
    logger.error('Error listSupportDocumentAdjustments:', e);
    fail(res, 'Error al consultar las Notas de Ajuste', 500);
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

    if (!cfg.nit || !cfg.software_id) {
      return fail(res, 'Configure primero NIT y Software ID antes de probar conexión');
    }

    const result = await dianKit.getNumberingRange(tenant);

    const connectionOk = result.raw && result.raw.length > 100 && !result.isFault;

    if (result.isFault) {
      return res.status(400).json({
        success: false,
        message: `Error DIAN: ${result.statusDescription || result.statusMessage}`,
        dian_raw: result.raw || 'Sin respuesta',
        dian_code: result.statusCode,
        environment: cfg.environment || 'test',
      });
    }

    ok(res, {
      data: {
        ...result,
        connectionOk,
        environment: cfg.environment || 'test',
      },
      message: connectionOk
        ? '✅ Conexión exitosa con DIAN'
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

    const result = await dianKit.getNumberingRange(tenant);

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
// DianEvent.document_type usa PascalCase (ver dianService.js) — distinto del
// enum snake_case de DianResolution.document_type. Mismo mapeo que
// dianAutoTestService.js#DIAN_EVENT_DOC_TYPE.
const DIAN_EVENT_DOC_TYPE = { invoice: 'Invoice', support_document: 'SupportDocument' };
const DOC_TYPE_LABEL_ES = { invoice: 'facturas', support_document: 'documentos soporte' };

const getHabilitacionStatus = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    const cfg = tenant.dian_config || {};
    // La habilitación es POR TIPO DE DOCUMENTO -- haber completado la de
    // factura no implica que Documento Soporte (u otro tipo agregado
    // después) también lo esté. Sin este filtro, el checklist se marcaba
    // "completo" apenas se terminaba de habilitar facturación, y ocultaba
    // el botón de pruebas para cualquier tipo agregado más tarde.
    const documentType = req.query.document_type || 'invoice';

    const resolution = await DianResolution.findOne({
      where: { tenant_id: req.tenant_id, is_active: true, is_test: true, document_type: documentType },
    });

    // Contar documentos de ESTE tipo enviados al set de pruebas
    const testDocs = await DianEvent.count({
      where: {
        tenant_id: req.tenant_id,
        is_test: true,
        event_type: 'SendTestSetAsync',
        status: 'accepted',
        document_type: DIAN_EVENT_DOC_TYPE[documentType] || 'Invoice',
      },
    });

    const effectiveTestSetId = resolution?.test_set_id || cfg.test_set_id;
    const docLabelEs = DOC_TYPE_LABEL_ES[documentType] || documentType;

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
        done: !!effectiveTestSetId,
        details: effectiveTestSetId ? `ID: ${effectiveTestSetId}` : null,
      },
      {
        key: 'test_invoices_sent',
        label: `${docLabelEs[0].toUpperCase()}${docLabelEs.slice(1)} de prueba enviados (${testDocs}/1 mínimo)`,
        done: testDocs >= 1,
        details: `${testDocs} documentos aceptados en set de pruebas`,
      },
    ];

    const allDone = steps.every(s => s.done);

    ok(res, {
      data: {
        document_type: documentType,
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
    if (!cfg.certificate_p12_base64 || cfg.certificate_p12_base64 === '[CONFIGURADO]') {
      return fail(res, 'Certificado digital no configurado. Cargue el archivo .p12 en la sección de Certificado Digital.');
    }
    if (!cfg.certificate_password || cfg.certificate_password === '[CONFIGURADO]') {
      return fail(res, 'Contraseña del certificado no configurada.');
    }

    const { count = 1, mode = 'invoices', document_type = 'invoice' } = req.body;

    const resolution = await DianResolution.findOne({
      where: { tenant_id: req.tenant_id, is_active: true, is_test: true, document_type },
    });
    if (!resolution) {
      return fail(res, `No hay resolución de habilitación activa para "${document_type}". Registre una resolución de pruebas primero.`);
    }

    // La llave técnica y el test_set_id pueden venir de la resolución propia
    // (habilitación separada por tipo de documento, ej. Documento Soporte) o
    // del valor global de facturación — mismo criterio que ya aplica al
    // enviar (ver dianKitAdapter.js#createInvoice y #sendToDian).
    if (!resolution.test_set_id && !cfg.test_set_id) {
      return fail(res, 'Configure el TestSetId (se obtiene en el portal de habilitación DIAN) — en la configuración global o en esta resolución.');
    }
    if (!resolution.technical_key && !cfg.technical_key) {
      return fail(res, 'Configure la Llave Técnica (Technical Key) de la DIAN — en la configuración global o en esta resolución.');
    }

    // mode='full'    → set completo (6 facturas + 2 NC + 2 ND = 10 docs)
    // mode='invoices' → solo facturas (1–6)
    const dianAutoTest = require('../../services/dian/dianAutoTestService');
    let results;

    if (mode === 'full') {
      results = await dianAutoTest.sendFullHabilitacionSet({ tenant, cfg, resolution, documentType: document_type });
    } else {
      const numDocs = Math.min(Math.max(parseInt(count) || 1, 1), 6);
      results = await dianAutoTest.sendTestDocuments({ tenant, cfg, resolution, count: numDocs, documentType: document_type });
    }

    const allAccepted = results.every(r => r.accepted);
    const acceptedCount = results.filter(r => r.accepted).length;
    ok(res, {
      data: results,
      message: allAccepted
        ? `✅ ${results.length} documentos aceptados por la DIAN`
        : `⚠️ ${acceptedCount}/${results.length} documentos aceptados.`,
    });
  } catch (e) {
    logger.error('[DIAN] Error en auto-test:', e);
    fail(res, e.message || 'Error al enviar documentos de prueba', 500);
  }
};


/* ──────────────────────────────────────────────────────────
 * POST /api/dian/test-connection-prod
 * Prueba de conectividad forzando endpoint de PRODUCCIÓN
 * Sirve para diagnosticar si el problema es del endpoint de habilitación
 * ────────────────────────────────────────────────────────── */
const testConnectionProd = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id);
    const cfg = tenant.dian_config || {};

    if (!cfg.nit || !cfg.software_id) {
      return fail(res, 'Configure primero NIT y Software ID');
    }
    if (!cfg.certificate_p12_base64 || !cfg.certificate_password) {
      return fail(res, 'Certificado no configurado');
    }

    // Forzar PRODUCCIÓN independientemente del cfg.environment. Se invalida
    // la caché del kit antes y después: getKit() cachea por tenant.id, y si
    // no se limpia, este tenant "de prueba forzada a producción" quedaría
    // pisando (o siendo pisado por) el kit real del tenant en llamadas
    // posteriores.
    const testTenant = { ...tenant.toJSON(), dian_config: { ...cfg, environment: 'production' } };
    dianKit.invalidateKit(req.tenant_id);
    let result;
    try {
      result = await dianKit.getNumberingRange(testTenant);
    } finally {
      dianKit.invalidateKit(req.tenant_id);
    }

    if (result.isFault) {
      return res.status(400).json({
        success: false,
        message: `PRODUCCIÓN: ${result.statusDescription || result.statusMessage}`,
        dian_raw: result.raw,
        dian_code: result.statusCode,
        environment: 'production (forzado para diagnóstico)',
        diagnostico: result.statusCode === 's:Sender' && result.raw?.includes('InvalidSecurity')
          ? 'InvalidSecurity también en PRODUCCIÓN → problema de código/certificado'
          : 'Error diferente en PRODUCCIÓN → el problema es específico del endpoint de habilitación',
      });
    }

    ok(res, {
      data: { ...result, environment: 'production' },
      message: '✅ PRODUCCIÓN funciona — el problema es específico del endpoint de habilitación (portal DIAN)',
      diagnostico: 'Para habilitación: registrar el software + certificado en catalogo-vpfe-hab.dian.gov.co',
    });
  } catch (e) {
    fail(res, `Error: ${e.message}`, 500);
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

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/create-credit-note/:saleId
 * Crear nota crédito parcial/total desde una factura y enviar a DIAN
 *
 * Body:
 *   items: [{ sale_item_id, quantity }]  ← devolución por ítems (opcional)
 *   amount: number                       ← monto fijo a acreditar (opcional)
 *   reason: string                       ← motivo (requerido)
 *
 * Si se envía `items`, se calcula el proporcional de cada ítem.
 * Si se envía `amount` sin `items`, se distribuye proporcionalmente.
 * Si no se envía ninguno, se asume devolución total.
 * ────────────────────────────────────────────────────────── */
const createAndSendCreditNote = async (req, res) => {
  const { sequelize: seq } = require('../../config/database');
  const transaction = await seq.transaction();
  try {
    const { saleId } = req.params;
    const tenantId = req.tenant_id;
    const { items, amount, reason } = req.body;

    if (!reason) {
      await transaction.rollback();
      return fail(res, 'El motivo es obligatorio');
    }

    // Cargar factura original
    const original = await Sale.findOne({
      where: { id: saleId, tenant_id: tenantId, document_type: 'factura' },
      include: [{ model: SaleItem, as: 'items' }],
      transaction,
    });
    if (!original) { await transaction.rollback(); return fail(res, 'Factura no encontrada', 404); }
    if (!original.cufe) {
      await transaction.rollback();
      return fail(res, 'La factura no tiene CUFE. Debe ser aceptada por la DIAN primero.');
    }
    if (!original.items?.length) {
      await transaction.rollback();
      return fail(res, 'La factura no tiene ítems');
    }

    // Calcular ítems de la nota crédito
    const noteItems = [];
    let noteSubtotal = 0;
    let noteTax = 0;

    if (items && Array.isArray(items) && items.length > 0) {
      // ── Modo: por ítems seleccionados ──
      for (const reqItem of items) {
        const saleItem = original.items.find(i => i.id === reqItem.sale_item_id);
        if (!saleItem) { await transaction.rollback(); return fail(res, `Ítem ${reqItem.sale_item_id} no pertenece a esta factura`); }

        const qtyReq = parseFloat(reqItem.quantity);
        if (!qtyReq || qtyReq <= 0) continue;
        if (qtyReq > parseFloat(saleItem.quantity)) {
          await transaction.rollback();
          return fail(res, `${saleItem.product_name}: máximo ${saleItem.quantity} unidades`);
        }

        const ratio = qtyReq / parseFloat(saleItem.quantity);
        const itemSubtot = parseFloat(saleItem.subtotal || 0) * ratio;
        const itemTax = parseFloat(saleItem.tax_amount || 0) * ratio;

        noteSubtotal += itemSubtot;
        noteTax += itemTax;
        noteItems.push({
          product_name: saleItem.product_name,
          product_sku: saleItem.product_sku,
          product_id: saleItem.product_id,
          quantity: qtyReq,
          unit_price: parseFloat(saleItem.unit_price),
          discount_amount: 0,
          discount_percentage: 0,
          tax_percentage: parseFloat(saleItem.tax_percentage || 0),
          tax_amount: itemTax,
          subtotal: itemSubtot,
          total: itemSubtot + itemTax,
        });
      }
    } else if (amount && parseFloat(amount) > 0) {
      // ── Modo: monto fijo — distribuir proporcionalmente ──
      const targetAmount = Math.min(parseFloat(amount), parseFloat(original.total_amount));
      const totalRatio = targetAmount / parseFloat(original.total_amount);

      for (const si of original.items) {
        const itemSubtot = parseFloat(si.subtotal || 0) * totalRatio;
        const itemTax = parseFloat(si.tax_amount || 0) * totalRatio;
        const qty = parseFloat(si.quantity) * totalRatio;

        noteSubtotal += itemSubtot;
        noteTax += itemTax;
        noteItems.push({
          product_name: si.product_name,
          product_sku: si.product_sku,
          product_id: si.product_id,
          quantity: Math.round(qty * 100) / 100,
          unit_price: parseFloat(si.unit_price),
          discount_amount: 0,
          discount_percentage: 0,
          tax_percentage: parseFloat(si.tax_percentage || 0),
          tax_amount: itemTax,
          subtotal: itemSubtot,
          total: itemSubtot + itemTax,
        });
      }
    } else {
      // ── Modo: devolución total ──
      for (const si of original.items) {
        const itemSubtot = parseFloat(si.subtotal || 0);
        const itemTax = parseFloat(si.tax_amount || 0);

        noteSubtotal += itemSubtot;
        noteTax += itemTax;
        noteItems.push({
          product_name: si.product_name,
          product_sku: si.product_sku,
          product_id: si.product_id,
          quantity: parseFloat(si.quantity),
          unit_price: parseFloat(si.unit_price),
          discount_amount: 0,
          discount_percentage: 0,
          tax_percentage: parseFloat(si.tax_percentage || 0),
          tax_amount: itemTax,
          subtotal: itemSubtot,
          total: itemSubtot + itemTax,
        });
      }
    }

    if (noteItems.length === 0) {
      await transaction.rollback();
      return fail(res, 'No hay ítems válidos para la nota crédito');
    }

    const noteTotal = noteSubtotal + noteTax;
    const noteNumber = `NC-${Date.now()}`;

    // Crear Sale como nota crédito
    const noteSale = await Sale.create({
      tenant_id: tenantId,
      branch_id: original.branch_id,
      reference_sale_id: original.id,
      sale_number: noteNumber,
      document_type: 'nota_credito',
      sale_date: new Date(),
      customer_id: original.customer_id,
      customer_name: original.customer_name,
      customer_tax_id: original.customer_tax_id,
      customer_email: original.customer_email,
      customer_phone: original.customer_phone,
      customer_address: original.customer_address,
      customer_city_code: original.customer_city_code,
      customer_city_name: original.customer_city_name,
      customer_department_name: original.customer_department_name,
      customer_document_type: original.customer_document_type,
      subtotal: noteSubtotal,
      tax_amount: noteTax,
      discount_amount: 0,
      total_amount: noteTotal,
      payment_method: original.payment_method,
      payment_status: 'paid',
      paid_amount: noteTotal,
      status: 'completed',
      notes: `Nota crédito para factura ${original.dian_invoice_number || original.sale_number}. Motivo: ${reason}`,
      dian_status: 'pending',
    }, { transaction });

    // Crear ítems de la nota crédito
    for (const item of noteItems) {
      await SaleItem.create({
        sale_id: noteSale.id,
        tenant_id: tenantId,
        item_type: 'product',
        product_id: item.product_id,
        product_name: item.product_name,
        product_sku: item.product_sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_percentage: 0,
        discount_amount: 0,
        tax_percentage: item.tax_percentage,
        tax_amount: item.tax_amount,
        subtotal: item.subtotal,
        total: item.total,
        unit_cost: 0,
      }, { transaction });
    }

    await transaction.commit();

    // Enviar a DIAN (async)
    const tenant = await Tenant.findByPk(tenantId);
    setImmediate(async () => {
      try {
        await dianService.sendCreditNoteToDian({
          ...noteSale.toJSON(),
          items: noteItems,
          reference_sale_id: original.id,
          reference_invoice_number: original.dian_invoice_number || original.sale_number,
          reference_invoice_cufe: original.cufe,
          reference_invoice_date: original.sale_date,
        }, tenant);
        logger.info(`[DIAN] NC ${noteNumber} enviada para factura ${original.sale_number}`);
      } catch (err) {
        logger.error(`[DIAN] Error enviando NC ${noteNumber}:`, err.message);
        await Sale.update({ dian_status: 'rejected', dian_error_message: err.message }, { where: { id: noteSale.id } });
      }
    });

    const completeNote = await Sale.findByPk(noteSale.id, {
      include: [{ model: SaleItem, as: 'items' }],
    });

    ok(res, {
      data: completeNote,
      message: 'Nota crédito creada. Envío a DIAN en proceso.',
    }, 201);
  } catch (e) {
    if (transaction && !transaction.finished) await transaction.rollback();
    logger.error('Error createAndSendCreditNote:', e);
    fail(res, e.message || 'Error al crear nota crédito', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * POST /api/dian/create-debit-note/:saleId
 * Crear nota débito parcial/total desde una factura y enviar a DIAN
 *
 * Body:
 *   items: [{ description, quantity, unit_price, tax_percentage }]  ← ítems de cargo
 *   amount: number                                                  ← monto fijo
 *   reason: string                                                  ← motivo (requerido)
 * ────────────────────────────────────────────────────────── */
const createAndSendDebitNote = async (req, res) => {
  const { sequelize: seq } = require('../../config/database');
  const transaction = await seq.transaction();
  try {
    const { saleId } = req.params;
    const tenantId = req.tenant_id;
    const { items, amount, reason } = req.body;

    if (!reason) {
      await transaction.rollback();
      return fail(res, 'El motivo es obligatorio');
    }

    const original = await Sale.findOne({
      where: { id: saleId, tenant_id: tenantId, document_type: 'factura' },
      include: [{ model: SaleItem, as: 'items' }],
      transaction,
    });
    if (!original) { await transaction.rollback(); return fail(res, 'Factura no encontrada', 404); }
    if (!original.cufe) {
      await transaction.rollback();
      return fail(res, 'La factura no tiene CUFE. Debe ser aceptada por la DIAN primero.');
    }

    const noteItems = [];
    let noteSubtotal = 0;
    let noteTax = 0;

    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        const qty = parseFloat(item.quantity) || 1;
        const price = parseFloat(item.unit_price) || 0;
        const taxPct = parseFloat(item.tax_percentage) || 0;
        const subtot = qty * price;
        const tax = subtot * taxPct / 100;

        noteSubtotal += subtot;
        noteTax += tax;
        noteItems.push({
          product_name: item.description || item.product_name || 'Cargo adicional',
          product_sku: null,
          product_id: item.product_id || null,
          quantity: qty,
          unit_price: price,
          discount_amount: 0,
          discount_percentage: 0,
          tax_percentage: taxPct,
          tax_amount: tax,
          subtotal: subtot,
          total: subtot + tax,
        });
      }
    } else if (amount && parseFloat(amount) > 0) {
      const amt = parseFloat(amount);
      noteSubtotal = amt;
      noteItems.push({
        product_name: 'Cargo adicional',
        product_sku: null,
        product_id: null,
        quantity: 1,
        unit_price: amt,
        discount_amount: 0,
        discount_percentage: 0,
        tax_percentage: 0,
        tax_amount: 0,
        subtotal: amt,
        total: amt,
      });
    } else {
      await transaction.rollback();
      return fail(res, 'Debe especificar ítems o monto para la nota débito');
    }

    const noteTotal = noteSubtotal + noteTax;
    const noteNumber = `ND-${Date.now()}`;

    const noteSale = await Sale.create({
      tenant_id: tenantId,
      branch_id: original.branch_id,
      reference_sale_id: original.id,
      sale_number: noteNumber,
      document_type: 'nota_debito',
      sale_date: new Date(),
      customer_id: original.customer_id,
      customer_name: original.customer_name,
      customer_tax_id: original.customer_tax_id,
      customer_email: original.customer_email,
      customer_phone: original.customer_phone,
      customer_address: original.customer_address,
      customer_city_code: original.customer_city_code,
      customer_city_name: original.customer_city_name,
      customer_department_name: original.customer_department_name,
      customer_document_type: original.customer_document_type,
      subtotal: noteSubtotal,
      tax_amount: noteTax,
      discount_amount: 0,
      total_amount: noteTotal,
      payment_method: original.payment_method,
      payment_status: 'pending',
      paid_amount: 0,
      status: 'completed',
      notes: `Nota débito para factura ${original.dian_invoice_number || original.sale_number}. Motivo: ${reason}`,
      dian_status: 'pending',
    }, { transaction });

    for (const item of noteItems) {
      await SaleItem.create({
        sale_id: noteSale.id,
        tenant_id: tenantId,
        item_type: 'product',
        product_id: item.product_id,
        product_name: item.product_name,
        product_sku: item.product_sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_percentage: 0,
        discount_amount: 0,
        tax_percentage: item.tax_percentage,
        tax_amount: item.tax_amount,
        subtotal: item.subtotal,
        total: item.total,
        unit_cost: 0,
      }, { transaction });
    }

    await transaction.commit();

    const tenant = await Tenant.findByPk(tenantId);
    setImmediate(async () => {
      try {
        await dianService.sendDebitNoteToDian({
          ...noteSale.toJSON(),
          items: noteItems,
          reference_sale_id: original.id,
          reference_invoice_number: original.dian_invoice_number || original.sale_number,
          reference_invoice_cufe: original.cufe,
          reference_invoice_date: original.sale_date,
        }, tenant);
        logger.info(`[DIAN] ND ${noteNumber} enviada para factura ${original.sale_number}`);
      } catch (err) {
        logger.error(`[DIAN] Error enviando ND ${noteNumber}:`, err.message);
        await Sale.update({ dian_status: 'rejected', dian_error_message: err.message }, { where: { id: noteSale.id } });
      }
    });

    const completeNote = await Sale.findByPk(noteSale.id, {
      include: [{ model: SaleItem, as: 'items' }],
    });

    ok(res, {
      data: completeNote,
      message: 'Nota débito creada. Envío a DIAN en proceso.',
    }, 201);
  } catch (e) {
    if (transaction && !transaction.finished) await transaction.rollback();
    logger.error('Error createAndSendDebitNote:', e);
    fail(res, e.message || 'Error al crear nota débito', 500);
  }
};

/* ──────────────────────────────────────────────────────────
 * GET /api/dian/divipola
 * Catálogo DIVIPOLA (departamentos + municipios) para poblar
 * el selector departamento → ciudad en el frontend. Datos
 * estáticos (backend/src/data/divipola-colombia.js), no requieren
 * ir a base de datos.
 * ────────────────────────────────────────────────────────── */
const getDivipola = async (req, res) => {
  try {
    ok(res, {
      data: {
        departments: DIVIPOLA_DEPARTMENTS,
        cities: DIVIPOLA_CITIES,
      },
    });
  } catch (e) {
    logger.error('Error getDivipola:', e);
    fail(res, 'Error al obtener catálogo DIVIPOLA', 500);
  }
};

module.exports = {
  getConfig,
  updateConfig,
  getResolutions,
  createResolution,
  updateResolution,
  deactivateResolution,
  reactivateResolution,
  deleteResolution,
  sendInvoice,
  sendCreditNote,
  sendDebitNote,
  createAndSendCreditNote,
  createAndSendDebitNote,
  checkStatus,
  sendSupportDocumentPurchase,
  sendSupportDocumentExpense,
  getSupportDocumentStatusPurchase: getSupportDocumentStatus('purchase'),
  getSupportDocumentStatusExpense: getSupportDocumentStatus('expense'),
  checkSupportDocumentStatusPurchase: checkSupportDocumentStatus('purchase'),
  checkSupportDocumentStatusExpense: checkSupportDocumentStatus('expense'),

  createSupportDocumentAdjustment,
  listSupportDocumentAdjustments,
  getEvents,
  testConnection,
  getNumberingRange,
  sendToTestSet,
  getHabilitacionStatus,
  sendAutoTestDocuments,
  diagnoseCert,
  testConnectionProd,
  getDivipola,
};