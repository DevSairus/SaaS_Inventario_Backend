const { addMonths, usageDays, displayStatus } = require('../services/tools/tools.service');

describe('herramientas: fechas', () => {
  test('próxima calibración: suma meses ajustando fin de mes', () => {
    expect(addMonths('2026-11-06', 12)).toBe('2027-11-06');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
  });
  test('días de uso: inclusivos, mínimo 1', () => {
    expect(usageDays('2026-11-01', '2026-11-01')).toBe(1);
    expect(usageDays('2026-11-01', '2026-11-06')).toBe(6);
    expect(usageDays('2026-10-30', '2026-11-02')).toBe(4);
  });
});

describe('herramientas: estado visible', () => {
  const tool = (o) => ({ status: 'active', quantity_total: 5, ...o });
  test('disponible, parcial, asignada', () => {
    expect(displayStatus(tool(), 0)).toBe('available');
    expect(displayStatus(tool(), 2)).toBe('partial');
    expect(displayStatus(tool(), 5)).toBe('assigned');
  });
  test('mantenimiento y baja mandan sobre la asignación', () => {
    expect(displayStatus(tool({ status: 'maintenance' }), 0)).toBe('maintenance');
    expect(displayStatus(tool({ status: 'retired' }), 0)).toBe('retired');
  });
});
