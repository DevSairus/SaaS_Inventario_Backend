// backend/src/controllers/payroll/payrollTermination.controller.js
//
// Liquidación definitiva / finiquito (mejora #7) -- ver
// payrollTerminationService.js para el cálculo y la orquestación de
// emisión. Mismo patrón de auth/tenant que el resto de controllers de
// payroll.
const { Employee } = require('../../models');
const {
  previewLiquidacionDefinitiva,
  emitirLiquidacionDefinitiva,
} = require('../../services/payroll/payrollTerminationService');

function parseOpciones(body = {}) {
  const indemnizacion = Number(body.indemnizacion) || 0;
  const bonifRetiro = Number(body.bonifRetiro) || 0;
  if (indemnizacion < 0 || bonifRetiro < 0) {
    throw new Error('indemnizacion y bonifRetiro no pueden ser negativos');
  }
  return { indemnizacion, bonifRetiro };
}

/**
 * GET /api/payroll/termination/pending
 * Empleados con `termination_date` registrada -- candidatos a liquidación
 * definitiva -- indicando si ya tienen una liquidación 'emitido'.
 */
const getPendingTerminations = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const { Op } = require('sequelize');
    const { PayrollPeriod } = require('../../models');

    const employees = await Employee.findAll({
      where: { tenant_id: req.user.tenant_id, termination_date: { [Op.ne]: null } },
      order: [['termination_date', 'DESC']],
    });

    const rows = [];
    for (const employee of employees) {
      // eslint-disable-next-line no-await-in-loop
      const emitido = await PayrollPeriod.findOne({
        where: { tenant_id: req.user.tenant_id, period_type: 'liquidacion', status: 'emitido', notes: { [Op.like]: `%${employee.id}%` } },
      });
      rows.push({
        employee_id: employee.id,
        employee_name: `${employee.first_name} ${employee.first_surname}`,
        document_number: employee.document_number,
        termination_date: employee.termination_date,
        is_active: employee.is_active,
        already_settled: !!emitido,
      });
    }

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error en getPendingTerminations:', error);
    res.status(500).json({
      success: false,
      message: 'Error al listar retiros pendientes de liquidar',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

/**
 * GET /api/payroll/termination/:employee_id/preview?indemnizacion=&bonifRetiro=
 * Cálculo completo (cesantías, intereses, prima, vacaciones + liquidación
 * de básico/deducciones del tramo pendiente) SIN persistir nada.
 */
const previewTermination = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const employee = await Employee.findOne({ where: { id: req.params.employee_id, tenant_id: req.user.tenant_id } });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado' });

    let opciones;
    try {
      opciones = parseOpciones(req.query);
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    const result = await previewLiquidacionDefinitiva(req.user.tenant_id, employee.id, opciones);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error en previewTermination:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Error al calcular la liquidación definitiva',
    });
  }
};

/**
 * POST /api/payroll/termination/:employee_id/emit
 * body: { indemnizacion?, bonifRetiro? }
 * Genera el periodo/novedades y emite el Documento Soporte de Nómina a la
 * DIAN. Idempotente -- reintentar sobre uno ya 'emitido' devuelve el
 * resultado ya aceptado sin reenviar nada.
 */
const emitTermination = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const employee = await Employee.findOne({ where: { id: req.params.employee_id, tenant_id: req.user.tenant_id } });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado' });

    let opciones;
    try {
      opciones = parseOpciones(req.body);
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    const result = await emitirLiquidacionDefinitiva(req.user.tenant_id, employee.id, req.user.id, opciones);

    if (result.alreadyEmitted) {
      return res.json({
        success: true,
        message: 'Esta liquidación ya había sido emitida y aceptada por la DIAN anteriormente -- no se reenvía.',
        data: result,
      });
    }

    if (!result.accepted) {
      return res.status(207).json({
        success: false,
        message: `La DIAN no aceptó el documento de liquidación: ${result.error}. El periodo queda disponible para corregir y reintentar.`,
        data: result,
      });
    }

    res.json({
      success: true,
      message: 'Liquidación definitiva emitida y aceptada por la DIAN',
      data: result,
    });
  } catch (error) {
    console.error('Error en emitTermination:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Error al emitir la liquidación definitiva',
    });
  }
};

module.exports = {
  getPendingTerminations,
  previewTermination,
  emitTermination,
};
