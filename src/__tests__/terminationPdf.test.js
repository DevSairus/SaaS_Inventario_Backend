// 6.3 — PDF de la liquidación definitiva de contrato.
const { generateTerminationSettlementPDF } = require('../services/payroll/payrollTerminationPdfService');

const employee = {
  id: 'e1', first_name: 'Juan', other_names: 'Carlos', first_surname: 'Pérez', second_surname: 'Gómez',
  document_type: '13', document_number: '1017123456', position: 'Mecánico', contract_type: '1',
  base_salary: 3000000, hire_date: '2024-03-01', termination_date: '2026-10-15', termination_notes: 'Salida acordada',
};
const tenant = { company_name: 'Taller Demo SAS', tax_id: '900123456-1', address: 'Calle 10 # 20-30', phone: '3001234567', email: 'demo@taller.co' };
const resumen = {
  devengadosLines: [{ label: 'Sueldo (15 días)', amount: 1500000 }, { label: 'Cesantías', amount: 2700000 }],
  deduccionesLines: [{ label: 'Salud', amount: 60000 }],
};
const breakdown = {
  cesantias: { dias: 645, fechaInicioAcumulacion: '2025-01-01', cesantias: 2700000, intereses: 300000 },
  prima: { dias: 105, semestre: 2, prima: 1800000 },
  vacaciones: { diasPendientes: 6, diasCausados: 31.5, diasYaTomados: 25.5, valor: 1200000 },
  indemnizacion: 5000000, bonifRetiro: 0,
};
const pageCount = (buffer) => (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;

describe('generateTerminationSettlementPDF', () => {
  const common = { employee, tenant, periodo: { start_date: '2026-10-01', end_date: '2026-10-15' }, resumen, netoTotal: 4140000, terminationReason: 'sin_justa_causa' };

  test('borrador: devuelve un PDF válido de una sola página', async () => {
    const buffer = await generateTerminationSettlementPDF(null, { ...common, status: 'borrador', breakdown });
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(buffer)).toBe(1);
  });

  test('emitida: PDF válido con número de documento y CUNE, sin detalle de cálculo', async () => {
    const buffer = await generateTerminationSettlementPDF(null, {
      ...common, status: 'emitida', breakdown: null, documentNumber: 'NIE42', cune: 'a'.repeat(96),
    });
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(buffer)).toBe(1);
  });

  test('con muchas líneas pagina sin perder el pie ni dejar páginas vacías', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ label: `Concepto ${i + 1}`, amount: 1000 * (i + 1) }));
    const buffer = await generateTerminationSettlementPDF(null, {
      ...common, status: 'borrador', breakdown, resumen: { devengadosLines: many, deduccionesLines: [] },
    });
    expect(pageCount(buffer)).toBeGreaterThanOrEqual(2);
    expect(pageCount(buffer)).toBeLessThanOrEqual(3);
  });

  test('con el salario ya cubierto y prima descontada también genera un PDF válido', async () => {
    const buffer = await generateTerminationSettlementPDF(null, {
      ...common, status: 'borrador', excludesSalary: true,
      breakdown: { ...breakdown, prima: { dias: 105, semestre: 2, prima: 0, primaCausada: 1800000, yaPagada: 1800000 } },
    });
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(buffer)).toBe(1);
  });

  test('en modo streaming escribe en la respuesta', async () => {
    const chunks = [];
    const res = {
      setHeader: jest.fn(),
      write: (c) => chunks.push(Buffer.from(c)),
      end: (c) => { if (c) chunks.push(Buffer.from(c)); res.finished = true; },
      on: jest.fn(), once: jest.fn(), emit: jest.fn(), removeListener: jest.fn(),
    };
    await generateTerminationSettlementPDF(res, { ...common, status: 'borrador', breakdown });
    await new Promise((r) => setTimeout(r, 100));
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(Buffer.concat(chunks).slice(0, 5).toString()).toBe('%PDF-');
  });
});
