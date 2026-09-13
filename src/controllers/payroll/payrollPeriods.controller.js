const { PayrollPeriod, Tenant } = require('../../models');
const { Op } = require('sequelize');
const { submitPayrollPeriod, previewPayrollPeriod } = require('../../services/payroll/payrollPeriodEmissionService');

// Orden válido de transición de estados del periodo (ver plan §4.4).
// MVP: solo se permite avanzar, nunca retroceder (evita reabrir un periodo
// ya emitido/cerrado sin pasar por una nota de ajuste -- Fase 2).
const STATUS_ORDER = ['abierto', 'liquidado', 'emitido', 'cerrado'];

// ── Helpers de fechas para suggestNextPeriod ────────────────────────
// Se opera sobre 'YYYY-MM-DD' (formato de un DATEONLY de Sequelize) con
// Date en UTC explícito para no arrastrar el desfase de zona horaria del
// servidor — un periodo es una fecha civil, no un instante.
const toISODate = (d) => d.toISOString().slice(0, 10);
const parseISODate = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (isoStr, days) => {
  const d = parseISODate(isoStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
};
const lastDayOfMonthISO = (isoStr) => {
  const d = parseISODate(isoStr);
  // Día 0 del mes siguiente = último día del mes actual.
  return toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};
const firstDayOfMonthISO = (isoStr) => {
  const d = parseISODate(isoStr);
  return toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
};

/**
 * Calcula el rango { start_date, end_date } de un periodo dado su
 * start_date y period_type — mensual siempre cierra a fin de mes;
 * quincenal cierra el 15 si empezó el 1, o a fin de mes si empezó el 16
 * (o cualquier otro día a mitad de mes, por si el usuario ajustó a mano).
 */
const computeEndDate = (startDate, periodType) => {
  if (periodType === 'quincenal') {
    const day = parseISODate(startDate).getUTCDate();
    if (day === 1) {
      const d = parseISODate(startDate);
      return toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15)));
    }
    return lastDayOfMonthISO(startDate);
  }
  return lastDayOfMonthISO(startDate); // mensual
};

const getPayrollPeriods = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const tenant_id = req.user.tenant_id;
    const { status, branch_id, period_type, page = 1, limit = 20 } = req.query;

    const where = { tenant_id };
    if (status) where.status = status;
    if (branch_id) where.branch_id = branch_id;
    if (period_type) where.period_type = period_type;

    const offset = (page - 1) * limit;
    const { count, rows } = await PayrollPeriod.findAndCountAll({
      where,
      order: [['start_date', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / limit),
      },
    });
  } catch (error) {
    console.error('Error en getPayrollPeriods:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener periodos de nómina',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const getPayrollPeriodById = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const period = await PayrollPeriod.findOne({ where: { id, tenant_id: req.user.tenant_id } });
    if (!period) {
      return res.status(404).json({ success: false, message: 'Periodo no encontrado' });
    }

    res.json({ success: true, data: period });
  } catch (error) {
    console.error('Error en getPayrollPeriodById:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener periodo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const createPayrollPeriod = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const tenant_id = req.user.tenant_id;
    const {
      branch_id,
      period_type = 'mensual',
      start_date,
      end_date,
      payment_date,
      notes,
    } = req.body;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'Fecha de inicio y fecha de fin son requeridas',
      });
    }
    // 'liquidacion' es un period_type de UN solo empleado que solo debe
    // crearse desde el flujo dedicado de liquidación definitiva (mejora
    // #7, ver payrollTerminationService.js) -- ese flujo conoce el rango
    // de fechas correcto para ESE empleado y ya deja el periodo asociado
    // a su propio PayrollDocument. Crearlo aquí a mano dejaría un periodo
    // sin ningún empleado real detrás.
    if (period_type === 'liquidacion') {
      return res.status(400).json({
        success: false,
        message: 'El tipo de periodo "liquidacion" no se crea manualmente -- use la liquidación definitiva de un empleado retirado (Empleados → Liquidar).',
      });
    }
    if (new Date(end_date) < new Date(start_date)) {
      return res.status(400).json({
        success: false,
        message: 'La fecha de fin no puede ser anterior a la fecha de inicio',
      });
    }

    const existing = await PayrollPeriod.findOne({ where: { tenant_id, start_date, end_date } });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Ya existe un periodo con ese rango de fechas',
      });
    }

    const period = await PayrollPeriod.create({
      tenant_id,
      branch_id: branch_id || null,
      period_type,
      start_date,
      end_date,
      payment_date: payment_date || null,
      status: 'abierto',
      notes: notes || null,
      created_by: req.user.id || null,
    });

    res.status(201).json({ success: true, message: 'Periodo creado exitosamente', data: period });
  } catch (error) {
    console.error('Error en createPayrollPeriod:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear periodo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const updatePayrollPeriod = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const period = await PayrollPeriod.findOne({ where: { id, tenant_id } });
    if (!period) {
      return res.status(404).json({ success: false, message: 'Periodo no encontrado' });
    }

    if (period.status !== 'abierto') {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden editar las fechas/datos de un periodo en estado "abierto"',
      });
    }

    const updateData = { ...req.body };
    delete updateData.status; // el estado cambia por el endpoint dedicado
    delete updateData.tenant_id;

    const startDate = updateData.start_date || period.start_date;
    const endDate = updateData.end_date || period.end_date;
    if (new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({
        success: false,
        message: 'La fecha de fin no puede ser anterior a la fecha de inicio',
      });
    }

    ['payment_date', 'branch_id', 'notes'].forEach((field) => {
      if (updateData[field] === '') updateData[field] = null;
    });
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === undefined) delete updateData[key];
    });

    await period.update(updateData);
    res.json({ success: true, message: 'Periodo actualizado exitosamente', data: period });
  } catch (error) {
    console.error('Error en updatePayrollPeriod:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar periodo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

/**
 * Avanzar el estado del periodo (abierto -> liquidado -> emitido -> cerrado).
 * Fase 1: transición manual/administrativa. En Fase 2-4, "liquidado" lo
 * dispara payrollService y "emitido" lo dispara el envío exitoso a la DIAN.
 */
const changePayrollPeriodStatus = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const { status } = req.body;
    const tenant_id = req.user.tenant_id;

    if (!STATUS_ORDER.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Estado inválido. Valores permitidos: ${STATUS_ORDER.join(', ')}`,
      });
    }

    const period = await PayrollPeriod.findOne({ where: { id, tenant_id } });
    if (!period) {
      return res.status(404).json({ success: false, message: 'Periodo no encontrado' });
    }

    const currentIndex = STATUS_ORDER.indexOf(period.status);
    const targetIndex = STATUS_ORDER.indexOf(status);

    if (targetIndex !== currentIndex + 1) {
      return res.status(400).json({
        success: false,
        message: `No se puede pasar de "${period.status}" a "${status}" directamente. El siguiente estado válido es "${STATUS_ORDER[currentIndex + 1] || 'ninguno (ya está cerrado)'}".`,
      });
    }

    const updates = { status };
    if (status === 'cerrado') {
      updates.closed_at = new Date();
      updates.closed_by = req.user.id || null;
    }

    // "Liquidado" ahora sí calcula: liquida (sin firmar ni enviar a la
    // DIAN) a cada empleado cuya payroll_periodicity coincide con este
    // periodo, y guarda el resultado en liquidation_preview para que el
    // usuario pueda revisarlo — antes este paso era solo una bandera de
    // estado sin ningún número detrás. Si no hay ningún empleado con esa
    // periodicidad/sede, se avisa aquí en vez de dejar avanzar un periodo
    // que luego "emitido" va a rechazar por vacío.
    if (status === 'liquidado') {
      const preview = await previewPayrollPeriod(period, tenant_id);
      if (preview.totals.count === 0) {
        return res.status(400).json({
          success: false,
          message: 'No hay empleados activos con esta periodicidad (y sede, si aplica) para liquidar en este periodo.',
        });
      }

      updates.liquidation_preview = preview;
      updates.liquidation_preview_at = new Date();
      await period.update(updates);
      return res.json({
        success: true,
        message: `Periodo liquidado: ${preview.totals.count} empleado${preview.totals.count !== 1 ? 's' : ''}, revise antes de emitir`,
        data: { period, preview },
      });
    }

    // Emitir un periodo = liquidar cada empleado activo + enviar su
    // Documento Soporte de Nómina a la DIAN + (si TODOS quedan aceptados)
    // contabilizar el periodo — ver payrollPeriodEmissionService.js. Si
    // algún empleado queda rechazado, el periodo NO avanza a 'emitido'
    // (queda en 'liquidado') para que se pueda corregir y reintentar sin
    // reenviar los que ya fueron aceptados (idempotente).
    if (status === 'emitido') {
      const tenant = await Tenant.findByPk(tenant_id);
      if (!tenant) {
        return res.status(400).json({ success: false, message: 'Tenant no encontrado' });
      }

      let emissionResult;
      try {
        emissionResult = await submitPayrollPeriod(period, tenant, req.user.id);
      } catch (emissionError) {
        console.error('Error en submitPayrollPeriod:', emissionError);
        return res.status(400).json({
          success: false,
          message: `No se pudo emitir el periodo: ${emissionError.message}`,
        });
      }

      if (!emissionResult.allAccepted) {
        const rejected = emissionResult.results.filter(r => !r.accepted);
        return res.status(207).json({
          success: false,
          message: `${rejected.length} de ${emissionResult.results.length} empleados no fueron aceptados por la DIAN. El periodo permanece en "liquidado" — corrija y vuelva a intentar (los ya aceptados no se reenvían).`,
          data: {
            period,
            results: emissionResult.results.map(r => ({
              employeeId: r.employee.id,
              employeeName: `${r.employee.first_name} ${r.employee.first_surname}`,
              accepted: r.accepted,
              error: r.error,
            })),
          },
        });
      }

      // Todos aceptados: sí se avanza el periodo a 'emitido' y queda
      // registrado el asiento contable generado.
      await period.update(updates);
      return res.json({
        success: true,
        message: `Periodo emitido: ${emissionResult.results.length} documentos aceptados por la DIAN, asiento contable generado`,
        data: { period, accountingEntryId: emissionResult.accountingEntry?.id || null },
      });
    }

    await period.update(updates);
    res.json({ success: true, message: `Periodo pasado a estado "${status}"`, data: period });
  } catch (error) {
    console.error('Error en changePayrollPeriodStatus:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cambiar el estado del periodo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const deletePayrollPeriod = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const period = await PayrollPeriod.findOne({ where: { id, tenant_id } });
    if (!period) {
      return res.status(404).json({ success: false, message: 'Periodo no encontrado' });
    }

    if (period.status !== 'abierto') {
      return res.status(400).json({
        success: false,
        message: 'Solo se puede eliminar un periodo en estado "abierto"',
      });
    }

    await period.destroy();
    res.json({ success: true, message: 'Periodo eliminado exitosamente' });
  } catch (error) {
    console.error('Error en deletePayrollPeriod:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar periodo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

/**
 * Sugiere fechas para un periodo nuevo, para que el usuario no tenga que
 * calcularlas a mano cada vez: si ya existe un periodo anterior con la
 * misma sede+tipo, arranca el día siguiente a que terminó ese; si no,
 * usa la quincena/mes en curso según la fecha de hoy. Es solo una
 * sugerencia — createPayrollPeriod no depende de este endpoint ni exige
 * que las fechas vengan de aquí.
 */
const suggestNextPeriod = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const tenant_id = req.user.tenant_id;
    const { branch_id, period_type = 'mensual' } = req.query;

    if (!['mensual', 'quincenal'].includes(period_type)) {
      return res.status(400).json({ success: false, message: "period_type debe ser 'mensual' o 'quincenal'" });
    }

    const where = { tenant_id, period_type };
    if (branch_id) where.branch_id = branch_id;

    const lastPeriod = await PayrollPeriod.findOne({ where, order: [['end_date', 'DESC']] });

    let start_date;
    let basedOn;
    if (lastPeriod) {
      start_date = addDays(lastPeriod.end_date, 1);
      basedOn = 'last_period';
    } else {
      const today = toISODate(new Date());
      if (period_type === 'quincenal' && parseISODate(today).getUTCDate() > 15) {
        const d = parseISODate(today);
        start_date = toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 16)));
      } else {
        start_date = firstDayOfMonthISO(today);
      }
      basedOn = 'calendar_default';
    }

    const end_date = computeEndDate(start_date, period_type);

    res.json({
      success: true,
      data: {
        start_date,
        end_date,
        payment_date: end_date, // sugerencia editable, no se asume política de pago
        period_type,
        branch_id: branch_id || null,
        based_on: basedOn,
      },
    });
  } catch (error) {
    console.error('Error en suggestNextPeriod:', error);
    res.status(500).json({
      success: false,
      message: 'Error al sugerir el siguiente periodo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

/**
 * Vuelve a calcular la vista previa de liquidación de un periodo que YA
 * está en 'liquidado', sin cambiar su estado — para cuando el usuario
 * agrega/borra novedades después de haber liquidado y quiere ver los
 * valores actualizados sin tener que reabrir el periodo (que no se puede:
 * las transiciones de estado solo avanzan).
 */
const recalculatePeriodPreview = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const period = await PayrollPeriod.findOne({ where: { id, tenant_id } });
    if (!period) {
      return res.status(404).json({ success: false, message: 'Periodo no encontrado' });
    }
    if (period.status !== 'liquidado') {
      return res.status(400).json({
        success: false,
        message: `Solo se puede recalcular un periodo en estado "liquidado" (este está en "${period.status}").`,
      });
    }

    const preview = await previewPayrollPeriod(period, tenant_id);
    await period.update({ liquidation_preview: preview, liquidation_preview_at: new Date() });

    res.json({
      success: true,
      message: 'Vista previa recalculada',
      data: { period, preview },
    });
  } catch (error) {
    console.error('Error en recalculatePeriodPreview:', error);
    res.status(500).json({
      success: false,
      message: 'Error al recalcular la vista previa',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = {
  getPayrollPeriods,
  getPayrollPeriodById,
  createPayrollPeriod,
  updatePayrollPeriod,
  changePayrollPeriodStatus,
  deletePayrollPeriod,
  suggestNextPeriod,
  recalculatePeriodPreview,
};