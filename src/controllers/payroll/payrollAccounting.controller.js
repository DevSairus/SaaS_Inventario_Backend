// backend/src/controllers/payroll/payrollAccounting.controller.js
//
// Comprobantes contables de nómina de un periodo (nómina, aportes y
// provisiones, desembolsos) y causación anual de cesantías -- ver
// services/payroll/payrollAccountingService.js. Montado bajo
// /api/payroll/periods/:id/accounting|payments y /api/payroll/settings.
const {
  generarComprobantesNomina,
  regenerarComprobantesPeriodo,
  liquidacionesAceptadasDelPeriodo,
  cierreAnualCesantias,
  estadoCesantiasAnuales,
  consignarCesantias,
  registrarPago,
  anularPago,
  resumenContablePeriodo,
} = require('../../services/payroll/payrollAccountingService');
const { PayrollPeriod, PayrollPayment } = require('../../models');

const ADMIN_ROLES = ['admin', 'super_admin'];

// Errores de validación del servicio (mensajes en español para el
// usuario) -> 400; cualquier otra cosa es un 500.
function sendError(res, error, context) {
  const isUserError = !error.name || error.name === 'Error';
  console.error(`Error en ${context}:`, error);
  res.status(isUserError ? 400 : 500).json({
    success: false,
    message: isUserError ? error.message : 'Error procesando la contabilidad de nómina',
    error: process.env.NODE_ENV === 'production' ? undefined : error.message,
  });
}

function requireTenant(req, res) {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    return false;
  }
  if (!req.user.tenant_id) {
    res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    return false;
  }
  return true;
}

// GET /api/payroll/periods/:id/accounting
const getPeriodAccounting = async (req, res) => {
  try {
    if (!requireTenant(req, res)) return;
    const data = await resumenContablePeriodo(req.user.tenant_id, req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'getPeriodAccounting');
  }
};

// POST /api/payroll/periods/:id/accounting/generate
// Para periodos emitidos cuyo asiento no se generó (mapeo faltante, o
// emitidos antes de esta contabilización). No duplica: si ya existen, los
// devuelve tal cual.
const generatePeriodAccounting = async (req, res) => {
  try {
    if (!requireTenant(req, res)) return;
    const tenantId = req.user.tenant_id;
    const period = await PayrollPeriod.findOne({ where: { id: req.params.id, tenant_id: tenantId } });
    if (!period) return res.status(404).json({ success: false, message: 'Periodo no encontrado' });
    if (!['emitido', 'cerrado'].includes(period.status)) {
      return res.status(400).json({ success: false, message: 'Solo se contabiliza un periodo ya emitido a la DIAN' });
    }

    const liquidations = await liquidacionesAceptadasDelPeriodo(tenantId, period.id);
    if (!liquidations.length) {
      return res.status(400).json({ success: false, message: 'El periodo no tiene documentos aceptados por la DIAN' });
    }

    const result = await generarComprobantesNomina(period, liquidations, tenantId, req.user.id);
    res.status(result.alreadyExisted ? 200 : 201).json({
      success: true,
      message: result.alreadyExisted ? 'El periodo ya tenía comprobantes contables' : 'Comprobantes contables generados',
      data: { entries: result.entries.map((e) => ({ id: e.id, entry_number: e.entry_number })), warnings: result.warnings },
    });
  } catch (error) {
    sendError(res, error, 'generatePeriodAccounting');
  }
};

// POST /api/payroll/periods/:id/accounting/regenerate
// Reemplaza los comprobantes del periodo por unos recalculados (cambio de
// fondos/configuración). Las notas de ajuste lo hacen solas al aceptarse.
const regeneratePeriodAccounting = async (req, res) => {
  try {
    if (!requireTenant(req, res)) return;
    if (!ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Solo un administrador puede regenerar los comprobantes de nómina' });
    }
    const result = await regenerarComprobantesPeriodo(req.user.tenant_id, req.params.id, req.user.id, 'Regeneración manual de comprobantes de nómina');
    res.json({
      success: true,
      message: result.replaced ? `Comprobantes regenerados (${result.replaced} reemplazado(s))` : 'Comprobantes generados',
      data: { entries: result.entries.map((e) => ({ id: e.id, entry_number: e.entry_number })), warnings: result.warnings },
    });
  } catch (error) {
    sendError(res, error, 'regeneratePeriodAccounting');
  }
};

// POST /api/payroll/periods/:id/payments
// Body: { payment_type: 'net_pay'|'social_security', payment_date, bank_account_id?, reference?, employee_ids? }
const createPeriodPayment = async (req, res) => {
  try {
    if (!requireTenant(req, res)) return;
    const { payment_type, payment_date, bank_account_id, reference, employee_ids } = req.body;
    const { payment, entry } = await registrarPago({
      tenantId: req.user.tenant_id,
      periodId: req.params.id,
      paymentType: payment_type,
      paymentDate: payment_date,
      bankAccountId: bank_account_id || null,
      reference,
      employeeIds: employee_ids,
      userId: req.user.id,
    });
    res.status(201).json({ success: true, message: 'Pago registrado', data: { payment, entry_number: entry.entry_number } });
  } catch (error) {
    sendError(res, error, 'createPeriodPayment');
  }
};

// POST /api/payroll/periods/:id/payments/:paymentId/void
const voidPeriodPayment = async (req, res) => {
  try {
    if (!requireTenant(req, res)) return;
    const payment = await anularPago(req.user.tenant_id, req.params.paymentId, req.user.id, req.body?.reason);
    res.json({ success: true, message: 'Pago anulado', data: payment });
  } catch (error) {
    sendError(res, error, 'voidPeriodPayment');
  }
};

// POST /api/payroll/settings/cesantias-year-end  Body: { year }
// Cierre anual según la configuración: causación (year_end) o ajuste de lo
// provisionado contra el valor legal (monthly).
const closeCesantiasYear = async (req, res) => {
  try {
    if (!requireTenant(req, res)) return;
    if (!ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Solo un administrador puede hacer el cierre anual de cesantías' });
    }
    const result = await cierreAnualCesantias(req.user.tenant_id, req.body?.year, req.user.id);
    let message;
    if (result.mode === 'year_end') message = `Cesantías causadas (${result.entry.entry_number})`;
    else if (result.entry) message = `Provisiones ajustadas (${result.entry.entry_number})`;
    else message = 'Lo provisionado coincide con el valor legal: no hubo ajuste';
    res.status(result.entry ? 201 : 200).json({
      success: true,
      message,
      data: {
        mode: result.mode,
        entry_number: result.entry?.entry_number || null,
        employees: result.employees,
        total_cesantias: result.totalCesantias ?? null,
        total_intereses: result.totalIntereses ?? null,
        ajuste_cesantias: result.ajusteCesantias ?? null,
        ajuste_intereses: result.ajusteIntereses ?? null,
      },
    });
  } catch (error) {
    sendError(res, error, 'closeCesantiasYear');
  }
};

// GET /api/payroll/settings/cesantias-annual?year=
const getCesantiasAnnual = async (req, res) => {
  try {
    if (!requireTenant(req, res)) return;
    const data = await estadoCesantiasAnuales(req.user.tenant_id, req.query.year);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'getCesantiasAnnual');
  }
};

// POST /api/payroll/settings/cesantias-annual/consign
// Body: { year, payment_date, bank_account_id?, reference?, employee_ids? }
const consignCesantias = async (req, res) => {
  try {
    if (!requireTenant(req, res)) return;
    const { year, payment_date, bank_account_id, reference, employee_ids } = req.body;
    const { payment, entry } = await consignarCesantias({
      tenantId: req.user.tenant_id,
      year,
      paymentDate: payment_date,
      bankAccountId: bank_account_id || null,
      reference,
      employeeIds: employee_ids,
      userId: req.user.id,
    });
    res.status(201).json({ success: true, message: 'Consignación registrada', data: { payment, entry_number: entry.entry_number } });
  } catch (error) {
    sendError(res, error, 'consignCesantias');
  }
};

// POST /api/payroll/settings/cesantias-annual/payments/:paymentId/void
const voidCesantiasPayment = async (req, res) => {
  try {
    if (!requireTenant(req, res)) return;
    const existing = await PayrollPayment.findOne({ where: { id: req.params.paymentId, tenant_id: req.user.tenant_id, payment_type: 'severance_fund' } });
    if (!existing) return res.status(404).json({ success: false, message: 'Consignación no encontrada' });
    const payment = await anularPago(req.user.tenant_id, existing.id, req.user.id, req.body?.reason || 'Consignación de cesantías anulada');
    res.json({ success: true, message: 'Consignación anulada', data: payment });
  } catch (error) {
    sendError(res, error, 'voidCesantiasPayment');
  }
};

module.exports = {
  getPeriodAccounting,
  generatePeriodAccounting,
  regeneratePeriodAccounting,
  createPeriodPayment,
  voidPeriodPayment,
  closeCesantiasYear,
  getCesantiasAnnual,
  consignCesantias,
  voidCesantiasPayment,
};
