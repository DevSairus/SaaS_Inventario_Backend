// backend/src/services/workshop/inspections.service.js
//
// Peritajes vehiculares (migración 2026112701). Reglas:
//   - La plantilla se congela al crear (template_snapshot + una fila por
//     punto en vehicle_inspection_items). Editar o desactivar la plantilla
//     no toca peritajes existentes.
//   - Mientras está en borrador todo se edita; cada guardado recalcula el
//     puntaje y el concepto sugerido (constants/inspectionTemplates.js).
//   - Finalizar exige que todos los puntos estén calificados (o "No aplica")
//     y un concepto. Después solo se puede cambiar is_public y el precio /
//     venta asociada; para corregir, se anula y se hace otro.
//   - El concepto final lo decide el perito: puede diferir del sugerido.
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  VehicleInspection, VehicleInspectionItem, InspectionTemplate, Vehicle, Customer, User,
  VehicleRuntSnapshot, Tenant, WorkOrder, Sale, SaleItem, Product,
} = require('../../models');
const {
  BUILTIN_TEMPLATES, builtinForVehicleType, computeScore, normalizeTemplateSections,
  CONCEPTS, RATINGS, DAMAGE_TYPES, DAMAGE_SEVERITIES, bodyKindFor, BODY_ZONES,
} = require('../../constants/inspectionTemplates');
const { validateSignature } = require('../../utils/signature');
const { uploadToCloudinary } = require('../../utils/uploadToCloudinary');
const { MAX_LIMIT, buildPagination } = require('../../utils/pagination');
const { productSalePrice } = require('../../utils/salePricing');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const clean = (v, max) => {
  if (v === undefined) return undefined;
  const s = v === null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};
const numOrNull = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const MAX_PHOTOS = 40;

// ── Plantillas ────────────────────────────────────────────────────────

function builtinAsRow(t) {
  return { id: `builtin:${t.base_key}`, builtin: true, name: t.name, base_key: t.base_key, vehicle_types: t.vehicle_types, sections: t.sections, is_active: true };
}

async function listTemplates(tenantId, { includeInactive = false } = {}) {
  const where = { tenant_id: tenantId };
  if (!includeInactive) where.is_active = true;
  const own = await InspectionTemplate.findAll({ where, order: [['name', 'ASC']] });
  return {
    own: own.map((t) => ({ ...t.toJSON(), builtin: false })),
    builtin: BUILTIN_TEMPLATES.map(builtinAsRow),
  };
}

function normalizeVehicleTypes(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20);
}

async function createTemplate(tenantId, userId, body) {
  let sections = body.sections;
  let baseKey = clean(body.base_key, 30) || null;
  if (!sections && baseKey) {
    const base = BUILTIN_TEMPLATES.find((t) => t.base_key === baseKey);
    if (!base) throw httpError(400, 'Plantilla base desconocida');
    sections = base.sections;
  }
  const name = clean(body.name, 150);
  if (!name) throw httpError(400, 'El nombre de la plantilla es obligatorio');
  let normalized;
  try { normalized = normalizeTemplateSections(sections); } catch (e) { throw httpError(400, e.message); }
  const base = BUILTIN_TEMPLATES.find((t) => t.base_key === baseKey);
  return InspectionTemplate.create({
    tenant_id: tenantId, name, base_key: baseKey,
    vehicle_types: normalizeVehicleTypes(body.vehicle_types ?? base?.vehicle_types ?? []),
    sections: normalized, is_active: true, created_by: userId,
  });
}

async function updateTemplate(tenantId, id, body) {
  const t = await InspectionTemplate.findOne({ where: { id, tenant_id: tenantId } });
  if (!t) throw httpError(404, 'Plantilla no encontrada');
  const data = {};
  if (body.name !== undefined) {
    data.name = clean(body.name, 150);
    if (!data.name) throw httpError(400, 'El nombre de la plantilla es obligatorio');
  }
  if (body.vehicle_types !== undefined) data.vehicle_types = normalizeVehicleTypes(body.vehicle_types);
  if (body.sections !== undefined) {
    try { data.sections = normalizeTemplateSections(body.sections); } catch (e) { throw httpError(400, e.message); }
  }
  if (body.is_active !== undefined) data.is_active = !!body.is_active;
  await t.update(data);
  return t;
}

/**
 * Plantilla a usar: la pedida (propia o "builtin:<key>"), o la propia activa
 * que cubra el tipo de vehículo, o la de Pitbox para ese tipo.
 */
async function resolveTemplate(tenantId, vehicleType, templateId) {
  if (templateId && String(templateId).startsWith('builtin:')) {
    const t = BUILTIN_TEMPLATES.find((b) => `builtin:${b.base_key}` === templateId);
    if (!t) throw httpError(400, 'Plantilla no encontrada');
    return { id: null, name: t.name, sections: t.sections };
  }
  if (templateId) {
    const t = await InspectionTemplate.findOne({ where: { id: templateId, tenant_id: tenantId, is_active: true } });
    if (!t) throw httpError(400, 'Plantilla no encontrada o inactiva');
    return { id: t.id, name: t.name, sections: t.sections };
  }
  const own = await InspectionTemplate.findAll({ where: { tenant_id: tenantId, is_active: true }, order: [['updated_at', 'DESC']] });
  const match = own.find((t) => (t.vehicle_types || []).includes(vehicleType));
  if (match) return { id: match.id, name: match.name, sections: match.sections };
  const b = builtinForVehicleType(vehicleType);
  return { id: null, name: b.name, sections: b.sections };
}

// ── Consecutivo ───────────────────────────────────────────────────────

async function nextNumber(tenantId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
    replacements: { key: `vehicle_inspections:${tenantId}` }, transaction,
  });
  // Por el modelo (no SQL crudo): el modelo respeta el schema del tenant;
  // una consulta cruda sin calificar caía en public y repetía PER-000001.
  const rows = await VehicleInspection.findAll({
    where: { tenant_id: tenantId, number: { [Op.like]: 'PER-%' } },
    attributes: ['number'],
    transaction,
  });
  const max = rows.reduce((mx, r) => Math.max(mx, parseInt(String(r.number).slice(4), 10) || 0), 0);
  return `PER-${String(max + 1).padStart(6, '0')}`;
}

// ── Lectura ───────────────────────────────────────────────────────────

const LIST_INCLUDE = [
  { model: Vehicle, as: 'vehicle', attributes: ['id', 'plate', 'brand', 'model', 'year', 'vehicle_type'] },
  { model: User, as: 'inspector', attributes: ['id', 'first_name', 'last_name'] },
];

async function listInspections(tenantId, query = {}) {
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 20), MAX_LIMIT);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const where = { tenant_id: tenantId };
  if (query.status && VehicleInspection.STATUSES.includes(query.status)) where.status = query.status;
  if (query.vehicle_id) where.vehicle_id = query.vehicle_id;
  if (query.concept && CONCEPTS.includes(query.concept)) where.concept = query.concept;
  const search = String(query.search || '').trim();
  if (search) {
    const like = `%${search.replace(/[%_]/g, '')}%`;
    where[Op.or] = [
      { number: { [Op.iLike]: like } },
      { requester_name: { [Op.iLike]: like } },
      { '$vehicle.plate$': { [Op.iLike]: `%${search.replace(/[\s-]/g, '').replace(/[%_]/g, '')}%` } },
    ];
  }
  const { count, rows } = await VehicleInspection.findAndCountAll({
    where,
    include: LIST_INCLUDE,
    attributes: { exclude: ['template_snapshot', 'inspector_signature', 'body_marks', 'paint_readings', 'photos'] },
    order: [['inspected_at', 'DESC'], ['number', 'DESC']],
    limit, offset: (page - 1) * limit,
    subQuery: false,
  });
  return { data: rows, pagination: buildPagination({ page, limit }, count) };
}

async function getInspection(tenantId, id) {
  const insp = await VehicleInspection.findOne({
    where: { id, tenant_id: tenantId },
    include: [
      { model: Vehicle, as: 'vehicle' },
      { model: Customer, as: 'owner', attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'phone', 'email'] },
      { model: Customer, as: 'requester', attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'phone', 'mobile', 'email'] },
      { model: User, as: 'inspector', attributes: ['id', 'first_name', 'last_name'] },
      { model: VehicleRuntSnapshot, as: 'runt_snapshot' },
      { model: WorkOrder, as: 'work_order', attributes: ['id', 'order_number', 'status'] },
      { model: Sale, as: 'sale', attributes: ['id', 'sale_number', 'status', 'total_amount'] },
      { model: VehicleInspectionItem, as: 'items' },
    ],
    order: [[{ model: VehicleInspectionItem, as: 'items' }, 'sort_order', 'ASC']],
  });
  if (!insp) throw httpError(404, 'Peritaje no encontrado');
  return insp;
}

// ── Creación ──────────────────────────────────────────────────────────

function requesterData(body) {
  const data = {};
  if (body.requester_type !== undefined) {
    if (!VehicleInspection.REQUESTER_TYPES.includes(body.requester_type)) throw httpError(400, 'Tipo de solicitante inválido');
    data.requester_type = body.requester_type;
  }
  if (body.purpose !== undefined) {
    if (!VehicleInspection.PURPOSES.includes(body.purpose)) throw httpError(400, 'Propósito inválido');
    data.purpose = body.purpose;
  }
  if (body.requester_customer_id !== undefined) data.requester_customer_id = body.requester_customer_id || null;
  const str = { requester_name: 200, requester_document: 30, requester_phone: 30, requester_email: 150 };
  for (const [k, max] of Object.entries(str)) {
    const v = clean(body[k], max);
    if (v !== undefined) data[k] = v;
  }
  return data;
}

async function createInspection(tenantId, userId, body) {
  if (!body.vehicle_id) throw httpError(400, 'Selecciona el vehículo a peritar');
  const vehicle = await Vehicle.findOne({ where: { id: body.vehicle_id, tenant_id: tenantId, is_active: true } });
  if (!vehicle) throw httpError(404, 'Vehículo no encontrado');
  const template = await resolveTemplate(tenantId, vehicle.vehicle_type, body.template_id);

  const header = requesterData(body);
  if (header.requester_customer_id) {
    const c = await Customer.findOne({ where: { id: header.requester_customer_id, tenant_id: tenantId } });
    if (!c) throw httpError(400, 'El cliente solicitante no existe');
    header.requester_name = header.requester_name || c.business_name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
    header.requester_document = header.requester_document || c.tax_id || null;
    header.requester_phone = header.requester_phone || c.phone || null;
    header.requester_email = header.requester_email || c.email || null;
  }
  // Si el solicitante es el propietario y no se indicó otro cliente, es el
  // dueño actual del vehículo.
  if ((header.requester_type || 'propietario') === 'propietario' && !header.requester_customer_id && vehicle.customer_id) {
    const c = await Customer.findOne({ where: { id: vehicle.customer_id, tenant_id: tenantId } });
    if (c) {
      header.requester_customer_id = c.id;
      header.requester_name = header.requester_name || c.business_name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
      header.requester_document = header.requester_document || c.tax_id || null;
      header.requester_phone = header.requester_phone || c.phone || null;
      header.requester_email = header.requester_email || c.email || null;
    }
  }

  // Consulta RUNT hecha al registrar el vehículo desde el modal del peritaje.
  let runtSnapshotId = null;
  if (body.runt_snapshot_id) {
    const snap = await VehicleRuntSnapshot.findOne({ where: { id: body.runt_snapshot_id, tenant_id: tenantId, vehicle_id: vehicle.id } });
    if (!snap) throw httpError(400, 'Consulta RUNT no encontrada para este vehículo');
    runtSnapshotId = snap.id;
  }

  let workOrderId = null;
  if (body.work_order_id) {
    const wo = await WorkOrder.findOne({ where: { id: body.work_order_id, tenant_id: tenantId, vehicle_id: vehicle.id } });
    if (!wo) throw httpError(400, 'La OT no existe o es de otro vehículo');
    workOrderId = wo.id;
  }

  return sequelize.transaction(async (t) => {
    const number = await nextNumber(tenantId, t);
    const insp = await VehicleInspection.create({
      tenant_id: tenantId, number, vehicle_id: vehicle.id,
      owner_customer_id: vehicle.customer_id || null,
      ...header,
      template_id: template.id, template_name: template.name, template_snapshot: template.sections,
      inspector_id: body.inspector_id || userId,
      inspected_at: body.inspected_at ? new Date(body.inspected_at) : new Date(),
      mileage: numOrNull(body.mileage) ?? vehicle.current_mileage ?? null,
      meter_unit: vehicle.meter_unit || 'km',
      price: numOrNull(body.price) ?? null,
      identity: {
        vin_expected: vehicle.vin || null,
        engine_expected: vehicle.engine_number || null,
      },
      work_order_id: workOrderId,
      runt_snapshot_id: runtSnapshotId,
      created_by: userId,
    }, { transaction: t });

    let order = 0;
    const rows = [];
    for (const s of template.sections) {
      for (const it of s.items || []) {
        rows.push({
          tenant_id: tenantId, inspection_id: insp.id, section_key: s.key, item_key: it.key,
          label: it.label, kind: it.kind || 'rating', unit: it.unit || null, critical: !!it.critical,
          sort_order: order++,
        });
      }
    }
    if (rows.length) await VehicleInspectionItem.bulkCreate(rows, { transaction: t });
    return insp;
  });
}

// ── Edición (borrador) ────────────────────────────────────────────────

function normalizeBodyMarks(marks, vehicleType) {
  if (!Array.isArray(marks)) throw httpError(400, 'Marcas de carrocería inválidas');
  const zones = new Set(BODY_ZONES[bodyKindFor(vehicleType)].map(([k]) => k));
  return marks.slice(0, 100).map((mk) => {
    if (!zones.has(mk.zone)) throw httpError(400, `Zona de carrocería desconocida: ${mk.zone}`);
    if (!DAMAGE_TYPES.includes(mk.damage)) throw httpError(400, 'Tipo de daño inválido');
    const severity = DAMAGE_SEVERITIES.includes(mk.severity) ? mk.severity : 'leve';
    return { zone: mk.zone, damage: mk.damage, severity, notes: clean(mk.notes, 300) || null };
  });
}

function normalizePaintReadings(readings, vehicleType) {
  if (!readings || typeof readings !== 'object' || Array.isArray(readings)) throw httpError(400, 'Lecturas de pintura inválidas');
  const zones = new Set(BODY_ZONES[bodyKindFor(vehicleType)].map(([k]) => k));
  const out = {};
  for (const [zone, v] of Object.entries(readings)) {
    if (!zones.has(zone)) continue;
    const n = numOrNull(v);
    if (n !== null && n !== undefined && n >= 0 && n < 5000) out[zone] = Math.round(n);
  }
  return out;
}

function normalizeIdentity(identity, current) {
  if (!identity || typeof identity !== 'object') throw httpError(400, 'Datos de identificación inválidos');
  const tri = (v) => (v === true || v === false ? v : null);
  return {
    vin_expected: current.vin_expected ?? null,
    engine_expected: current.engine_expected ?? null,
    vin_read: clean(identity.vin_read, 50) ?? current.vin_read ?? null,
    vin_match: identity.vin_match !== undefined ? tri(identity.vin_match) : (current.vin_match ?? null),
    engine_read: clean(identity.engine_read, 50) ?? current.engine_read ?? null,
    engine_match: identity.engine_match !== undefined ? tri(identity.engine_match) : (current.engine_match ?? null),
    chassis_match: identity.chassis_match !== undefined ? tri(identity.chassis_match) : (current.chassis_match ?? null),
    plate_match: identity.plate_match !== undefined ? tri(identity.plate_match) : (current.plate_match ?? null),
    notes: identity.notes !== undefined ? clean(identity.notes, 500) : (current.notes ?? null),
  };
}

function scoreFlags(insp) {
  const id = insp.identity || {};
  return {
    identityMismatch: [id.vin_match, id.engine_match, id.chassis_match, id.plate_match].some((v) => v === false),
    structuralBodyDamage: (insp.body_marks || []).some((mk) => mk.severity === 'grave'),
  };
}

async function recompute(insp, transaction) {
  const items = await VehicleInspectionItem.findAll({ where: { inspection_id: insp.id }, attributes: ['section_key', 'rating', 'critical'], transaction });
  const res = computeScore(items, insp.template_snapshot, scoreFlags(insp));
  await insp.update({ score: res.score, suggested_concept: res.concept, section_scores: res.sections }, { transaction });
  return res;
}

async function updateInspection(tenantId, id, body) {
  const insp = await VehicleInspection.findOne({ where: { id, tenant_id: tenantId }, include: [{ model: Vehicle, as: 'vehicle', attributes: ['vehicle_type'] }] });
  if (!insp) throw httpError(404, 'Peritaje no encontrado');

  // Después de finalizar solo se puede publicar/despublicar y el precio/venta.
  if (insp.status !== 'draft') {
    const allowed = {};
    if (body.is_public !== undefined) {
      if (insp.status !== 'finalized') throw httpError(400, 'Solo un peritaje finalizado se puede publicar');
      allowed.is_public = !!body.is_public;
    }
    if (body.price !== undefined) allowed.price = numOrNull(body.price);
    if (Object.keys(allowed).length === 0) throw httpError(400, 'El peritaje ya no está en borrador; anúlalo y crea uno nuevo para corregirlo');
    await insp.update(allowed);
    return getInspection(tenantId, id);
  }

  const vehicleType = insp.vehicle?.vehicle_type;
  return sequelize.transaction(async (t) => {
    const data = requesterData(body);
    if (body.mileage !== undefined) data.mileage = numOrNull(body.mileage);
    if (body.inspected_at !== undefined && body.inspected_at) data.inspected_at = new Date(body.inspected_at);
    if (body.inspector_id !== undefined) data.inspector_id = body.inspector_id || null;
    if (body.price !== undefined) data.price = numOrNull(body.price);
    if (body.conclusion !== undefined) data.conclusion = clean(body.conclusion, 5000);
    if (body.recommendations !== undefined) data.recommendations = clean(body.recommendations, 5000);
    if (body.concept !== undefined) {
      if (body.concept !== null && !CONCEPTS.includes(body.concept)) throw httpError(400, 'Concepto inválido');
      data.concept = body.concept || null;
    }
    if (body.is_public !== undefined) data.is_public = !!body.is_public;
    if (body.body_marks !== undefined) data.body_marks = normalizeBodyMarks(body.body_marks, vehicleType);
    if (body.paint_readings !== undefined) data.paint_readings = normalizePaintReadings(body.paint_readings, vehicleType);
    if (body.identity !== undefined) data.identity = normalizeIdentity(body.identity, insp.identity || {});
    if (body.runt_snapshot_id !== undefined) {
      if (body.runt_snapshot_id) {
        const snap = await VehicleRuntSnapshot.findOne({ where: { id: body.runt_snapshot_id, tenant_id: tenantId, vehicle_id: insp.vehicle_id }, transaction: t });
        if (!snap) throw httpError(400, 'Consulta RUNT no encontrada para este vehículo');
      }
      data.runt_snapshot_id = body.runt_snapshot_id || null;
    }
    if (body.inspector_signature !== undefined) {
      try { validateSignature(body.inspector_signature); } catch (e) { throw httpError(400, e.message); }
      data.inspector_signature = body.inspector_signature || null;
    }
    if (body.photos !== undefined) {
      // Solo reordenar / quitar / cambiar leyenda: las fotos nuevas entran por uploadPhotos.
      if (!Array.isArray(body.photos)) throw httpError(400, 'Fotos inválidas');
      const known = new Map((insp.photos || []).map((p) => [p.url, p]));
      data.photos = body.photos.filter((p) => known.has(p?.url)).map((p) => ({ ...known.get(p.url), caption: clean(p.caption, 200) || '' }));
    }
    if (Object.keys(data).length) await insp.update(data, { transaction: t });

    if (Array.isArray(body.items)) {
      const existing = await VehicleInspectionItem.findAll({ where: { inspection_id: insp.id }, transaction: t });
      const byId = new Map(existing.map((it) => [it.id, it]));
      for (const patch of body.items) {
        const it = byId.get(patch.id);
        if (!it) continue;
        const upd = {};
        if (patch.rating !== undefined) {
          if (patch.rating !== null && !RATINGS.includes(patch.rating)) throw httpError(400, 'Calificación inválida');
          upd.rating = patch.rating || null;
        }
        if (patch.measure !== undefined) upd.measure = numOrNull(patch.measure);
        if (patch.notes !== undefined) upd.notes = clean(patch.notes, 1000);
        if (patch.photos !== undefined && Array.isArray(patch.photos)) {
          const known = new Map((it.photos || []).map((p) => [p.url, p]));
          upd.photos = patch.photos.filter((p) => known.has(p?.url)).map((p) => known.get(p.url));
        }
        if (Object.keys(upd).length) await it.update(upd, { transaction: t });
      }
    }
    await recompute(insp, t);
    return insp.id;
  }).then(() => getInspection(tenantId, id));
}

async function finalizeInspection(tenantId, id, userId, body = {}) {
  const insp = await VehicleInspection.findOne({ where: { id, tenant_id: tenantId } });
  if (!insp) throw httpError(404, 'Peritaje no encontrado');
  if (insp.status !== 'draft') throw httpError(400, 'El peritaje ya no está en borrador');

  const pending = await VehicleInspectionItem.count({ where: { inspection_id: insp.id, rating: null } });
  if (pending > 0) throw httpError(400, `Faltan ${pending} punto(s) por calificar (usa "No aplica" si no corresponde)`);

  return sequelize.transaction(async (t) => {
    const res = await recompute(insp, t);
    const concept = body.concept || insp.concept || res.concept;
    if (!CONCEPTS.includes(concept)) throw httpError(400, 'Define el concepto final del peritaje');
    await insp.update({
      status: 'finalized', concept, finalized_at: new Date(), finalized_by: userId,
      ...(body.is_public !== undefined ? { is_public: !!body.is_public } : {}),
    }, { transaction: t });
    // El kilometraje del peritaje alimenta la ficha si es mayor al actual.
    if (insp.mileage) {
      await Vehicle.update(
        { current_mileage: insp.mileage },
        { where: { id: insp.vehicle_id, tenant_id: tenantId, [Op.or]: [{ current_mileage: null }, { current_mileage: { [Op.lt]: insp.mileage } }] }, transaction: t },
      );
    }
    return insp.id;
  }).then(() => getInspection(tenantId, id));
}

async function cancelInspection(tenantId, id, userId, reason) {
  const insp = await VehicleInspection.findOne({ where: { id, tenant_id: tenantId } });
  if (!insp) throw httpError(404, 'Peritaje no encontrado');
  if (insp.status === 'cancelled') throw httpError(400, 'El peritaje ya está anulado');
  const why = clean(reason, 500);
  if (!why) throw httpError(400, 'Indica el motivo de la anulación');
  await insp.update({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: why, is_public: false });
  return getInspection(tenantId, id);
}

async function deleteDraft(tenantId, id) {
  const insp = await VehicleInspection.findOne({ where: { id, tenant_id: tenantId } });
  if (!insp) throw httpError(404, 'Peritaje no encontrado');
  if (insp.status !== 'draft') throw httpError(400, 'Solo se pueden eliminar borradores; un peritaje finalizado se anula');
  await insp.destroy();
}

// ── Fotos ─────────────────────────────────────────────────────────────

async function uploadPhotos(tenantId, id, files, { itemId } = {}) {
  const insp = await VehicleInspection.findOne({ where: { id, tenant_id: tenantId } });
  if (!insp) throw httpError(404, 'Peritaje no encontrado');
  if (insp.status !== 'draft') throw httpError(400, 'Solo se agregan fotos a un peritaje en borrador');
  if (!files?.length) throw httpError(400, 'No llegó ninguna foto');

  let item = null;
  if (itemId) {
    item = await VehicleInspectionItem.findOne({ where: { id: itemId, inspection_id: insp.id } });
    if (!item) throw httpError(404, 'Punto del peritaje no encontrado');
  }
  const current = item ? (item.photos || []) : (insp.photos || []);
  if (current.length + files.length > MAX_PHOTOS) throw httpError(400, `Máximo ${MAX_PHOTOS} fotos`);

  const added = [];
  for (const f of files) {
    const up = await uploadToCloudinary(f.buffer, f.originalname, `inspections/${tenantId}/${insp.id}`, { mimeType: f.mimetype });
    added.push({ url: up.url, public_id: up.public_id, caption: '', taken_at: new Date().toISOString() });
  }
  if (item) await item.update({ photos: [...current, ...added] });
  else await insp.update({ photos: [...current, ...added] });
  return added;
}

// ── Facturación ───────────────────────────────────────────────────────
// El peritaje se cobra con una venta normal (borrador) que el usuario
// confirma como factura o remisión desde Ventas: mismos impuestos,
// numeración, asiento y DIAN que cualquier venta. La venta se crea con
// sales.controller.create, igual que la facturación recurrente.

function invokeController(controllerFn, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); },
      setHeader() {}, send(body) { resolve({ statusCode: this.statusCode, body }); },
    };
    Promise.resolve(controllerFn(req, res)).catch((err) => resolve({ statusCode: 500, body: { success: false, message: err.message } }));
  });
}

/**
 * Valores para el modal "Facturar peritaje": el servicio que se usó en el
 * último peritaje facturado (así nadie tiene que configurarlo) y el cliente
 * sugerido (el solicitante registrado, o uno con su mismo documento).
 */
async function billingDefaults(tenantId, id) {
  const insp = await VehicleInspection.findOne({ where: { id, tenant_id: tenantId } });
  if (!insp) throw httpError(404, 'Peritaje no encontrado');

  let product = null;
  const last = await VehicleInspection.findOne({
    where: { tenant_id: tenantId, sale_id: { [Op.ne]: null } },
    order: [['updated_at', 'DESC']],
    attributes: ['sale_id'],
  });
  if (last) {
    const item = await SaleItem.findOne({ where: { sale_id: last.sale_id, product_id: { [Op.ne]: null } }, attributes: ['product_id'] });
    if (item) {
      product = await Product.findOne({
        where: { id: item.product_id, tenant_id: tenantId, is_active: true },
        attributes: ['id', 'name', 'sku', 'base_price', 'sale_price', 'product_type', 'is_labor', 'has_tax', 'tax_percentage', 'price_includes_tax'],
      });
    }
  }

  let customerId = insp.requester_customer_id;
  if (!customerId && insp.requester_document) {
    const doc = String(insp.requester_document).replace(/\D/g, '');
    if (doc) {
      const c = await Customer.findOne({
        where: { tenant_id: tenantId, is_active: true, [Op.and]: [sequelize.where(sequelize.fn('regexp_replace', sequelize.col('tax_id'), '[^0-9]', '', 'g'), doc)] },
        attributes: ['id'],
      });
      customerId = c?.id || null;
    }
  }
  return {
    product,
    customer_id: customerId || null,
    price: insp.price !== null && insp.price !== undefined ? Number(insp.price) : (product ? productSalePrice(product) : null),
    requester: {
      name: insp.requester_name, document: insp.requester_document, phone: insp.requester_phone, email: insp.requester_email,
    },
  };
}

/**
 * Crea la venta (borrador) del peritaje y la deja enlazada.
 * body: { product_id, unit_price, customer_id? | new_customer?: { document_type } }
 *   Sin customer_id se crea el cliente con los datos del solicitante.
 */
async function createSaleForInspection(req, id, body) {
  const tenantId = req.user.tenant_id;
  const insp = await VehicleInspection.findOne({
    where: { id, tenant_id: tenantId },
    include: [{ model: Vehicle, as: 'vehicle', attributes: ['plate', 'brand', 'model', 'year', 'vehicle_type'] }],
  });
  if (!insp) throw httpError(404, 'Peritaje no encontrado');
  if (insp.status === 'cancelled') throw httpError(400, 'No se factura un peritaje anulado');
  if (insp.sale_id) {
    const prev = await Sale.findOne({ where: { id: insp.sale_id }, attributes: ['id', 'status', 'sale_number'] });
    if (prev && prev.status !== 'cancelled') throw httpError(400, `El peritaje ya tiene la venta ${prev.sale_number}`);
  }

  const product = await Product.findOne({ where: { id: body.product_id, tenant_id: tenantId, is_active: true } });
  if (!product) throw httpError(400, 'Selecciona el servicio con el que se factura el peritaje');
  const price = numOrNull(body.unit_price);
  if (price === null || price === undefined || price < 0) throw httpError(400, 'Indica el valor del peritaje');

  const saleBody = {
    items: [{
      product_id: product.id,
      item_type: product.product_type === 'service' || product.is_labor ? 'service' : 'product',
      quantity: 1,
      unit_price: price,
      discount_percentage: 0,
    }],
    notes: `Peritaje ${insp.number} · vehículo ${insp.vehicle?.plate || ''}`.trim(),
    vehicle_plate: insp.vehicle?.plate || undefined,
    vehicle_type: insp.vehicle?.vehicle_type || undefined,
    vehicle_brand: insp.vehicle?.brand || undefined,
    vehicle_model: insp.vehicle?.model || undefined,
    vehicle_year: insp.vehicle?.year || undefined,
    mileage: insp.mileage || undefined,
  };

  if (body.customer_id) {
    const c = await Customer.findOne({ where: { id: body.customer_id, tenant_id: tenantId }, attributes: ['id'] });
    if (!c) throw httpError(400, 'Cliente no encontrado');
    saleBody.customer_id = c.id;
  } else {
    // Cliente nuevo con los datos del solicitante (mismo camino que el
    // "cliente rápido" del formulario de ventas).
    if (!insp.requester_name) throw httpError(400, 'El peritaje no tiene nombre de solicitante; elige un cliente');
    if (!insp.requester_document) throw httpError(400, 'Para crear el cliente se necesita el documento del solicitante; elige un cliente registrado (o créalo en Ventas → Clientes)');
    const docType = ['13', '31', '22', '41', '42'].includes(String(body.new_customer?.document_type)) ? String(body.new_customer.document_type) : '13';
    saleBody.customer_data = {
      full_name: insp.requester_name,
      document_type: docType,
      customer_type: docType === '31' ? 'company' : 'individual',
      ...(docType === '31' ? { business_name: insp.requester_name } : {}),
      tax_id: String(insp.requester_document).trim(),
      email: insp.requester_email || null,
      phone: insp.requester_phone || null,
    };
  }

  const salesController = require('../../controllers/sales/sales.controller');
  const created = await invokeController(salesController.create, {
    tenant_id: tenantId,
    user: req.user,
    user_id: req.user.id,
    branch_id: req.branch_id || null,
    params: {}, query: {}, headers: req.headers || {},
    body: saleBody,
  });
  if (!created.body?.success) throw httpError(created.statusCode >= 400 && created.statusCode < 500 ? created.statusCode : 400, created.body?.message || 'No se pudo crear la venta');
  const sale = created.body.data;
  await insp.update({ sale_id: sale.id, price });
  // El solicitante queda como cliente registrado del peritaje.
  if (!insp.requester_customer_id && sale.customer_id) await insp.update({ requester_customer_id: sale.customer_id });
  return { sale_id: sale.id, sale_number: sale.sale_number };
}

// ── WhatsApp ──────────────────────────────────────────────────────────

/** Teléfono y nombre a quien se envía el certificado: el solicitante (cliente registrado o datos sueltos). */
async function certificateRecipient(tenantId, insp) {
  const { getCustomerWhatsappNumber, normalizeWhatsAppPhone } = require('../../utils/customerWhatsappPhone');
  if (insp.requester_customer_id) {
    const c = await Customer.findOne({ where: { id: insp.requester_customer_id, tenant_id: tenantId }, attributes: ['first_name', 'business_name', 'phone', 'mobile', 'mobile_country_code'] });
    const phone = getCustomerWhatsappNumber(c);
    if (phone) return { phone, name: c.first_name || c.business_name || insp.requester_name };
  }
  const phone = normalizeWhatsAppPhone(insp.requester_phone);
  return { phone, name: insp.requester_name };
}

module.exports = {
  httpError,
  billingDefaults, createSaleForInspection, certificateRecipient,
  listTemplates, createTemplate, updateTemplate, resolveTemplate,
  listInspections, getInspection, createInspection, updateInspection,
  finalizeInspection, cancelInspection, deleteDraft, uploadPhotos,
  scoreFlags,
};
