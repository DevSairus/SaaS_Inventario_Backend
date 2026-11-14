// backend/src/controllers/payroll/payrollVacations.controller.js
// 6.5 — Liquidación de vacaciones fuera de período.
//   GET  /api/payroll/vacations?employee_id=&status=
//   GET  /api/payroll/vacations/:id
//   GET  /api/payroll/vacations/:id/pdf
//   POST /api/payroll/vacations                 { employee_id, days_enjoyed, days_compensated, start_date, end_date, base_override?, notes? }
//   POST /api/payroll/vacations/:id/pay         { payment_date, bank_account_id?, reference? }
//   POST /api/payroll/vacations/:id/attach      { period_id }
//   POST /api/payroll/vacations/:id/void        { reason }
const service = require('../../services/payroll/payrollVacationService');
const { generateVacationSettlementPDF } = require('../../services/payroll/payrollVacationPdfService');
const logger = require('../../config/logger');

const fail = (res, error, message) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  logger.error(`${message}:`, error);
  // Los errores de contabilización (mapeos, período cerrado) son accionables: se muestran.
  return res.status(500).json({ success: false, message: `${message}: ${error.message}` });
};

exports.list = async (req, res) => {
  try {
    res.json({ success: true, data: await service.list(req.tenant_id, { employeeId: req.query.employee_id, status: req.query.status }) });
  } catch (error) { fail(res, error, 'Error al listar las liquidaciones de vacaciones'); }
};

exports.get = async (req, res) => {
  try {
    const { settlement, employee } = await service.get(req.tenant_id, req.params.id);
    res.json({ success: true, data: { settlement, employee } });
  } catch (error) { fail(res, error, 'Error al leer la liquidación de vacaciones'); }
};

exports.create = async (req, res) => {
  try {
    const data = await service.create(req.tenant_id, req.body || {}, req.user?.id);
    res.status(201).json({ success: true, data, message: 'Liquidación de vacaciones creada' });
  } catch (error) { fail(res, error, 'Error al crear la liquidación de vacaciones'); }
};

exports.pay = async (req, res) => {
  try {
    const { payment_date: paymentDate, bank_account_id: bankAccountId, reference } = req.body || {};
    const data = await service.pay(req.tenant_id, req.params.id, { paymentDate, bankAccountId, reference }, req.user?.id);
    res.json({ success: true, data, message: 'Vacaciones pagadas y contabilizadas' });
  } catch (error) { fail(res, error, 'Error al pagar las vacaciones'); }
};

exports.attach = async (req, res) => {
  try {
    const data = await service.attachToPeriod(req.tenant_id, req.params.id, req.body?.period_id, req.user?.id);
    res.json({ success: true, data, message: 'Liquidación agregada al período de nómina' });
  } catch (error) { fail(res, error, 'Error al agregar la liquidación al período'); }
};

exports.void = async (req, res) => {
  try {
    const data = await service.voidSettlement(req.tenant_id, req.params.id, req.body?.reason, req.user?.id);
    res.json({ success: true, data, message: 'Liquidación anulada' });
  } catch (error) { fail(res, error, 'Error al anular la liquidación de vacaciones'); }
};

exports.pdf = async (req, res) => {
  try {
    const { settlement, employee } = await service.get(req.tenant_id, req.params.id);
    const tenant = await require('../../models').Tenant.findByPk(req.tenant_id);
    await generateVacationSettlementPDF(res, { settlement, employee, tenant: tenant || {} });
  } catch (error) {
    if (!res.headersSent) fail(res, error, 'Error al generar el PDF de vacaciones');
  }
};
