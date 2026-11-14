// 6.2 — Causa del retiro e indemnización sugerida (Art. 64 CST).
const {
  TERMINATION_REASONS, isValidTerminationReason, terminationReasonLabel, calcularIndemnizacionSugerida,
} = require('../services/payroll/terminationReasons');

const SMLMV = 1750905;
const base = { contractType: '1', baseSalary: 3000000, serviceDays: 360, smlmv: SMLMV };

describe('catálogo de causas', () => {
  test('valida claves y entrega etiquetas', () => {
    expect(isValidTerminationReason('sin_justa_causa')).toBe(true);
    expect(isValidTerminationReason('inventada')).toBe(false);
    expect(isValidTerminationReason('')).toBe(false);
    expect(terminationReasonLabel('renuncia')).toBe('Renuncia voluntaria');
    expect(terminationReasonLabel('xx')).toBeNull();
    expect(Object.keys(TERMINATION_REASONS)).toHaveLength(10);
  });
});

describe('indemnización sugerida', () => {
  test('solo aplica al despido sin justa causa', () => {
    for (const reason of ['renuncia', 'justa_causa', 'mutuo_acuerdo', 'otro', null]) {
      expect(calcularIndemnizacionSugerida({ ...base, reason })).toMatchObject({ applies: false, amount: 0 });
    }
  });

  test('indefinido con menos de 10 SMLMV: 30 días el primer año', () => {
    expect(calcularIndemnizacionSugerida({ ...base, reason: 'sin_justa_causa', serviceDays: 200 }))
      .toMatchObject({ applies: true, days: 30, amount: 3000000 });
    expect(calcularIndemnizacionSugerida({ ...base, reason: 'sin_justa_causa', serviceDays: 360 }))
      .toMatchObject({ days: 30, amount: 3000000 });
  });

  test('indefinido: 20 días por cada año adicional, proporcional por fracción', () => {
    expect(calcularIndemnizacionSugerida({ ...base, reason: 'sin_justa_causa', serviceDays: 720 }))
      .toMatchObject({ days: 50, amount: 5000000 });
    expect(calcularIndemnizacionSugerida({ ...base, reason: 'sin_justa_causa', serviceDays: 540 }))
      .toMatchObject({ days: 40, amount: 4000000 });
  });

  test('indefinido con 10 SMLMV o más: 20 días el primer año y 15 por año adicional', () => {
    const high = { ...base, reason: 'sin_justa_causa', baseSalary: 20000000 };
    expect(calcularIndemnizacionSugerida({ ...high, serviceDays: 360 })).toMatchObject({ days: 20, amount: 13333333 });
    expect(calcularIndemnizacionSugerida({ ...high, serviceDays: 720 })).toMatchObject({ days: 35, amount: 23333333 });
  });

  test('término fijo: salarios que faltaban hasta la fecha pactada', () => {
    const fijo = { ...base, reason: 'sin_justa_causa', contractType: '2' };
    expect(calcularIndemnizacionSugerida({ ...fijo, remainingDays: 90 })).toMatchObject({ applies: true, days: 90, amount: 9000000 });
    expect(calcularIndemnizacionSugerida({ ...fijo, remainingDays: 0 })).toMatchObject({ days: 0, amount: 0 });
  });

  test('término fijo sin fecha de fin y obra o labor: aplica pero no sugiere monto', () => {
    const sinFecha = calcularIndemnizacionSugerida({ ...base, reason: 'sin_justa_causa', contractType: '2' });
    expect(sinFecha).toMatchObject({ applies: true, amount: 0 });
    expect(sinFecha.note).toMatch(/fecha de fin/);
    const obra = calcularIndemnizacionSugerida({ ...base, reason: 'sin_justa_causa', contractType: '3' });
    expect(obra).toMatchObject({ applies: true, amount: 0 });
  });

  test('aprendizaje u otro tipo no tienen fórmula; sin salario no hay valor', () => {
    expect(calcularIndemnizacionSugerida({ ...base, reason: 'sin_justa_causa', contractType: '4' })).toMatchObject({ applies: false });
    expect(calcularIndemnizacionSugerida({ ...base, reason: 'sin_justa_causa', baseSalary: 0 })).toMatchObject({ applies: false });
  });
});
