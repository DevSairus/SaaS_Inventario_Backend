// Tests del servicio de mantenimientos del vehículo. Se aísla de la base de
// datos: lo que se verifica es la lógica que decide qué ítems de una OT
// disparan un mantenimiento, cómo se calcula el "próximo" y el semáforo.
jest.mock('../models', () => ({
  MaintenanceType: { findAll: jest.fn() },
  VehicleMaintenanceRecord: { findAll: jest.fn(), bulkCreate: jest.fn(), destroy: jest.fn() },
  Vehicle: { findOne: jest.fn() },
  WorkOrder: { findOne: jest.fn() },
  WorkOrderItem: { findAll: jest.fn() },
}));

const models = require('../models');
const svc = require('../services/workshop/maintenance.service');

describe('itemMatchesType', () => {
  it('ignora mayúsculas y tildes', () => {
    expect(svc.itemMatchesType('CAMBIO DE ACEITÉ 20W50', ['aceite'])).toBe(true);
    expect(svc.itemMatchesType('Filtro de aire', ['Aceite'])).toBe(false);
  });

  it('no matchea con keywords vacías', () => {
    expect(svc.itemMatchesType('Cambio de aceite', ['', '  '])).toBe(false);
    expect(svc.itemMatchesType('', ['aceite'])).toBe(false);
  });
});

describe('addMonths', () => {
  it('suma meses cruzando de año', () => {
    expect(svc.addMonths('2026-09-25', 6)).toBe('2027-03-25');
  });

  it('ajusta al último día cuando el día no existe en el mes destino', () => {
    expect(svc.addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('computeStatus', () => {
  const inDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('vencido por km', () => {
    const r = svc.computeStatus({ mileage_at_service: 10000, next_due_mileage: 15000, next_due_date: null }, 15200);
    expect(r).toMatchObject({ status: 'vencido', km_remaining: -200 });
  });

  it('próximo por fecha dentro del margen', () => {
    const r = svc.computeStatus({ mileage_at_service: 10000, next_due_mileage: 15000, next_due_date: inDays(5) }, 11000);
    expect(r.status).toBe('proximo');
    expect(r.days_remaining).toBe(5);
  });

  it('al día fuera de ambos márgenes', () => {
    const r = svc.computeStatus({ mileage_at_service: 10000, next_due_mileage: 15000, next_due_date: inDays(90) }, 11000);
    expect(r.status).toBe('al_dia');
  });

  it('usa el km del servicio si el km del vehículo está atrasado', () => {
    const r = svc.computeStatus({ mileage_at_service: 10000, next_due_mileage: 15000, next_due_date: null }, null);
    expect(r.km_remaining).toBe(5000);
  });
});

describe('estimateUsage', () => {
  const today = new Date(2026, 8, 26, 12);

  it('estima el km de hoy con el ritmo entre la primera y la última lectura', () => {
    const u = svc.estimateUsage([
      { date: new Date(2026, 2, 1), km: 40000 },
      { date: new Date(2026, 5, 9), km: 44000 }, // 100 días -> 40 km/día
    ], today);
    expect(u.km_per_day).toBe(40);
    // 109 días desde la última lectura
    expect(u.estimated_km).toBe(44000 + 40 * 109);
    expect(u.last_reading).toEqual({ date: '2026-06-09', km: 44000 });
  });

  it('no estima con una sola lectura o con menos de 30 días entre lecturas', () => {
    expect(svc.estimateUsage([{ date: new Date(2026, 5, 1), km: 44000 }], today)).toBeNull();
    expect(svc.estimateUsage([
      { date: new Date(2026, 5, 1), km: 44000 },
      { date: new Date(2026, 5, 20), km: 44900 },
    ], today)).toBeNull();
  });

  it('descarta lecturas que retroceden (error de digitación)', () => {
    const u = svc.estimateUsage([
      { date: new Date(2026, 2, 1), km: 40000 },
      { date: new Date(2026, 3, 1), km: 4100 },   // le faltó un cero
      { date: new Date(2026, 5, 9), km: 44000 },
    ], today);
    expect(u.readings).toBe(2);
    expect(u.km_per_day).toBe(40);
  });

  it('ignora lecturas de hace más de 2 años', () => {
    const u = svc.estimateUsage([
      { date: new Date(2022, 0, 1), km: 1000 },
      { date: new Date(2026, 2, 1), km: 40000 },
      { date: new Date(2026, 5, 9), km: 44000 },
    ], today);
    expect(u.km_per_day).toBe(40);
  });
});

describe('computeStatus con ritmo de uso', () => {
  it('usa el km estimado y calcula la fecha aproximada de llegada', () => {
    const r = svc.computeStatus(
      { mileage_at_service: 44000, next_due_mileage: 49000, next_due_date: null },
      44000,
      { km_per_day: 40, estimated_km: 48360 },
    );
    expect(r.km_estimated).toBe(true);
    expect(r.km_remaining).toBe(640);
    expect(r.status).toBe('al_dia');
    expect(r.estimated_km_due_date).not.toBeNull(); // ~16 días
  });

  it('marca vencido cuando el estimado ya pasó el km objetivo', () => {
    const r = svc.computeStatus(
      { mileage_at_service: 44000, next_due_mileage: 49000, next_due_date: null },
      44000,
      { km_per_day: 40, estimated_km: 49200 },
    );
    expect(r).toMatchObject({ status: 'vencido', km_remaining: -200, km_estimated: true, estimated_km_due_date: null });
  });

  it('nunca usa una estimación menor a lo último conocido', () => {
    const r = svc.computeStatus(
      { mileage_at_service: 44000, next_due_mileage: 49000, next_due_date: null },
      46000,
      { km_per_day: 10, estimated_km: 45000 },
    );
    expect(r).toMatchObject({ km_estimated: false, km_remaining: 3000 });
  });
});

describe('generateRecordsForDeliveredOrder', () => {
  beforeEach(() => jest.clearAllMocks());

  it('crea un registro por tipo que matchea un ítem aprobado, con el próximo calculado', async () => {
    models.WorkOrder.findOne.mockResolvedValue({
      id: 'wo1', tenant_id: 't1', vehicle_id: 'v1', status: 'entregado',
      mileage_in: 9900, mileage_out: 10000, delivered_at: new Date(2026, 8, 25, 10),
    });
    models.Vehicle.findOne.mockResolvedValue({ id: 'v1', vehicle_type: 'automovil' });
    models.MaintenanceType.findAll.mockResolvedValue([
      { id: 'mt-aceite', interval_km: 5000, interval_months: 6, match_keywords: ['aceite'] },
      { id: 'mt-frenos', interval_km: 20000, interval_months: null, match_keywords: ['pastilla'] },
      { id: 'mt-aire', interval_km: 10000, interval_months: null, match_keywords: ['filtro de aire'] },
    ]);
    models.WorkOrderItem.findAll.mockResolvedValue([
      { product_name: 'Aceite 20W50 x 4L', approval_status: 'aprobado' },
      { product_name: 'Pastillas de freno', approval_status: 'rechazado' },
      { product_name: 'Filtro de aire', approval_status: null },
    ]);

    const n = await svc.generateRecordsForDeliveredOrder('wo1', 't1');

    expect(n).toBe(2);
    const [rows, opts] = models.VehicleMaintenanceRecord.bulkCreate.mock.calls[0];
    expect(opts).toEqual({ ignoreDuplicates: true });
    expect(rows).toEqual([
      expect.objectContaining({ maintenance_type_id: 'mt-aceite', performed_at: '2026-09-25', mileage_at_service: 10000, next_due_mileage: 15000, next_due_date: '2027-03-25' }),
      expect.objectContaining({ maintenance_type_id: 'mt-aire', next_due_mileage: 20000, next_due_date: null }),
    ]);
  });

  it('no hace nada si la OT no está entregada', async () => {
    models.WorkOrder.findOne.mockResolvedValue({ id: 'wo1', status: 'listo', vehicle_id: 'v1' });
    expect(await svc.generateRecordsForDeliveredOrder('wo1', 't1')).toBe(0);
    expect(models.VehicleMaintenanceRecord.bulkCreate).not.toHaveBeenCalled();
  });
});
