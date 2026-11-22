// El PDF de los estados se genera completo con datos de ejemplo (sin BD).
const { generateNiifPdf } = require('../services/accounting/niifPdf.service');

const esf = {
  as_of: '2026-12-31', compare_as_of: '2025-12-31',
  sections: [
    { code: 'activo_corriente', label: 'Activo corriente', group: 'activo', current: 1000, prior: 800, rubros: [{ code: 'efectivo', label: 'Efectivo y equivalentes al efectivo', current: 1000, prior: 800, accounts: [] }] },
    { code: 'activo_no_corriente', label: 'Activo no corriente', group: 'activo', current: 0, prior: 0, rubros: [] },
    { code: 'pasivo_corriente', label: 'Pasivo corriente', group: 'pasivo', current: 400, prior: 300, rubros: [{ code: 'proveedores_cxp', label: 'Acreedores comerciales', current: 400, prior: 300, accounts: [] }] },
    { code: 'pasivo_no_corriente', label: 'Pasivo no corriente', group: 'pasivo', current: 0, prior: 0, rubros: [] },
    { code: 'patrimonio', label: 'Patrimonio', group: 'patrimonio', current: 600, prior: 500, rubros: [{ code: 'capital', label: 'Capital social', current: 600, prior: 500, accounts: [] }] },
  ],
  totals: {
    current: { activo: 1000, pasivo: 400, patrimonio: 600, pasivo_patrimonio: 1000, cuadra: true },
    prior: { activo: 800, pasivo: 300, patrimonio: 500, pasivo_patrimonio: 800, cuadra: true },
  },
};
const eri = {
  from: '2026-01-01', to: '2026-12-31', compare_from: '2025-01-01', compare_to: '2025-12-31',
  lines: [
    { key: 'ingresos_ordinarios', rubro: 'ingresos_ordinarios', label: 'Ingresos', current: 500, prior: 400 },
    { key: 'resultado_periodo', label: 'Resultado del periodo', subtotal: true, strong: true, current: 100, prior: 50 },
  ],
};
const ecp = {
  from: '2026-01-01', to: '2026-12-31', opening_date: '2025-12-31',
  columns: [{ code: 'capital', label: 'Capital social' }, { code: 'resultado_ejercicio', label: 'Resultado del ejercicio' }],
  rows: [
    { key: 'saldo_inicial', label: 'Saldo', strong: true, values: { capital: 500, resultado_ejercicio: 0 }, total: 500 },
    { key: 'resultado_periodo', label: 'Resultado del periodo', values: { capital: 0, resultado_ejercicio: 100 }, total: 100 },
    { key: 'saldo_final', label: 'Saldo', strong: true, values: { capital: 500, resultado_ejercicio: 100 }, total: 600 },
  ],
};
const cashflow = {
  from: '2026-01-01', to: '2026-12-31', net_income: 100,
  operating: { changes: [{ code: '220505', name: 'Proveedores', cash_impact: 100 }], total: 200 },
  investing: { changes: [], total: 0 }, financing: { changes: [], total: 0 },
  net_cash_flow: 200, cash: { opening: 800, closing: 1000, matches: true, difference: 0 },
};
const notes = {
  as_of: '2026-12-31', year: 2026, tenant: { name: 'Empresa de prueba', tax_id: '900123456' },
  signatures: { legal_rep_name: 'Ana Pérez', accountant_name: 'Carlos Gómez', accountant_tp: '1-T' },
  rubro_note_numbers: { efectivo: 4 },
  notes: [
    { key: 'politicas', number: 1, title: 'Políticas contables', paragraphs: ['**Inventarios.** Promedio ponderado.'], tables: [] },
    { key: 'rubro_efectivo', number: 4, title: 'Efectivo', paragraphs: [], custom: { mode: 'append', body: 'Texto propio.\n\nOtro párrafo.' },
      tables: [{ columns: [{ label: 'Cuenta' }, { label: 'Concepto' }, { label: '2026', align: 'right' }, { label: '2025', align: 'right' }], rows: [['110505', 'Caja', 1000, 800]], money_from: 2, total: ['', 'Total', 1000, 800] }] },
  ],
};

test('genera el PDF del juego completo de estados financieros', async () => {
  const buffer = await generateNiifPdf(null, { esf, eri, ecp, cashflow, notes }, { company_name: 'Empresa de prueba', tax_id: '900123456' }, 'Tester', { title: 'ESTADOS FINANCIEROS', filename: 'x' });
  expect(Buffer.isBuffer(buffer)).toBe(true);
  expect(buffer.slice(0, 4).toString()).toBe('%PDF');
  expect(buffer.length).toBeGreaterThan(3000);
});
