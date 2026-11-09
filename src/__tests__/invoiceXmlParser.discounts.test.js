// Descuentos de factura electrónica de proveedor (cac:AllowanceCharge) al
// importar el ZIP: por línea (con LineExtensionAmount neto o bruto según el
// emisor) y globales, sin restar dos veces el que se repite en la raíz.
const { parseInvoiceXML } = require('../services/invoiceXmlParser');

const ac = (amount, base, pct, charge = false) => `
  <cac:AllowanceCharge>
    <cbc:ID>1</cbc:ID>
    <cbc:ChargeIndicator>${charge}</cbc:ChargeIndicator>
    ${pct ? `<cbc:MultiplierFactorNumeric>${pct}</cbc:MultiplierFactorNumeric>` : ''}
    <cbc:Amount currencyID="COP">${amount}</cbc:Amount>
    <cbc:BaseAmount currencyID="COP">${base}</cbc:BaseAmount>
  </cac:AllowanceCharge>`;

function invoice({ lineExt, lineAC = '', taxable, tax, docAC = '', allowanceTotal = 0, payable }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>FE1</cbc:ID>
  <cbc:IssueDate>2026-11-03</cbc:IssueDate>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>PROVEEDOR</cbc:Name></cac:PartyName>
  </cac:Party></cac:AccountingSupplierParty>
  ${docAC}
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="COP">${lineExt}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="COP">${taxable}</cbc:TaxExclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="COP">${allowanceTotal}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="COP">${payable}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="94">3</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">${lineExt}</cbc:LineExtensionAmount>
    ${lineAC}
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">${tax}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">${taxable}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">${tax}</cbc:TaxAmount>
        <cac:TaxCategory><cbc:Percent>19.00</cbc:Percent><cac:TaxScheme><cbc:ID>01</cbc:ID></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Description>SILICONA</cbc:Description></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="COP">85235.90</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('invoiceXmlParser — descuentos', () => {
  test('descuento de línea con LineExtensionAmount BRUTO y repetido en la raíz (caso real)', async () => {
    const r = await parseInvoiceXML(invoice({
      lineExt: '255707.70', lineAC: ac('25570.77', '255707.70', '10.00'),
      taxable: '230136.93', tax: '43726.02',
      docAC: ac('25570.77', '255707.70', '10.00'), allowanceTotal: '25570.77', payable: '273862.95',
    }));
    const [it] = r.items;
    expect(it.unit_price).toBeCloseTo(85235.9);
    expect(it.discount_percentage).toBe(10);
    expect(it.discount_amount).toBeCloseTo(25570.77);
    expect(it.subtotal).toBeCloseTo(230136.93);
    expect(r.totals.global_discount).toBe(0); // no se resta dos veces
    expect(r.totals.subtotal + r.totals.tax).toBeCloseTo(273862.95);
  });

  test('descuento de línea con LineExtensionAmount NETO (anexo DIAN)', async () => {
    const r = await parseInvoiceXML(invoice({
      lineExt: '230136.93', lineAC: ac('25570.77', '255707.70', '10.00'),
      taxable: '230136.93', tax: '43726.02', payable: '273862.95',
    }));
    expect(r.items[0].subtotal).toBeCloseTo(230136.93);
    expect(r.items[0].discount_percentage).toBe(10);
    expect(r.totals.global_discount).toBe(0);
  });

  test('descuento solo global (raíz) llega como descuento de la compra', async () => {
    const r = await parseInvoiceXML(invoice({
      lineExt: '255707.70', taxable: '255707.70', tax: '48584.46',
      docAC: ac('25570.77', '255707.70', '10.00'), allowanceTotal: '25570.77', payable: '278721.39',
    }));
    expect(r.items[0].discount_amount).toBe(0);
    expect(r.items[0].subtotal).toBeCloseTo(255707.7);
    expect(r.totals.global_discount).toBeCloseTo(25570.77);
  });

  test('cargo global (flete) llega como global_charge', async () => {
    const r = await parseInvoiceXML(invoice({
      lineExt: '255707.70', taxable: '255707.70', tax: '48584.46',
      docAC: ac('10000', '255707.70', null, true), payable: '314292.16',
    }));
    expect(r.totals.global_charge).toBe(10000);
    expect(r.totals.global_discount).toBe(0);
  });
});
