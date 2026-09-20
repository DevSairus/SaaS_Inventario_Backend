// backend/src/services/exogena/format2276.service.js
//
// Formato 2276 — Información de rentas de trabajo y pensiones (certificado
// de ingresos y retenciones a empleados).
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo D.
// Anexo técnico: T3.45 (F2276 v4, Resolución 000227/2025).
//
// Agrega PayrollDocument (por periodo liquidado, filtrado por año vía
// PayrollPeriod) por empleado. Usa el modelo Sequelize directo (no SQL
// crudo): el schema-per-tenant ya se resuelve automáticamente para modelos
// (ver registerTenantSchemaHooks.js) y la lógica de reemplazo/eliminación
// de PayrollDocumentAdjustment es más clara en JS que en SQL.
//
// Mapeo de snapshot_liquidation → atributos del formato (best-effort, dado
// que liquidarEmpleado() no discrimina cada concepto DIAN por separado):
//   pasa   = básico + horas extra/recargos + bonificaciones (lo salarial)
//   paco   = comisiones
//   papre  = primas + vacaciones (prestaciones sociales, sin cesantías)
//   cein   = cesantías pagadas directamente (solo periodos de liquidación/retiro)
//   ceco   = cesantías consignadas al fondo (empleados activos)
//   apos/apof = aportes obligatorios salud/pensión retenidos al trabajador
//   apov/apafc = aportes voluntarios pensión/AFC
//   vare   = retención en la fuente
// Los demás atributos (paec, pabop, vaex, paho, pase, pavia, paga, patra,
// vapo, potro, auce, peju, aprais, apavc, ivav, rfiva, pagahuvt, vilap) no
// tienen fuente confiable en el motor de nómina actual y se reportan en 0
// -- si algún empleado tiene alguno de estos conceptos, se debe ajustar a
// mano por ahora (ver TODO en exogenaReadiness.service.js).
// Nota: el auxilio de transporte NO se reporta (no es ingreso gravable).

const { PayrollDocument, PayrollDocumentAdjustment, PayrollPeriod, Employee } = require('../../models');
const { Op } = require('sequelize');
const { COLOMBIA_COUNTRY_CODE } = require('../../data/exogena-catalogs');

function sumArrayField(arr, field) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((sum, item) => sum + Number(item?.[field] ?? item?.pago ?? item?.pagoNS ?? 0), 0);
}

function extractIncome(snapshot) {
  const d = snapshot?.devengados || {};
  const basico = Number(d.basico?.sueldoTrabajado || 0);
  const extras = ['heds', 'hens', 'heddfs', 'hendfs', 'hrns', 'hrddfs', 'hrndfs']
    .reduce((sum, key) => sum + sumArrayField(d[key], 'pago'), 0);
  const bonificaciones = sumArrayField(d.bonificaciones, 'pago');
  const comisiones = sumArrayField(d.comisiones, 'pago');
  const primas = Number(d.primas?.pago || d.primas?.valor || 0);
  const vacaciones = Number(d.vacaciones?.pago || d.vacaciones?.valor || 0);
  const cesantias = Number(d.cesantias?.pago || d.cesantias?.valor || d.cesantias?.cesantias || 0);

  return {
    pasa: basico + extras + bonificaciones,
    paco: comisiones,
    papre: primas + vacaciones,
    cesantias,
  };
}

function extractDeductions(snapshot) {
  const ded = snapshot?.deducciones || {};
  return {
    apos: Number(ded.salud?.deduccion || 0),
    apof: Number(ded.fondoPension?.deduccion || 0) + Number(ded.fondoSP?.deduccionSP || 0),
    apov: Number(ded.pensionVoluntaria || 0),
    apafc: Number(ded.afc || 0),
    vare: Number(ded.retencionFuente || 0),
  };
}

// Devuelve la liquidación efectiva de un PayrollDocument, resolviendo la
// última nota de ajuste ACEPTADA (replace/delete) si existe -- ver hallazgo
// del agente de exploración sobre PayrollDocumentAdjustment.
function resolveEffective(doc, adjustmentsByDocId) {
  const adjustments = adjustmentsByDocId.get(doc.id) || [];
  const latest = adjustments[0]; // ya vienen ordenadas DESC por created_at
  if (!latest) {
    return { snapshot: doc.snapshot_liquidation, devengadosTotal: Number(doc.devengados_total), isDeleted: false, periodId: doc.payroll_period_id };
  }
  if (latest.adjustment_type === 'delete') {
    return { isDeleted: true };
  }
  return {
    snapshot: latest.snapshot_liquidation,
    devengadosTotal: Number(latest.devengados_total),
    isDeleted: false,
    periodId: doc.payroll_period_id,
  };
}

async function buildRecords(tenantId, year) {
  const periods = await PayrollPeriod.findAll({
    where: {
      tenant_id: tenantId,
      start_date: { [Op.gte]: `${year}-01-01`, [Op.lte]: `${year}-12-31` },
    },
    attributes: ['id', 'period_type'],
  });
  const periodTypeById = new Map(periods.map((p) => [p.id, p.period_type]));
  const periodIds = periods.map((p) => p.id);
  if (periodIds.length === 0) return { records: [], skipped: [] };

  const documents = await PayrollDocument.findAll({
    where: { tenant_id: tenantId, payroll_period_id: periodIds },
    include: [{ model: Employee, as: 'employee' }],
  });

  const adjustments = await PayrollDocumentAdjustment.findAll({
    where: { tenant_id: tenantId, payroll_document_id: documents.map((d) => d.id), dian_status: 'accepted' },
    order: [['created_at', 'DESC']],
  });
  const adjustmentsByDocId = new Map();
  for (const adj of adjustments) {
    if (!adjustmentsByDocId.has(adj.payroll_document_id)) adjustmentsByDocId.set(adj.payroll_document_id, []);
    adjustmentsByDocId.get(adj.payroll_document_id).push(adj);
  }

  const byEmployee = new Map();
  const skipped = [];

  for (const doc of documents) {
    const effective = resolveEffective(doc, adjustmentsByDocId);
    if (effective.isDeleted) continue;

    const employee = doc.employee;
    if (!employee?.document_number) {
      skipped.push({ reason: 'empleado_sin_documento', employee_id: doc.employee_id });
      continue;
    }

    if (!byEmployee.has(employee.id)) {
      byEmployee.set(employee.id, {
        employee,
        pasa: 0, paco: 0, papre: 0, cein: 0, ceco: 0,
        apos: 0, apof: 0, apov: 0, apafc: 0, vare: 0,
        devengadosTotal: 0,
      });
    }
    const acc = byEmployee.get(employee.id);
    const income = extractIncome(effective.snapshot);
    const deductions = extractDeductions(effective.snapshot);
    const periodType = periodTypeById.get(effective.periodId);

    acc.pasa += income.pasa;
    acc.paco += income.paco;
    acc.papre += income.papre;
    // Cesantías pagadas directamente solo en liquidación/retiro; en
    // periodos normales se asumen consignadas al fondo (ver comentario de
    // cabecera -- el motor de nómina no distingue esto explícitamente).
    if (periodType === 'liquidacion') acc.cein += income.cesantias;
    else acc.ceco += income.cesantias;

    acc.apos += deductions.apos;
    acc.apof += deductions.apof;
    acc.apov += deductions.apov;
    acc.apafc += deductions.apafc;
    acc.vare += deductions.vare;
    acc.devengadosTotal += effective.devengadosTotal || 0;
  }

  const records = [...byEmployee.values()].map(({ employee, devengadosTotal, ...totals }) => ({
    entinfo: 1, // 1 = empleador reportando directamente (no fiduciaria/tercero)
    tdocb: employee.document_type || '13',
    nitb: String(employee.document_number).replace(/\D/g, ''),
    pap: employee.first_surname || null,
    sap: employee.second_surname || null,
    pno: employee.first_name || null,
    ono: employee.other_names || null,
    dir: employee.address || null,
    dpto: employee.city_code ? String(employee.city_code).padStart(5, '0').slice(0, 2) : null,
    mun: employee.city_code ? String(employee.city_code).padStart(5, '0').slice(2, 5) : null,
    pais: COLOMBIA_COUNTRY_CODE,
    pasa: Math.round(totals.pasa),
    paec: 0, pabop: 0, vaex: 0, paho: 0, pase: 0,
    paco: Math.round(totals.paco),
    papre: Math.round(totals.papre),
    pavia: 0, paga: 0, patra: 0, vapo: 0, potro: 0,
    cein: Math.round(totals.cein),
    ceco: Math.round(totals.ceco),
    auce: 0,
    peju: 0,
    tingbtp: Math.round(devengadosTotal),
    apos: Math.round(totals.apos),
    apof: Math.round(totals.apof),
    aprais: 0,
    apov: Math.round(totals.apov),
    apafc: Math.round(totals.apafc),
    apavc: 0,
    vare: Math.round(totals.vare),
    ivav: 0,
    rfiva: 0,
    pagahuvt: 0,
    vilap: 0,
  }));

  return { records, skipped };
}

module.exports = {
  formatCode: '2276',
  version: 4,
  recordElementName: 'rentra',
  totalValueField: 'tingbtp',
  buildRecords,
};
