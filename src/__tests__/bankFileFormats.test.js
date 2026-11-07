const { PRESETS, buildBankFile, fromCustomTemplate } = require('../services/payments/bankFileFormats');
const { findBank, accountKind } = require('../services/payments/colombianBanks');

const company = { tax_id: '901234567-8', name: 'Solier S.A.S.' };
const batch = { batch_number: 'LP-000001', payment_date: '2026-11-10', debit_account: '123-456789-01', debit_account_type: 'checking' };
const items = [
  { reference: 'PC-2026-00005', name: 'Masser S.A.S.', tax_id: '900491889-1', doc_type: '31', bank_name: 'Bancolombia S.A.', account_type: 'Ahorros', account_number: '0012 3456 789', amount: 1666000.5, email: 'pagos@masser.co' },
  { reference: 'GAS-2026-00003', name: 'José Pérez', tax_id: '1020304050', doc_type: '13', bank_name: 'Davivienda', account_type: 'Corriente', account_number: '4567890123', amount: 4000000 },
];

describe('bancos y tipos de cuenta', () => {
  test('nombre libre → código ACH', () => {
    expect(findBank('Bancolombia S.A.').code).toBe('1007');
    expect(findBank('banco davivienda').code).toBe('1051');
    expect(findBank('1013').name).toBe('BBVA Colombia');
    expect(findBank('Banco inventado')).toBeNull();
  });
  test('tipo de cuenta en texto libre', () => {
    expect(accountKind('Ahorros')).toBe('savings');
    expect(accountKind('CTA CORRIENTE')).toBe('checking');
    expect(accountKind('')).toBeNull();
  });
});

describe('archivo plano', () => {
  test('Bancolombia PAB: todas las líneas del mismo tipo con el mismo ancho, valores en centavos', () => {
    const { content, problems, filename } = buildBankFile(PRESETS.bancolombia_pab, { company, batch, items });
    expect(problems).toEqual([]);
    expect(filename).toBe('LP-000001-Bancolombia.txt');
    const lines = content.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    const width = (fields) => fields.reduce((s, f) => s + f.width, 0);
    expect(lines[0]).toHaveLength(width(PRESETS.bancolombia_pab.header));
    expect(lines[1]).toHaveLength(width(PRESETS.bancolombia_pab.detail));
    expect(lines[2]).toHaveLength(width(PRESETS.bancolombia_pab.detail));
    expect(lines[0].startsWith('1000000901234567')).toBe(true); // NIT sin DV, con ceros a la izquierda
    expect(lines[0]).toContain('00000000566600050'); // total 5.666.000,50 en centavos
    expect(lines[1]).toContain('000001007');          // banco destino
    expect(lines[1]).toContain('0012345678');         // cuenta sin espacios
    expect(lines[1]).toContain('37');                 // ahorros
  });

  test('delimitado (BBVA): el delimitador nunca queda dentro de un valor', () => {
    const { content } = buildBankFile(PRESETS.bbva, { company, batch, items: [{ ...items[0], name: 'Masser, S.A.S.' }] });
    const fields = content.trim().split(',');
    expect(fields).toHaveLength(PRESETS.bbva.detail.length);
    expect(fields).toContain('1666000.50');
  });

  test('si falta un dato bancario no se genera nada y se dice qué falta', () => {
    const { content, problems } = buildBankFile(PRESETS.davivienda, { company, batch, items: [{ ...items[1], account_number: '', bank_name: 'Banco inventado' }] });
    expect(content).toBeNull();
    expect(problems[0].missing).toEqual(['banco', 'número de cuenta']);
  });

  test('plantilla propia: columnas en orden, encabezado y códigos de cuenta de la empresa', () => {
    const tpl = fromCustomTemplate({
      id: 'x', name: 'Mi banco', delimiter: ';', extension: 'csv', include_header: true, savings_code: 'AHO', checking_code: 'CTE',
      columns: [{ source: 'beneficiary_tax_id', label: 'NIT' }, { source: 'beneficiary_account_type' }, { source: 'amount', format: 'decimal_comma' }, { source: 'const', value: 'PAGO' }],
    });
    const lines = buildBankFile(tpl, { company, batch, items }).content.trim().split('\r\n');
    expect(lines[0]).toBe('NIT;Tipo de cuenta del proveedor;Valor a pagar;const');
    expect(lines[1]).toBe('900491889;AHO;1666000,50;PAGO');
    expect(lines[2]).toBe('1020304050;CTE;4000000,00;PAGO');
  });
});
