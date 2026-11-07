const { expenseAccountsByEmployee, buildLaborReclassLines } = require('../services/accounting/projectAccounting.service');

const acc = (type) => ({ account_type: type });
// Comprobante de nómina: devengados por empleado (tercero) y aportes/provisiones consolidados.
const lines = [
  { account_id: 'A_sueldo', debit: 2000000, credit: 0, third_party_id: 'e1', account: acc('gasto') },
  { account_id: 'A_auxtr', debit: 200000, credit: 0, third_party_id: 'e1', account: acc('gasto') },
  { account_id: 'A_sueldo', debit: 1500000, credit: 0, third_party_id: 'e2', account: acc('gasto') },
  { account_id: 'P_neto', debit: 0, credit: 3700000, third_party_id: 'e1', account: acc('pasivo') },
  { account_id: 'A_pension', debit: 420000, credit: 0, third_party_id: null, account: acc('gasto') },
  { account_id: 'A_cesantias', debit: 300000, credit: 0, third_party_id: null, account: acc('gasto') },
];
const mapped = { 'payroll_employer:pension': 'A_pension', 'payroll_expense:cesantias': 'A_cesantias', 'payroll_employer:arl': 'A_arl' };
const costs = new Map([
  ['e1', { by_concept: { aportes: { pension: 240000, arl: 10000 }, provisiones: { cesantias: 183000 } } }],
  ['e2', { by_concept: { aportes: { pension: 180000 }, provisiones: { cesantias: 117000 } } }],
]);

describe('reclasificación de nómina a obras', () => {
  const byEmployee = expenseAccountsByEmployee({ lines, employeeCosts: costs, mappedAccount: (k) => mapped[k] });

  test('cuentas de gasto de cada empleado: devengados + su parte de aportes y provisiones', () => {
    expect(Object.fromEntries(byEmployee.get('e1'))).toEqual({ A_sueldo: 2000000, A_auxtr: 200000, A_pension: 240000, A_cesantias: 183000 });
    // ARL sin línea en el comprobante: no se reclasifica una cuenta que no se debitó
    expect(byEmployee.get('e1').has('A_arl')).toBe(false);
    expect(Object.fromEntries(byEmployee.get('e2'))).toEqual({ A_sueldo: 1500000, A_pension: 180000, A_cesantias: 117000 });
  });

  test('acredita las mismas cuentas en el % del proyecto y debita costo de obra por proyecto', () => {
    const { lines: out, total } = buildLaborReclassLines({
      allocations: [
        { employee_id: 'e1', project_id: 'p1', percentage: 40 },
        { employee_id: 'e1', project_id: 'p2', percentage: 20 },
        { employee_id: 'e2', project_id: 'p1', percentage: 50 },
      ],
      accountsByEmployee: byEmployee,
      laborAccount: 'C_mo',
    });
    const debit = Object.fromEntries(out.filter((l) => l.debit > 0).map((l) => [l.project_id, l.debit]));
    // e1: 2.623.000 × 40 % y × 20 %; e2: 1.797.000 × 50 %
    expect(debit).toEqual({ p1: 1049200 + 898500, p2: 524600 });
    const credit = Object.fromEntries(out.filter((l) => l.credit > 0).map((l) => [l.account_id, l.credit]));
    expect(credit.A_sueldo).toBe(800000 + 400000 + 750000);
    const sumD = out.reduce((s, l) => s + l.debit, 0);
    const sumC = out.reduce((s, l) => s + l.credit, 0);
    expect(Math.round(sumD * 100)).toBe(Math.round(sumC * 100));
    expect(total).toBe(sumD);
    // Las líneas de gasto acreditadas no llevan proyecto; el costo de obra sí.
    expect(out.filter((l) => l.credit > 0).every((l) => l.project_id === null)).toBe(true);
  });
});
