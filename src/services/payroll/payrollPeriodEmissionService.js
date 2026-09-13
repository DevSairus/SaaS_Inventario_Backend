// backend/src/services/payroll/payrollPeriodEmissionService.js
/**
 * Orquesta la emisión de un periodo de nómina completo: liquida cada
 * empleado activo, genera y envía su Documento Soporte de Pago de Nómina
 * Electrónica a la DIAN, y — solo si TODOS quedaron aceptados — genera el
 * asiento contable consolidado del periodo.
 *
 * Mismo patrón (transacción por documento, DianEvent de auditoría,
 * manejo de error que no tumba el proceso completo) que
 * dianService.js#sendSupportDocumentToDian(), adaptado para procesar N
 * empleados en un solo periodo en vez de un solo documento.
 *
 * Idempotencia: un PayrollDocument con dian_status='accepted' NUNCA se
 * reenvía — si se llama de nuevo sobre un periodo parcialmente emitido
 * (algunos empleados aceptados, otros rechazados o con error), solo se
 * reintentan los que no quedaron en 'accepted'. Esto es lo que permite que
 * el controlador llame este servicio de forma segura cada vez que alguien
 * reintenta pasar el periodo a 'emitido' sin duplicar envíos a la DIAN.
 */
'use strict';

const { generateSoftwareSecurityCode } = require('@dian-kit/core');
const { Op } = require('sequelize');
const {
  sequelize, Employee, PayrollNovedad, PayrollConcept, PayrollDocument, DianEvent, DianResolution,
} = require('../../models');
const logger = require('../../config/logger');
const { liquidarEmpleado, resumenLiquidacionParaImpresion, DIAN_CATEGORY_MAP } = require('./payrollService');
const { submitPayrollDocument } = require('../dian/payrollDianAdapter');
const { getNextConsecutive, extractDianConfig } = require('../dian/dianService');
const { generatePayrollEntry } = require('../accounting/autoEntries.service');

/**
 * Empleados que le corresponden a este periodo: activos durante el rango
 * (ya ingresaron y, si se retiraron, fue dentro o después del periodo),
 * cuya payroll_periodicity coincide con period.period_type, y — si el
 * periodo está atado a una sede — que pertenezcan a esa sede.
 *
 * BUG CORREGIDO: antes esta función no filtraba por branch_id en absoluto
 * (un periodo de la sede A incluía empleados de la sede B); y por
 * supuesto no existía el filtro de periodicidad porque el campo no
 * existía en Employee. Con periodicidad por empleado, no filtrar por
 * sede se vuelve más grave todavía: un periodo mensual sin este filtro
 * liquidaría también a los quincenales de OTRAS sedes.
 */
async function getEmployeesActiveInPeriod(tenantId, period) {
  const where = {
    tenant_id: tenantId,
    is_active: true,
    payroll_periodicity: period.period_type,
    hire_date: { [Op.lte]: period.end_date },
    [Op.or]: [
      { termination_date: null },
      { termination_date: { [Op.gte]: period.start_date } },
    ],
  };
  if (period.branch_id) where.branch_id = period.branch_id;

  return Employee.findAll({ where, order: [['first_name', 'ASC']] });
}

/**
 * Trae las novedades de un empleado para el periodo y las separa en
 * (a) días no remunerados a restar del Básico, (b) novedades DIAN listas
 * para pasar a payrollService.js#aplicarNovedades().
 */
async function getNovedadesParaLiquidacion(tenantId, employeeId, periodId) {
  const rows = await PayrollNovedad.findAll({
    where: { tenant_id: tenantId, employee_id: employeeId, payroll_period_id: periodId },
  });

  let diasNoRemunerados = 0;
  const novedadesDian = [];

  for (const row of rows) {
    diasNoRemunerados += Number(row.unpaid_days || 0);
    if (row.dian_category) {
      if (!DIAN_CATEGORY_MAP[row.dian_category]) {
        // No debería pasar (createNovedad ya valida al guardar), pero si el
        // mapa de categorías cambió después de que se guardó la novedad,
        // mejor fallar explícito acá que silenciar datos de nómina.
        throw new Error(`Novedad ${row.id} tiene dian_category "${row.dian_category}" que ya no existe en DIAN_CATEGORY_MAP`);
      }
      novedadesDian.push({ dian_category: row.dian_category, payload: row.payload });
    }
  }

  return { diasNoRemunerados, novedadesDian };
}

/**
 * Conceptos con auto_apply=true del tenant — se traen UNA sola vez por
 * periodo (no cambian por empleado) y se pasan tal cual a cada
 * liquidarEmpleado(), que los resuelve usando el ibc de cada empleado
 * (ver resolverConceptosAutomaticos en payrollService.js). No filtra por
 * sede/cargo — hoy aplican a TODOS los empleados que le corresponden al
 * periodo, y no hay forma de excluir a un empleado puntual salvo
 * desactivar el concepto entero. Limitación conocida, ver
 * Mejoras-Nomina-Sin-PILA-Nexora.md punto #1.
 */
async function getActiveAutoConcepts(tenantId) {
  const concepts = await PayrollConcept.findAll({
    where: { tenant_id: tenantId, auto_apply: true, is_active: true },
  });
  return concepts.map(c => ({
    name: c.name,
    dian_category: c.dian_category,
    calculation_type: c.calculation_type,
    default_value: c.default_value,
  }));
}

/**
 * Resuelve la resolución de numeración de NÓMINA vigente del tenant
 * (document_type='payroll', is_test según ambiente) — separada de la de
 * facturación por diseño (habilitación independiente, ver
 * Plan-Implementacion-Nomina-Electronica-Nexora.md §2).
 */
async function getPayrollResolution(tenantId, isTest) {
  const resolution = await DianResolution.findOne({
    where: { tenant_id: tenantId, document_type: 'payroll', is_test: isTest, is_active: true },
    order: [['created_at', 'DESC']],
  });
  if (!resolution) {
    throw new Error(`No hay una resolución de numeración de Nómina Electrónica activa (${isTest ? 'pruebas' : 'producción'}) configurada para este tenant. Configúrela en DianConfigPage antes de emitir.`);
  }
  return resolution;
}

/**
 * Emite (o reintenta emitir) el Documento Soporte de Pago de Nómina
 * Electrónica de UN empleado dentro de un periodo, dentro de su propia
 * transacción — igual que sendSupportDocumentToDian() hace para un
 * documento de compra/gasto.
 *
 * @returns {{ employee, liquidation, accepted, error }}
 */
async function emitirDocumentoEmpleado({ tenant, period, employee, isTest, autoConcepts = [] }) {
  const t = await sequelize.transaction();
  try {
    let payrollDocument = await PayrollDocument.findOne({
      where: { tenant_id: tenant.id, employee_id: employee.id, payroll_period_id: period.id },
      transaction: t,
    });

    // Idempotencia: si ya quedó aceptado en un intento anterior, no se
    // vuelve a tocar — se devuelve tal cual con la liquidación reconstruida
    // desde su propio snapshot (no se recalcula, para que el resultado
    // reportado sea exactamente el que ya se envió a la DIAN).
    if (payrollDocument && payrollDocument.dian_status === 'accepted') {
      await t.commit();
      return { employee, liquidation: payrollDocument.snapshot_liquidation, accepted: true, error: null, payrollDocumentId: payrollDocument.id };
    }

    const { diasNoRemunerados, novedadesDian } = await getNovedadesParaLiquidacion(tenant.id, employee.id, period.id);

    // getNextConsecutive() devuelve { consecutive, invoiceNumber, resolution }
    // (mismo contrato que usan todos los demás documentos DIAN del proyecto —
    // ver dianService.js#sendInvoiceToDian/sendCreditNoteToDian). Se normaliza
    // aquí a { prefix, consecutivo } porque payrollXmlBuilder.js ya está
    // escrito contra esa forma (numeroSecuenciaXmlXml, etc.) en varios puntos
    // — más simple normalizar en el único punto de entrada que tocar cada uso
    // interno del builder. BUG CORREGIDO: antes se leía numbering.prefix /
    // numbering.consecutivo directamente, que no existen en la respuesta real
    // de getNextConsecutive — numeroDocumento salía literalmente
    // "undefinedundefined" y así se firmaba y enviaba a la DIAN.
    const rawNumbering = await getNextConsecutive(tenant.id, period.branch_id, isTest, t, null, 'payroll');
    const numbering = { prefix: rawNumbering.resolution.prefix, consecutivo: rawNumbering.consecutive };
    const numeroDocumento = rawNumbering.invoiceNumber;
    const cfg = extractDianConfig(tenant);
    const softwareSecurityCode = generateSoftwareSecurityCode(cfg.software_id_nomina, cfg.software_pin_nomina, numeroDocumento);

    const liquidation = liquidarEmpleado({ employee, period, novedades: novedadesDian, autoConcepts, diasNoRemunerados, softwareSecurityCode });

    if (!payrollDocument) {
      payrollDocument = await PayrollDocument.create({
        tenant_id: tenant.id,
        branch_id: period.branch_id,
        employee_id: employee.id,
        payroll_period_id: period.id,
        payroll_document_number: numeroDocumento,
        devengados_total: liquidation.devengadosTotal,
        deducciones_total: liquidation.deduccionesTotal,
        comprobante_total: liquidation.devengadosTotal - liquidation.deduccionesTotal,
        snapshot_liquidation: liquidation,
        dian_status: 'sending',
        created_by: null,
      }, { transaction: t });
    } else {
      await payrollDocument.update({
        payroll_document_number: numeroDocumento,
        devengados_total: liquidation.devengadosTotal,
        deducciones_total: liquidation.deduccionesTotal,
        comprobante_total: liquidation.devengadosTotal - liquidation.deduccionesTotal,
        snapshot_liquidation: liquidation,
        dian_status: 'sending',
      }, { transaction: t });
    }

    const result = await submitPayrollDocument({ tenant, employee, period, liquidation, numbering });

    const accepted = result.dianResponse?.isValid || result.dianResponse?.statusCode === '00';
    const dianStatus = accepted ? 'accepted' : 'rejected';

    await payrollDocument.update({
      cune: result.cune,
      xml_content: result.xml,
      dian_status: dianStatus,
      dian_response: result.dianResponse,
      dian_sent_at: new Date(),
      dian_accepted_at: accepted ? new Date() : null,
      dian_error_message: accepted ? null : (result.dianResponse?.statusMessage || 'Rechazado por la DIAN'),
    }, { transaction: t });

    await DianEvent.create({
      tenant_id: tenant.id,
      payroll_document_id: payrollDocument.id,
      event_type: 'SendNominaSync',
      document_type: 'Payroll',
      invoice_number: numeroDocumento,
      cufe: result.cune,
      request_xml: result.xml,
      response_raw: result.dianResponse?.raw,
      status: dianStatus,
      error_message: accepted ? null : result.dianResponse?.statusMessage,
      is_test: isTest,
    }, { transaction: t });

    await t.commit();

    logger.info(`[Nómina-DIAN] ${numeroDocumento} (empleado ${employee.id}) — Status: ${dianStatus} | CUNE: ${result.cune?.substring(0, 16)}...`);

    // Envío del comprobante por correo al empleado — no bloquea la
    // respuesta ni el resto del periodo (ver payrollEmailService.js): un
    // problema de correo no debe hacer parecer que la nómina no se emitió
    // a la DIAN. Solo se intenta si quedó aceptado.
    if (accepted) {
      setImmediate(async () => {
        try {
          await require('./payrollEmailService').sendPayrollDocumentEmail(payrollDocument, employee, period, tenant);
        } catch (emailErr) {
          logger.error(`[Nómina] Error enviando correo de comprobante ${numeroDocumento}:`, emailErr.message);
        }
      });
    }

    return { employee, liquidation, accepted, error: accepted ? null : (result.dianResponse?.statusMessage || 'Rechazado por la DIAN'), payrollDocumentId: payrollDocument.id };
  } catch (error) {
    await t.rollback();
    logger.error(`[Nómina-DIAN] Error emitiendo documento de nómina (empleado ${employee.id}, periodo ${period.id}):`, error);

    try {
      const existing = await PayrollDocument.findOne({ where: { tenant_id: tenant.id, employee_id: employee.id, payroll_period_id: period.id } });
      if (existing) {
        await existing.update({ dian_status: 'rejected', dian_error_message: error.message });
        await DianEvent.create({
          tenant_id: tenant.id,
          payroll_document_id: existing.id,
          event_type: 'SendNominaSync',
          document_type: 'Payroll',
          status: 'error',
          error_message: error.message,
          is_test: isTest,
        });
      }
    } catch (e2) {
      logger.error('[Nómina-DIAN] Error guardando evento de error de nómina:', e2);
    }

    return { employee, liquidation: null, accepted: false, error: error.message, payrollDocumentId: null };
  }
}

/**
 * Calcula (SIN persistir ningún PayrollDocument ni tocar la DIAN) lo que
 * cobraría cada empleado que le corresponde a este periodo, con las
 * novedades que existan en este momento — es el "preview" que se guarda en
 * PayrollPeriod.liquidation_preview al pasar a 'liquidado', para que el
 * usuario pueda revisar antes de emitir. Reutiliza exactamente la misma
 * `liquidarEmpleado()` que usa la emisión real, así que el número que ve el
 * usuario aquí es el mismo que se firmaría y enviaría a la DIAN si nada
 * cambia entre "liquidado" y "emitido" (si algo cambia — se agrega o borra
 * una novedad — 'emitido' vuelve a calcular por su cuenta, este snapshot no
 * se usa para emitir).
 *
 * @returns {{
 *   employees: Array<{ employeeId, employeeName, devengadosTotal, deduccionesTotal, netoTotal, lines }>,
 *   totals: { devengados, deducciones, neto, count },
 * }}
 */
async function previewPayrollPeriod(period, tenantId) {
  const employees = await getEmployeesActiveInPeriod(tenantId, period);
  const autoConcepts = await getActiveAutoConcepts(tenantId);

  const rows = [];
  for (const employee of employees) {
    // eslint-disable-next-line no-await-in-loop
    const { diasNoRemunerados, novedadesDian } = await getNovedadesParaLiquidacion(tenantId, employee.id, period.id);
    const liquidation = liquidarEmpleado({
      employee, period, novedades: novedadesDian, autoConcepts, diasNoRemunerados, softwareSecurityCode: null,
    });
    rows.push({
      employeeId: employee.id,
      employeeName: `${employee.first_name} ${employee.first_surname}`,
      devengadosTotal: liquidation.devengadosTotal,
      deduccionesTotal: liquidation.deduccionesTotal,
      netoTotal: liquidation.devengadosTotal - liquidation.deduccionesTotal,
      lines: resumenLiquidacionParaImpresion(liquidation),
    });
  }

  const totals = rows.reduce((acc, r) => ({
    devengados: acc.devengados + r.devengadosTotal,
    deducciones: acc.deducciones + r.deduccionesTotal,
    neto: acc.neto + r.netoTotal,
    count: acc.count + 1,
  }), { devengados: 0, deducciones: 0, neto: 0, count: 0 });

  return { employees: rows, totals };
}

/**
 * Punto de entrada — emite el periodo completo.
 *
 * @returns {{
 *   allAccepted: boolean,
 *   results: Array<{employee, liquidation, accepted, error}>,
 *   accountingEntry: object|null
 * }}
 */
async function submitPayrollPeriod(period, tenant, userId) {
  const cfg = extractDianConfig(tenant);
  const isTest = cfg.environment !== 'production';
  // Se resuelve una vez arriba solo para fallar rápido con un mensaje claro
  // si el tenant no configuró la resolución de nómina — getNextConsecutive()
  // vuelve a resolverla internamente por cada documento (documentType
  // 'payroll'), no hace falta pasarla explícitamente.
  await getPayrollResolution(tenant.id, isTest);

  const employees = await getEmployeesActiveInPeriod(tenant.id, period);
  if (!employees.length) {
    throw new Error('No hay empleados activos para este periodo — no se puede emitir un periodo vacío.');
  }
  const autoConcepts = await getActiveAutoConcepts(tenant.id);

  const results = [];
  for (const employee of employees) {
    // Secuencial, no Promise.all: cada documento consume un consecutivo de
    // la MISMA resolución (getNextConsecutive ya bloquea la fila dentro de
    // su propia transacción, pero paralelizar aquí solo añadiría contención
    // sin beneficio real — el envío SOAP a DIAN es el cuello de botella, no
    // algo que valga la pena paralelizar contra un servicio gubernamental).
    // eslint-disable-next-line no-await-in-loop
    const result = await emitirDocumentoEmpleado({ tenant, period, employee, isTest, autoConcepts });
    results.push(result);
  }

  const allAccepted = results.every(r => r.accepted);
  let accountingEntry = null;

  if (allAccepted) {
    const liquidations = results.map(r => ({ employee: r.employee, liquidation: r.liquidation }));
    accountingEntry = await generatePayrollEntry(period, liquidations, tenant.id, userId);
  } else {
    logger.warn(`[Nómina] Periodo ${period.id}: ${results.filter(r => !r.accepted).length} de ${results.length} documentos NO fueron aceptados — no se genera el asiento contable hasta que todos queden aceptados.`);
  }

  return { allAccepted, results, accountingEntry };
}

module.exports = {
  getEmployeesActiveInPeriod,
  getNovedadesParaLiquidacion,
  getActiveAutoConcepts,
  previewPayrollPeriod,
  submitPayrollPeriod,
  getPayrollResolution,
  // Exportado para payrollTerminationService.js (mejora #7): la
  // liquidación definitiva emite el Documento Soporte de UN empleado
  // dentro de su propio PayrollPeriod ('liquidacion'), sin pasar por
  // submitPayrollPeriod/getEmployeesActiveInPeriod (esas dos asumen un
  // periodo compartido filtrado por payroll_periodicity, que no aplica
  // acá) -- pero el envío a la DIAN en sí (numeración, firma, DianEvent,
  // correo, idempotencia) es exactamente el mismo por documento, así que
  // se reutiliza tal cual en vez de duplicarlo.
  emitirDocumentoEmpleado,
};