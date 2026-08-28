// backend/src/services/dian/dianService.js
/**
 * Servicio principal DIAN — migrado a dian-kit SDK
 * Orquesta: dian-kit (XML + firma + envío) → persistencia
 */

const dianKit = require('./dianKitAdapter');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');
const { assertReadiness: assertCustomerDianReadiness } = require('./customerDianReadiness');

/* ──────────────────────────────────────────────────────────
 * Extrae configuración DIAN del tenant y valida campos
 * ────────────────────────────────────────────────────────── */
function extractDianConfig(tenant) {
  const cfg = tenant.dian_config || {};
  const required = [
    'nit', 'dv', 'company_name',
    'software_id', 'software_pin', 'software_provider_nit',
    'technical_key',
  ];
  const missing = required.filter(k => !cfg[k]);
  if (missing.length) {
    throw new Error(`Configuración DIAN incompleta para tenant ${tenant.id}. Faltan: ${missing.join(', ')}`);
  }
  return cfg;
}

/* ──────────────────────────────────────────────────────────
 * Arma el mensaje de rechazo: la DIAN casi siempre manda un
 * statusDescription genérico ("Validación contiene errores en campos
 * mandatorios") y el detalle real de qué campo(s) fallaron viene en
 * dianResponse.errors ([{code, description}]). Se concatena todo en un
 * solo string — la primera línea (el genérico) es lo que muestra
 * getPrimaryDianReason() del frontend, y el resto queda disponible
 * detrás de "Ver detalle completo" en DianDetailPanel.
 * ────────────────────────────────────────────────────────── */
function buildRejectionMessage(dianResponse) {
  const lines = [dianResponse.statusMessage || dianResponse.statusDescription];
  for (const err of dianResponse.errors || []) {
    const label = err.code ? `${err.code}: ` : '';
    lines.push(`${label}${err.description || err.message || ''}`);
  }
  return lines.filter(Boolean).join('\n');
}

/* ──────────────────────────────────────────────────────────
 * Obtiene o incrementa el consecutivo de la resolución
 * ────────────────────────────────────────────────────────── */
async function getNextConsecutive(tenantId, branchId, isTest = false, transaction, existingInvoiceNumber = null, documentType = 'invoice') {
  const { DianResolution } = require('../../models');

  if (!branchId) {
    throw new Error('No se puede generar el consecutivo DIAN sin una sede (branch_id) definida.');
  }

  const resolution = await DianResolution.findOne({
    where: { tenant_id: tenantId, branch_id: branchId, is_active: true, is_test: isTest, document_type: documentType },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });

  const docLabel = { invoice: 'de facturación', credit_note: 'de nota crédito', debit_note: 'de nota débito' }[documentType] || '';
  if (!resolution) {
    throw new Error(`No existe resolución DIAN ${docLabel} ${isTest ? 'de pruebas ' : ''}activa para esta sede. Las notas crédito/débito requieren su propia resolución de numeración — regístrala en Facturación Electrónica DIAN → Resoluciones.`);
  }

  // Reintento de una venta que ya tenía número asignado (rechazada o con
  // error en un envío anterior): se reutiliza el mismo consecutivo en vez
  // de tomar uno nuevo — una factura no debe consumir numeración adicional
  // solo porque el intento anterior falló.
  if (existingInvoiceNumber && existingInvoiceNumber.startsWith(resolution.prefix)) {
    const existing = parseInt(existingInvoiceNumber.slice(resolution.prefix.length), 10);
    if (!Number.isNaN(existing) && existing >= resolution.from_number && existing < resolution.current_number) {
      return { consecutive: existing, invoiceNumber: existingInvoiceNumber, resolution };
    }
  }

  if (resolution.current_number > resolution.to_number) {
    throw new Error(`Se agotó el rango de numeración DIAN (hasta ${resolution.to_number}).`);
  }

  const today = new Date().toISOString().split('T')[0];
  if (today > resolution.valid_to) {
    throw new Error(`La resolución DIAN venció el ${resolution.valid_to}.`);
  }

  const consecutive = resolution.current_number;
  await resolution.increment('current_number', { transaction });

  return {
    consecutive,
    invoiceNumber: `${resolution.prefix}${consecutive}`,
    resolution,
  };
}

/* ──────────────────────────────────────────────────────────
 * sendInvoiceToDian – Función principal
 * ────────────────────────────────────────────────────────── */
async function sendInvoiceToDian(sale, tenant) {
  const { Sale, DianEvent } = require('../../models');
  const transaction = await sequelize.transaction();

  try {
    const dianCfg = extractDianConfig(tenant);
    const isTest = dianCfg.environment !== 'production';

    if (sale.document_type !== 'factura') {
      logger.info(`[DIAN] Documento ${sale.sale_number} tipo ${sale.document_type} — NO se envía a DIAN`);
      await Sale.update({ dian_status: 'not_applicable' }, { where: { id: sale.id }, transaction });
      await transaction.commit();
      return { sent: false, reason: 'not_applicable' };
    }

    // Cortar acá si faltan datos DIAN del comprador (ciudad DIVIPOLA, tipo
    // de identificación) — antes de consumir un consecutivo, no después.
    assertCustomerDianReadiness(sale);

    // Si esta venta ya tuvo un intento previo (rechazado o con error) que le
    // asignó un número, se reutiliza en el reintento en vez de tomar uno nuevo.
    const reusableNumber = (sale.dian_invoice_number && sale.dian_status && sale.dian_status !== 'accepted')
      ? sale.dian_invoice_number
      : null;

    const { consecutive, invoiceNumber, resolution } = await getNextConsecutive(
      tenant.id, sale.branch_id, isTest, transaction, reusableNumber
    );

    await Sale.update(
      { dian_status: 'sending', dian_invoice_number: invoiceNumber },
      { where: { id: sale.id }, transaction }
    );

    const items = sale.items || [];

    // Usar dian-kit para generar y firmar el XML
    const { signedXml, cufe } = await dianKit.createInvoice(tenant, {
      invoiceNumber,
      items,
      resolution,
      sale,
    });

    // Enviar a DIAN
    const dianResponse = await dianKit.sendToDian(tenant, {
      signedXml,
      invoiceNumber,
      cufe,
    });

    const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
    const dianStatus = accepted ? 'accepted' : 'rejected';

    await Sale.update({
      dian_invoice_number: invoiceNumber,
      cufe,
      dian_status: dianStatus,
      dian_response: dianResponse,
      dian_sent_at: new Date(),
      dian_accepted_at: accepted ? new Date() : null,
      dian_error_message: accepted ? null : buildRejectionMessage(dianResponse),
    }, { where: { id: sale.id }, transaction });

    await DianEvent.create({
      tenant_id: tenant.id,
      sale_id: sale.id,
      event_type: isTest ? 'SendTestSetAsync' : 'SendBillSync',
      document_type: 'Invoice',
      invoice_number: invoiceNumber,
      cufe,
      request_xml: signedXml,
      response_raw: dianResponse.raw,
      status: dianStatus,
      error_message: accepted ? null : dianResponse.statusMessage,
      is_test: isTest,
    }, { transaction });

    await transaction.commit();

    logger.info(`[DIAN] Factura ${invoiceNumber} — Status: ${dianStatus} | CUFE: ${cufe.substring(0, 16)}...`);

    // Envío del PDF+XML al comprador — obligatorio para todo documento
    // electrónico aceptado (Resolución 000042/2020). No bloquea la
    // respuesta al usuario: un problema de correo no debe hacer parecer que
    // la factura no se envió a la DIAN.
    if (accepted) {
      setImmediate(async () => {
        try {
          const { Sale: SaleModel } = require('../../models');
          const freshSale = await SaleModel.findByPk(sale.id, {
            include: [{ model: require('../../models').SaleItem, as: 'items' }],
          });
          await require('./dianEmailService').sendElectronicInvoiceEmail(freshSale, tenant, signedXml);
        } catch (emailErr) {
          logger.error(`[DIAN] Error enviando correo de factura ${invoiceNumber}:`, emailErr.message);
        }
      });
    }

    return { sent: true, accepted, invoiceNumber, cufe, dianStatus, dianResponse };

  } catch (error) {
    await transaction.rollback();
    logger.error(`[DIAN] Error enviando factura ${sale.sale_number}:`, error);

    try {
      const { Sale, DianEvent } = require('../../models');
      await Sale.update({
        dian_status: 'rejected',
        dian_error_message: error.message,
      }, { where: { id: sale.id } });

      await DianEvent.create({
        tenant_id: tenant.id,
        sale_id: sale.id,
        event_type: 'SendBillSync',
        document_type: 'Invoice',
        status: 'error',
        error_message: error.message,
        is_test: (tenant.dian_config?.environment || 'test') !== 'production',
      });
    } catch (e2) {
      logger.error('[DIAN] Error guardando evento de error:', e2);
    }

    throw error;
  }
}

/* ──────────────────────────────────────────────────────────
 * checkInvoiceStatus – Re-consulta estado en DIAN
 * ────────────────────────────────────────────────────────── */
async function checkInvoiceStatus(sale, tenant) {
  const { Sale, DianEvent } = require('../../models');
  const dianCfg = extractDianConfig(tenant);
  const environment = dianCfg.environment || 'test';

  if (!sale.cufe) {
    throw new Error('Esta factura no tiene CUFE registrado.');
  }

  const result = await dianKit.getStatusByCufe(tenant, sale.cufe);

  const accepted = result.isValid || result.statusCode === '00';
  await Sale.update({
    dian_status: accepted ? 'accepted' : 'rejected',
    dian_response: result,
    dian_accepted_at: accepted ? new Date() : null,
    dian_error_message: accepted ? null : buildRejectionMessage(result),
  }, { where: { id: sale.id } });

  await DianEvent.create({
    tenant_id: tenant.id,
    sale_id: sale.id,
    event_type: 'GetStatus',
    document_type: 'Invoice',
    invoice_number: sale.dian_invoice_number,
    cufe: sale.cufe,
    response_raw: result.raw,
    status: accepted ? 'accepted' : 'rejected',
    error_message: accepted ? null : result.statusMessage,
    is_test: environment !== 'production',
  });

  return result;
}

/* ──────────────────────────────────────────────────────────
 * _sendNoteToDian — NC y ND
 * ────────────────────────────────────────────────────────── */
async function _sendNoteToDian(note, tenant, isDebit = false) {
  const { Sale, DianEvent } = require('../../models');
  const transaction = await sequelize.transaction();
  const docLabel = isDebit ? 'ND' : 'NC';
  const documentType = isDebit ? 'debit_note' : 'credit_note';

  try {
    const dianCfg = extractDianConfig(tenant);
    const isTest = dianCfg.environment !== 'production';

    // Resolver referencia a factura original
    const ref = await resolveNoteReference(note);

    // ID de la venta original para actualizar estado DIAN y registrar evento
    // Bug corregido: antes se priorizaba reference_sale_id (la factura
    // ORIGINAL referenciada) sobre note.id (la nota crédito/débito en sí),
    // así que cada envío de una nota terminaba pisando el dian_status/cufe/
    // dian_invoice_number de la FACTURA ORIGINAL con los datos de la nota —
    // incluso si la nota fallaba, la factura ya aceptada quedaba marcada
    // como rechazada con el error de la nota. note.id es siempre el registro
    // Sale propio de la nota (ver createAndSendCreditNote/voidSale.js).
    const saleId = note.id;

    // Mismo gate que en sendInvoiceToDian — antes de consumir consecutivo.
    assertCustomerDianReadiness(note);

    // Bug corregido: las notas crédito/débito requieren su PROPIA resolución
    // de numeración ante la DIAN (modalidad "Nota Crédito"/"Nota Débito"),
    // no la misma resolución de la factura — por eso se filtra por
    // document_type acá, y el número sale de un consecutivo real dentro del
    // rango autorizado de ESA resolución (antes se inventaba
    // "NC"+prefijo_factura+timestamp, que nunca iba a corresponder con
    // ninguna autorización real: exactamente los rechazos FAB05b/07b/08b/
    // 10b/11b/12b que reportaba la DIAN).
    const reusableNoteNumber = (note.dian_invoice_number && note.dian_status && note.dian_status !== 'accepted')
      ? note.dian_invoice_number
      : null;

    const { invoiceNumber: noteNumber, resolution } = await getNextConsecutive(
      tenant.id, note.branch_id, isTest, transaction, reusableNoteNumber, documentType
    );

    if (saleId) {
      await Sale.update(
        { dian_status: 'sending', dian_invoice_number: noteNumber },
        { where: { id: saleId }, transaction }
      );
    }

    // Para NC/ND usamos dian-kit para generar XML firmado
    // OJO: usar parseDateCol (mediodía UTC), NO `new Date(resolution.valid_from)`
    // directo -- un DATEONLY tipo "2026-08-27" parseado así cae en medianoche
    // UTC, y con el server en una zona horaria negativa .getFullYear()/
    // getMonth()/getDate() (que usa formatDate() del SDK) muestran el día
    // ANTERIOR. La fecha de vigencia declarada en el XML quedaba corrida un
    // día, exactamente lo que reporta la DIAN como FAB07b/FAB08b. Ver el
    // mismo fix ya aplicado en dianKitAdapter.createInvoice().
    //
    // Las NC/ND no tienen resolución/vigencia DIAN real (a diferencia de la
    // factura) -- estos campos son opcionales en su resolución. El SDK
    // igual exige un authorizationNumber no vacío y fechas válidas para
    // pasar su propio schema, así que se usan valores internos sin
    // significado ante la DIAN (no los valida para este tipo de documento).
    const kit = dianKit.getKit(tenant);
    kit.config.numbering = {
      authorizationNumber: resolution.resolution_number || resolution.id,
      prefix: resolution.prefix,
      startNumber: Number(resolution.from_number),
      endNumber: Number(resolution.to_number),
      startDate: dianKit.parseDateCol(resolution.valid_from || '2000-01-01'),
      endDate: dianKit.parseDateCol(resolution.valid_to || '2100-01-01'),
      technicalKey: dianCfg.technical_key,
    };

    const items = note.items?.length ? note.items : [{
      description: isDebit ? 'Cargo adicional' : 'Devolucion parcial',
      quantity: 1,
      unit_price: Number(note.total_amount || note.subtotal || 0),
      subtotal: Number(note.subtotal || note.total_amount || 0),
      tax_amount: Number(note.tax_amount || 0),
      tax_rate: 0,
      unit_code: 'EA',
    }];

    // Dirección y tipo de identificación reales del comprador — denormalizados
    // en la venta/nota igual que customer_address/customer_tax_id (ver
    // sales.controller.js, voidSale.js y dian.controller.js), en vez del
    // hardcodeo fijo a Bogotá/Cundinamarca y cédula ('13') que traía antes.
    // Mismo schemeID que tuvo la factura original, no uno asumido.
    const noteCityCode = note.customer_city_code || '11001';
    const noteAddress = {
      street: note.customer_address || 'Sin direccion',
      cityCode: noteCityCode,
      cityName: note.customer_city_name || 'Bogota',
      departmentCode: noteCityCode.substring(0, 2),
      departmentName: note.customer_department_name || 'Cundinamarca',
      countryCode: 'CO',
      countryName: 'Colombia',
    };
    const noteSchemeID = note.customer_document_type || '13';
    // Un espacio de más en el NIT (dato capturado en un formulario) corrompe
    // el CUFE/CUDE: la DIAN normaliza espacios al parsear el XML y el hash
    // que ellos recalculan deja de coincidir con el que enviamos (FAD06).
    const noteCustomerNit = (note.customer_tax_id || '').toString().trim() || '13832081';

    const noteInput = {
      id: noteNumber,
      issueDate: new Date(),
      issueTime: new Date(),
      customer: {
        name: note.customer_name || 'Consumidor Final',
        identification: { number: noteCustomerNit, type: noteSchemeID, dv: '0' },
        personType: '1',
        fiscalResponsibilities: ['R-99-PN'],
        taxInfo: {
          registrationName: note.customer_name || 'Consumidor Final',
          companyId: { number: noteCustomerNit, type: noteSchemeID, dv: '0' },
          taxLevelCode: 'R-99-PN',
          taxScheme: { code: '01' },
          address: noteAddress,
        },
        address: noteAddress,
        email: note.customer_email || '',
      },
      billingReference: {
        id: ref.number,
        uuid: ref.cufe,
        issueDate: new Date(ref.date),
      },
      discrepancyResponse: {
        referenceId: ref.number,
        responseCode: isDebit ? '1' : '1',
        description: isDebit ? 'Intereses' : 'Devolucion parcial',
      },
      lines: dianKit.mapLines(items),
      taxTotals: dianKit.buildDocumentTaxTotals(items),
      legalMonetaryTotal: {
        lineExtensionAmount: Number(note.subtotal || 0),
        taxExclusiveAmount: Number(note.subtotal || 0),
        taxInclusiveAmount: Number(note.total_amount || 0),
        allowanceTotalAmount: 0,
        chargeTotalAmount: 0,
        prepaidAmount: 0,
        payableAmount: Number(note.total_amount || 0),
      },
      paymentMeans: { paymentForm: '1', paymentMethod: '10' },
    };

    let result;
    if (isDebit) {
      result = await kit.createDebitNote(noteInput);
    } else {
      result = await kit.createCreditNote(noteInput);
    }

    const dianResponse = await dianKit.sendToDian(tenant, {
      signedXml: result.signedXml,
      invoiceNumber: noteNumber,
      cufe: result.uuid,
    });

    const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
    const dianStatus = accepted ? 'accepted' : 'rejected';

    if (saleId) {
      await Sale.update({
        dian_invoice_number: noteNumber,
        cufe: result.uuid,
        dian_status: dianStatus,
        dian_response: dianResponse,
        dian_sent_at: new Date(),
        dian_accepted_at: accepted ? new Date() : null,
        dian_error_message: accepted ? null : buildRejectionMessage(dianResponse),
      }, { where: { id: saleId }, transaction });
    }

    await DianEvent.create({
      tenant_id: tenant.id,
      sale_id: saleId || null,
      event_type: isTest ? 'SendTestSetAsync' : 'SendBillSync',
      document_type: isDebit ? 'DebitNote' : 'CreditNote',
      invoice_number: noteNumber,
      cufe: result.uuid,
      request_xml: result.signedXml,
      response_raw: dianResponse.raw,
      status: dianStatus,
      error_message: accepted ? null : dianResponse.statusMessage,
      is_test: isTest,
    }, { transaction });

    await transaction.commit();

    logger.info(`[DIAN ${docLabel}] ${noteNumber} → ${dianStatus} | CUDE: ${result.uuid?.substring(0, 16)}...`);

    // Mismo requisito de entrega al comprador que las facturas (ver
    // sendInvoiceToDian) — también aplica a notas crédito/débito.
    if (accepted && saleId) {
      setImmediate(async () => {
        try {
          const freshNote = await Sale.findByPk(saleId, {
            include: [{ model: require('../../models').SaleItem, as: 'items' }],
          });
          await require('./dianEmailService').sendElectronicInvoiceEmail(freshNote, tenant, result.signedXml);
        } catch (emailErr) {
          logger.error(`[DIAN ${docLabel}] Error enviando correo de ${noteNumber}:`, emailErr.message);
        }
      });
    }

    return { sent: true, accepted, noteNumber, cude: result.uuid, dianStatus, dianResponse };

  } catch (error) {
    await transaction.rollback();
    logger.error(`[DIAN ${docLabel}] Error:`, error.message);
    // Bug corregido: antes se priorizaba reference_sale_id (la factura
    // ORIGINAL referenciada) sobre note.id (la nota crédito/débito en sí),
    // así que cada envío de una nota terminaba pisando el dian_status/cufe/
    // dian_invoice_number de la FACTURA ORIGINAL con los datos de la nota —
    // incluso si la nota fallaba, la factura ya aceptada quedaba marcada
    // como rechazada con el error de la nota. note.id es siempre el registro
    // Sale propio de la nota (ver createAndSendCreditNote/voidSale.js).
    const saleId = note.id;
    if (saleId) {
      try {
        await Sale.update({ dian_status: 'rejected', dian_error_message: error.message }, { where: { id: saleId } });
        await DianEvent.create({
          tenant_id: tenant.id, sale_id: saleId,
          event_type: 'SendBillSync', document_type: isDebit ? 'DebitNote' : 'CreditNote',
          status: 'error', error_message: error.message,
          is_test: (tenant.dian_config?.environment || 'test') !== 'production',
        });
      } catch (_) { /* no bloquear */ }
    }
    throw error;
  }
}

async function resolveNoteReference(note) {
  const { Sale } = require('../../models');

  if (note.reference_invoice_number && note.reference_invoice_cufe) {
    return {
      number: note.reference_invoice_number,
      cufe: note.reference_invoice_cufe,
      date: note.reference_invoice_date || new Date().toISOString().split('T')[0],
    };
  }

  if (note.reference_sale_id) {
    const ref = await Sale.findByPk(note.reference_sale_id);
    if (!ref) throw new Error(`No se encontró la factura referenciada (ID ${note.reference_sale_id}).`);
    if (!ref.dian_invoice_number || !ref.cufe) {
      throw new Error(`La factura referenciada (${ref.sale_number}) no ha sido enviada a la DIAN o no tiene CUFE.`);
    }
    return {
      number: ref.dian_invoice_number,
      cufe: ref.cufe,
      date: ref.created_at?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0],
    };
  }

  throw new Error('Nota crédito/débito requiere reference_invoice_number+cufe o reference_sale_id con una factura DIAN aceptada.');
}

async function sendCreditNoteToDian(sale, tenant) {
  return _sendNoteToDian(sale, tenant, false);
}

async function sendDebitNoteToDian(sale, tenant) {
  return _sendNoteToDian(sale, tenant, true);
}

/* ──────────────────────────────────────────────────────────
 * Documento Soporte DIAN (adquisiciones a no obligados a facturar) —
 * origen Purchase o Expense. Ver Documento-Soporte-Plan-v2.md.
 *
 * sendSupportDocumentToDian() es agnóstica al origen: recibe items/seller/
 * retentions ya armados y solo conoce `sourceType`/`sourceId` para saber en
 * qué columna de support_documents (purchase_id o expense_id) buscar/crear
 * el registro. sendSupportDocumentForPurchase/ForExpense son los wrappers
 * que arman ese payload desde cada modelo.
 * ────────────────────────────────────────────────────────── */
async function sendSupportDocumentToDian({ tenant, sourceType, sourceId, branchId, items, seller, retentions, userId }) {
  const { SupportDocument, DianEvent } = require('../../models');

  if (!['purchase', 'expense'].includes(sourceType)) {
    throw new Error(`sourceType inválido para Documento Soporte: "${sourceType}" (debe ser 'purchase' o 'expense')`);
  }
  if (!items || items.length === 0) {
    throw new Error('El Documento Soporte necesita al menos un ítem.');
  }

  const sourceColumn = sourceType === 'purchase' ? 'purchase_id' : 'expense_id';
  const transaction = await sequelize.transaction();

  try {
    const dianCfg = extractDianConfig(tenant);
    const isTest = dianCfg.environment !== 'production';

    let supportDocument = await SupportDocument.findOne({
      where: { tenant_id: tenant.id, [sourceColumn]: sourceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (supportDocument && supportDocument.dian_status === 'accepted') {
      throw new Error('Este Documento Soporte ya fue aceptado por la DIAN — para corregirlo usa una Nota de Ajuste, no se puede volver a generar.');
    }

    // Reintento de un intento previo (rechazado o con error): se reutiliza
    // el mismo consecutivo en vez de tomar uno nuevo — mismo criterio que
    // sendInvoiceToDian con Sale.
    const reusableNumber = (supportDocument?.support_document_number && supportDocument.dian_status !== 'accepted')
      ? supportDocument.support_document_number
      : null;

    const { invoiceNumber: documentNumber, resolution } = await getNextConsecutive(
      tenant.id, branchId, isTest, transaction, reusableNumber, 'support_document'
    );

    // Fase 5 — se guarda el `seller` ya armado (mismo objeto que arma
    // dianKit.buildSellerFromSupplier/buildSellerFromAdHoc) junto con el
    // documento. Es lo único que permite generar una Nota de Ajuste después
    // cuando el origen es un Expense con vendedor ad-hoc (sin Supplier real
    // vinculado) — ver createSupportDocumentAdjustment en el controller.
    if (!supportDocument) {
      supportDocument = await SupportDocument.create({
        tenant_id: tenant.id,
        branch_id: branchId,
        source_type: sourceType,
        [sourceColumn]: sourceId,
        support_document_number: documentNumber,
        dian_status: 'sending',
        seller_snapshot: seller || null,
        created_by: userId || null,
      }, { transaction });
    } else {
      await supportDocument.update({
        support_document_number: documentNumber,
        dian_status: 'sending',
        seller_snapshot: seller || supportDocument.seller_snapshot,
      }, { transaction });
    }

    const { signedXml, cufe } = await dianKit.createSupportDocument(tenant, {
      documentNumber,
      items,
      resolution,
      seller,
      retentions,
    });

    const dianResponse = await dianKit.sendToDian(tenant, {
      signedXml,
      invoiceNumber: documentNumber,
      cufe,
    });

    const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
    const dianStatus = accepted ? 'accepted' : 'rejected';

    await supportDocument.update({
      support_document_number: documentNumber,
      cuds: cufe,
      dian_status: dianStatus,
      dian_response: dianResponse,
      dian_sent_at: new Date(),
      dian_accepted_at: accepted ? new Date() : null,
      dian_error_message: accepted ? null : buildRejectionMessage(dianResponse),
    }, { transaction });

    await DianEvent.create({
      tenant_id: tenant.id,
      support_document_id: supportDocument.id,
      purchase_id: sourceType === 'purchase' ? sourceId : null,
      event_type: isTest ? 'SendTestSetAsync' : 'SendBillSync',
      document_type: 'SupportDocument',
      invoice_number: documentNumber,
      cufe,
      request_xml: signedXml,
      response_raw: dianResponse.raw,
      status: dianStatus,
      error_message: accepted ? null : dianResponse.statusMessage,
      is_test: isTest,
    }, { transaction });

    await transaction.commit();

    logger.info(`[DIAN] Documento Soporte ${documentNumber} (${sourceType} ${sourceId}) — Status: ${dianStatus} | CUDS: ${cufe?.substring(0, 16)}...`);

    return { sent: true, accepted, documentNumber, cuds: cufe, dianStatus, dianResponse, supportDocumentId: supportDocument.id };

  } catch (error) {
    await transaction.rollback();
    logger.error(`[DIAN] Error enviando Documento Soporte (${sourceType} ${sourceId}):`, error);

    try {
      const existing = await SupportDocument.findOne({ where: { tenant_id: tenant.id, [sourceColumn]: sourceId } });
      if (existing) {
        await existing.update({ dian_status: 'rejected', dian_error_message: error.message });
        await DianEvent.create({
          tenant_id: tenant.id,
          support_document_id: existing.id,
          purchase_id: sourceType === 'purchase' ? sourceId : null,
          event_type: 'SendBillSync',
          document_type: 'SupportDocument',
          status: 'error',
          error_message: error.message,
          is_test: (tenant.dian_config?.environment || 'test') !== 'production',
        });
      }
    } catch (e2) {
      logger.error('[DIAN] Error guardando evento de error de Documento Soporte:', e2);
    }

    throw error;
  }
}

async function sendSupportDocumentForPurchase(purchaseId, tenant, userId) {
  const { Purchase, PurchaseItem, Supplier } = require('../../models');
  const { assertReadiness } = require('./supplierDianReadiness');

  const purchase = await Purchase.findByPk(purchaseId, {
    include: [
      { model: PurchaseItem, as: 'items' },
      { model: Supplier, as: 'supplier' },
    ],
  });
  if (!purchase) throw new Error('Compra no encontrada.');
  if (!purchase.requires_support_document) {
    throw new Error('Esta compra no está marcada para generar Documento Soporte (revisa el flag en la compra).');
  }
  if (!purchase.supplier) {
    throw new Error('Esta compra no tiene proveedor asociado.');
  }
  assertReadiness(purchase.supplier);

  const items = (purchase.items || []).map(it => ({
    id: it.id,
    quantity: Number(it.quantity || 1),
    unit_code: 'EA',
    description: it.description || it.product_name || 'Item',
    unit_price: Number(it.unit_price || 0),
    subtotal: Number(it.subtotal || 0),
    tax_amount: Number(it.tax_amount || 0),
    tax_rate: Number(it.tax_rate || 0),
  }));

  return sendSupportDocumentToDian({
    tenant,
    sourceType: 'purchase',
    sourceId: purchase.id,
    branchId: purchase.branch_id,
    items,
    seller: dianKit.buildSellerFromSupplier(purchase.supplier),
    retentions: {
      retefuente_rate: purchase.retefuente_rate, retefuente_amount: purchase.retefuente_amount,
      reteiva_rate: purchase.reteiva_rate, reteiva_amount: purchase.reteiva_amount,
      reteica_rate: purchase.reteica_rate, reteica_amount: purchase.reteica_amount,
    },
    userId,
  });
}

/**
 * @param {string} expenseId
 * @param {object} tenant
 * @param {string} userId
 * @param {object} [adHocSeller] - Datos del vendedor capturados a mano
 *   cuando el gasto no tiene supplier_id (decisión del usuario: se permite
 *   capturar sin crear la ficha). Mismo shape que requiere
 *   supplierDianReadiness (tax_id, person_type, city_code, ...) — se valida
 *   en el controller antes de llegar acá y de nuevo acá por seguridad.
 */
async function sendSupportDocumentForExpense(expenseId, tenant, userId, adHocSeller) {
  const { Expense, Supplier } = require('../../models');
  const { assertReadiness } = require('./supplierDianReadiness');

  const expense = await Expense.findByPk(expenseId, {
    include: [{ model: Supplier, as: 'supplier' }],
  });
  if (!expense) throw new Error('Gasto no encontrado.');
  if (!expense.requires_support_document) {
    throw new Error('Este gasto no está marcado para generar Documento Soporte (revisa el flag en el gasto).');
  }

  let seller;
  if (expense.supplier) {
    assertReadiness(expense.supplier);
    seller = dianKit.buildSellerFromSupplier(expense.supplier);
  } else if (adHocSeller) {
    assertReadiness(adHocSeller);
    seller = dianKit.buildSellerFromAdHoc(adHocSeller);
  } else {
    throw new Error('Este gasto no tiene proveedor asociado — captura los datos del vendedor o crea el proveedor primero.');
  }

  const items = [{
    id: '1',
    quantity: 1,
    unit_code: 'EA',
    description: expense.description || expense.category || 'Gasto',
    unit_price: Number(expense.subtotal || 0),
    subtotal: Number(expense.subtotal || 0),
    tax_amount: Number(expense.tax_amount || 0),
    tax_rate: Number(expense.tax_rate || 0),
  }];

  return sendSupportDocumentToDian({
    tenant,
    sourceType: 'expense',
    sourceId: expense.id,
    branchId: expense.branch_id,
    items,
    seller,
    retentions: {
      retefuente_rate: expense.retefuente_rate, retefuente_amount: expense.retefuente_amount,
      reteiva_rate: expense.reteiva_rate, reteiva_amount: expense.reteiva_amount,
      reteica_rate: expense.reteica_rate, reteica_amount: expense.reteica_amount,
    },
    userId,
  });
}

/* ──────────────────────────────────────────────────────────
 * checkSupportDocumentStatus – Re-consulta estado en DIAN, mismo criterio
 * que checkInvoiceStatus pero sobre support_documents.
 * ────────────────────────────────────────────────────────── */
async function checkSupportDocumentStatus(sourceType, sourceId, tenant) {
  const { SupportDocument, DianEvent } = require('../../models');
  const sourceColumn = sourceType === 'purchase' ? 'purchase_id' : 'expense_id';

  const supportDocument = await SupportDocument.findOne({
    where: { tenant_id: tenant.id, [sourceColumn]: sourceId },
  });
  if (!supportDocument) throw new Error('No se ha generado un Documento Soporte para este registro.');
  if (!supportDocument.cuds) throw new Error('Este Documento Soporte no tiene CUDS registrado.');

  const result = await dianKit.getStatusByCufe(tenant, supportDocument.cuds);

  const accepted = result.isValid || result.statusCode === '00';
  await supportDocument.update({
    dian_status: accepted ? 'accepted' : 'rejected',
    dian_response: result,
    dian_accepted_at: accepted ? new Date() : null,
    dian_error_message: accepted ? null : buildRejectionMessage(result),
  });

  await DianEvent.create({
    tenant_id: tenant.id,
    support_document_id: supportDocument.id,
    purchase_id: sourceType === 'purchase' ? sourceId : null,
    event_type: 'GetStatus',
    document_type: 'SupportDocument',
    invoice_number: supportDocument.support_document_number,
    cufe: supportDocument.cuds,
    response_raw: result.raw,
    status: accepted ? 'accepted' : 'rejected',
    is_test: (tenant.dian_config?.environment || 'test') !== 'production',
  });

  return supportDocument;
}

/* ──────────────────────────────────────────────────────────
 * sendSupportDocumentAdjustmentToDian – Firma y envía la Nota de Ajuste
 * (tipo 95) de un Documento Soporte ya aceptado. Mismo reparto de
 * responsabilidades que createAndSendCreditNote/DebitNote (Sale): el
 * controller ya creó la fila SupportDocumentAdjustment con
 * items/subtotal/tax_amount/total_amount calculados y la dejó en
 * dian_status='pending' dentro de su propia transacción — esta función solo
 * se encarga de la numeración + firma + envío + actualización del registro,
 * igual que _sendNoteToDian hace para Sale.
 *
 * @param {object} adjustment - instancia SupportDocumentAdjustment (con id,
 *   adjustment_type, reason, items, subtotal, tax_amount, total_amount)
 * @param {object} supportDocument - instancia SupportDocument original (con
 *   branch_id, support_document_number, cuds, dian_accepted_at)
 * @param {object} seller - construido con dianKit.buildSellerFromSupplier()
 *   a partir del mismo proveedor del Documento Soporte original.
 * ────────────────────────────────────────────────────────── */
async function sendSupportDocumentAdjustmentToDian(adjustment, supportDocument, seller, tenant, retentions) {
  const { SupportDocumentAdjustment, DianEvent } = require('../../models');
  const transaction = await sequelize.transaction();

  try {
    const dianCfg = extractDianConfig(tenant);
    const isTest = dianCfg.environment !== 'production';

    if (!supportDocument.cuds || supportDocument.dian_status !== 'accepted') {
      throw new Error('El Documento Soporte original debe estar aceptado por la DIAN (con CUDS) antes de generar una Nota de Ajuste.');
    }

    const reusableNumber = (adjustment.adjustment_number && adjustment.dian_status !== 'accepted')
      ? adjustment.adjustment_number
      : null;

    const { invoiceNumber: documentNumber, resolution } = await getNextConsecutive(
      tenant.id, supportDocument.branch_id, isTest, transaction, reusableNumber, 'support_document_adjustment'
    );

    await adjustment.update({ adjustment_number: documentNumber, dian_status: 'sending' }, { transaction });

    const items = adjustment.items?.length ? adjustment.items : [{
      id: '1',
      quantity: 1,
      unit_code: 'EA',
      description: adjustment.reason || 'Ajuste al Documento Soporte',
      unit_price: Number(adjustment.subtotal || 0),
      subtotal: Number(adjustment.subtotal || 0),
      tax_amount: Number(adjustment.tax_amount || 0),
      tax_rate: 0,
    }];

    const { signedXml, cufe } = await dianKit.createSupportDocumentAdjustment(tenant, {
      documentNumber,
      items,
      resolution,
      seller,
      retentions,
      adjustmentType: adjustment.adjustment_type,
      reason: adjustment.reason,
      original: {
        number: supportDocument.support_document_number,
        cuds: supportDocument.cuds,
        issueDate: supportDocument.dian_accepted_at || supportDocument.created_at,
      },
    });

    const dianResponse = await dianKit.sendToDian(tenant, {
      signedXml,
      invoiceNumber: documentNumber,
      cufe,
    });

    const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
    const dianStatus = accepted ? 'accepted' : 'rejected';

    await adjustment.update({
      adjustment_number: documentNumber,
      cuds: cufe,
      dian_status: dianStatus,
      dian_response: dianResponse,
      dian_sent_at: new Date(),
      dian_accepted_at: accepted ? new Date() : null,
      dian_error_message: accepted ? null : buildRejectionMessage(dianResponse),
    }, { transaction });

    await DianEvent.create({
      tenant_id: tenant.id,
      support_document_id: supportDocument.id,
      purchase_id: supportDocument.source_type === 'purchase' ? supportDocument.purchase_id : null,
      event_type: isTest ? 'SendTestSetAsync' : 'SendBillSync',
      document_type: 'SupportDocumentAdjustment',
      invoice_number: documentNumber,
      cufe,
      request_xml: signedXml,
      response_raw: dianResponse.raw,
      status: dianStatus,
      error_message: accepted ? null : dianResponse.statusMessage,
      is_test: isTest,
    }, { transaction });

    await transaction.commit();

    logger.info(`[DIAN] Nota de Ajuste ${documentNumber} (Documento Soporte ${supportDocument.id}) — Status: ${dianStatus} | CUDS: ${cufe?.substring(0, 16)}...`);

    return { sent: true, accepted, documentNumber, cuds: cufe, dianStatus, dianResponse, adjustmentId: adjustment.id };

  } catch (error) {
    await transaction.rollback();
    logger.error(`[DIAN] Error enviando Nota de Ajuste (SupportDocumentAdjustment ${adjustment.id}):`, error);
    try {
      await SupportDocumentAdjustment.update(
        { dian_status: 'rejected', dian_error_message: error.message },
        { where: { id: adjustment.id } }
      );
    } catch (e2) {
      logger.error('[DIAN] Error guardando estado de error de la Nota de Ajuste:', e2);
    }
    throw error;
  }
}

module.exports = {
  sendInvoiceToDian,
  checkInvoiceStatus,
  getNextConsecutive,
  extractDianConfig,
  sendCreditNoteToDian,
  sendDebitNoteToDian,
  sendSupportDocumentToDian,
  sendSupportDocumentForPurchase,
  sendSupportDocumentForExpense,
  checkSupportDocumentStatus,
  sendSupportDocumentAdjustmentToDian,
};
