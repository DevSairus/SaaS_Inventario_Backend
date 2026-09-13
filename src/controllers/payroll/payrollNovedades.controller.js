// backend/src/controllers/payroll/payrollNovedades.controller.js
const { PayrollNovedad, PayrollPeriod, Employee } = require('../../models');
const { Op } = require('sequelize');
const { DIAN_CATEGORY_MAP, CATEGORIAS_HORAS_EXTRA, validarTopeHorasExtra } = require('../../services/payroll/payrollService');
const { getEmployeesActiveInPeriod } = require('../../services/payroll/payrollPeriodEmissionService');

/**
 * Lista las novedades de un periodo (todas, o filtradas por empleado).
 * GET /api/payroll/novedades?payroll_period_id=&employee_id=
 */
const getNovedades = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const tenant_id = req.user.tenant_id;
    const { payroll_period_id, employee_id } = req.query;

    if (!payroll_period_id) {
      return res.status(400).json({ success: false, message: 'payroll_period_id es obligatorio' });
    }

    const where = { tenant_id, payroll_period_id };
    if (employee_id) where.employee_id = employee_id;

    const novedades = await PayrollNovedad.findAll({
      where,
      include: [{ model: Employee, as: 'employee', attributes: ['id', 'first_name', 'first_surname', 'second_surname'] }],
      order: [['created_at', 'ASC']],
    });

    res.json({ success: true, data: novedades });
  } catch (error) {
    console.error('Error en getNovedades:', error);
    res.status(500).json({ success: false, message: 'Error al listar novedades', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

/**
 * Crea una novedad para un empleado dentro de un periodo abierto.
 * POST /api/payroll/novedades
 * Body: { employee_id, payroll_period_id, payroll_concept_id?, dian_category?, payload?, unpaid_days?, notes? }
 *
 * Validaciones:
 *  - dian_category (si viene) debe ser una clave conocida de
 *    DIAN_CATEGORY_MAP — evita capturar novedades que luego revienten en
 *    aplicarNovedades() al momento de emitir, cuando ya es tarde para
 *    corregirlas cómodamente.
 *  - el periodo debe existir, ser del tenant, y estar en estado 'abierto'
 *    o 'liquidado' — no se pueden agregar novedades a un periodo ya
 *    emitido/cerrado (los documentos DIAN de esos empleados ya podrían
 *    estar enviados).
 *
 * Si la novedad es de horas EXTRA (ver CATEGORIAS_HORAS_EXTRA), además se
 * valida el tope legal orientativo del periodo (validarTopeHorasExtra) —
 * NO bloquea la creación, solo agrega `warning` en la respuesta si el
 * empleado ya acumula más horas extra de las que el tope legal permite en
 * este periodo (puede haber excepciones legales que el sistema no puede
 * verificar solo).
 */
const createNovedad = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const tenant_id = req.user.tenant_id;
    const { employee_id, payroll_period_id, payroll_concept_id, dian_category, payload, unpaid_days, notes } = req.body;

    if (!employee_id || !payroll_period_id) {
      return res.status(400).json({ success: false, message: 'employee_id y payroll_period_id son obligatorios' });
    }
    if (!dian_category && !(Number(unpaid_days) > 0)) {
      return res.status(400).json({ success: false, message: 'La novedad necesita dian_category o unpaid_days > 0' });
    }
    if (dian_category && !DIAN_CATEGORY_MAP[dian_category]) {
      return res.status(400).json({
        success: false,
        message: `dian_category inválida: "${dian_category}". Valores permitidos: ${Object.keys(DIAN_CATEGORY_MAP).join(', ')}`,
      });
    }

    const period = await PayrollPeriod.findOne({ where: { id: payroll_period_id, tenant_id } });
    if (!period) return res.status(404).json({ success: false, message: 'Periodo no encontrado' });
    if (!['abierto', 'liquidado'].includes(period.status)) {
      return res.status(400).json({ success: false, message: `No se pueden agregar novedades a un periodo en estado "${period.status}"` });
    }

    const employee = await Employee.findOne({ where: { id: employee_id, tenant_id } });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado' });

    const novedad = await PayrollNovedad.create({
      tenant_id,
      employee_id,
      payroll_period_id,
      payroll_concept_id: payroll_concept_id || null,
      dian_category: dian_category || null,
      payload: payload || null,
      unpaid_days: unpaid_days || 0,
      notes: notes || null,
      created_by: req.user.id || null,
    });

    let warning = null;
    if (CATEGORIAS_HORAS_EXTRA.has(novedad.dian_category)) {
      const horasExtraDelEmpleado = await PayrollNovedad.findAll({
        where: {
          tenant_id,
          employee_id,
          payroll_period_id,
          dian_category: { [Op.in]: Array.from(CATEGORIAS_HORAS_EXTRA) },
        },
      });
      warning = validarTopeHorasExtra(horasExtraDelEmpleado, period);
    }

    res.status(201).json({ success: true, message: 'Novedad creada', warning, data: novedad });
  } catch (error) {
    console.error('Error en createNovedad:', error);
    res.status(500).json({ success: false, message: 'Error al crear novedad', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

/**
 * Elimina una novedad — mismas reglas de estado del periodo que crear.
 * DELETE /api/payroll/novedades/:id
 */
const deleteNovedad = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const tenant_id = req.user.tenant_id;
    const novedad = await PayrollNovedad.findOne({
      where: { id: req.params.id, tenant_id },
      include: [{ model: PayrollPeriod, as: 'period' }],
    });
    if (!novedad) return res.status(404).json({ success: false, message: 'Novedad no encontrada' });
    if (!['abierto', 'liquidado'].includes(novedad.period.status)) {
      return res.status(400).json({ success: false, message: `No se pueden eliminar novedades de un periodo en estado "${novedad.period.status}"` });
    }

    await novedad.destroy();
    res.json({ success: true, message: 'Novedad eliminada' });
  } catch (error) {
    console.error('Error en deleteNovedad:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar novedad', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

/**
 * Copia las novedades de un periodo anterior hacia este — para el caso de
 * "otra vez lo mismo del mes pasado, con ajustes menores" (ej. una
 * comisión variable que de todos modos hay que volver a capturar porque
 * no califica para auto_apply, ver PayrollConcept). NO reemplaza al
 * motor de conceptos automáticos (Mejora #1) — ese es para "siempre el
 * mismo valor sin pensarlo"; esto es para "parecido al mes pasado, lo
 * reviso y ajusto".
 *
 * POST /api/payroll/periods/:id/copy-novedades
 * Body: { source_period_id? } — si se omite, se autodetecta el periodo
 * inmediatamente anterior de la MISMA sede+periodicidad (mismo criterio
 * que getEmployeesActiveInPeriod).
 *
 * Solo copia novedades de empleados que TODAVÍA califican para el periodo
 * destino (activos, misma sede/periodicidad) — evita arrastrar novedades
 * de alguien que ya se retiró o cambió de periodicidad entre un periodo y
 * el otro. No hay deduplicación: si se corre dos veces, duplica — el
 * frontend advierte de esto antes de confirmar.
 */
const copyNovedadesFromPreviousPeriod = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const tenant_id = req.user.tenant_id;
    const { id } = req.params;
    const { source_period_id } = req.body;

    const targetPeriod = await PayrollPeriod.findOne({ where: { id, tenant_id } });
    if (!targetPeriod) return res.status(404).json({ success: false, message: 'Periodo no encontrado' });
    if (!['abierto', 'liquidado'].includes(targetPeriod.status)) {
      return res.status(400).json({ success: false, message: `No se pueden agregar novedades a un periodo en estado "${targetPeriod.status}"` });
    }

    let sourcePeriod;
    if (source_period_id) {
      if (source_period_id === id) {
        return res.status(400).json({ success: false, message: 'El periodo de origen no puede ser el mismo que el destino' });
      }
      sourcePeriod = await PayrollPeriod.findOne({ where: { id: source_period_id, tenant_id } });
      if (!sourcePeriod) return res.status(404).json({ success: false, message: 'Periodo de origen no encontrado' });
    } else {
      const where = { tenant_id, period_type: targetPeriod.period_type, end_date: { [Op.lt]: targetPeriod.start_date } };
      if (targetPeriod.branch_id) where.branch_id = targetPeriod.branch_id;
      sourcePeriod = await PayrollPeriod.findOne({ where, order: [['end_date', 'DESC']] });
      if (!sourcePeriod) {
        return res.status(404).json({ success: false, message: 'No hay un periodo anterior (misma sede y periodicidad) del cual copiar novedades' });
      }
    }

    const sourceNovedades = await PayrollNovedad.findAll({ where: { tenant_id, payroll_period_id: sourcePeriod.id } });
    if (!sourceNovedades.length) {
      return res.json({ success: true, message: 'El periodo de origen no tiene novedades para copiar', data: { copied: 0, skipped: 0, source_period_id: sourcePeriod.id } });
    }

    const eligibleEmployees = await getEmployeesActiveInPeriod(tenant_id, targetPeriod);
    const eligibleIds = new Set(eligibleEmployees.map(e => e.id));

    const toCopy = sourceNovedades.filter(n => eligibleIds.has(n.employee_id));
    const skipped = sourceNovedades.length - toCopy.length;

    if (!toCopy.length) {
      return res.json({
        success: true,
        message: 'Ningún empleado de esas novedades sigue vigente para este periodo (sede/periodicidad) — no se copió nada',
        data: { copied: 0, skipped, source_period_id: sourcePeriod.id },
      });
    }

    const created = await PayrollNovedad.bulkCreate(toCopy.map(n => ({
      tenant_id,
      employee_id: n.employee_id,
      payroll_period_id: targetPeriod.id,
      payroll_concept_id: n.payroll_concept_id,
      dian_category: n.dian_category,
      payload: n.payload,
      unpaid_days: n.unpaid_days,
      notes: n.notes,
      created_by: req.user.id || null,
    })));

    res.status(201).json({
      success: true,
      message: `Se copiaron ${created.length} novedad${created.length !== 1 ? 'es' : ''}${skipped ? ` (${skipped} omitida${skipped !== 1 ? 's' : ''} por no seguir vigente)` : ''}`,
      data: { copied: created.length, skipped, source_period_id: sourcePeriod.id, novedades: created },
    });
  } catch (error) {
    console.error('Error en copyNovedadesFromPreviousPeriod:', error);
    res.status(500).json({ success: false, message: 'Error al copiar novedades', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

module.exports = {
  getNovedades,
  createNovedad,
  deleteNovedad,
  copyNovedadesFromPreviousPeriod,
};