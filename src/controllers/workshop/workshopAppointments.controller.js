// backend/src/controllers/workshop/workshopAppointments.controller.js
const crypto = require('crypto');
const logger = require('../../config/logger');
const { sequelize } = require('../../config/database');
const {
  WorkshopAppointment, WorkshopAppointmentConfig, Branch, Customer, Vehicle,
  WorkOrder, Warehouse, Tenant,
} = require('../../models');
const { Op } = require('sequelize');
const { runWithTenantSchema } = require('../../config/tenantContext');
const whatsappService = require('../../services/whatsappService');

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date#getDay(): 0=domingo

function dateStrOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function timeStrOf(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function minutesToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// Franjas candidatas de un día según business_hours -- un solo rango por
// día (sin partir en almuerzo, MVP simple). No mira disponibilidad todavía.
function generateSlotsForDay(config, dateStr) {
  const weekday = WEEKDAY_KEYS[new Date(`${dateStr}T00:00:00`).getDay()];
  const ranges = config.business_hours?.[weekday] || [];
  const slots = [];
  for (const range of ranges) {
    let cursor = toMinutes(range.start);
    const end = toMinutes(range.end);
    while (cursor + config.slot_duration_minutes <= end) {
      slots.push(minutesToHHMM(cursor));
      cursor += config.slot_duration_minutes;
    }
  }
  return slots;
}

function formatDateEs(date) {
  return new Date(date).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' });
}

async function computeAvailability({ tenant_id, branch_id, date }) {
  const config = await WorkshopAppointmentConfig.findOne({ where: { tenant_id, branch_id } });
  if (!config || !config.is_public_booking_enabled) return { open: false, slots: [] };

  const isBlocked = (config.blocked_dates || []).some(b => b.date === date);
  if (isBlocked) return { open: false, slots: [], reason: 'blocked' };

  const slotTimes = generateSlotsForDay(config, date);
  if (slotTimes.length === 0) return { open: false, slots: [] };

  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T23:59:59`);
  const existing = await WorkshopAppointment.findAll({
    where: {
      tenant_id, branch_id,
      status: { [Op.in]: ['pendiente', 'confirmada'] },
      scheduled_at: { [Op.between]: [dayStart, dayEnd] },
    },
    attributes: ['scheduled_at'],
  });
  const counts = {};
  for (const a of existing) {
    const key = a.scheduled_at.toISOString();
    counts[key] = (counts[key] || 0) + 1;
  }

  const now = new Date();
  const minAllowed = new Date(now.getTime() + config.min_notice_hours * 3600000);
  const maxAllowed = new Date(now.getTime() + config.advance_booking_days * 86400000);

  const slots = slotTimes.map(time => {
    const dt = new Date(`${date}T${time}:00`);
    const booked = counts[dt.toISOString()] || 0;
    const withinWindow = dt >= minAllowed && dt <= maxAllowed;
    return {
      time,
      scheduled_at: dt.toISOString(),
      capacity: config.capacity_per_slot,
      booked,
      available: withinWindow && booked < config.capacity_per_slot,
    };
  });

  return { open: true, slot_duration_minutes: config.slot_duration_minutes, slots };
}

// ── Resolución de tenant SIN token previo (primera vez que aparece el
// cliente) -- por slug, a diferencia de resolveSaleSchemaByToken/
// resolveWorkOrderSchemaByToken que resuelven un registro ya existente.
async function resolveTenantSchemaBySlug(slug) {
  const [rows] = await sequelize.query(
    'SELECT id, schema_name FROM "public"."tenants" WHERE slug = :slug LIMIT 1',
    { replacements: { slug } }
  );
  if (!rows[0]) return null;
  return { tenantId: rows[0].id, schemaName: rows[0].schema_name || null };
}

// Mismo patrón que resolveSaleSchemaByToken, para /public/workshop/appointments/:token
async function resolveAppointmentSchemaByToken(token) {
  const [publicRows] = await sequelize.query(
    'SELECT id FROM "public"."workshop_appointments" WHERE share_token = :token LIMIT 1',
    { replacements: { token } }
  );
  if (publicRows[0]) return { appointmentId: publicRows[0].id, schemaName: null };

  const [tenants] = await sequelize.query(
    'SELECT schema_name FROM "public"."tenants" WHERE schema_name IS NOT NULL'
  );
  for (const { schema_name } of tenants) {
    const [rows] = await sequelize.query(
      `SELECT id FROM "${schema_name}"."workshop_appointments" WHERE share_token = :token LIMIT 1`,
      { replacements: { token } }
    );
    if (rows[0]) return { appointmentId: rows[0].id, schemaName: schema_name };
  }
  return null;
}

async function generateOrderNumber(tenant_id, transaction) {
  const year = new Date().getFullYear();
  const prefix = `OT-${year}-`;
  const last = await WorkOrder.findOne({
    where: { tenant_id, order_number: { [Op.like]: `${prefix}%` } },
    order: [['order_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction,
  });
  const lastSeq = last ? parseInt(last.order_number.replace(prefix, ''), 10) : 0;
  const seq = (isNaN(lastSeq) ? 0 : lastSeq) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// Crea la solicitud -- reusada por el flujo público y por el staff (walk-in
// / teléfono). Revalida horario, fecha bloqueada, ventana de reserva y
// capacidad server-side (nunca confiar solo en lo que ya filtró el cliente).
async function createAppointmentBody({ tenant_id, branch_id, body, source, res }) {
  const {
    scheduled_at, customer_name, customer_phone, customer_email,
    vehicle_plate, vehicle_brand, vehicle_model, service_description,
  } = body;

  if (!scheduled_at || !customer_name || !customer_phone) {
    return res.status(400).json({ success: false, message: 'Fecha, nombre y teléfono son requeridos' });
  }

  const config = await WorkshopAppointmentConfig.findOne({ where: { tenant_id, branch_id } });
  if (!config || !config.is_public_booking_enabled) {
    return res.status(404).json({ success: false, message: 'Esta sede no tiene reserva de citas habilitada' });
  }

  const dt = new Date(scheduled_at);
  if (Number.isNaN(dt.getTime())) {
    return res.status(400).json({ success: false, message: 'Fecha inválida' });
  }

  const dateStr = dateStrOf(dt);
  const isBlocked = (config.blocked_dates || []).some(b => b.date === dateStr);
  if (isBlocked) {
    return res.status(400).json({ success: false, message: 'Esa fecha no está disponible' });
  }

  const validSlotTimes = generateSlotsForDay(config, dateStr);
  if (!validSlotTimes.includes(timeStrOf(dt))) {
    return res.status(400).json({ success: false, message: 'Esa franja no está dentro del horario disponible' });
  }

  const now = new Date();
  const minAllowed = new Date(now.getTime() + config.min_notice_hours * 3600000);
  const maxAllowed = new Date(now.getTime() + config.advance_booking_days * 86400000);
  if (dt < minAllowed || dt > maxAllowed) {
    return res.status(400).json({ success: false, message: 'Esa fecha/hora está fuera de la ventana de reserva permitida' });
  }

  const transaction = await sequelize.transaction();
  try {
    const count = await WorkshopAppointment.count({
      where: { tenant_id, branch_id, scheduled_at: dt, status: { [Op.in]: ['pendiente', 'confirmada'] } },
      transaction,
    });
    if (count >= config.capacity_per_slot) {
      await transaction.rollback();
      return res.status(409).json({ success: false, message: 'Esa franja ya no tiene disponibilidad, elige otra.' });
    }

    const appointment = await WorkshopAppointment.create({
      tenant_id, branch_id,
      scheduled_at: dt,
      duration_minutes: config.slot_duration_minutes,
      customer_name, customer_phone,
      customer_email: customer_email || null,
      vehicle_plate: vehicle_plate || null,
      vehicle_brand: vehicle_brand || null,
      vehicle_model: vehicle_model || null,
      service_description: service_description || null,
      share_token: crypto.randomUUID(),
      source,
    }, { transaction });

    await transaction.commit();

    // Avisar en vivo al staff conectado (namespace /appointments) cuando la
    // solicitud viene del cliente -- las creadas por el propio staff
    // (walk-in/teléfono) no necesitan notificarse a sí mismas.
    if (source === 'public') {
      try {
        const { emitNewAppointment } = require('../../services/appointmentNotifications.socket');
        emitNewAppointment(tenant_id, {
          id: appointment.id,
          customer_name: appointment.customer_name,
          scheduled_at: appointment.scheduled_at,
          vehicle_plate: appointment.vehicle_plate,
        });
      } catch (e) {
        logger.error('Error emitiendo notificación de nueva cita:', e);
      }
    }

    res.status(201).json({
      success: true,
      data: { id: appointment.id, share_token: appointment.share_token, scheduled_at: appointment.scheduled_at, status: appointment.status },
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error creando cita:', error);
    res.status(500).json({ success: false, message: 'Error al crear la cita' });
  }
}

// ── Endpoints PÚBLICOS (sin auth) ───────────────────────────────────────────

const getPublicBranches = async (req, res) => {
  try {
    const { slug } = req.params;
    const resolved = await resolveTenantSchemaBySlug(slug);
    if (!resolved) return res.status(404).json({ success: false, message: 'Taller no encontrado' });
    return runWithTenantSchema(resolved.schemaName, () => getPublicBranchesBody(resolved.tenantId, res));
  } catch (error) {
    logger.error('[Citas público] Error obteniendo sedes:', error.message);
    res.status(500).json({ success: false, message: 'Error obteniendo sedes' });
  }
};

async function getPublicBranchesBody(tenant_id, res) {
  const configs = await WorkshopAppointmentConfig.findAll({
    where: { tenant_id, is_public_booking_enabled: true },
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'address'], where: { is_active: true }, required: true }],
  });
  res.json({ success: true, data: configs.map(c => c.branch) });
}

const getPublicConfig = async (req, res) => {
  try {
    const { slug, branchId } = req.params;
    const resolved = await resolveTenantSchemaBySlug(slug);
    if (!resolved) return res.status(404).json({ success: false, message: 'Taller no encontrado' });
    return runWithTenantSchema(resolved.schemaName, () => getPublicConfigBody(resolved.tenantId, branchId, res));
  } catch (error) {
    logger.error('[Citas público] Error obteniendo horario:', error.message);
    res.status(500).json({ success: false, message: 'Error obteniendo horario' });
  }
};

async function getPublicConfigBody(tenant_id, branch_id, res) {
  const config = await WorkshopAppointmentConfig.findOne({ where: { tenant_id, branch_id } });
  if (!config || !config.is_public_booking_enabled) {
    return res.status(404).json({ success: false, message: 'Esta sede no tiene reserva de citas habilitada' });
  }
  res.json({
    success: true,
    data: {
      business_hours: config.business_hours,
      slot_duration_minutes: config.slot_duration_minutes,
      advance_booking_days: config.advance_booking_days,
      min_notice_hours: config.min_notice_hours,
      blocked_dates: config.blocked_dates,
    },
  });
}

const getPublicAvailability = async (req, res) => {
  try {
    const { slug, branchId } = req.params;
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'Fecha requerida' });
    const resolved = await resolveTenantSchemaBySlug(slug);
    if (!resolved) return res.status(404).json({ success: false, message: 'Taller no encontrado' });
    return runWithTenantSchema(resolved.schemaName, async () => {
      const availability = await computeAvailability({ tenant_id: resolved.tenantId, branch_id: branchId, date });
      res.json({ success: true, data: availability });
    });
  } catch (error) {
    logger.error('[Citas público] Error obteniendo disponibilidad:', error.message);
    res.status(500).json({ success: false, message: 'Error obteniendo disponibilidad' });
  }
};

const createPublicAppointment = async (req, res) => {
  try {
    const { slug, branchId } = req.params;
    const resolved = await resolveTenantSchemaBySlug(slug);
    if (!resolved) return res.status(404).json({ success: false, message: 'Taller no encontrado' });
    return runWithTenantSchema(resolved.schemaName, () =>
      createAppointmentBody({ tenant_id: resolved.tenantId, branch_id: branchId, body: req.body, source: 'public', res })
    );
  } catch (error) {
    logger.error('[Citas público] Error creando cita:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear la cita' });
  }
};

const getPublicAppointmentStatus = async (req, res) => {
  try {
    const { token } = req.params;
    let resolved;
    try {
      resolved = await resolveAppointmentSchemaByToken(token);
    } catch {
      return res.status(503).json({ success: false, message: 'Función no disponible aún' });
    }
    if (!resolved) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    return runWithTenantSchema(resolved.schemaName, () => getPublicAppointmentStatusBody(resolved.appointmentId, res));
  } catch (error) {
    logger.error('[Citas público] Error consultando estado:', error.message);
    res.status(500).json({ success: false, message: 'Error obteniendo la cita' });
  }
};

async function getPublicAppointmentStatusBody(appointmentId, res) {
  const appointment = await WorkshopAppointment.findByPk(appointmentId, {
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'address', 'phone'] }],
  });
  if (!appointment) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
  res.json({
    success: true,
    data: {
      status: appointment.status,
      scheduled_at: appointment.scheduled_at,
      duration_minutes: appointment.duration_minutes,
      customer_name: appointment.customer_name,
      vehicle_plate: appointment.vehicle_plate,
      cancelled_reason: appointment.cancelled_reason,
      branch: appointment.branch,
    },
  });
}

// ── Endpoints de STAFF (autenticados, sede activa vía branchMiddleware) ────

const getConfig = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const branch_id = req.branch_id;
    if (!branch_id) return res.status(409).json({ success: false, message: 'No hay sede activa' });

    let config = await WorkshopAppointmentConfig.findOne({ where: { tenant_id, branch_id } });
    if (!config) config = await WorkshopAppointmentConfig.create({ tenant_id, branch_id });
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Error obteniendo config de citas:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la configuración' });
  }
};

const updateConfig = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const branch_id = req.branch_id;
    if (!branch_id) return res.status(409).json({ success: false, message: 'No hay sede activa' });

    const {
      business_hours, slot_duration_minutes, capacity_per_slot,
      advance_booking_days, min_notice_hours, blocked_dates, is_public_booking_enabled,
    } = req.body;
    const updateData = {};
    if (business_hours !== undefined) updateData.business_hours = business_hours;
    if (slot_duration_minutes !== undefined) updateData.slot_duration_minutes = slot_duration_minutes;
    if (capacity_per_slot !== undefined) updateData.capacity_per_slot = capacity_per_slot;
    if (advance_booking_days !== undefined) updateData.advance_booking_days = advance_booking_days;
    if (min_notice_hours !== undefined) updateData.min_notice_hours = min_notice_hours;
    if (blocked_dates !== undefined) updateData.blocked_dates = blocked_dates;
    if (is_public_booking_enabled !== undefined) updateData.is_public_booking_enabled = is_public_booking_enabled;

    let config = await WorkshopAppointmentConfig.findOne({ where: { tenant_id, branch_id } });
    if (!config) config = await WorkshopAppointmentConfig.create({ tenant_id, branch_id, ...updateData });
    else await config.update(updateData);

    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Error actualizando config de citas:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la configuración' });
  }
};

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { date, from_date, to_date, status } = req.query;
    const where = { tenant_id, branch_id: req.branch_id };
    if (status) where.status = status;
    if (date) where.scheduled_at = { [Op.between]: [new Date(`${date}T00:00:00`), new Date(`${date}T23:59:59`)] };
    else if (from_date && to_date) where.scheduled_at = { [Op.between]: [new Date(from_date), new Date(to_date)] };

    const appointments = await WorkshopAppointment.findAll({ where, order: [['scheduled_at', 'ASC']] });
    res.json({ success: true, data: appointments });
  } catch (error) {
    logger.error('Error listando citas:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las citas' });
  }
};

const getPending = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const appointments = await WorkshopAppointment.findAll({
      where: { tenant_id, branch_id: req.branch_id, status: 'pendiente' },
      order: [['created_at', 'DESC']],
      limit: 20,
    });
    res.json({ success: true, data: appointments });
  } catch (error) {
    logger.error('Error obteniendo citas pendientes:', error);
    res.status(500).json({ success: false, message: 'Error al obtener citas pendientes' });
  }
};

const createStaffAppointment = async (req, res) => {
  const branch_id = req.branch_id;
  if (!branch_id) return res.status(409).json({ success: false, message: 'No hay sede activa' });
  return createAppointmentBody({ tenant_id: req.user.tenant_id, branch_id, body: req.body, source: 'staff', res });
};

const confirmAppointment = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const appointment = await WorkshopAppointment.findOne({ where: { id: req.params.id, tenant_id } });
    if (!appointment) return res.status(404).json({ success: false, message: 'Cita no encontrada' });
    if (appointment.status !== 'pendiente') {
      return res.status(400).json({ success: false, message: 'Solo se pueden confirmar citas pendientes' });
    }
    await appointment.update({ status: 'confirmada', confirmed_by: req.user.id, confirmed_at: new Date() });
    res.json({ success: true, data: appointment });
  } catch (error) {
    logger.error('Error confirmando cita:', error);
    res.status(500).json({ success: false, message: 'Error al confirmar la cita' });
  }
};

const cancelAppointment = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { reason } = req.body;
    const appointment = await WorkshopAppointment.findOne({ where: { id: req.params.id, tenant_id } });
    if (!appointment) return res.status(404).json({ success: false, message: 'Cita no encontrada' });
    if (['cancelada', 'completada'].includes(appointment.status)) {
      return res.status(400).json({ success: false, message: 'Esta cita ya no se puede cancelar' });
    }
    await appointment.update({ status: 'cancelada', cancelled_reason: reason || null });
    res.json({ success: true, data: appointment });
  } catch (error) {
    logger.error('Error cancelando cita:', error);
    res.status(500).json({ success: false, message: 'Error al cancelar la cita' });
  }
};

// Mensajes construidos server-side, enviados como link wa.me click-to-send
// -- mismo mecanismo que sales.controller.js#sendWhatsApp (no hay push
// automático de WhatsApp Business API disponible en este proyecto).
const MESSAGE_BUILDERS = {
  confirmacion: (a, tenant) =>
    `Hola ${a.customer_name}! Tu cita en *${tenant.company_name}* quedó *confirmada* para el ${formatDateEs(a.scheduled_at)}.\n\n🚗 Placa: ${a.vehicle_plate || 'N/A'}\n\n¡Te esperamos!`,
  recordatorio: (a, tenant) =>
    `Hola ${a.customer_name}! Te recordamos tu cita en *${tenant.company_name}* el ${formatDateEs(a.scheduled_at)}.\n\n🚗 Placa: ${a.vehicle_plate || 'N/A'}\n\n¡Te esperamos!`,
  cancelacion: (a, tenant) =>
    `Hola ${a.customer_name}, tu cita en *${tenant.company_name}* del ${formatDateEs(a.scheduled_at)} fue *cancelada*.${a.cancelled_reason ? `\nMotivo: ${a.cancelled_reason}` : ''}\n\nSi deseas, puedes agendar una nueva cita cuando quieras.`,
};

const sendAppointmentWhatsApp = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { type } = req.body;
    if (!MESSAGE_BUILDERS[type]) {
      return res.status(400).json({ success: false, message: 'Tipo de mensaje inválido' });
    }

    const appointment = await WorkshopAppointment.findOne({ where: { id: req.params.id, tenant_id } });
    if (!appointment) return res.status(404).json({ success: false, message: 'Cita no encontrada' });

    const tenant = await Tenant.findByPk(tenant_id);
    const message = MESSAGE_BUILDERS[type](appointment, tenant);
    const result = await whatsappService.sendText(appointment.customer_phone, message);

    if (type === 'recordatorio') await appointment.update({ reminder_sent_at: new Date() });

    res.json({ success: true, waLink: result.waLink });
  } catch (error) {
    logger.error('Error generando WhatsApp de cita:', error);
    res.status(500).json({ success: false, message: 'Error al generar el enlace de WhatsApp' });
  }
};

// Convierte una cita CONFIRMADA (cliente ya llegó) en una WorkOrder -- mismo
// patrón que convertQuoteToWorkOrder (workOrders.controller.js): busca o
// crea Vehicle/Customer a partir de los datos sueltos, guard de conversión
// única, bodega por defecto de la sede.
const convertToWorkOrder = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const appointment = await WorkshopAppointment.findOne({ where: { id: req.params.id, tenant_id }, transaction });
    if (!appointment) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Cita no encontrada' });
    }
    if (appointment.status !== 'confirmada') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Solo se pueden convertir citas confirmadas' });
    }
    if (appointment.converted_to_work_order_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Esta cita ya fue convertida a una Orden de Trabajo' });
    }
    // La cita pública no exige placa (el cliente puede no saberla al agendar).
    // Si falta, el staff la digita al confirmar la llegada -- el frontend
    // pide estos datos en un modal antes de reintentar esta misma llamada.
    const plateInput = appointment.vehicle_plate || req.body.vehicle_plate;
    if (!plateInput) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        code: 'VEHICLE_PLATE_REQUIRED',
        message: 'Esta cita no tiene placa registrada. Ingresa la placa del vehículo para continuar.',
      });
    }
    const brandInput = appointment.vehicle_brand || req.body.vehicle_brand || null;
    const modelInput = appointment.vehicle_model || req.body.vehicle_model || null;

    let customer = appointment.customer_id
      ? await Customer.findOne({ where: { id: appointment.customer_id, tenant_id }, transaction })
      : await Customer.findOne({ where: { tenant_id, phone: appointment.customer_phone }, transaction });
    if (!customer) {
      customer = await Customer.create({
        tenant_id,
        first_name: appointment.customer_name,
        phone: appointment.customer_phone,
        email: appointment.customer_email || null,
      }, { transaction });
    }

    const plate = plateInput.toUpperCase().trim();
    let vehicle = await Vehicle.findOne({ where: { tenant_id, plate }, transaction });
    if (!vehicle) {
      vehicle = await Vehicle.create({
        tenant_id,
        customer_id: customer.id,
        plate,
        brand: brandInput,
        model: modelInput,
      }, { transaction });
    } else if (!vehicle.customer_id) {
      await vehicle.update({ customer_id: customer.id }, { transaction });
    }

    // Deja constancia en la cita de los datos que efectivamente se usaron
    // (útil si el staff los completó manualmente en este paso).
    if (!appointment.vehicle_plate) {
      await appointment.update({ vehicle_plate: plate, vehicle_brand: brandInput, vehicle_model: modelInput }, { transaction });
    }

    const branchWarehouse = await Warehouse.findOne({
      where: { branch_id: appointment.branch_id, tenant_id, is_active: true },
      order: [['is_default', 'DESC'], ['created_at', 'ASC']],
      transaction,
    });

    const order_number = await generateOrderNumber(tenant_id, transaction);
    const order = await WorkOrder.create({
      tenant_id, order_number,
      vehicle_id: vehicle.id,
      customer_id: customer.id,
      warehouse_id: branchWarehouse?.id || null,
      problem_description: appointment.service_description || null,
      created_by: req.user.id,
      received_at: new Date(),
    }, { transaction });

    await appointment.update({
      status: 'completada',
      customer_id: customer.id,
      vehicle_id: vehicle.id,
      converted_to_work_order_id: order.id,
    }, { transaction });

    await transaction.commit();

    const full = await WorkOrder.findByPk(order.id, {
      include: [{ model: Vehicle, as: 'vehicle' }, { model: Customer, as: 'customer' }],
    });
    res.json({ success: true, message: 'Orden de trabajo creada', data: full });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error convirtiendo cita a OT:', error);
    res.status(500).json({ success: false, message: 'Error al convertir la cita' });
  }
};

module.exports = {
  // públicos
  getPublicBranches, getPublicConfig, getPublicAvailability, createPublicAppointment, getPublicAppointmentStatus,
  // staff
  getConfig, updateConfig, list, getPending, createStaffAppointment,
  confirmAppointment, cancelAppointment, sendAppointmentWhatsApp, convertToWorkOrder,
};
