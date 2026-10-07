// backend/src/services/payroll/pila/pila.service.js
//
// Planilla PILA de un mes (tipo E, empleados) a partir de la nómina ya
// emitida: junta las liquidaciones vigentes de los periodos del mes
// (mensual o las dos quincenas, más liquidaciones definitivas), calcula
// cada cotizante (pilaCalc.js) y arma el archivo plano (pilaLayout.js).
// Toda la empresa (todas las sedes) va en una sola planilla: se paga por NIT.
//
// Periodo: pensión y riesgos con el mes liquidado; salud con el mes
// siguiente (trabajadores dependientes).

const { Op } = require('sequelize');
const { buildHeader, buildDetail } = require('./pilaLayout');
const { computeCotizante } = require('./pilaCalc');

const models = () => require('../../../models');

const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

async function buildPila(tenantId, year, month) {
  const { Tenant, PayrollPeriod, PayrollDocument, PayrollDocumentAdjustment, PayrollNovedad, PayrollSetting, Employee, Supplier } = models();
  const { liquidacionVigente, basesDeLiquidacion } = require('../payrollAccountingService');
  const { PAYROLL_CONSTANTS } = require('../payrollService');
  const { computeNitCheckDigit } = require('../../dian/dianKitAdapter');

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mesInicio = ymd(year, month, 1);
  const mesFin = ymd(year, month, lastDay);
  const warnings = [];

  const tenant = await Tenant.findByPk(tenantId);
  const settings = (await PayrollSetting.findOne({ where: { tenant_id: tenantId } }))?.get({ plain: true }) || {};
  const cfg = tenant?.dian_config || {};

  // Periodos del mes: los que empiezan en el mes (mensual/quincenal) y las
  // liquidaciones definitivas que terminan en él.
  const periods = await PayrollPeriod.findAll({
    where: {
      tenant_id: tenantId,
      [Op.or]: [
        { period_type: { [Op.in]: ['mensual', 'quincenal'] }, start_date: { [Op.between]: [mesInicio, mesFin] } },
        { period_type: 'liquidacion', end_date: { [Op.between]: [mesInicio, mesFin] } },
      ],
    },
    order: [['start_date', 'ASC']],
  });
  const incluidos = periods.filter((p) => ['emitido', 'cerrado'].includes(p.status));
  const pendientes = periods.filter((p) => !['emitido', 'cerrado'].includes(p.status));
  if (!periods.length) warnings.push('No hay periodos de nómina en este mes.');
  for (const p of pendientes) {
    warnings.push(`El periodo ${p.start_date} a ${p.end_date} está "${p.status}": no se incluye hasta emitirlo.`);
  }

  const periodIds = incluidos.map((p) => p.id);
  const docs = periodIds.length ? await PayrollDocument.findAll({
    where: { tenant_id: tenantId, payroll_period_id: { [Op.in]: periodIds } },
    include: [{ model: Employee, as: 'employee' }, { model: PayrollDocumentAdjustment, as: 'adjustments', required: false }],
  }) : [];
  const unpaid = periodIds.length ? await PayrollNovedad.findAll({
    where: { tenant_id: tenantId, payroll_period_id: { [Op.in]: periodIds }, unpaid_days: { [Op.gt]: 0 } },
    attributes: ['employee_id', 'unpaid_days'],
  }) : [];

  // Agrupar por empleado
  const byEmployee = new Map();
  for (const d of docs) {
    const liquidation = liquidacionVigente(d);
    if (!d.employee || !liquidation) continue;
    const entry = byEmployee.get(d.employee_id) || { employee: d.employee.get({ plain: true }), liquidations: [], unpaidDays: 0 };
    entry.liquidations.push(liquidation);
    byEmployee.set(d.employee_id, entry);
  }
  for (const u of unpaid) {
    const entry = byEmployee.get(u.employee_id);
    if (entry) entry.unpaidDays += Number(u.unpaid_days || 0);
  }

  // Códigos PILA de las administradoras
  const supplierIds = new Set([settings.arl_supplier_id, settings.ccf_supplier_id].filter(Boolean));
  for (const { employee } of byEmployee.values()) {
    if (employee.eps_supplier_id) supplierIds.add(employee.eps_supplier_id);
    if (employee.pension_fund_supplier_id) supplierIds.add(employee.pension_fund_supplier_id);
  }
  const suppliers = supplierIds.size ? await Supplier.findAll({ where: { tenant_id: tenantId, id: { [Op.in]: [...supplierIds] } }, attributes: ['id', 'pila_code', 'name'] }) : [];
  const code = (id) => (id ? suppliers.find((s) => s.id === id)?.pila_code || '' : '');
  const codigoArl = code(settings.arl_supplier_id);
  const codigoCcf = code(settings.ccf_supplier_id);
  if (!codigoArl) warnings.push('Falta el código PILA de la ARL de la empresa (Configuración de Nómina → ARL, y en Proveedores su código PILA).');

  const rows = [...byEmployee.values()]
    .sort((a, b) => `${a.employee.first_surname} ${a.employee.first_name}`.localeCompare(`${b.employee.first_surname} ${b.employee.first_name}`))
    .map(({ employee, liquidations, unpaidDays }) => {
      const r = computeCotizante({
        employee,
        liquidations,
        unpaidDays,
        period: { year, month },
        settings,
        codes: { eps: code(employee.eps_supplier_id), afp: code(employee.pension_fund_supplier_id), ccf: codigoCcf, arl: codigoArl },
        smlmv: PAYROLL_CONSTANTS.SMLMV,
        defaultCityCode: cfg.city_code,
        ibcFallback: (l) => basesDeLiquidacion(l).ibc,
      });
      return {
        employee_id: employee.id,
        name: [employee.first_name, employee.other_names, employee.first_surname, employee.second_surname].filter(Boolean).join(' '),
        document: employee.document_number,
        ...r,
      };
    });

  const nit = String(cfg.nit || tenant?.tax_id || '').replace(/\D/g, '');
  if (!nit) warnings.push('Falta el NIT de la empresa (Configuración DIAN).');
  const dv = cfg.dv ?? (nit ? computeNitCheckDigit(nit) : '');
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };

  const header = {
    modalidad: '0',
    secuencia: 1,
    razonSocial: cfg.company_name || tenant?.business_name || tenant?.company_name || '',
    tipoDoc: 'NI',
    nit,
    dv,
    tipoPlanilla: 'E',
    formaPresentacion: settings.pila_presentation_form || 'U',
    codigoSucursal: settings.pila_branch_code || '',
    nombreSucursal: settings.pila_branch_name || '',
    codigoArl,
    periodoPension: `${year}-${String(month).padStart(2, '0')}`,
    periodoSalud: `${next.y}-${String(next.m).padStart(2, '0')}`,
    numeroCotizantes: rows.length,
    valorNomina: rows.reduce((s, r) => s + r.lines.reduce((x, l) => x + (l.ibcCcf || 0), 0), 0),
    tipoAportante: settings.pila_contributor_type || '01',
    codigoOperador: '00',
  };

  // Registros 02: una línea por novedad (ver pilaCalc.js), secuencia continua.
  const details = rows.flatMap((r) => r.lines).map((l, i) => ({ secuencia: i + 1, ...l }));
  const lines = [buildHeader(header), ...details.map((d) => buildDetail(d))];
  const totals = rows.reduce((t, r) => {
    for (const k of ['ibc', 'salud', 'pension', 'arl', 'ccf', 'sena', 'icbf', 'total']) t[k] = (t[k] || 0) + (r.summary[k] || 0);
    return t;
  }, {});

  return {
    period: header.periodoPension,
    periodoSalud: header.periodoSalud,
    header,
    rows,
    details,
    totals,
    warnings,
    periods: periods.map((p) => ({ id: p.id, start_date: p.start_date, end_date: p.end_date, status: p.status, type: p.period_type, included: incluidos.includes(p) })),
    txt: `${lines.join('\r\n')}\r\n`,
  };
}

module.exports = { buildPila };
