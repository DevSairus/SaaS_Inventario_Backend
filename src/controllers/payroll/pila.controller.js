// backend/src/controllers/payroll/pila.controller.js
//
//   GET /api/payroll/pila/preview?year=2026&month=9   -> cotizantes, totales y avisos
//   GET /api/payroll/pila/download?year=2026&month=9  -> archivo plano para el operador
//   POST /api/payroll/pila/import/analyze (archivo)    -> cambios propuestos desde una planilla anterior
//   POST /api/payroll/pila/import/apply { changes }    -> aplica los cambios confirmados
//   GET /api/payroll/pila/download-excel?year&month    -> la planilla en Excel (plantilla de la empresa o estándar)
//   GET/PUT/DELETE /api/payroll/pila/excel-template    -> plantilla de Excel guardada
//   POST /api/payroll/pila/excel-template/learn (archivo) -> aprende una plantilla de un Excel de muestra
//
// Ver services/payroll/pila/pila.service.js.
const { buildPila } = require('../../services/payroll/pila/pila.service');

const parsePeriod = (q) => {
  const year = Number(q.year);
  const month = Number(q.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
};

const ROLES = ['admin', 'super_admin', 'accountant', 'manager'];

const preview = async (req, res) => {
  try {
    if (!ROLES.includes(req.user?.role)) return res.status(403).json({ success: false, message: 'Sin permiso para generar la PILA' });
    const p = parsePeriod(req.query);
    if (!p) return res.status(400).json({ success: false, message: 'Mes inválido' });
    const { txt, details, ...data } = await buildPila(req.user.tenant_id, p.year, p.month);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PILA preview:', error);
    res.status(500).json({ success: false, message: error.message || 'Error generando la PILA' });
  }
};

const download = async (req, res) => {
  try {
    if (!ROLES.includes(req.user?.role)) return res.status(403).json({ success: false, message: 'Sin permiso para generar la PILA' });
    const p = parsePeriod(req.query);
    if (!p) return res.status(400).json({ success: false, message: 'Mes inválido' });
    const { txt, rows } = await buildPila(req.user.tenant_id, p.year, p.month);
    if (!rows.length) return res.status(400).json({ success: false, message: 'No hay cotizantes con nómina emitida en ese mes' });
    const name = `PILA_${p.year}-${String(p.month).padStart(2, '0')}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=us-ascii');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(Buffer.from(txt, 'latin1'));
  } catch (error) {
    console.error('Error en PILA download:', error);
    res.status(500).json({ success: false, message: error.message || 'Error generando la PILA' });
  }
};

const { parsePilaFile, analyze, apply } = require('../../services/payroll/pila/pilaImport.service');
// Importar cambia la ficha de empleados, proveedores y la configuración.
const IMPORT_ROLES = ['admin', 'super_admin', 'accountant'];

const importAnalyze = async (req, res) => {
  try {
    if (!IMPORT_ROLES.includes(req.user?.role)) return res.status(403).json({ success: false, message: 'Solo un administrador o contador puede importar la planilla' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Adjunte el archivo de la planilla (TXT o Excel)' });
    let parsed;
    try {
      parsed = await parsePilaFile(req.file.buffer, req.file.originalname);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }
    const data = await analyze(req.user.tenant_id, parsed);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PILA import analyze:', error);
    res.status(500).json({ success: false, message: error.message || 'Error leyendo la planilla' });
  }
};

const importApply = async (req, res) => {
  try {
    if (!IMPORT_ROLES.includes(req.user?.role)) return res.status(403).json({ success: false, message: 'Solo un administrador o contador puede importar la planilla' });
    const result = await apply(req.user.tenant_id, req.body?.changes, req.user.id);
    try {
      const audit = require('../../utils/audit');
      await audit({ tenant_id: req.user.tenant_id, user_id: req.user.id, action: 'PILA_IMPORT', entity: 'payroll_settings', entity_id: req.user.tenant_id, changes: { applied: result.applied, fields: (req.body?.changes || []).map((c) => `${c.entity}.${c.field}`) }, req });
    } catch { /* la auditoría no bloquea */ }
    res.json({ success: true, data: result, message: `${result.applied} cambio(s) aplicados` });
  } catch (error) {
    console.error('Error en PILA import apply:', error);
    res.status(400).json({ success: false, message: error.message || 'Error aplicando los cambios' });
  }
};

/* ── Excel ───────────────────────────────────────────────────────────── */

const { learnTemplate, sanitizeTemplate, renderExcel, describe } = require('../../services/payroll/pila/pilaExcel.service');
const DEFAULT_TEMPLATE = require('../../data/pila-excel-default-template.json');

const loadTemplate = async (tenantId) => {
  const { PayrollSetting } = require('../../models');
  const settings = await PayrollSetting.findOne({ where: { tenant_id: tenantId }, attributes: ['tenant_id', 'pila_excel_template'] });
  return { settings, template: settings?.pila_excel_template || null };
};

const downloadExcel = async (req, res) => {
  try {
    if (!ROLES.includes(req.user?.role)) return res.status(403).json({ success: false, message: 'Sin permiso para generar la PILA' });
    const p = parsePeriod(req.query);
    if (!p) return res.status(400).json({ success: false, message: 'Mes inválido' });
    const { header, rows, details } = await buildPila(req.user.tenant_id, p.year, p.month);
    if (!rows.length) return res.status(400).json({ success: false, message: 'No hay cotizantes con nómina emitida en ese mes' });
    const { template } = await loadTemplate(req.user.tenant_id);
    const buffer = await renderExcel(template || DEFAULT_TEMPLATE, header, details);
    const name = `PILA_${p.year}-${String(p.month).padStart(2, '0')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Error en PILA download-excel:', error);
    res.status(500).json({ success: false, message: error.message || 'Error generando el Excel' });
  }
};

const getExcelTemplate = async (req, res) => {
  try {
    const { template } = await loadTemplate(req.user.tenant_id);
    const t = template || DEFAULT_TEMPLATE;
    res.json({ success: true, data: { template: t, is_default: !template, ...describe(t) } });
  } catch (error) {
    console.error('Error en PILA excel-template:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo la plantilla' });
  }
};

const learnExcelTemplate = async (req, res) => {
  try {
    if (!IMPORT_ROLES.includes(req.user?.role)) return res.status(403).json({ success: false, message: 'Solo un administrador o contador puede configurar la plantilla' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Adjunte el Excel de muestra' });
    try {
      const data = await learnTemplate(req.file.buffer, req.file.originalname);
      res.json({ success: true, data });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  } catch (error) {
    console.error('Error en PILA learn template:', error);
    res.status(500).json({ success: false, message: 'Error leyendo el Excel' });
  }
};

const saveExcelTemplate = async (req, res) => {
  try {
    if (!IMPORT_ROLES.includes(req.user?.role)) return res.status(403).json({ success: false, message: 'Solo un administrador o contador puede configurar la plantilla' });
    let template;
    try {
      template = sanitizeTemplate(req.body?.template);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }
    const { PayrollSetting } = require('../../models');
    const [settings] = await PayrollSetting.findOrCreate({ where: { tenant_id: req.user.tenant_id }, defaults: { tenant_id: req.user.tenant_id } });
    await settings.update({ pila_excel_template: template, updated_by: req.user.id });
    res.json({ success: true, message: 'Plantilla guardada', data: { template, is_default: false, ...describe(template) } });
  } catch (error) {
    console.error('Error guardando plantilla PILA:', error);
    res.status(500).json({ success: false, message: 'Error guardando la plantilla' });
  }
};

const resetExcelTemplate = async (req, res) => {
  try {
    if (!IMPORT_ROLES.includes(req.user?.role)) return res.status(403).json({ success: false, message: 'Solo un administrador o contador puede configurar la plantilla' });
    const { settings } = await loadTemplate(req.user.tenant_id);
    if (settings) await settings.update({ pila_excel_template: null, updated_by: req.user.id });
    res.json({ success: true, message: 'Se usará la plantilla estándar', data: { template: DEFAULT_TEMPLATE, is_default: true, ...describe(DEFAULT_TEMPLATE) } });
  } catch (error) {
    console.error('Error restableciendo plantilla PILA:', error);
    res.status(500).json({ success: false, message: 'Error restableciendo la plantilla' });
  }
};

module.exports = {
  preview, download, importAnalyze, importApply,
  downloadExcel, getExcelTemplate, learnExcelTemplate, saveExcelTemplate, resetExcelTemplate,
};
