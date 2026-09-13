// backend/src/services/payroll/payrollCertificateService.js
/**
 * Certificado de Ingresos y Retenciones (Formulario 220) — mejora #6 del
 * plan de mejoras sin PILA.
 *
 * NO reinventa el cálculo: agrega, por empleado y año fiscal, los
 * PayrollDocument ya emitidos (dian_status='accepted') usando la misma
 * `resumenLiquidacionParaImpresion()` que ya usa payrollPdfService.js y el
 * detalle del documento — así el certificado siempre cuadra línea por línea
 * con lo que el empleado ya vio en cada comprobante mensual/quincenal, sin
 * un segundo camino de cálculo que se pueda desincronizar.
 *
 * IMPORTANTE — alcance y limitaciones a propósito:
 *  - El Formulario 220 oficial (Resolución DIAN de cada año) tiene casillas
 *    numeradas que pueden cambiar de un año a otro. Este servicio NO intenta
 *    reproducir el formato exacto casilla por casilla — genera el
 *    CONTENIDO que exige el Art. 379 del Estatuto Tributario (concepto,
 *    valor total pagado, retenciones practicadas) agrupado de forma que sea
 *    fácil de trasladar al formulario vigente. Antes de cada temporada de
 *    certificados (marzo), verificar la estructura contra la plantilla
 *    oficial del año en curso — igual que ya se advierte para
 *    PAYROLL_CONSTANTS en payrollService.js.
 *  - La separación ingresos "gravados" vs "no gravados/exentos" es MEJOR
 *    ESFUERZO (excluye auxilio de transporte —no salarial— e indemnización
 *    y cesantías/intereses —tratamiento especial Art. 206 ET—, sin aplicar
 *    los topes de exención vigentes). Un contador debe revisar el resultado
 *    antes de presentarlo como certificado oficial firmado.
 *  - Solo cuenta PayrollDocument con dian_status='accepted' — un documento
 *    'rejected' o 'pending' no es un pago legalmente soportado todavía.
 */
'use strict';

const { Op } = require('sequelize');
const { resumenLiquidacionParaImpresion } = require('./payrollService');

// Labels de resumenLiquidacionParaImpresion que se tratan distinto al resto
// (no constitutivos de renta / tratamiento especial) — el resto de líneas de
// devengados cae en "ingresosLaboralesGravados" tal cual.
const LABEL_AUXILIO_TRANSPORTE = 'Auxilio de transporte';
const LABEL_CESANTIAS = 'Cesantías e intereses';
const LABEL_INDEMNIZACION = 'Indemnización';

const LABEL_SALUD = 'Salud (empleado)';
const LABEL_PENSION = 'Fondo de pensión (empleado)';
const LABEL_FONDO_SP = 'Fondo de solidaridad pensional';
const LABEL_PENSION_VOLUNTARIA = 'Pensión voluntaria';
const LABEL_AFC = 'Cuenta AFC';
const LABEL_RETENCION_FUENTE = 'Retención en la fuente';

function acumularLineas(target, lines) {
  for (const { label, amount } of lines || []) {
    target[label] = (target[label] || 0) + (Number(amount) || 0);
  }
}

/**
 * Trae los PayrollDocument aceptados de un empleado cuyo periodo cae dentro
 * del año fiscal dado (por fecha de inicio del periodo).
 */
async function getAcceptedDocumentsForYear({ tenant_id, employee_id, year, models }) {
  const { PayrollDocument, PayrollPeriod } = models;
  return PayrollDocument.findAll({
    where: {
      tenant_id,
      employee_id,
      dian_status: 'accepted',
    },
    include: [{
      model: PayrollPeriod,
      as: 'period',
      required: true,
      where: {
        start_date: { [Op.gte]: `${year}-01-01`, [Op.lte]: `${year}-12-31` },
      },
    }],
    order: [[{ model: PayrollPeriod, as: 'period' }, 'start_date', 'ASC']],
  });
}

/**
 * Agrega los documentos ya cargados en un resumen listo para imprimir o
 * exponer por API. `documents` debe traer `snapshot_liquidation` (no
 * requiere el include de period para esta parte).
 */
function summarizeDocuments(documents) {
  const devengadosPorConcepto = {};
  const deduccionesPorConcepto = {};
  let totalDevengados = 0;
  let totalDeducciones = 0;
  let totalNeto = 0;
  let documentosSinLiquidacion = 0;

  for (const doc of documents) {
    totalDevengados += Number(doc.devengados_total) || 0;
    totalDeducciones += Number(doc.deducciones_total) || 0;
    totalNeto += Number(doc.comprobante_total) || 0;

    if (!doc.snapshot_liquidation) {
      documentosSinLiquidacion += 1;
      continue;
    }
    const { devengadosLines, deduccionesLines } = resumenLiquidacionParaImpresion(doc.snapshot_liquidation);
    acumularLineas(devengadosPorConcepto, devengadosLines);
    acumularLineas(deduccionesPorConcepto, deduccionesLines);
  }

  const auxilioTransporte = devengadosPorConcepto[LABEL_AUXILIO_TRANSPORTE] || 0;
  const cesantiasEIntereses = devengadosPorConcepto[LABEL_CESANTIAS] || 0;
  const indemnizacion = devengadosPorConcepto[LABEL_INDEMNIZACION] || 0;

  // "Ingresos laborales gravados" = todo lo demás (best-effort, ver aviso
  // de cabecera del archivo).
  const ingresosLaboralesGravados = totalDevengados - auxilioTransporte - cesantiasEIntereses - indemnizacion;

  const aportesSalud = deduccionesPorConcepto[LABEL_SALUD] || 0;
  const aportesPensionObligatoria = (deduccionesPorConcepto[LABEL_PENSION] || 0) + (deduccionesPorConcepto[LABEL_FONDO_SP] || 0);
  const aportesPensionVoluntaria = deduccionesPorConcepto[LABEL_PENSION_VOLUNTARIA] || 0;
  const aportesAFC = deduccionesPorConcepto[LABEL_AFC] || 0;
  const retencionFuente = deduccionesPorConcepto[LABEL_RETENCION_FUENTE] || 0;

  return {
    documentosCount: documents.length,
    documentosSinLiquidacion,
    totales: {
      totalDevengados,
      totalDeducciones,
      totalNeto,
    },
    ingresos: {
      ingresosLaboralesGravados,
      auxilioTransporte,
      cesantiasEIntereses,
      indemnizacion,
    },
    deducciones: {
      aportesSalud,
      aportesPensionObligatoria,
      aportesPensionVoluntaria,
      aportesAFC,
      retencionFuente,
    },
    devengadosPorConcepto,
    deduccionesPorConcepto,
  };
}

/**
 * @returns {object|null} null si el empleado no tiene ningún documento
 *   aceptado en ese año (no hay nada que certificar).
 */
async function getAnnualCertificateSummary({ tenant_id, employee_id, year, models }) {
  const documents = await getAcceptedDocumentsForYear({ tenant_id, employee_id, year, models });
  if (!documents.length) return null;
  return { year, employee_id, ...summarizeDocuments(documents), documents };
}

/**
 * Lista, para el año dado, todos los empleados del tenant que tienen al
 * menos un PayrollDocument aceptado — con el total neto pagado en el año,
 * para la vista de "certificados disponibles" (no trae el detalle línea a
 * línea, eso se pide por separado con getAnnualCertificateSummary).
 */
async function listEmployeesWithCertificates({ tenant_id, year, models }) {
  const { PayrollDocument, PayrollPeriod, Employee } = models;
  const documents = await PayrollDocument.findAll({
    where: { tenant_id, dian_status: 'accepted' },
    include: [
      {
        model: PayrollPeriod,
        as: 'period',
        required: true,
        attributes: [],
        where: { start_date: { [Op.gte]: `${year}-01-01`, [Op.lte]: `${year}-12-31` } },
      },
      { model: Employee, as: 'employee', attributes: ['id', 'first_name', 'other_names', 'first_surname', 'second_surname', 'document_type', 'document_number'] },
    ],
  });

  const byEmployee = new Map();
  for (const doc of documents) {
    const emp = doc.employee;
    if (!emp) continue;
    if (!byEmployee.has(emp.id)) {
      byEmployee.set(emp.id, {
        employee_id: emp.id,
        employee: emp,
        documentsCount: 0,
        totalDevengados: 0,
        totalNeto: 0,
      });
    }
    const entry = byEmployee.get(emp.id);
    entry.documentsCount += 1;
    entry.totalDevengados += Number(doc.devengados_total) || 0;
    entry.totalNeto += Number(doc.comprobante_total) || 0;
  }

  return Array.from(byEmployee.values()).sort((a, b) => {
    const nameA = `${a.employee.first_surname || ''} ${a.employee.first_name || ''}`;
    const nameB = `${b.employee.first_surname || ''} ${b.employee.first_name || ''}`;
    return nameA.localeCompare(nameB);
  });
}

module.exports = {
  getAcceptedDocumentsForYear,
  summarizeDocuments,
  getAnnualCertificateSummary,
  listEmployeesWithCertificates,
};
