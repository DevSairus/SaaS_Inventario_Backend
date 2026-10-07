// backend/src/services/payroll/pila/pilaImport.service.js
//
// Importación de una planilla PILA ya pagada (la del mes anterior, tal como
// la exporta el operador o el software que usaba la empresa) para:
//   1) precargar lo que Pitbox necesita para generar la siguiente sin
//      digitarlo: códigos PILA de EPS/AFP/caja/ARL, tipo y subtipo de
//      cotizante, clase y tarifa ARL, centro de trabajo, actividad
//      económica, municipio de trabajo, datos del aportante;
//   2) comparar contra lo que Pitbox genera para ese mismo mes (si su
//      nómina está emitida en Pitbox).
// analyze() no escribe nada: devuelve cambios propuestos con un id, y
// apply() aplica solo los que el usuario confirmó (lista blanca de campos).
//
// Formatos: archivo plano (TXT, Resolución 2388 -- mismo layout que
// genera Pitbox) o su equivalente en Excel (una fila por registro, mismas
// columnas en el mismo orden: 22 del encabezado y 98 por cotizante).

const { Op } = require('sequelize');
const { R1, R2, parseRecord } = require('./pilaLayout');
const { ARL_TARIFAS } = require('./pilaCalc');
const { DIVIPOLA_CITIES, DIVIPOLA_DEPARTMENTS } = require('../../../data/divipola-colombia');

const models = () => require('../../../models');

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const clean = (v) => String(v ?? '').trim();

/* ── Lectura ─────────────────────────────────────────────────────────── */

function parseTxt(buffer) {
  // Los operadores exportan en UTF-8 (con o sin BOM) o ANSI; el layout es
  // ASCII, así que basta con quitar el BOM.
  let text = buffer.toString('utf8');
  if (text.includes('�')) text = buffer.toString('latin1');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const header = lines.find((l) => l.startsWith('01'));
  const details = lines.filter((l) => l.startsWith('02'));
  if (!header || !details.length) throw new Error('El archivo no parece una planilla PILA (faltan registros tipo 01 o 02).');
  const bad = details.find((l) => l.length < 690);
  if (bad) throw new Error(`Una línea de cotizante tiene ${bad.length} posiciones (se esperaban 693): el archivo no tiene el formato estándar.`);
  const trim = (rec) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v.trim()]));
  return {
    header: trim(parseRecord(R1, header.padEnd(359, ' '))),
    details: details.map((l) => trim(parseRecord(R2, l.padEnd(693, ' ')))),
  };
}

async function parseXlsx(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const val = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if (v.result !== undefined) return v.result;
      if (v.richText) return v.richText.map((t) => t.text).join('');
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (v.text !== undefined) return v.text;
    }
    return v;
  };
  let header = null;
  const details = [];
  ws.eachRow((row) => {
    const cells = row.values.slice(1).map(val);
    const tipo = digits(cells[0]);
    if (tipo === '1' || tipo === '01') {
      header = Object.fromEntries(R1.map(([name], i) => [name, clean(cells[i])]));
    } else if (tipo === '2' || tipo === '02') {
      details.push(Object.fromEntries(R2.map(([name], i) => [name, clean(cells[i])])));
    }
  });
  if (!header || !details.length) throw new Error('El Excel no tiene filas de encabezado (01) y de cotizantes (02) en el orden estándar.');
  // Excel guarda "05" como 5 y "001" como 1.
  for (const d of details) {
    if (d.departamento) d.departamento = d.departamento.padStart(2, '0');
    if (d.municipio) d.municipio = d.municipio.padStart(3, '0');
    if (d.tipoCotizante) d.tipoCotizante = d.tipoCotizante.padStart(2, '0');
    if (d.subtipoCotizante) d.subtipoCotizante = d.subtipoCotizante.padStart(2, '0');
  }
  return { header, details };
}

async function parsePilaFile(buffer, filename = '') {
  const isXlsx = /\.xlsx$/i.test(filename) || buffer.slice(0, 2).toString() === 'PK';
  return isXlsx ? parseXlsx(buffer) : parseTxt(buffer);
}

/* ── Análisis ────────────────────────────────────────────────────────── */

const num = (v) => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0;

// Un cotizante puede venir en varias líneas (una por novedad): para leer su
// configuración se toma, campo por campo, el primer valor con contenido.
const isBlank = (v) => v == null || String(v).trim() === '' || /^0+(\.0+)?$/.test(String(v).trim());
function mergeRecords(records) {
  const out = { ...records[0] };
  for (const r of records.slice(1)) {
    for (const [k, v] of Object.entries(r)) if (isBlank(out[k]) && !isBlank(v)) out[k] = v;
  }
  return out;
}
const groupByDocument = (details) => {
  const map = new Map();
  for (const d of details) {
    const k = digits(d.documento);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d);
  }
  return map;
};
const tarifa = (v) => {
  const n = num(v);
  return n > 1 ? n / 100 : n; // "0.0052200" o 0.522 (%) en Excel
};

async function analyze(tenantId, parsed) {
  const { Tenant, Employee, Supplier, PayrollSetting } = models();
  const { header, details } = parsed;
  const changes = [];
  const warnings = [];
  const add = (c) => {
    const id = `${c.entity}:${c.entity_id}:${c.field}`;
    if (!changes.some((x) => x.id === id)) changes.push({ id, selected: c.selected !== false, ...c });
  };

  const tenant = await Tenant.findByPk(tenantId);
  const cfg = tenant?.dian_config || {};
  const settings = (await PayrollSetting.findOne({ where: { tenant_id: tenantId } }))?.get({ plain: true }) || {};
  const employees = (await Employee.findAll({ where: { tenant_id: tenantId } })).map((e) => e.get({ plain: true }));
  const suppliers = (await Supplier.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'name', 'business_name', 'tax_id', 'pila_code', 'payroll_fund_types'] }))
    .map((s) => s.get({ plain: true }));
  const supplierName = (s) => s?.business_name || s?.name || '';
  const byCode = (code) => suppliers.filter((s) => s.pila_code && s.pila_code.toUpperCase() === code.toUpperCase());

  // ── Encabezado ──
  const nitPlanilla = digits(header.nit);
  const nitEmpresa = digits(cfg.nit || tenant?.tax_id);
  if (nitPlanilla && nitEmpresa && nitPlanilla !== nitEmpresa) {
    warnings.push(`La planilla es del NIT ${nitPlanilla} y la empresa tiene NIT ${nitEmpresa}: verifique que sea la planilla correcta.`);
  }
  if (header.tipoPlanilla && header.tipoPlanilla !== 'E') warnings.push(`Planilla tipo ${header.tipoPlanilla}: Pitbox genera la tipo E (empleados).`);

  const settingChange = (field, value, label, extra = {}) => {
    if (value == null || value === '' || String(settings[field] ?? '') === String(value)) return;
    add({ entity: 'settings', entity_id: tenantId, field, value, label, current: settings[field] ?? null, ...extra });
  };
  settingChange('pila_contributor_type', header.tipoAportante?.padStart(2, '0'), 'Tipo de aportante');
  settingChange('pila_presentation_form', header.formaPresentacion, 'Forma de presentación');
  settingChange('pila_branch_code', header.codigoSucursal, 'Código de sucursal');
  settingChange('pila_branch_name', header.nombreSucursal, 'Nombre de sucursal');

  // Código de una administradora de la empresa (ARL, caja): se guarda en el
  // proveedor asignado en Configuración de Nómina.
  const companyFund = (code, settingField, label) => {
    if (!code) return;
    const assignedId = settings[settingField];
    const assigned = suppliers.find((s) => s.id === assignedId);
    if (assigned) {
      if (!assigned.pila_code) {
        add({ entity: 'supplier', entity_id: assigned.id, field: 'pila_code', value: code, label: `Código PILA de ${supplierName(assigned)} (${label})`, current: null });
      } else if (assigned.pila_code.toUpperCase() !== code.toUpperCase()) {
        warnings.push(`La ${label} de la planilla es ${code}, pero la asignada en Pitbox (${supplierName(assigned)}) tiene código ${assigned.pila_code}.`);
      }
      return;
    }
    const match = byCode(code);
    if (match.length === 1) {
      add({ entity: 'settings', entity_id: tenantId, field: settingField, value: match[0].id, label: `${label} de la empresa: ${supplierName(match[0])}`, current: null });
    } else {
      warnings.push(`La planilla usa la ${label} ${code}: asígnela en Configuración de Nómina y escriba ese código PILA en el proveedor.`);
    }
  };
  companyFund(header.codigoArl || details.find((d) => d.codigoArl)?.codigoArl, 'arl_supplier_id', 'ARL');
  const ccfCodes = [...new Set(details.map((d) => d.ccf).filter(Boolean))];
  if (ccfCodes.length > 1) warnings.push(`La planilla tiene varias cajas de compensación (${ccfCodes.join(', ')}): Pitbox usa una por empresa.`);
  companyFund(ccfCodes[0], 'ccf_supplier_id', 'caja de compensación');

  // Actividad económica ARL más usada -> la de la empresa; la de cada
  // empleado solo si es distinta.
  const actividades = details.map((d) => digits(d.actividadArl)).filter((a) => a.length === 7);
  const freq = actividades.reduce((m, a) => m.set(a, (m.get(a) || 0) + 1), new Map());
  const actividadEmpresa = settings.arl_economic_activity || [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  settingChange('arl_economic_activity', actividadEmpresa, 'Actividad económica ARL de la empresa');

  // Jornada: horas laboradas / días del cotizante con 30 días.
  const completo = details.find((d) => num(d.diasArl) === 30 && num(d.horasLaboradas) > 0);
  if (completo) {
    const semanal = Math.round((num(completo.horasLaboradas) / 30) * 6 * 10) / 10;
    const { weeklyHoursFor } = require('../jornada');
    const legal = weeklyHoursFor(new Date());
    if (semanal && semanal !== legal && Number(settings.weekly_hours || 0) !== semanal) {
      add({
        entity: 'settings', entity_id: tenantId, field: 'weekly_hours', value: semanal, current: settings.weekly_hours ?? null,
        label: 'Jornada semanal', selected: false,
        note: `La planilla reporta ${num(completo.horasLaboradas)} horas al mes (${semanal} h semanales); la jornada máxima legal vigente es ${legal} h. Márquelo solo si la empresa trabaja ${semanal} h.`,
      });
    }
  }

  // ── Cotizantes ──
  const byDoc = new Map(employees.map((e) => [digits(e.document_number), e]));
  const matched = [];
  const unmatched = [];
  for (const records of groupByDocument(details).values()) {
    const d = mergeRecords(records);
    const e = byDoc.get(digits(d.documento));
    const nombre = [d.primerNombre, d.segundoNombre, d.primerApellido, d.segundoApellido].filter(Boolean).join(' ');
    if (!e) { unmatched.push({ document: d.documento, name: nombre }); continue; }
    matched.push({ employee: e, records });
    const empName = [e.first_name, e.first_surname].filter(Boolean).join(' ');
    const empChange = (field, value, label, current = e[field]) => {
      if (value == null || value === '' || String(current ?? '') === String(value)) return;
      add({ entity: 'employee', entity_id: e.id, employee_name: empName, field, value, label, current: current ?? null });
    };

    empChange('worker_type', d.tipoCotizante, 'Tipo de cotizante');
    empChange('worker_subtype', d.subtipoCotizante || '00', 'Subtipo de cotizante');
    const clase = num(d.claseRiesgo);
    if (clase >= 1 && clase <= 5) empChange('arl_risk_class', clase, 'Clase de riesgo ARL', e.arl_risk_class);
    const t = tarifa(d.tarifaArl);
    const tarifaClase = ARL_TARIFAS[clase];
    if (t > 0 && tarifaClase && Math.abs(t - tarifaClase) > 1e-7) {
      empChange('arl_rate', t, 'Tarifa ARL exacta', e.arl_rate != null ? Number(e.arl_rate) : null);
    }
    if (num(d.centroTrabajo) > 0) empChange('pila_work_center', String(num(d.centroTrabajo)), 'Centro de trabajo ARL');
    const act = digits(d.actividadArl);
    if (act.length === 7 && act !== actividadEmpresa) empChange('arl_economic_activity', act, 'Actividad económica ARL');

    const city = `${d.departamento}${d.municipio}`;
    if (/^\d{5}$/.test(city) && city !== e.work_city_code && city !== (e.work_city_code ? null : e.city_code)) {
      const c = DIVIPOLA_CITIES.find((x) => x.code === city);
      empChange('work_city_code', city, `Municipio de trabajo${c ? ` (${c.name})` : ''}`);
      if (c) {
        empChange('work_city', c.name, 'Ciudad de trabajo');
        const dep = DIVIPOLA_DEPARTMENTS.find((x) => x.code === c.department_code);
        if (dep) empChange('work_state', dep.name, 'Departamento de trabajo');
      }
    }

    // EPS / AFP: el código va en el proveedor; si el empleado no tiene
    // fondo asignado se le asigna el proveedor con ese código.
    const fund = (code, field, label) => {
      if (!code) return;
      const assigned = suppliers.find((s) => s.id === e[field]);
      if (assigned) {
        if (!assigned.pila_code) {
          add({ entity: 'supplier', entity_id: assigned.id, field: 'pila_code', value: code, label: `Código PILA de ${supplierName(assigned)} (${label})`, current: null });
          assigned.pila_code = code; // para no proponerlo dos veces con otro valor
        } else if (assigned.pila_code.toUpperCase() !== code.toUpperCase()) {
          warnings.push(`${empName}: en la planilla su ${label} es ${code}, pero en Pitbox tiene asignada ${supplierName(assigned)} (código ${assigned.pila_code}).`);
        }
        return;
      }
      const match = byCode(code);
      if (match.length === 1) {
        add({ entity: 'employee', entity_id: e.id, employee_name: empName, field, value: match[0].id, label: `${label}: ${supplierName(match[0])}`, current: null });
      } else {
        warnings.push(`${empName}: su ${label} en la planilla es ${code} y ningún proveedor tiene ese código PILA. Escríbalo en el proveedor que corresponda y vuelva a importar.`);
      }
    };
    fund(d.eps, 'eps_supplier_id', 'EPS');
    if (num(d.diasAfp) > 0) fund(d.afp, 'pension_fund_supplier_id', 'fondo de pensión');

    if (Math.round(num(d.salarioBasico)) !== Math.round(Number(e.base_salary || 0))) {
      warnings.push(`${empName}: salario en la planilla ${num(d.salarioBasico).toLocaleString('es-CO')}, en Pitbox ${Number(e.base_salary || 0).toLocaleString('es-CO')} (no se cambia).`);
    }
  }

  const docsEnPlanilla = new Set(details.map((d) => digits(d.documento)));
  const missing = employees
    .filter((e) => e.is_active !== false && !e.termination_date && !docsEnPlanilla.has(digits(e.document_number)))
    .map((e) => ({ id: e.id, document: e.document_number, name: [e.first_name, e.first_surname].filter(Boolean).join(' ') }));

  const comparison = await compareWithPitbox(tenantId, header, matched);

  return {
    header: {
      razonSocial: header.razonSocial, nit: header.nit, periodoPension: header.periodoPension, periodoSalud: header.periodoSalud,
      cotizantes: groupByDocument(details).size, lineas: details.length, valorNomina: num(header.valorNomina), tipoPlanilla: header.tipoPlanilla,
    },
    changes,
    warnings,
    unmatched,
    missing,
    comparison,
  };
}

// Compara campo por campo contra la PILA que Pitbox genera para el mismo
// mes, si ese mes tiene nómina emitida en Pitbox.
async function compareWithPitbox(tenantId, header, matched) {
  const m = /^(\d{4})-(\d{2})$/.exec(header.periodoPension || '');
  if (!m) return { available: false, reason: 'La planilla no trae el período de pensión.' };
  const { buildPila } = require('./pila.service');
  const pitbox = await buildPila(tenantId, Number(m[1]), Number(m[2]));
  if (!pitbox.rows.length) return { available: false, reason: `No hay nómina emitida en Pitbox para ${header.periodoPension}: se podrá comparar desde el próximo mes.` };

  // Totales por cotizante (suma de sus líneas) y novedades presentes en alguna.
  const SUMS = [['diasEps', 'Días'], ['ibcEps', 'IBC'], ['cotizacionEps', 'Salud'], ['cotizacionAfp', 'Pensión'], ['fsp', 'FSP solidaridad'],
    ['fsps', 'FSP subsistencia'], ['cotizacionArl', 'ARL'], ['aporteCcf', 'Caja'], ['aporteSena', 'SENA'], ['aporteIcbf', 'ICBF'], ['horasLaboradas', 'Horas']];
  const CODES = [['eps', 'Código EPS'], ['afp', 'Código AFP'], ['ccf', 'Código caja']];
  const FLAGS = [['ing', 'ING'], ['ret', 'RET'], ['vst', 'VST'], ['sln', 'SLN'], ['ige', 'IGE'], ['lma', 'LMA'], ['vacLr', 'VAC-LR']];
  const aggregate = (lines) => {
    const out = { lineas: lines.length };
    for (const [k] of SUMS) out[k] = lines.reduce((s, l) => s + num(l[k]), 0);
    for (const [k] of CODES) out[k] = String(lines.map((l) => String(l[k] ?? '').trim()).find((v) => v) || '').toUpperCase();
    for (const [k] of FLAGS) out[k] = lines.map((l) => String(l[k] ?? '').trim()).find((v) => v) || '';
    out.irl = lines.reduce((s, l) => s + num(l.irl), 0);
    return out;
  };
  const rows = [];
  for (const { employee, records } of matched) {
    const mine = pitbox.rows.find((r) => r.employee_id === employee.id);
    const name = [employee.first_name, employee.first_surname].filter(Boolean).join(' ');
    if (!mine) { rows.push({ name, missingInPitbox: true, diffs: [] }); continue; }
    const a = aggregate(records);
    const b = aggregate(mine.lines);
    const diffs = [];
    if (a.lineas !== b.lineas) diffs.push({ field: 'lineas', label: 'Líneas', planilla: a.lineas, pitbox: b.lineas });
    for (const [k, label] of [...SUMS, ['irl', 'Días IRL']]) if (a[k] !== b[k]) diffs.push({ field: k, label, planilla: a[k], pitbox: b[k] });
    for (const [k, label] of [...CODES, ...FLAGS]) if (a[k] !== b[k]) diffs.push({ field: k, label, planilla: a[k] || '—', pitbox: b[k] || '—' });
    rows.push({ name, diffs });
  }
  return { available: true, period: header.periodoPension, rows, identical: rows.every((r) => !r.missingInPitbox && !r.diffs.length) };
}

/* ── Aplicar ─────────────────────────────────────────────────────────── */

const ALLOWED = {
  employee: ['worker_type', 'worker_subtype', 'arl_risk_class', 'arl_rate', 'pila_work_center', 'arl_economic_activity',
    'work_city_code', 'work_city', 'work_state', 'eps_supplier_id', 'pension_fund_supplier_id'],
  supplier: ['pila_code'],
  settings: ['pila_contributor_type', 'pila_presentation_form', 'pila_branch_code', 'pila_branch_name', 'arl_economic_activity',
    'weekly_hours', 'arl_supplier_id', 'ccf_supplier_id'],
};
const SUPPLIER_REF_FIELDS = ['eps_supplier_id', 'pension_fund_supplier_id', 'arl_supplier_id', 'ccf_supplier_id'];

async function apply(tenantId, changes, userId) {
  const { Employee, Supplier, PayrollSetting, sequelize } = { ...models(), sequelize: require('../../../config/database').sequelize };
  const valid = (Array.isArray(changes) ? changes : []).filter((c) => ALLOWED[c?.entity]?.includes(c.field));
  if (!valid.length) throw new Error('No hay cambios para aplicar');

  // Los proveedores referenciados deben ser de la empresa.
  const refIds = valid.filter((c) => SUPPLIER_REF_FIELDS.includes(c.field)).map((c) => c.value);
  if (refIds.length) {
    const found = await Supplier.count({ where: { tenant_id: tenantId, id: { [Op.in]: refIds } } });
    if (found !== new Set(refIds).size) throw new Error('Un proveedor indicado no pertenece a la empresa');
  }

  const group = (entity) => valid.filter((c) => c.entity === entity).reduce((m, c) => {
    const patch = m.get(c.entity_id) || {};
    patch[c.field] = c.value;
    return m.set(c.entity_id, patch);
  }, new Map());

  const counts = { employee: 0, supplier: 0, settings: 0 };
  await sequelize.transaction(async (t) => {
    for (const [id, patch] of group('employee')) {
      const e = await Employee.findOne({ where: { id, tenant_id: tenantId }, transaction: t });
      if (!e) continue;
      if (patch.arl_risk_class != null) patch.arl_risk_class = Number(patch.arl_risk_class);
      if (patch.arl_rate != null) patch.arl_rate = Number(patch.arl_rate);
      await e.update(patch, { transaction: t });
      counts.employee += 1;
    }
    for (const [id, patch] of group('supplier')) {
      const s = await Supplier.findOne({ where: { id, tenant_id: tenantId }, transaction: t });
      if (!s) continue;
      await s.update({ pila_code: String(patch.pila_code).trim().toUpperCase().slice(0, 10) }, { transaction: t });
      counts.supplier += 1;
    }
    const settingsPatch = group('settings').get(tenantId);
    if (settingsPatch) {
      const [settings] = await PayrollSetting.findOrCreate({ where: { tenant_id: tenantId }, defaults: { tenant_id: tenantId }, transaction: t });
      if (settingsPatch.weekly_hours != null) settingsPatch.weekly_hours = Number(settingsPatch.weekly_hours);
      await settings.update({ ...settingsPatch, updated_by: userId }, { transaction: t });
      counts.settings = Object.keys(settingsPatch).length;
    }
  });
  return { applied: valid.length, ...counts };
}

module.exports = { parsePilaFile, analyze, apply };
