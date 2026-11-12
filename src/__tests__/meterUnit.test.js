// Horómetro (cuatrimotos/UTV): unidad del medidor por vehículo y margen del
// semáforo de mantenimientos en horas.
const { defaultMeterUnit, meterUnitOf, sanitizeMeterUnit, formatMeter } = require('../constants/vehicleTypes');
const { computeStatus, estimateUsage } = require('../services/workshop/maintenance.service');

describe('unidad del medidor', () => {
  test('cuatrimoto y UTV en horas, el resto en km', () => {
    expect(defaultMeterUnit('cuatrimoto')).toBe('h');
    expect(defaultMeterUnit('utv')).toBe('h');
    expect(defaultMeterUnit('motocicleta')).toBe('km');
    expect(defaultMeterUnit(undefined)).toBe('km');
  });
  test('el vehículo puede tener su propia unidad', () => {
    expect(meterUnitOf({ vehicle_type: 'utv', meter_unit: 'km' })).toBe('km');
    expect(meterUnitOf({ vehicle_type: 'cuatrimoto' })).toBe('h');
    expect(sanitizeMeterUnit('x', 'utv')).toBe('h');
  });
  test('formato con unidad', () => {
    expect(formatMeter(350, 'h')).toBe('350 h');
    expect(formatMeter(null, 'km')).toBeNull();
  });
});

describe('mantenimientos en horas', () => {
  const record = { next_due_mileage: 100, mileage_at_service: 50, next_due_date: null };
  test('faltando 8 h está próximo en horas, pero al día si fueran km', () => {
    expect(computeStatus(record, 92, null, 'h').status).toBe('proximo');
    expect(computeStatus(record, 92, null, 'h').km_remaining).toBe(8);
    expect(computeStatus({ ...record, next_due_mileage: 2000 }, 1000, null, 'km').status).toBe('al_dia');
  });
  test('el ritmo de uso en horas descarta más de 24 h por día', () => {
    const today = new Date('2026-06-30T12:00:00');
    const readings = [{ date: '2026-01-01', km: 100 }, { date: '2026-03-01', km: 3000 }];
    expect(estimateUsage(readings, today, 24)).toBeNull();
    expect(estimateUsage(readings, today, 1500)).not.toBeNull();
  });
});
