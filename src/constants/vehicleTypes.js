// Tipos de vehículo (vehicles.vehicle_type, sales.vehicle_type, diagramas,
// tipos de mantenimiento, aplicaciones de producto). Cada tipo apunta a una
// clase del catálogo global de marcas/líneas (public.vehicle_catalog_lines,
// ver services/workshop/vehicleCatalog.service.js).
const VEHICLE_TYPES = ['automovil', 'camioneta', 'motocicleta', 'motocarro', 'cuatrimoto', 'utv', 'camion', 'otro'];

const CATALOG_CLASS_BY_TYPE = {
  automovil: 'liviano',
  camioneta: 'liviano',
  camion: 'pesado',
  motocicleta: 'moto',
  motocarro: 'motocarro',
  cuatrimoto: 'cuatrimoto',
  utv: 'utv',
  otro: null,
};

const CATALOG_CLASSES = ['liviano', 'pesado', 'moto', 'motocarro', 'cuatrimoto', 'utv'];

// Tipos que atiende la empresa (business_config.vehicle_types). Sin
// configurar = todos, como antes de existir la opción.
function tenantVehicleTypes(businessConfig) {
  const list = Array.isArray(businessConfig?.vehicle_types) ? businessConfig.vehicle_types : [];
  const valid = list.filter((t) => VEHICLE_TYPES.includes(t));
  return valid.length ? valid : [...VEHICLE_TYPES];
}

// Limpia la lista que llega del formulario de configuración: solo tipos
// válidos, sin repetir; 'otro' siempre queda disponible.
function sanitizeVehicleTypes(list) {
  if (!Array.isArray(list)) return undefined;
  const valid = [...new Set(list.filter((t) => VEHICLE_TYPES.includes(t)))];
  if (!valid.length) return [];
  if (!valid.includes('otro')) valid.push('otro');
  return VEHICLE_TYPES.filter((t) => valid.includes(t));
}

// Medidor de uso: kilómetros (odómetro) u horas (horómetro). Cuatrimotos y
// UTV usan horas por defecto; cada vehículo puede cambiarlo (vehicles.meter_unit).
// Las lecturas van en las mismas columnas (mileage_in/out, current_mileage,
// interval_km): solo cambia la unidad con que se leen.
const METER_UNITS = ['km', 'h'];
const HOURS_DEFAULT_TYPES = ['cuatrimoto', 'utv'];
const defaultMeterUnit = (vehicleType) => (HOURS_DEFAULT_TYPES.includes(vehicleType) ? 'h' : 'km');
const meterUnitOf = (vehicle) => (METER_UNITS.includes(vehicle?.meter_unit) ? vehicle.meter_unit : defaultMeterUnit(vehicle?.vehicle_type));
const sanitizeMeterUnit = (unit, vehicleType) => (METER_UNITS.includes(unit) ? unit : defaultMeterUnit(vehicleType));
// Lectura con su unidad para PDF y tiquetes: "12.500 km" / "350 h".
const formatMeter = (value, unit) => (value == null || value === '' ? null
  : `${Number(value).toLocaleString('es-CO')} ${unit === 'h' ? 'h' : 'km'}`);
const meterLabel = (unit) => (unit === 'h' ? 'Horas' : 'Km');

module.exports = {
  METER_UNITS, HOURS_DEFAULT_TYPES, defaultMeterUnit, meterUnitOf, sanitizeMeterUnit, formatMeter, meterLabel,
  VEHICLE_TYPES, CATALOG_CLASS_BY_TYPE, CATALOG_CLASSES, tenantVehicleTypes, sanitizeVehicleTypes };
