// backend/src/services/workshop/maintenance.service.js
//
// Mantenimientos por vehículo -- ver
// 00 - Documentación/plan-portal-mantenimiento-vehiculo.md secciones 3 y 4.
//
//  • generateRecordsForDeliveredOrder: al entregar una OT, crea un
//    vehicle_maintenance_record por cada maintenance_type activo (del
//    vehicle_type del vehículo) cuyo match_keywords aparezca en algún ítem
//    aprobado. Idempotente (índice único work_order_id + maintenance_type_id)
//    porque changeStatus y generateSale pueden dispararlo sobre la misma OT.
//  • resolveVehicleMaintenance: "próximos" por tipo + semáforo, para la
//    ficha interna y el portal público. El km se compara contra una
//    estimación del km de hoy según el ritmo de uso del vehículo
//    (estimateUsage), si hay lecturas suficientes.

const { Op } = require('sequelize');
const { MaintenanceType, VehicleMaintenanceRecord, Vehicle, WorkOrder, WorkOrderItem } = require('../../models');

// Margen del semáforo "próximo" -- constante de código a propósito (el plan
// no pide configurarlo por tenant en esta fase).
const SOON_KM = 500;
const SOON_DAYS = 15;

// Minúsculas y sin tildes: "Cambio de ACEITE" / "aceité" matchean "aceite".
function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function itemMatchesType(itemName, keywords) {
  const name = normalize(itemName);
  if (!name) return false;
  return (keywords || [])
    .map(normalize)
    .filter(Boolean)
    .some(k => name.includes(k));
}

function toDateOnly(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' + N meses. Si el día no existe en el mes destino (31 de
// enero + 1 mes) se va al último día de ese mes, en vez de desbordar a marzo.
function addMonths(dateOnly, months) {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function daysUntil(dateOnly) {
  const today = new Date(`${toDateOnly(new Date())}T00:00:00Z`);
  const target = new Date(`${dateOnly}T00:00:00Z`);
  return Math.round((target - today) / 86400000);
}

/**
 * Crea los registros de mantenimiento de una OT recién entregada. Se llama
 * después del commit de la entrega (changeStatus / generateSale): si esto
 * falla, la OT igual queda entregada -- el llamador solo loguea.
 * Devuelve la cantidad de tipos que matchearon.
 */
async function generateRecordsForDeliveredOrder(orderId, tenant_id) {
  const order = await WorkOrder.findOne({
    where: { id: orderId, tenant_id },
    attributes: ['id', 'tenant_id', 'vehicle_id', 'status', 'mileage_in', 'mileage_out', 'delivered_at'],
  });
  if (!order || order.status !== 'entregado' || !order.vehicle_id) return 0;

  const vehicle = await Vehicle.findOne({
    where: { id: order.vehicle_id, tenant_id },
    attributes: ['id', 'vehicle_type'],
  });
  if (!vehicle) return 0;

  const types = await MaintenanceType.findAll({
    where: { tenant_id, vehicle_type: vehicle.vehicle_type, is_active: true },
  });
  if (types.length === 0) return 0;

  // Mismo criterio que calcTotals: solo lo aprobado se hizo de verdad.
  const items = await WorkOrderItem.findAll({
    where: { work_order_id: order.id },
    attributes: ['product_name', 'approval_status'],
  });
  const doneNames = items
    .filter(i => (i.approval_status || 'aprobado') === 'aprobado')
    .map(i => i.product_name);

  const matched = types.filter(t => doneNames.some(n => itemMatchesType(n, t.match_keywords)));
  if (matched.length === 0) return 0;

  const performed_at = toDateOnly(order.delivered_at || new Date());
  const mileage = order.mileage_out || order.mileage_in || null;

  await VehicleMaintenanceRecord.bulkCreate(matched.map(t => ({
    tenant_id,
    vehicle_id: vehicle.id,
    maintenance_type_id: t.id,
    work_order_id: order.id,
    performed_at,
    mileage_at_service: mileage,
    next_due_mileage: mileage != null && t.interval_km ? mileage + t.interval_km : null,
    next_due_date: t.interval_months ? addMonths(performed_at, t.interval_months) : null,
  })), { ignoreDuplicates: true });

  return matched.length;
}

/**
 * Al reversar una OT entregada (revertStatus) sus registros dejan de ser
 * ciertos -- se borran y se regeneran con los datos finales cuando se
 * vuelva a entregar.
 */
async function removeRecordsForOrder(orderId, tenant_id) {
  await VehicleMaintenanceRecord.destroy({ where: { work_order_id: orderId, tenant_id } });
}

// ── Estimación del km actual por ritmo de uso ────────────────────────────
//
// El sistema solo "ve" el km del vehículo cuando entra al taller -- entre
// visitas no sabe cuánto rodó. Para que el "faltan X km" no se quede
// congelado hasta la próxima visita, se estima el km de hoy con el ritmo de
// uso del propio vehículo, calculado con sus lecturas de km (ingreso y
// salida de cada OT). El dato mejora solo con cada revisión periódica.
const USAGE_WINDOW_DAYS = 730;   // solo el uso reciente (últimos 2 años)
const USAGE_MIN_SPAN_DAYS = 30;  // menos que eso es ruido (dos visitas seguidas)
const USAGE_MAX_KM_PER_DAY = 1500; // más que eso es un error de digitación

const DAY_MS = 86400000;
// Día calendario (hora local) representado como medianoche UTC, para restar
// fechas en días enteros; se vuelve a texto con utcDay(), NO con toDateOnly()
// (que usa hora local y en UTC-5 lo correría un día hacia atrás).
const startOfDay = (d) => new Date(`${toDateOnly(d)}T00:00:00Z`);
const utcDay = (d) => d.toISOString().slice(0, 10);

/**
 * @param {Array<{date: Date|string, km: number}>} readings lecturas de km con fecha
 * @param {Date} [today]
 * @returns {null | { km_per_day, estimated_km, last_reading: {date, km}, readings, span_days }}
 *   null si no hay datos suficientes para una estimación confiable.
 */
function estimateUsage(readings, today = new Date()) {
  const todayStart = startOfDay(today);
  const since = new Date(todayStart.getTime() - USAGE_WINDOW_DAYS * DAY_MS);

  const points = (readings || [])
    .filter(r => r && r.date && Number.isFinite(Number(r.km)) && Number(r.km) > 0)
    .map(r => ({ date: startOfDay(r.date), km: Number(r.km) }))
    .filter(r => r.date >= since && r.date <= todayStart)
    .sort((a, b) => a.date - b.date || a.km - b.km);

  // Un km que retrocede es un error de digitación (o cambio de tablero):
  // se descarta en vez de dejar que arruine el promedio.
  const clean = [];
  for (const p of points) {
    if (clean.length === 0 || p.km >= clean[clean.length - 1].km) clean.push(p);
  }
  if (clean.length < 2) return null;

  const first = clean[0];
  const last = clean[clean.length - 1];
  const spanDays = Math.round((last.date - first.date) / DAY_MS);
  const deltaKm = last.km - first.km;
  if (spanDays < USAGE_MIN_SPAN_DAYS || deltaKm <= 0) return null;

  const kmPerDay = deltaKm / spanDays;
  if (kmPerDay > USAGE_MAX_KM_PER_DAY) return null;

  const daysSinceLast = Math.max(0, Math.round((todayStart - last.date) / DAY_MS));
  return {
    km_per_day: Math.round(kmPerDay * 10) / 10,
    estimated_km: Math.round(last.km + kmPerDay * daysSinceLast),
    last_reading: { date: utcDay(last.date), km: last.km },
    readings: clean.length,
    span_days: spanDays,
  };
}

// Lecturas de km de un vehículo: ingreso (received_at) y salida
// (delivered_at) de cada OT no cancelada.
async function loadMileageReadings(vehicle) {
  const orders = await WorkOrder.findAll({
    where: { vehicle_id: vehicle.id, tenant_id: vehicle.tenant_id, status: { [Op.ne]: 'cancelado' } },
    attributes: ['received_at', 'mileage_in', 'delivered_at', 'mileage_out'],
  });
  const readings = [];
  for (const o of orders) {
    if (o.mileage_in && o.received_at) readings.push({ date: o.received_at, km: o.mileage_in });
    if (o.mileage_out && o.delivered_at) readings.push({ date: o.delivered_at, km: o.mileage_out });
  }
  return readings;
}

function computeStatus(record, currentMileage, usage = null) {
  // El km del vehículo puede venir atrasado (generateSale no lo actualiza):
  // nunca asumir que está por debajo del km al que se hizo el servicio.
  const knownKm = Math.max(currentMileage || 0, record.mileage_at_service || 0) || null;
  // Con ritmo de uso, se compara contra el km estimado de hoy (si es mayor
  // que lo último conocido -- una estimación nunca "resta" km).
  const km_estimated = !!(usage && usage.estimated_km > (knownKm || 0));
  const effectiveKm = km_estimated ? usage.estimated_km : knownKm;

  const km_remaining = record.next_due_mileage != null && effectiveKm != null
    ? record.next_due_mileage - effectiveKm
    : null;
  const days_remaining = record.next_due_date ? daysUntil(record.next_due_date) : null;

  // Fecha aproximada en que llegaría al km del próximo servicio a su ritmo.
  let estimated_km_due_date = null;
  if (usage && usage.km_per_day > 0 && km_remaining != null && km_remaining > 0) {
    const days = Math.ceil(km_remaining / usage.km_per_day);
    estimated_km_due_date = utcDay(new Date(startOfDay(new Date()).getTime() + days * DAY_MS));
  }

  let status = 'al_dia';
  if ((km_remaining != null && km_remaining <= 0) || (days_remaining != null && days_remaining <= 0)) {
    status = 'vencido';
  } else if ((km_remaining != null && km_remaining <= SOON_KM) || (days_remaining != null && days_remaining <= SOON_DAYS)) {
    status = 'proximo';
  }
  return { status, km_remaining, days_remaining, km_estimated, estimated_km_due_date };
}

const STATUS_ORDER = { vencido: 0, proximo: 1, al_dia: 2, sin_historial: 3 };

/**
 * Próximos mantenimientos (uno por maintenance_type activo del vehicle_type
 * del vehículo) + historial completo de registros + ritmo de uso estimado.
 * Un tipo sin ningún registro previo queda 'sin_historial': no se inventa un
 * "próximo" a partir de current_mileage (sección 4, punto 3 del plan).
 */
async function resolveVehicleMaintenance(vehicle) {
  const [types, records, readings] = await Promise.all([
    MaintenanceType.findAll({
      where: { tenant_id: vehicle.tenant_id, vehicle_type: vehicle.vehicle_type, is_active: true },
      order: [['name', 'ASC']],
    }),
    VehicleMaintenanceRecord.findAll({
      where: { vehicle_id: vehicle.id, tenant_id: vehicle.tenant_id },
      include: [
        { model: MaintenanceType, as: 'maintenance_type', attributes: ['id', 'name'] },
        { model: WorkOrder, as: 'work_order', attributes: ['id', 'order_number'] },
      ],
      order: [['performed_at', 'DESC'], ['created_at', 'DESC']],
    }),
    loadMileageReadings(vehicle),
  ]);

  const usage = estimateUsage(readings);

  const upcoming = types.map(t => {
    const last = records.find(r => r.maintenance_type_id === t.id);
    const base = {
      maintenance_type_id: t.id,
      name: t.name,
      interval_km: t.interval_km,
      interval_months: t.interval_months,
    };
    if (!last) return { ...base, status: 'sin_historial', last: null };
    return {
      ...base,
      ...computeStatus(last, vehicle.current_mileage, usage),
      next_due_mileage: last.next_due_mileage,
      next_due_date: last.next_due_date,
      last: {
        performed_at: last.performed_at,
        mileage_at_service: last.mileage_at_service,
        work_order_id: last.work_order_id,
        order_number: last.work_order?.order_number || null,
      },
    };
  }).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  return {
    usage,
    upcoming,
    records: records.map(r => ({
      id: r.id,
      maintenance_type_id: r.maintenance_type_id,
      name: r.maintenance_type?.name || null,
      performed_at: r.performed_at,
      mileage_at_service: r.mileage_at_service,
      next_due_mileage: r.next_due_mileage,
      next_due_date: r.next_due_date,
      work_order_id: r.work_order_id,
      order_number: r.work_order?.order_number || null,
    })),
  };
}

module.exports = {
  generateRecordsForDeliveredOrder,
  removeRecordsForOrder,
  resolveVehicleMaintenance,
  // exportados para tests
  itemMatchesType,
  addMonths,
  computeStatus,
  estimateUsage,
  SOON_KM,
  SOON_DAYS,
};
