// backend/src/services/workshop/vehicle360.service.js
//
// Hoja de vida 360 del vehículo (migración 2026112701): todo lo que le ha
// pasado al vehículo en un solo lugar, armado al leer desde las tablas que ya
// existen (OT, mantenimientos, citas, peritajes, propietarios, consultas
// RUNT, recordatorios). No hay tabla de "eventos": nada que sincronizar.
//
// Lo que sale al portal público (sticker QR) pasa por publicView(), que
// quita todo dato personal (propietarios, solicitantes, técnicos con
// apellido, valores).
const { Op } = require('sequelize');
const {
  Vehicle, Customer, WorkOrder, WorkOrderItem, User, Sale, WorkshopAppointment,
  VehicleMaintenanceRecord, MaintenanceType, VehicleReminderLog,
  VehicleOwner, VehicleRuntSnapshot, VehicleInspection, VehicleInspectionItem,
} = require('../../models');
const { estimateUsage } = require('./maintenance.service');

const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const customerName = (c) => (c ? (c.business_name || `${c.first_name || ''} ${c.last_name || ''}`.trim()) : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

// Una lectura que baja más de esto respecto al máximo anterior se marca
// como posible alteración del odómetro (o error de digitación).
const ODOMETER_TOLERANCE = { km: 50, h: 5 };

// ── Propietarios ──────────────────────────────────────────────────────

/**
 * Registra un cambio de propietario: cierra el vigente (ended_at = hoy) y
 * abre uno nuevo si hay nuevo cliente. No hace nada si no cambió.
 */
async function recordOwnerChange(vehicle, previousCustomerId, newCustomerId, userId, { transaction, notes, date } = {}) {
  if ((previousCustomerId || null) === (newCustomerId || null)) return null;
  const day = date || todayLocal();
  const open = await VehicleOwner.findOne({
    where: { vehicle_id: vehicle.id, ended_at: null },
    order: [['started_at', 'DESC'], ['created_at', 'DESC']],
    transaction,
  });
  if (open) {
    await open.update({ ended_at: day < open.started_at ? open.started_at : day }, { transaction });
  } else if (previousCustomerId) {
    // Vehículo sin historial (creado antes de la migración y sin dueño en
    // ese momento): dejar constancia del dueño anterior.
    await VehicleOwner.create({
      tenant_id: vehicle.tenant_id, vehicle_id: vehicle.id, customer_id: previousCustomerId,
      started_at: (vehicle.createdAt ? new Date(vehicle.createdAt).toISOString().slice(0, 10) : day),
      ended_at: day, source: 'inicial', created_by: userId,
    }, { transaction });
  }
  if (!newCustomerId) return null;
  return VehicleOwner.create({
    tenant_id: vehicle.tenant_id, vehicle_id: vehicle.id, customer_id: newCustomerId,
    started_at: day, source: open || previousCustomerId ? 'cambio' : 'inicial', notes: notes || null, created_by: userId,
  }, { transaction });
}

async function listOwners(vehicle) {
  const rows = await VehicleOwner.findAll({
    where: { vehicle_id: vehicle.id, tenant_id: vehicle.tenant_id },
    include: [
      { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'phone'] },
      { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] },
    ],
    order: [['started_at', 'DESC'], ['created_at', 'DESC']],
  });
  return rows.map((o) => ({
    id: o.id, customer_id: o.customer_id, customer_name: customerName(o.customer), customer_tax_id: o.customer?.tax_id || null,
    started_at: o.started_at, ended_at: o.ended_at, source: o.source, notes: o.notes, current: !o.ended_at,
    created_by: o.creator ? `${o.creator.first_name || ''} ${o.creator.last_name || ''}`.trim() : null,
  }));
}

// ── RUNT ──────────────────────────────────────────────────────────────

const truthyRunt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toUpperCase();
  if (['NO', 'N', 'FALSE', '0', 'NINGUNO', 'NINGUNA', 'SIN'].includes(s)) return false;
  return true;
};

/** Guarda el resultado de RuntConsultaModal (shape de runt.controller consultarVehiculo). */
async function saveRuntSnapshot(vehicle, userId, runtData) {
  if (!runtData || typeof runtData !== 'object') throw Object.assign(new Error('Datos RUNT inválidos'), { statusCode: 400 });
  const extra = runtData._runt || {};
  const isDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null);
  return VehicleRuntSnapshot.create({
    tenant_id: vehicle.tenant_id, vehicle_id: vehicle.id, consulted_by: userId, consulted_at: new Date(),
    estado: extra.estadoAutomotor ? String(extra.estadoAutomotor).slice(0, 60) : null,
    has_liens: truthyRunt(extra.gravamenes),
    has_pledges: truthyRunt(extra.prendas),
    soat_expiry: isDate(runtData.soat_expiry),
    tecnomecanica_expiry: isDate(runtData.tecnomecanica_expiry),
    data: runtData,
  });
}

async function listRuntSnapshots(vehicle, limit = 20) {
  return VehicleRuntSnapshot.findAll({
    where: { vehicle_id: vehicle.id, tenant_id: vehicle.tenant_id },
    include: [{ model: User, as: 'consultant', attributes: ['id', 'first_name', 'last_name'] }],
    order: [['consulted_at', 'DESC']],
    limit,
  });
}

// ── Carga común ───────────────────────────────────────────────────────

async function loadSources(vehicle) {
  const where = { vehicle_id: vehicle.id, tenant_id: vehicle.tenant_id };
  const [orders, maintenance, appointments, inspections, owners, runts, reminders] = await Promise.all([
    WorkOrder.findAll({
      where,
      attributes: ['id', 'order_number', 'status', 'received_at', 'delivered_at', 'mileage_in', 'mileage_out',
        'total_amount', 'problem_description', 'work_performed', 'photos_in', 'photos_out', 'customer_id'],
      include: [
        { model: User, as: 'technician', attributes: ['id', 'first_name', 'last_name'] },
        { model: Sale, as: 'sale', attributes: ['id', 'sale_number', 'status', 'total_amount'] },
        { model: WorkOrderItem, as: 'items', attributes: ['item_type', 'product_name', 'quantity', 'approval_status'] },
      ],
      order: [['received_at', 'DESC']],
    }),
    VehicleMaintenanceRecord.findAll({
      where,
      include: [{ model: MaintenanceType, as: 'maintenance_type', attributes: ['id', 'name'] }],
      order: [['performed_at', 'DESC']],
    }),
    WorkshopAppointment.findAll({
      where,
      attributes: ['id', 'scheduled_at', 'status', 'service_description', 'converted_to_work_order_id'],
      order: [['scheduled_at', 'DESC']],
    }),
    VehicleInspection.findAll({
      where: { ...where, status: { [Op.ne]: 'cancelled' } },
      attributes: ['id', 'number', 'status', 'inspected_at', 'finalized_at', 'mileage', 'score', 'concept', 'suggested_concept',
        'section_scores', 'requester_type', 'purpose', 'is_public', 'verify_token', 'photos', 'body_marks'],
      include: [{ model: User, as: 'inspector', attributes: ['id', 'first_name', 'last_name'] }],
      order: [['inspected_at', 'DESC']],
    }),
    VehicleOwner.findAll({
      where,
      include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] }],
      order: [['started_at', 'DESC']],
    }),
    VehicleRuntSnapshot.findAll({ where, order: [['consulted_at', 'DESC']], limit: 50 }),
    VehicleReminderLog.findAll({ where, order: [['created_at', 'DESC']], limit: 50 }),
  ]);
  return { orders, maintenance, appointments, inspections, owners, runts, reminders };
}

// ── Kilometraje ───────────────────────────────────────────────────────

function buildOdometer(vehicle, src) {
  const unit = vehicle.meter_unit || 'km';
  const readings = [];
  for (const o of src.orders) {
    if (o.status === 'cancelado') continue;
    if (o.mileage_in && o.received_at) readings.push({ date: o.received_at, value: Number(o.mileage_in), source: 'ot_ingreso', ref: o.order_number, ref_id: o.id });
    if (o.mileage_out && o.delivered_at) readings.push({ date: o.delivered_at, value: Number(o.mileage_out), source: 'ot_entrega', ref: o.order_number, ref_id: o.id });
  }
  for (const i of src.inspections) {
    if (i.status === 'finalized' && i.mileage) readings.push({ date: i.inspected_at, value: Number(i.mileage), source: 'peritaje', ref: i.number, ref_id: i.id });
  }
  for (const r of src.maintenance) {
    if (!r.work_order_id && r.mileage_at_service && r.performed_at) {
      readings.push({ date: r.performed_at, value: Number(r.mileage_at_service), source: 'mantenimiento', ref: r.maintenance_type?.name || null, ref_id: r.id });
    }
  }
  readings.sort((a, b) => new Date(a.date) - new Date(b.date) || a.value - b.value);

  const tol = ODOMETER_TOLERANCE[unit] ?? 50;
  const anomalies = [];
  let max = null;
  for (const r of readings) {
    if (max && r.value < max.value - tol) {
      r.anomaly = true;
      anomalies.push({
        date: r.date, value: r.value, source: r.source, ref: r.ref,
        previous_value: max.value, previous_date: max.date, previous_ref: max.ref, drop: max.value - r.value,
      });
    }
    if (!max || r.value > max.value) max = r;
  }
  const usage = estimateUsage(readings.filter((r) => !r.anomaly).map((r) => ({ date: r.date, km: r.value })));
  return { unit, readings, anomalies, usage };
}

// ── Línea de tiempo ───────────────────────────────────────────────────

const OT_LABEL = { recibido: 'Recibida', en_proceso: 'En proceso', en_espera: 'En espera', listo: 'Lista', entregado: 'Entregada', cancelado: 'Cancelada' };
const CONCEPT_LABEL = { aprobado: 'Aprobado', aprobado_observaciones: 'Aprobado con observaciones', no_recomendado: 'No recomendado' };
const APPT_LABEL = { pendiente: 'Pendiente', confirmada: 'Confirmada', cancelada: 'Cancelada', no_asistio: 'No asistió', completada: 'Completada' };

function buildTimeline(vehicle, src, odometer) {
  const events = [];
  const maintByOrder = new Map();
  for (const r of src.maintenance) {
    if (!r.work_order_id) continue;
    if (!maintByOrder.has(r.work_order_id)) maintByOrder.set(r.work_order_id, []);
    maintByOrder.get(r.work_order_id).push(r.maintenance_type?.name);
  }

  for (const o of src.orders) {
    const approved = (o.items || []).filter((i) => (i.approval_status || 'aprobado') === 'aprobado');
    events.push({
      type: 'work_order', date: o.delivered_at || o.received_at, status: o.status,
      title: `OT ${o.order_number} · ${OT_LABEL[o.status] || o.status}`,
      detail: o.work_performed || o.problem_description || null,
      mileage: num(o.mileage_out || o.mileage_in),
      amount: num(o.total_amount),
      technician: o.technician ? `${o.technician.first_name || ''} ${o.technician.last_name || ''}`.trim() : null,
      maintenance: (maintByOrder.get(o.id) || []).filter(Boolean),
      items: approved.slice(0, 12).map((i) => ({ item_type: i.item_type, name: i.product_name, quantity: num(i.quantity) })),
      invoice: o.sale ? { id: o.sale.id, number: o.sale.sale_number } : null,
      photos: (o.photos_in?.length || 0) + (o.photos_out?.length || 0),
      ref: { kind: 'work_order', id: o.id, number: o.order_number },
    });
  }
  for (const r of src.maintenance) {
    if (r.work_order_id) continue; // ya va dentro de su OT
    events.push({
      type: 'maintenance', date: r.performed_at, title: `Mantenimiento: ${r.maintenance_type?.name || 'servicio'}`,
      mileage: num(r.mileage_at_service), ref: { kind: 'maintenance', id: r.id },
    });
  }
  for (const i of src.inspections) {
    events.push({
      type: 'inspection', date: i.inspected_at, status: i.status,
      title: `Peritaje ${i.number}${i.status === 'draft' ? ' · en borrador' : ''}`,
      detail: i.concept ? `${CONCEPT_LABEL[i.concept]}${i.score != null ? ` · ${Number(i.score)} / 100` : ''}` : null,
      concept: i.concept, score: num(i.score), mileage: num(i.mileage), is_public: i.is_public,
      ref: { kind: 'inspection', id: i.id, number: i.number },
    });
  }
  for (const a of src.appointments) {
    if (a.status === 'completada' && a.converted_to_work_order_id) continue; // la OT ya está
    events.push({
      type: 'appointment', date: a.scheduled_at, status: a.status,
      title: `Cita · ${APPT_LABEL[a.status] || a.status}`, detail: a.service_description || null,
      ref: { kind: 'appointment', id: a.id },
    });
  }
  for (const ow of src.owners) {
    events.push({
      type: 'owner', date: ow.started_at, source: ow.source,
      title: ow.source === 'inicial' ? 'Propietario registrado' : 'Cambio de propietario',
      detail: customerName(ow.customer), owner_id: ow.customer_id,
      ref: { kind: 'owner', id: ow.id },
    });
  }
  for (const s of src.runts) {
    const flags = [s.has_pledges ? 'con prenda' : null, s.has_liens ? 'con gravámenes' : null].filter(Boolean);
    events.push({
      type: 'runt', date: s.consulted_at, title: 'Consulta RUNT',
      detail: [s.estado, flags.length ? flags.join(', ') : 'sin prendas ni gravámenes reportados'].filter(Boolean).join(' · '),
      alert: !!(s.has_pledges || s.has_liens), ref: { kind: 'runt', id: s.id },
    });
  }
  for (const r of src.reminders) {
    if (r.status !== 'sent') continue;
    events.push({
      type: 'reminder', date: r.createdAt || r.created_at,
      title: `Recordatorio ${r.document_type === 'soat' ? 'SOAT' : 'técnico-mecánica'} (${r.channel === 'whatsapp' ? 'WhatsApp' : 'correo'})`,
      detail: r.expiry_date ? `Vence ${r.expiry_date}` : null, ref: { kind: 'reminder', id: r.id },
    });
  }
  for (const a of odometer.anomalies) {
    events.push({
      type: 'odometer_alert', date: a.date, alert: true,
      title: `${vehicle.meter_unit === 'h' ? 'Horómetro' : 'Odómetro'} menor al registrado antes`,
      detail: `${a.value.toLocaleString('es-CO')} ${odometer.unit} (${a.ref || a.source}) vs ${a.previous_value.toLocaleString('es-CO')} ${odometer.unit} (${a.previous_ref || ''})`,
    });
  }
  events.push({ type: 'created', date: vehicle.createdAt || vehicle.created_at, title: 'Vehículo registrado en el taller' });

  return events
    .filter((e) => e.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

// ── Galería ───────────────────────────────────────────────────────────

async function buildGallery(vehicle, src) {
  const photos = [];
  for (const o of src.orders) {
    for (const [phase, list] of [['ingreso', o.photos_in], ['entrega', o.photos_out]]) {
      for (const p of list || []) {
        if (!p?.url) continue;
        photos.push({ url: p.url, type: p.type || 'image', caption: p.caption || '', date: phase === 'entrega' ? (o.delivered_at || o.received_at) : o.received_at,
          source: `ot_${phase}`, ref: { kind: 'work_order', id: o.id, number: o.order_number } });
      }
    }
  }
  const inspIds = src.inspections.map((i) => i.id);
  const items = inspIds.length
    ? await VehicleInspectionItem.findAll({
      where: { inspection_id: inspIds, photos: { [Op.ne]: [] } },
      attributes: ['inspection_id', 'label', 'photos'],
    })
    : [];
  const byInsp = new Map(src.inspections.map((i) => [i.id, i]));
  for (const i of src.inspections) {
    for (const p of i.photos || []) {
      if (p?.url) photos.push({ url: p.url, type: 'image', caption: p.caption || '', date: i.inspected_at, source: 'peritaje', ref: { kind: 'inspection', id: i.id, number: i.number } });
    }
  }
  for (const it of items) {
    const i = byInsp.get(it.inspection_id);
    for (const p of it.photos || []) {
      if (p?.url) photos.push({ url: p.url, type: 'image', caption: it.label, date: i?.inspected_at, source: 'peritaje', ref: { kind: 'inspection', id: it.inspection_id, number: i?.number } });
    }
  }
  return photos.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// ── Resumen ───────────────────────────────────────────────────────────

function docState(expiry) {
  if (!expiry) return { status: 'sin_dato', days: null };
  const days = Math.round((new Date(`${expiry}T12:00:00`) - new Date(`${todayLocal()}T12:00:00`)) / 86400000);
  return { status: days < 0 ? 'vencido' : days <= 30 ? 'por_vencer' : 'vigente', days, expiry };
}

function buildSummary(vehicle, src, odometer) {
  const valid = src.orders.filter((o) => o.status !== 'cancelado');
  const delivered = valid.filter((o) => o.status === 'entregado');
  const spent = delivered.reduce((s, o) => s + (Number(o.total_amount) || 0), 0);
  const dates = valid.map((o) => new Date(o.received_at)).sort((a, b) => a - b);
  const last = dates[dates.length - 1] || null;
  const lastInspection = src.inspections.find((i) => i.status === 'finalized') || null;
  const lastRunt = src.runts[0] || null;
  const currentOwner = src.owners.find((o) => !o.ended_at) || null;
  return {
    visits: valid.length,
    open_orders: valid.filter((o) => !['entregado', 'cancelado'].includes(o.status)).length,
    total_spent: Math.round(spent),
    avg_ticket: delivered.length ? Math.round(spent / delivered.length) : 0,
    first_visit: dates[0] || null,
    last_visit: last,
    days_since_last_visit: last ? Math.round((Date.now() - last.getTime()) / 86400000) : null,
    usage: odometer.usage,
    odometer_anomalies: odometer.anomalies.length,
    owners_count: src.owners.length,
    owner_since: currentOwner?.started_at || null,
    inspections: src.inspections.filter((i) => i.status === 'finalized').length,
    last_inspection: lastInspection ? {
      id: lastInspection.id, number: lastInspection.number, date: lastInspection.inspected_at,
      score: num(lastInspection.score), concept: lastInspection.concept, sections: lastInspection.section_scores || [],
    } : null,
    runt: lastRunt ? {
      consulted_at: lastRunt.consulted_at, estado: lastRunt.estado, has_liens: lastRunt.has_liens, has_pledges: lastRunt.has_pledges,
    } : null,
    documents: { soat: docState(vehicle.soat_expiry), tecnomecanica: docState(vehicle.tecnomecanica_expiry) },
  };
}

async function getVehicle360(tenantId, vehicleId) {
  const vehicle = await Vehicle.findOne({ where: { id: vehicleId, tenant_id: tenantId } });
  if (!vehicle) throw Object.assign(new Error('Vehículo no encontrado'), { statusCode: 404 });
  const src = await loadSources(vehicle);
  const odometer = buildOdometer(vehicle, src);
  const [gallery, owners] = await Promise.all([buildGallery(vehicle, src), listOwners(vehicle)]);
  return {
    summary: buildSummary(vehicle, src, odometer),
    timeline: buildTimeline(vehicle, src, odometer),
    odometer,
    gallery,
    owners,
    inspections: src.inspections.map((i) => ({
      id: i.id, number: i.number, status: i.status, inspected_at: i.inspected_at, mileage: num(i.mileage),
      score: num(i.score), concept: i.concept || i.suggested_concept, is_public: i.is_public,
      inspector: i.inspector ? `${i.inspector.first_name || ''} ${i.inspector.last_name || ''}`.trim() : null,
      requester_type: i.requester_type, purpose: i.purpose,
    })),
    runt: src.runts.map((s) => ({
      id: s.id, consulted_at: s.consulted_at, estado: s.estado, has_liens: s.has_liens, has_pledges: s.has_pledges,
      soat_expiry: s.soat_expiry, tecnomecanica_expiry: s.tecnomecanica_expiry, data: s.data,
    })),
  };
}

// ── Vista pública (portal del sticker) ────────────────────────────────

/**
 * Lo que agrega la 360 al portal público. Sin datos personales: ni
 * propietarios (solo cuántos ha tenido el vehículo en el taller), ni
 * solicitantes, ni valores, ni consultas RUNT. Solo peritajes publicados.
 */
async function publicView(vehicle) {
  const src = await loadSources(vehicle);
  const odometer = buildOdometer(vehicle, src);
  const published = src.inspections.filter((i) => i.status === 'finalized' && i.is_public);
  const frontendUrl = process.env.FRONTEND_URL || 'https://tu-app.vercel.app';
  return {
    odometer: {
      unit: odometer.unit,
      readings: odometer.readings.map((r) => ({ date: r.date, value: r.value, source: r.source, anomaly: !!r.anomaly })),
      anomalies: odometer.anomalies.length,
    },
    owners_count: src.owners.length,
    inspections: published.map((i) => ({
      number: i.number, date: i.inspected_at, mileage: num(i.mileage), score: num(i.score), concept: i.concept,
      sections: (i.section_scores || []).filter((s) => s.score !== null).map((s) => ({ label: s.label, score: s.score })),
      verify_url: `${frontendUrl}/peritaje/${i.verify_token}`,
    })),
  };
}

module.exports = {
  recordOwnerChange, listOwners, saveRuntSnapshot, listRuntSnapshots,
  getVehicle360, publicView, buildOdometer, ODOMETER_TOLERANCE,
};
