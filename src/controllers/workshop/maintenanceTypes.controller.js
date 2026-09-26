// backend/src/controllers/workshop/maintenanceTypes.controller.js
//
// "Taller > Mantenimientos" -- catálogo por tenant y tipo de vehículo de los
// mantenimientos (Cambio de aceite cada 5.000 km / 6 meses...) que se
// registran solos al entregar una OT. Ver
// 00 - Documentación/plan-portal-mantenimiento-vehiculo.md secciones 3.1 y 5.1.

const { MaintenanceType } = require('../../models');
const logger = require('../../config/logger');

const { VEHICLE_TYPES } = MaintenanceType;

// Entero positivo o null ("" / 0 / basura = sin ese intervalo).
function toPositiveIntOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Acepta array o texto separado por comas; sin vacíos ni repetidos.
function normalizeKeywords(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(list.map(k => String(k).trim().toLowerCase()).filter(Boolean))];
}

// Mensaje de la validación del modelo (hasSomeInterval, isIn) en vez de un
// 500 genérico.
function validationMessage(error) {
  if (error.name !== 'SequelizeValidationError') return null;
  return error.errors?.[0]?.message || error.message;
}

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { vehicle_type, include_inactive = 'false' } = req.query;
    const where = { tenant_id };
    if (vehicle_type) where.vehicle_type = vehicle_type;
    if (include_inactive !== 'true') where.is_active = true;

    const types = await MaintenanceType.findAll({
      where,
      order: [['vehicle_type', 'ASC'], ['name', 'ASC']],
    });
    res.json({ success: true, data: types });
  } catch (error) {
    logger.error('Error listando tipos de mantenimiento:', error);
    res.status(500).json({ success: false, message: 'Error al obtener los tipos de mantenimiento' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { name, vehicle_type, interval_km, interval_months, match_keywords } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ success: false, message: 'El nombre es requerido' });
    if (!VEHICLE_TYPES.includes(vehicle_type))
      return res.status(400).json({ success: false, message: 'Tipo de vehículo inválido' });

    const keywords = normalizeKeywords(match_keywords);
    if (keywords.length === 0)
      return res.status(400).json({ success: false, message: 'Indica al menos una palabra clave para reconocer el servicio en la OT' });

    const type = await MaintenanceType.create({
      tenant_id,
      name: name.trim(),
      vehicle_type,
      interval_km: toPositiveIntOrNull(interval_km),
      interval_months: toPositiveIntOrNull(interval_months),
      match_keywords: keywords,
    });
    res.status(201).json({ success: true, message: 'Tipo de mantenimiento creado', data: type });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return res.status(400).json({ success: false, message: msg });
    logger.error('Error creando tipo de mantenimiento:', error);
    res.status(500).json({ success: false, message: 'Error al crear el tipo de mantenimiento' });
  }
};

// Cambiar el intervalo NO reescribe los registros ya hechos: su
// next_due_mileage/next_due_date quedó guardado con el intervalo vigente en
// ese momento (sección 3.2 del plan). Aplica desde el próximo servicio.
const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const type = await MaintenanceType.findOne({ where: { id: req.params.id, tenant_id } });
    if (!type) return res.status(404).json({ success: false, message: 'Tipo de mantenimiento no encontrado' });

    const { name, vehicle_type, interval_km, interval_months, match_keywords, is_active } = req.body;
    if (name !== undefined && !String(name).trim())
      return res.status(400).json({ success: false, message: 'El nombre es requerido' });
    if (vehicle_type !== undefined && !VEHICLE_TYPES.includes(vehicle_type))
      return res.status(400).json({ success: false, message: 'Tipo de vehículo inválido' });

    let keywords;
    if (match_keywords !== undefined) {
      keywords = normalizeKeywords(match_keywords);
      if (keywords.length === 0)
        return res.status(400).json({ success: false, message: 'Indica al menos una palabra clave para reconocer el servicio en la OT' });
    }

    await type.update({
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(vehicle_type !== undefined ? { vehicle_type } : {}),
      ...(interval_km !== undefined ? { interval_km: toPositiveIntOrNull(interval_km) } : {}),
      ...(interval_months !== undefined ? { interval_months: toPositiveIntOrNull(interval_months) } : {}),
      ...(keywords ? { match_keywords: keywords } : {}),
      ...(is_active !== undefined ? { is_active: !!is_active } : {}),
    });
    res.json({ success: true, message: 'Tipo de mantenimiento actualizado', data: type });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return res.status(400).json({ success: false, message: msg });
    logger.error('Error actualizando tipo de mantenimiento:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el tipo de mantenimiento' });
  }
};

// Soft delete (is_active = false), igual que Vehicle.remove: los registros
// históricos de ese tipo siguen apuntándolo.
const remove = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const type = await MaintenanceType.findOne({ where: { id: req.params.id, tenant_id } });
    if (!type) return res.status(404).json({ success: false, message: 'Tipo de mantenimiento no encontrado' });

    await type.update({ is_active: false });
    res.json({ success: true, message: 'Tipo de mantenimiento eliminado' });
  } catch (error) {
    logger.error('Error eliminando tipo de mantenimiento:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el tipo de mantenimiento' });
  }
};

module.exports = { list, create, update, remove };
