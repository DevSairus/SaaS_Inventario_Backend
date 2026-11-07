const { computeAllocations, baseHoursForPeriod } = require('../services/projects/projectLabor.service');

const cost = (total) => ({ total, devengado: total * 0.7, aportes: total * 0.2, provisiones: total * 0.1, source: 'comprobante' });

describe('jornada del periodo', () => {
  test('mes completo después del 15-jul-2026: 42 h/semana → 210 h', () => {
    expect(baseHoursForPeriod({ start_date: '2026-10-01', end_date: '2026-10-31' })).toBe(210);
  });
  test('quincena: la mitad', () => {
    expect(baseHoursForPeriod({ start_date: '2026-10-01', end_date: '2026-10-15' })).toBe(105);
  });
  test('jornada propia de la empresa', () => {
    expect(baseHoursForPeriod({ start_date: '2026-10-01', end_date: '2026-10-31' }, 40)).toBe(200);
  });
});

describe('reparto de la nómina por horas', () => {
  test('horas por debajo de la jornada: el resto queda como gasto general', () => {
    const { rows, overhead } = computeAllocations({
      hours: [{ employee_id: 'e1', project_id: 'p1', hours: 42 }],
      costs: new Map([['e1', cost(2100000)]]),
      baseHours: 210,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(420000); // 42/210 = 20 %
    expect(rows[0].percentage).toBe(20);
    expect(overhead).toBe(1680000);
  });

  test('horas que cubren toda la jornada: se reparte el costo completo, sin perder centavos', () => {
    const { rows, overhead } = computeAllocations({
      hours: [
        { employee_id: 'e1', project_id: 'p1', hours: 100 },
        { employee_id: 'e1', project_id: 'p2', hours: 70 },
        { employee_id: 'e1', project_id: 'p1', hours: 50 },
      ],
      costs: new Map([['e1', cost(1000000.01)]]),
      baseHours: 210,
    });
    const total = rows.reduce((s, r) => s + r.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(1000000.01);
    expect(overhead).toBe(0);
    expect(rows.find((r) => r.project_id === 'p1').hours).toBe(150);
  });

  test('empleado sin nómina en el periodo: no se reparte', () => {
    const { rows } = computeAllocations({ hours: [{ employee_id: 'e9', project_id: 'p1', hours: 8 }], costs: new Map(), baseHours: 210 });
    expect(rows).toEqual([]);
  });
});

describe('alertas de sobrecosto', () => {
  const { evaluateLevels } = require('../services/projects/projectAlerts.service');
  const pnl = {
    budget: {
      total: 1000, executed: 1050,
      lines: [
        { category: 'materials', budget: 600, executed: 500 },
        { category: 'labor', budget: 400, executed: 550 },
        { category: 'services', budget: 0, executed: 0 },
      ],
    },
  };
  test('aviso desde el 80 %, sobrecosto desde el 100 %; sin presupuesto no se evalúa', () => {
    const r = Object.fromEntries(evaluateLevels(pnl).map((l) => [l.category, l.levels]));
    expect(r.materials).toEqual(['warning']);      // 83 %
    expect(r.labor).toEqual(['warning', 'critical']); // 137,5 %
    expect(r.total).toEqual(['warning', 'critical']); // 105 %
    expect(r.services).toBeUndefined();
  });
  test('umbrales propios del proyecto', () => {
    const r = Object.fromEntries(evaluateLevels(pnl, { warningPct: 90, criticalPct: 110 }).map((l) => [l.category, l.levels]));
    expect(r.materials).toEqual([]);
    expect(r.total).toEqual(['warning']);
  });
});
