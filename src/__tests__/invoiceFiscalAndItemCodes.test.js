// Factura electrónica: responsabilidades fiscales del emisor (varias, con
// ';'), tributo del PartyTaxScheme (tabla 13.2.6.2), tipo de persona y
// código estándar de cada línea (UNSPSC 001/10 o propio 999). Genera y firma
// una factura real en modo simulación (certificado de demostración).

const fs = require('fs');
const os = require('os');
const path = require('path');
const kit = require('../services/dian/dianKitAdapter');
const {
  parseResponsibilities, formatResponsibilities, partyTaxScheme, regimeLabel, isIvaResponsibleForAccounting,
} = require('../utils/fiscalResponsibilities');

jest.setTimeout(60000);

const resolution = {
  resolution_number: '18760000001', prefix: 'SETP', from_number: 990000000, to_number: 995000000,
  valid_from: '2019-01-19', valid_to: '2030-01-19', technical_key: 'fc8eac422eba16e22ffd8c6f94b3f40a6e38162c',
};
const sale = { customer_name: 'CLIENTE', customer_tax_id: '222222222222', customer_document_type: '13', payment_form: 'contado' };
const items = () => [
  { product_sku: 'FIL-001', unspsc_code: '40161504', description: 'Filtro de aceite', quantity: 2, unit_price: 10000, subtotal: 20000, tax_percentage: 19, tax_amount: 3800, iva_status: 'gravado' },
  { product_sku: 'MO-ALIN', description: 'Alineación', quantity: 1, unit_price: 50000, subtotal: 50000, tax_percentage: 19, tax_amount: 9500, iva_status: 'gravado' },
];
let n = 0;
async function invoice(cfg) {
  const tenant = {
    id: `t-fiscal-${++n}`, company_name: 'TALLER DEMO', tax_id: '1020304050', email: 'a@b.co',
    dian_config: { environment: 'simulation', nit: '1020304050', company_name: 'JUAN PEREZ GOMEZ', ...cfg },
  };
  const r = await kit.createInvoice(tenant, { invoiceNumber: 'SETP990000001', items: items(), resolution, customer: null, sale });
  if (process.env.DUMP_INVOICE_XML) fs.writeFileSync(path.join(os.tmpdir(), `factura_${cfg.tax_level_code || 'unset'}.xml`.replace(/;/g, '_')), r.signedXml);
  const supplier = r.signedXml.match(/<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/)[0];
  return { xml: r.signedXml, supplier };
}

describe('responsabilidades fiscales', () => {
  test('parse/format: orden de la tabla, R-99-PN no se combina, vacío = R-99-PN', () => {
    expect(parseResponsibilities('o-47; O-13')).toEqual(['O-13', 'O-47']);
    expect(parseResponsibilities(['R-99-PN', 'O-15'])).toEqual(['O-15']);
    expect(parseResponsibilities('')).toEqual(['R-99-PN']);
    expect(parseResponsibilities('X-1')).toEqual(['R-99-PN']);
    expect(formatResponsibilities(['O-47', 'O-23'])).toBe('O-23;O-47');
  });

  test('tributo del emisor (tabla 13.2.6.2)', () => {
    expect(partyTaxScheme({ regime_code: '48' }).code).toBe('01');
    expect(partyTaxScheme({ regime_code: '48', inc_responsible: true }).code).toBe('ZA');
    expect(partyTaxScheme({ regime_code: '49', inc_responsible: true }).code).toBe('04');
    expect(partyTaxScheme({ regime_code: '49' }).code).toBe('ZZ');
  });

  test('contabilidad conserva la regla anterior (solo R-99-PN = no responsable)', () => {
    expect(isIvaResponsibleForAccounting({})).toBe(true);
    expect(isIvaResponsibleForAccounting({ tax_level_code: 'R-99-PN' })).toBe(false);
    expect(isIvaResponsibleForAccounting({ tax_level_code: 'O-47;O-23' })).toBe(true);
  });

  test('texto del régimen para el PDF', () => {
    expect(regimeLabel({})).toBeNull();
    expect(regimeLabel({ regime_code: '48', tax_level_code: 'O-23;O-47' }))
      .toBe('Responsable de IVA · Agente de retención de IVA · Régimen Simple de Tributación');
    expect(regimeLabel({ regime_code: '49', tax_level_code: 'R-99-PN' })).toBe('No responsable de IVA');
  });
});

describe('XML de la factura', () => {
  test('Régimen Simple + agente de retención, persona natural', async () => {
    const { xml, supplier } = await invoice({ tax_level_code: 'O-47;O-23', regime_code: '48', person_type: '2' });
    expect(supplier).toMatch(/<cbc:AdditionalAccountID>2<\/cbc:AdditionalAccountID>/);
    expect(supplier).toMatch(/<cbc:TaxLevelCode[^>]*>O-23;O-47<\/cbc:TaxLevelCode>/);
    expect(supplier).toMatch(/<cac:TaxScheme><cbc:ID>01<\/cbc:ID><cbc:Name>IVA<\/cbc:Name><\/cac:TaxScheme>/);
    // Línea con UNSPSC y línea con código propio.
    expect(xml).toContain('<cbc:ID schemeID="001" schemeAgencyID="10" schemeName="UNSPSC">40161504</cbc:ID>');
    expect(xml).toContain('<cbc:ID schemeID="999" schemeName="Estándar de adopción del contribuyente">MO-ALIN</cbc:ID>');
    expect(xml).toContain('<cac:SellersItemIdentification><cbc:ID>FIL-001</cbc:ID></cac:SellersItemIdentification>');
    // El cliente no se toca.
    const customer = xml.match(/<cac:AccountingCustomerParty>[\s\S]*?<\/cac:AccountingCustomerParty>/)[0];
    expect(customer).toMatch(/<cbc:TaxLevelCode[^>]*>R-99-PN<\/cbc:TaxLevelCode>/);
  });

  test('no responsable de IVA: R-99-PN y tributo ZZ', async () => {
    const { supplier } = await invoice({ tax_level_code: 'R-99-PN', regime_code: '49' });
    expect(supplier).toMatch(/<cbc:AdditionalAccountID>1<\/cbc:AdditionalAccountID>/);
    expect(supplier).toMatch(/<cbc:TaxLevelCode[^>]*>R-99-PN<\/cbc:TaxLevelCode>/);
    expect(supplier).toMatch(/<cbc:ID>ZZ<\/cbc:ID><cbc:Name>No aplica<\/cbc:Name>/);
  });

  test('sin configurar ya no sale como gran contribuyente (O-13)', async () => {
    const { supplier } = await invoice({});
    expect(supplier).not.toMatch(/O-13/);
    expect(supplier).toMatch(/<cbc:TaxLevelCode[^>]*>R-99-PN<\/cbc:TaxLevelCode>/);
  });
});
