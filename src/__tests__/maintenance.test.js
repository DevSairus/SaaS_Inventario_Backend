// Mantenimientos recurrentes (Fase 4, req. 1.3): fechas de la siguiente
// visita, alertas (vencida / por vencer) y checklist de la visita.
const CUSTOMERS = [
  { id: 'c1', tax_id: '900123456-7', business_name: 'Finca El Roble S.A.S.' },
  { id: 'c2', tax_id: '1020304050', first_name: 'Ana', last_name: 'Pérez' },
];
jest.mock('../models', () => ({ Customer: { findAll: jest.fn(async () => CUSTOMERS) } }));
jest.mock('../models/maintenance/MaintenanceModels', () => ({
  MaintenanceInstallation: { findAll: jest.fn(async () => [{ id: 'i-old', customer_id: 'c2', name: 'Casa Ana' }]) },
}));
jest.mock('../config/database', () => ({ sequelize: { transaction: jest.fn() } }));

const {
  addMonths, nextVisitDate, alertState, normalizeTasks, buildChecklist, parseDateCell, importInstallations,
} = require('../services/projects/maintenance.service');

describe('fechas', () => {
  test('suma meses y ajusta al último día del mes', () => {
    expect(addMonths('2026-01-15', 6)).toBe('2026-07-15');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2027-12-31', 2)).toBe('2028-02-29');
  });

  test('la siguiente visita conserva la cadencia del plan', () => {
    // Programada el 10-mar, hecha el 14-mar, cada 3 meses → 10-jun.
    expect(nextVisitDate('2026-03-10', '2026-03-14', 3)).toBe('2026-06-10');
  });

  test('si la visita se hizo tan tarde que la siguiente ya pasó, se cuenta desde la fecha en que se hizo', () => {
    // Programada el 10-ene, hecha el 20-feb, cada mes → 10-feb ya pasó → 20-mar.
    expect(nextVisitDate('2026-01-10', '2026-02-20', 1)).toBe('2026-03-20');
  });
});

describe('alertas', () => {
  const plan = { status: 'active', alert_days_before: 15 };
  const v = (date, status = 'scheduled') => ({ scheduled_date: date, status });

  test('vencida, por vencer y programada', () => {
    expect(alertState(v('2026-11-10'), plan, '2026-11-14')).toBe('overdue');
    expect(alertState(v('2026-11-14'), plan, '2026-11-14')).toBe('due_soon');
    expect(alertState(v('2026-11-29'), plan, '2026-11-14')).toBe('due_soon');
    expect(alertState(v('2026-11-30'), plan, '2026-11-14')).toBe('scheduled');
  });

  test('plan pausado o visita cerrada no alertan', () => {
    expect(alertState(v('2026-11-10'), { ...plan, status: 'paused' }, '2026-11-14')).toBeNull();
    expect(alertState(v('2026-11-10', 'done'), plan, '2026-11-14')).toBeNull();
  });
});

describe('tareas y checklist', () => {
  test('acepta lista o texto por líneas; exige al menos una', () => {
    expect(normalizeTasks(['Limpiar paneles', ' ', 'Revisar inversor'])).toEqual(['Limpiar paneles', 'Revisar inversor']);
    expect(normalizeTasks('Limpiar paneles\nTorque de bornes\n')).toEqual(['Limpiar paneles', 'Torque de bornes']);
    expect(() => normalizeTasks([])).toThrow(/al menos una tarea/);
  });

  test('el checklist de la visita guarda el resultado de cada tarea del plan', () => {
    const c = buildChecklist(['Limpiar paneles', 'Revisar inversor'], [{ done: true }, { done: false, note: 'Falla de ventilador' }]);
    expect(c).toEqual([
      { text: 'Limpiar paneles', done: true, note: null },
      { text: 'Revisar inversor', done: false, note: 'Falla de ventilador' },
    ]);
  });
});

describe('importación de instalaciones anteriores a Pitbox', () => {
  test('fechas de Excel: Date, AAAA-MM-DD y DD/MM/AAAA; inválida = undefined', () => {
    expect(parseDateCell(new Date('2024-03-05T00:00:00Z'))).toBe('2024-03-05');
    expect(parseDateCell('2024-03-05')).toBe('2024-03-05');
    expect(parseDateCell('5/3/2024')).toBe('2024-03-05');
    expect(parseDateCell('')).toBeNull();
    expect(parseDateCell('marzo')).toBeUndefined();
  });

  test('tareas separadas por punto y coma', () => {
    expect(normalizeTasks('Limpiar paneles; Revisar inversor')).toEqual(['Limpiar paneles', 'Revisar inversor']);
  });

  test('revisión: cliente por documento (con o sin DV), agrupa filas de la misma instalación y marca errores', async () => {
    const rows = [
      { row: 2, customer_document: '900123456', name: 'Sistema solar 10 kWp', city: 'Montería', installed_at: '2023-06-01', plan_name: 'Limpieza', frequency_months: 3, next_visit: '15/12/2026', tasks: 'Limpiar paneles; Revisar conexiones' },
      { row: 3, customer_document: '9001234567', name: 'sistema solar 10 kWp', plan_name: 'Revisión anual', frequency_months: 12, tasks: 'Termografía' },
      { row: 4, customer_document: '1020304050', name: 'Casa Ana' },
      { row: 5, customer_document: '111', name: 'Otra' },
      { row: 6, customer_document: '1020304050', name: 'Bodega', frequency_months: 0, tasks: 'x' },
    ];
    const r = await importInstallations('t1', 'u1', rows, { dryRun: true });
    expect(r.summary).toMatchObject({ rows: 5, valid: 3, invalid: 2, new_installations: 1, plans: 2 });
    expect(r.results[0]).toMatchObject({ ok: true, action: 'nueva', customer: 'Finca El Roble S.A.S.' });
    expect(r.results[2]).toMatchObject({ ok: true, action: 'existente' });
    expect(r.results[3].errors[0]).toMatch(/No existe un cliente/);
    expect(r.results[4].errors[0]).toMatch(/frecuencia/);
  });
});
