// backend/src/services/payroll/payrollDashboardService.js
//
// Dashboard de costos de nómina (Mejoras-Nomina-Sin-PILA-Nexora.md, punto
// #8): "costo total por sede/mes, comparativo devengado vs. deducciones,
// tendencia de novedades por categoría. Toda la data granular ya existe
// en PayrollDocument/PayrollNovedad -- prácticamente solo consultas de
// agregación + un par de gráficas."
//
// Solo lectura, nada nuevo que persistir. Como con los certificados
// (mejora #6), la fuente de verdad es `PayrollDocument` con
// dian_status='accepted' -- lo que de verdad se le pagó al empleado y
// quedó aceptado por la DIAN, no periodos en borrador ni novedades
// cargadas pero nunca liquidadas.
'use strict';

const { fn, col, Op } = require('sequelize');
const {
  PayrollDocument, PayrollPeriod, PayrollNovedad, Branch,
} = require('../../models');
const { sumarValorNovedad, CONCEPT_LABELS, DIAN_CATEGORY_MAP } = require('./payrollService');

const MES_TRUNC = () => fn('date_trunc', 'month', col('period.end_date'));

function rangoPorDefecto({ desde, hasta } = {}) {
  // Últimos 12 meses cerrados en `hasta` (hoy, si no se especifica) --
  // mismo criterio de "ventana razonable por defecto" que
  // ContractAlertsPage.jsx usa para su selector (30 días), solo que acá
  // el dato es mensual.
  const fin = hasta ? new Date(`${hasta}T00:00:00Z`) : new Date();
  const inicio = desde ? new Date(`${desde}T00:00:00Z`) : new Date(Date.UTC(fin.getUTCFullYear() - 1, fin.getUTCMonth(), 1));
  return { desde: inicio.toISOString().slice(0, 10), hasta: fin.toISOString().slice(0, 10) };
}

/**
 * Costo total por sede y mes (Básico+Auxilio+novedades / deducciones /
 * neto pagado), solo de documentos ya aceptados por la DIAN.
 */
async function getCostosPorSedeMes(tenantId, opciones = {}) {
  const { desde, hasta } = rangoPorDefecto(opciones);

  const rows = await PayrollDocument.findAll({
    where: {
      tenant_id: tenantId,
      dian_status: 'accepted',
      '$period.end_date$': { [Op.between]: [desde, hasta] },
      ...(opciones.branch_id ? { branch_id: opciones.branch_id } : {}),
    },
    attributes: [
      [MES_TRUNC(), 'mes'],
      [col('PayrollDocument.branch_id'), 'branch_id'],
      [fn('SUM', col('PayrollDocument.devengados_total')), 'devengados'],
      [fn('SUM', col('PayrollDocument.deducciones_total')), 'deducciones'],
      [fn('SUM', col('PayrollDocument.comprobante_total')), 'neto'],
      [fn('COUNT', col('PayrollDocument.id')), 'documentos'],
    ],
    include: [
      { model: PayrollPeriod, as: 'period', attributes: [], required: true },
      { model: Branch, as: 'branch', attributes: ['id', 'name'], required: false },
    ],
    group: [MES_TRUNC(), 'PayrollDocument.branch_id', 'branch.id', 'branch.name'],
    order: [[MES_TRUNC(), 'ASC']],
    raw: false, // para poder leer row.branch?.name sin desdoblar el join a mano
  });

  return rows.map((row) => ({
    mes: row.get('mes'),
    branch_id: row.branch_id,
    branch_name: row.branch?.name || 'Sin sede asignada',
    devengados: Number(row.get('devengados')) || 0,
    deducciones: Number(row.get('deducciones')) || 0,
    neto: Number(row.get('neto')) || 0,
    documentos: Number(row.get('documentos')) || 0,
  }));
}

/**
 * Comparativo mensual devengado vs. deducciones, agregado de TODAS las
 * sedes -- la vista "de un vistazo" para la gráfica principal del
 * dashboard.
 */
async function getComparativoDevengadoDeducciones(tenantId, opciones = {}) {
  const { desde, hasta } = rangoPorDefecto(opciones);

  const rows = await PayrollDocument.findAll({
    where: {
      tenant_id: tenantId,
      dian_status: 'accepted',
      '$period.end_date$': { [Op.between]: [desde, hasta] },
      ...(opciones.branch_id ? { branch_id: opciones.branch_id } : {}),
    },
    attributes: [
      [MES_TRUNC(), 'mes'],
      [fn('SUM', col('PayrollDocument.devengados_total')), 'devengados'],
      [fn('SUM', col('PayrollDocument.deducciones_total')), 'deducciones'],
      [fn('SUM', col('PayrollDocument.comprobante_total')), 'neto'],
      [fn('COUNT', col('PayrollDocument.id')), 'documentos'],
    ],
    include: [{ model: PayrollPeriod, as: 'period', attributes: [], required: true }],
    group: [MES_TRUNC()],
    order: [[MES_TRUNC(), 'ASC']],
    raw: true,
  });

  return rows.map((row) => ({
    mes: row.mes,
    devengados: Number(row.devengados) || 0,
    deducciones: Number(row.deducciones) || 0,
    neto: Number(row.neto) || 0,
    documentos: Number(row.documentos) || 0,
  }));
}

/**
 * Tendencia mensual de novedades por categoría DIAN (horas extra,
 * incapacidades, bonificaciones, etc.) -- solo de periodos que ya tienen
 * al menos un PayrollDocument aceptado (para no mezclar novedades
 * cargadas en un periodo todavía abierto/nunca liquidado con las que sí
 * se pagaron de verdad).
 *
 * La suma no puede hacerse en SQL porque el valor de cada novedad vive
 * dentro de un JSONB de forma distinta según la categoría (objeto simple,
 * objeto con arreglos anidados, o número plano -- ver DIAN_CATEGORY_MAP en
 * payrollService.js) -- se reutiliza `sumarValorNovedad()`, la misma
 * función que ya usa el resto del módulo para esto, en vez de reescribir
 * esa lógica en SQL.
 */
async function getTendenciaNovedadesPorCategoria(tenantId, opciones = {}) {
  const { desde, hasta } = rangoPorDefecto(opciones);

  const periodosConDocumentoAceptado = await PayrollPeriod.findAll({
    where: {
      tenant_id: tenantId,
      end_date: { [Op.between]: [desde, hasta] },
      '$documents.dian_status$': 'accepted',
      ...(opciones.branch_id ? { branch_id: opciones.branch_id } : {}),
    },
    include: [{ association: 'documents', attributes: [], required: true }],
    attributes: ['id', 'end_date'],
    group: ['PayrollPeriod.id'],
    raw: true,
  });

  if (periodosConDocumentoAceptado.length === 0) return [];

  const finDePeriodoPorId = new Map(periodosConDocumentoAceptado.map((p) => [p.id, p.end_date]));

  const novedades = await PayrollNovedad.findAll({
    where: { tenant_id: tenantId, payroll_period_id: { [Op.in]: [...finDePeriodoPorId.keys()] } },
    attributes: ['dian_category', 'payload', 'payroll_period_id'],
    raw: true,
  });

  // acumulador: "YYYY-MM" -> { categoria -> valor }
  const porMesYCategoria = new Map();
  for (const nov of novedades) {
    const finPeriodo = finDePeriodoPorId.get(nov.payroll_period_id);
    if (!finPeriodo) continue;
    const mes = String(finPeriodo).slice(0, 7); // 'YYYY-MM'
    const valor = sumarValorNovedad(typeof nov.payload === 'string' ? JSON.parse(nov.payload) : nov.payload);
    if (!valor) continue;

    if (!porMesYCategoria.has(mes)) porMesYCategoria.set(mes, {});
    const bucket = porMesYCategoria.get(mes);
    bucket[nov.dian_category] = (bucket[nov.dian_category] || 0) + valor;
  }

  return [...porMesYCategoria.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([mes, categorias]) => ({
      mes,
      categorias: Object.entries(categorias)
        .map(([dian_category, valor]) => ({
          dian_category,
          // El label legible sale de la MISMA tabla que usa el resto del
          // módulo (DIAN_CATEGORY_MAP → key interno → CONCEPT_LABELS) en
          // vez de adivinar la transformación de mayúsculas/minúsculas
          // (dian_category no sigue un patrón uniforme: 'HEDs', 'AFC',
          // 'Cesantias' se abrevian distinto).
          label: CONCEPT_LABELS[DIAN_CATEGORY_MAP[dian_category]?.key] || dian_category,
          valor,
        }))
        .sort((a, b) => b.valor - a.valor),
    }));
}

/**
 * Todo lo anterior en una sola llamada -- lo que consume la página del
 * dashboard.
 */
async function getDashboardCostos(tenantId, opciones = {}) {
  const [porSedeMes, comparativo, tendenciaNovedades] = await Promise.all([
    getCostosPorSedeMes(tenantId, opciones),
    getComparativoDevengadoDeducciones(tenantId, opciones),
    getTendenciaNovedadesPorCategoria(tenantId, opciones),
  ]);

  const totalPeriodo = comparativo.reduce((acc, m) => ({
    devengados: acc.devengados + m.devengados,
    deducciones: acc.deducciones + m.deducciones,
    neto: acc.neto + m.neto,
    documentos: acc.documentos + m.documentos,
  }), {
    devengados: 0, deducciones: 0, neto: 0, documentos: 0,
  });

  return {
    rango: rangoPorDefecto(opciones),
    totalPeriodo,
    porSedeMes,
    comparativo,
    tendenciaNovedades,
  };
}

module.exports = {
  rangoPorDefecto,
  getCostosPorSedeMes,
  getComparativoDevengadoDeducciones,
  getTendenciaNovedadesPorCategoria,
  getDashboardCostos,
};
