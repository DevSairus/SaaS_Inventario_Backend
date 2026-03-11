// backend/src/services/dian/dianXmlBuilder.js
/**
 * Constructor de XML UBL 2.1 para Facturación Electrónica DIAN (Colombia)
 * Basado en: Resolución 000012 del 09-02-2021 (Anexo Técnico v1.8)
 *
 * Documentos soportados:
 *   - Factura de Venta (InvoiceTypeCode 01)
 *   - Nota Crédito
 *   - Nota Débito
 */

const crypto = require('crypto');

/* ──────────────────────────────────────────────────────────
 * CUFE (Código Único de Factura Electrónica) – SHA-384
 * Algoritmo: SHA384(NumFac+FecFac+HorFac+ValFac+CodImp1+ValImp1+
 *             CodImp2+ValImp2+CodImp3+ValImp3+ValTot+NitOFE+
 *             NumAdq+ClaveT+TipoFe)
 * ────────────────────────────────────────────────────────── */
function buildCufe({ invoiceNumber, issueDate, issueTime,
  subtotal,               // ValFac = base imponible SIN impuestos
  totalAmount,            // ValTot = total CON impuestos
  taxAmount19,            // ValImp IVA
  taxAmount5,             // ValImp INC
  taxAmount0,             // ValImp ICA
  nitEmisor, nitAdquiriente, technicalKey }) {

  // Algoritmo oficial DIAN (verificado contra Caja de Herramientas V19):
  // SHA384(NumFac+FecFac+HorFac+ValFac+01+ValIVA+04+ValINC+03+ValICA+ValTot+NitOFE+NumAdq+ClaveT)
  // NOTA: TipoFe NO se incluye en el hash (confirmado en ejemplificaciones oficiales)
  const fmt2 = (n) => Number(n || 0).toFixed(2);

  const plain = [
    invoiceNumber,
    issueDate,              // YYYY-MM-DD
    issueTime,              // HH:MM:SS-05:00
    fmt2(subtotal),         // ValFac = base imponible (sin IVA)
    '01', fmt2(taxAmount19),
    '04', fmt2(taxAmount5),
    '03', fmt2(taxAmount0),
    fmt2(totalAmount),      // ValTot = total con impuestos
    nitEmisor,
    nitAdquiriente,
    technicalKey,
    // TipoFe NO va aquí — confirmado por ejemplificación oficial DIAN V19
  ].join('');

  return crypto.createHash('sha384').update(plain).digest('hex');
}

/* ──────────────────────────────────────────────────────────
 * Software Security Code
 * SHA-384(softwareId + pinSoftware + numFac)
 * ────────────────────────────────────────────────────────── */
function buildSoftwareSecurityCode(softwareId, softwarePin, invoiceNumber) {
  const plain = softwareId + softwarePin + invoiceNumber;
  return crypto.createHash('sha384').update(plain).digest('hex');
}

/* ──────────────────────────────────────────────────────────
 * QR Code text
 * ────────────────────────────────────────────────────────── */
function buildQrCode({ invoiceNumber, nitEmisor, nitAdquiriente,
  issueDate, totalAmount, cufe, environment }) {
  const base = environment === 'production'
    ? 'https://catalogo-vpfe.dian.gov.co'
    : 'https://catalogo-vpfe-hab.dian.gov.co';
  const emDate = issueDate.replace(/-/g, '');
  const partition = `co|${emDate.substring(4, 6)}|${cufe.substring(0, 2)}`;

  return [
    `NroFactura=${invoiceNumber}`,
    `NitFacturador=${nitEmisor}`,
    `NitAdquiriente=${nitAdquiriente}`,
    `FechaFactura=${issueDate}`,
    `ValorTotalFactura=${Number(totalAmount).toFixed(2)}`,
    `CUFE=${cufe}`,
    `URL=${base}/Document/FindDocument?documentKey=${cufe}&partitionKey=${partition}&emissionDate=${emDate}`
  ].join('\n\t\t\t\t\t\t\t\t');
}

/* ──────────────────────────────────────────────────────────
 * Party section helper
 * ────────────────────────────────────────────────────────── */
function partyXml({ nit, name, tradeName, regimeCode, liabilityCode,
  taxLevelCode, address, city, cityCode, dept, country = 'CO',
  email, phone, schemeID = '31' }) {

  return `
    <cac:Party>
      <cac:PartyName>
        <cbc:Name>${escXml(name)}</cbc:Name>
      </cac:PartyName>
      ${tradeName ? `<cac:PartyName><cbc:Name>${escXml(tradeName)}</cbc:Name></cac:PartyName>` : ''}
      <cac:PhysicalLocation>
        <cac:Address>
          <cbc:ID>${escXml(cityCode || '')}</cbc:ID>
          <cbc:CityName>${escXml(city || '')}</cbc:CityName>
          <cbc:PostalZone>${escXml('')}</cbc:PostalZone>
          <cbc:CountrySubentity>${escXml(dept || '')}</cbc:CountrySubentity>
          <cbc:CountrySubentityCode>${escXml('')}</cbc:CountrySubentityCode>
          <cac:AddressLine>
            <cbc:Line>${escXml(address || '')}</cbc:Line>
          </cac:AddressLine>
          <cac:Country>
            <cbc:IdentificationCode>${country}</cbc:IdentificationCode>
            <cbc:Name languageID="es">${country === 'CO' ? 'Colombia' : country}</cbc:Name>
          </cac:Country>
        </cac:Address>
      </cac:PhysicalLocation>
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>${escXml(name)}</cbc:RegistrationName>
        <cbc:CompanyID schemeAgencyID="195"
          schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"
          schemeID="${schemeID}" schemeName="${schemeID === '31' ? 'NIT' : 'CC'}">${escXml(nit)}</cbc:CompanyID>
        <cbc:TaxLevelCode listName="${regimeCode || 'ZZ'}">${taxLevelCode || 'O-99'}</cbc:TaxLevelCode>
        <cac:RegistrationAddress>
          <cbc:ID>${escXml(cityCode || '')}</cbc:ID>
          <cbc:CityName>${escXml(city || '')}</cbc:CityName>
          <cac:Country>
            <cbc:IdentificationCode>${country}</cbc:IdentificationCode>
          </cac:Country>
        </cac:RegistrationAddress>
        <cac:TaxScheme>
          <cbc:ID>01</cbc:ID>
          <cbc:Name>IVA</cbc:Name>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escXml(name)}</cbc:RegistrationName>
        <cbc:CompanyID schemeAgencyID="195"
          schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"
          schemeID="${schemeID}" schemeName="${schemeID === '31' ? 'NIT' : 'CC'}">${escXml(nit)}</cbc:CompanyID>
        ${address ? `<cac:CorporateRegistrationScheme>
          <cbc:ID>${escXml(nit)}</cbc:ID>
        </cac:CorporateRegistrationScheme>` : ''}
      </cac:PartyLegalEntity>
      ${email || phone ? `<cac:Contact>
        ${email ? `<cbc:ElectronicMail>${escXml(email)}</cbc:ElectronicMail>` : ''}
        ${phone ? `<cbc:Telephone>${escXml(phone)}</cbc:Telephone>` : ''}
      </cac:Contact>` : ''}
    </cac:Party>`;
}

/* ──────────────────────────────────────────────────────────
 * Tax totals helper
 * ────────────────────────────────────────────────────────── */
function taxTotalsXml(items) {
  // Agrupar impuestos por tipo y porcentaje
  const groups = {};
  for (const item of items) {
    const pct = item.tax_percentage || 0;
    const taxId = pct === 0 ? '01' : pct === 5 ? '01' : '01'; // IVA siempre 01
    const key = `${taxId}_${pct}`;
    if (!groups[key]) {
      groups[key] = { taxId, pct, taxableAmount: 0, taxAmount: 0, name: 'IVA' };
    }
    groups[key].taxableAmount += Number(item.subtotal || 0);
    groups[key].taxAmount += Number(item.tax_amount || 0);
  }

  const totalIva = Object.values(groups).reduce((s, g) => s + g.taxAmount, 0);

  const subtotals = Object.values(groups).map(g => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="COP">${g.taxableAmount.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="COP">${g.taxAmount.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:Percent>${g.pct.toFixed(2)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>${g.taxId}</cbc:ID>
          <cbc:Name>${g.name}</cbc:Name>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`).join('');

  // ICA y INC siempre en 0 (requeridos por DIAN)
  const icaIcn = `
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">0.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">0.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">0.00</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>0.000</cbc:Percent>
          <cac:TaxScheme><cbc:ID>03</cbc:ID><cbc:Name>ICA</cbc:Name></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">0.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">0.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">0.00</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>0.00</cbc:Percent>
          <cac:TaxScheme><cbc:ID>04</cbc:ID><cbc:Name>INC</cbc:Name></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>`;

  return `
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="COP">${totalIva.toFixed(2)}</cbc:TaxAmount>
    ${subtotals}
  </cac:TaxTotal>
  ${icaIcn}`;
}

/* ──────────────────────────────────────────────────────────
 * Invoice lines
 * ────────────────────────────────────────────────────────── */
function invoiceLinesXml(items) {
  return items.map((item, idx) => {
    const lineNum = idx + 1;
    const taxPct = Number(item.tax_percentage || 0);
    const taxAmt = Number(item.tax_amount || 0);
    const subtotal = Number(item.subtotal || 0);
    const unitPrice = Number(item.unit_price || 0);
    const qty = Number(item.quantity || 1);
    const discPct = Number(item.discount_percentage || 0);
    const discAmt = Number(item.discount_amount || 0);

    const discountBlock = discAmt > 0 ? `
      <cac:AllowanceCharge>
        <cbc:ID>1</cbc:ID>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>Descuento</cbc:AllowanceChargeReason>
        <cbc:MultiplierFactorNumeric>${discPct.toFixed(2)}</cbc:MultiplierFactorNumeric>
        <cbc:Amount currencyID="COP">${discAmt.toFixed(2)}</cbc:Amount>
        <cbc:BaseAmount currencyID="COP">${(unitPrice * qty).toFixed(2)}</cbc:BaseAmount>
      </cac:AllowanceCharge>` : '';

    return `
  <cac:InvoiceLine>
    <cbc:ID>${lineNum}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${item.item_type === 'service' ? 'ZZ' : 'EA'}">${qty.toFixed(6)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">${subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:FreeOfChargeIndicator>false</cbc:FreeOfChargeIndicator>
    ${discountBlock}
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">${taxAmt.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">${subtotal.toFixed(2)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">${taxAmt.toFixed(2)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>${taxPct.toFixed(2)}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>01</cbc:ID>
            <cbc:Name>IVA</cbc:Name>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>${escXml(item.product_name || 'Producto/Servicio')}</cbc:Description>
      <cac:StandardItemIdentification>
        <cbc:ID schemeID="999" schemeName="EAN">${escXml(item.product_sku || String(lineNum))}</cbc:ID>
      </cac:StandardItemIdentification>
      <cac:AdditionalItemProperty>
        <cbc:Name>Marca</cbc:Name>
        <cbc:Value>N/A</cbc:Value>
      </cac:AdditionalItemProperty>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="COP">${unitPrice.toFixed(2)}</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="${item.item_type === 'service' ? 'ZZ' : 'EA'}">${qty.toFixed(6)}</cbc:BaseQuantity>
    </cac:Price>
  </cac:InvoiceLine>`;
  }).join('');
}

/* ──────────────────────────────────────────────────────────
 * Main: buildInvoiceXml
 * ────────────────────────────────────────────────────────── */
function buildInvoiceXml({
  // ─── Factura
  invoiceNumber,          // ej: SETP990000001
  issueDate,              // YYYY-MM-DD
  issueTime,              // HH:MM:SS-05:00
  invoiceTypeCode = '01', // 01=Factura venta, 02=Exportación, 03=Contingencia
  notes,
  items,                  // array de SaleItem
  subtotal, taxAmount, discountAmount, totalAmount,
  paymentMeans = '1',     // 1=Contado, 2=Crédito
  paymentMeansCode = '10',// 10=Efectivo, 20=Crédito, 42=Transferencia, 47=Tarjeta débito, 48=Tarjeta crédito

  // ─── Emisor (tenant)
  supplierNit, supplierDv, supplierName, supplierTradeName,
  supplierAddress, supplierCity, supplierCityCode, supplierDept,
  supplierPhone, supplierEmail,
  supplierRegimeCode = '48', // 48=Responsable de IVA
  supplierTaxLevelCode = 'R-99-PN',
  supplierSchemeID = '31',

  // ─── Adquiriente (cliente)
  buyerNit, buyerName, buyerAddress, buyerCity, buyerCityCode, buyerDept,
  buyerPhone, buyerEmail,
  buyerSchemeID = '13', // 13=CC, 31=NIT, 22=Pasaporte
  buyerTaxLevelCode = 'R-99-PN',
  buyerRegimeCode = '49', // 49=No responsable de IVA

  // ─── Config DIAN
  softwareId, softwareProviderId, softwarePin,
  technicalKey,
  resolutionNumber, resolutionStartDate, resolutionEndDate,
  resolutionPrefix, resolutionFrom, resolutionTo,
  environment = 'test', // 'test' | 'production'
  customizationID = '10', // 10=Estándar, 09=Mandatos

  // ─── Firma (se inserta en placeholder después de firmar)
  signaturePlaceholder = '',
}) {
  const profileExecutionID = environment === 'production' ? '1' : '2';
  const nitAdq = buyerNit || 'Consumidor Final';
  const nitConsumidorFinal = '222222222222';
  const resolvedBuyerNit = buyerNit || nitConsumidorFinal;

  const secCode = buildSoftwareSecurityCode(softwareId, softwarePin, invoiceNumber);

  const cufe = buildCufe({
    invoiceNumber,
    issueDate,
    issueTime,
    subtotal,               // ValFac = base imponible sin IVA
    totalAmount,            // ValTot = total con IVA
    taxAmount19: taxAmount,
    taxAmount5: 0,
    taxAmount0: 0,
    nitEmisor: supplierNit,
    nitAdquiriente: resolvedBuyerNit,
    technicalKey,
  });

  const qrCode = buildQrCode({
    invoiceNumber,
    nitEmisor: supplierNit,
    nitAdquiriente: resolvedBuyerNit,
    issueDate,
    totalAmount,
    cufe,
    environment,
  });

  const taxableBase = Number(subtotal || 0);
  const lineCount = items.length;
  const lineExtension = Number(subtotal || 0);
  const taxExclusive = lineExtension;
  const taxInclusive = Number(totalAmount || 0);
  const payable = taxInclusive;

  // Nota CUFE: concatenación exacta igual al input del hash SHA384
  // Formato: NumFac+FecFac+HorFac+ValFac+01+ValIVA+04+ValINC+03+ValICA+ValTot+NitOFE+NumAdq+ClaveT
  const cufeNote = [
    invoiceNumber, issueDate, issueTime,
    Number(subtotal || 0).toFixed(2),          // ValFac = base imponible
    '01', Number(taxAmount || 0).toFixed(2),   // IVA
    '04', '0.00',                               // INC
    '03', '0.00',                               // ICA
    Number(totalAmount || 0).toFixed(2),        // ValTot
    supplierNit, resolvedBuyerNit, technicalKey
    // TipoFe NO va — confirmado por DIAN V19
  ].join('');

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
  xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1"
  xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"
  xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2
    http://docs.oasis-open.org/ubl/os-UBL-2.1/xsd/maindoc/UBL-Invoice-2.1.xsd">

  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sts:DianExtensions>
          <sts:InvoiceControl>
            <sts:InvoiceAuthorization>${resolutionNumber}</sts:InvoiceAuthorization>
            <sts:AuthorizationPeriod>
              <cbc:StartDate>${resolutionStartDate}</cbc:StartDate>
              <cbc:EndDate>${resolutionEndDate}</cbc:EndDate>
            </sts:AuthorizationPeriod>
            <sts:AuthorizedInvoices>
              <sts:Prefix>${resolutionPrefix}</sts:Prefix>
              <sts:From>${resolutionFrom}</sts:From>
              <sts:To>${resolutionTo}</sts:To>
            </sts:AuthorizedInvoices>
          </sts:InvoiceControl>
          <sts:InvoiceSource>
            <cbc:IdentificationCode
              listAgencyID="6"
              listAgencyName="United Nations Economic Commission for Europe"
              listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>
          </sts:InvoiceSource>
          <sts:SoftwareProvider>
            <sts:ProviderID
              schemeAgencyID="195"
              schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"
              schemeID="4" schemeName="31">${softwareProviderId}</sts:ProviderID>
            <sts:SoftwareID
              schemeAgencyID="195"
              schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${softwareId}</sts:SoftwareID>
          </sts:SoftwareProvider>
          <sts:SoftwareSecurityCode
            schemeAgencyID="195"
            schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${secCode}</sts:SoftwareSecurityCode>
          <sts:AuthorizationProvider>
            <sts:AuthorizationProviderID
              schemeAgencyID="195"
              schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"
              schemeID="4" schemeName="31">800197268</sts:AuthorizationProviderID>
          </sts:AuthorizationProvider>
          <sts:QRCode>${qrCode}</sts:QRCode>
        </sts:DianExtensions>
      </ext:ExtensionContent>
    </ext:UBLExtension>
    ${signaturePlaceholder ? `<ext:UBLExtension><ext:ExtensionContent>${signaturePlaceholder}</ext:ExtensionContent></ext:UBLExtension>` : '<ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension>'}
  </ext:UBLExtensions>

  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>${customizationID}</cbc:CustomizationID>
  <cbc:ProfileID>DIAN 2.1</cbc:ProfileID>
  <cbc:ProfileExecutionID>${profileExecutionID}</cbc:ProfileExecutionID>
  <cbc:ID>${invoiceNumber}</cbc:ID>
  <cbc:UUID schemeID="${profileExecutionID}" schemeName="CUFE-SHA384">${cufe}</cbc:UUID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode>${invoiceTypeCode}</cbc:InvoiceTypeCode>
  <cbc:Note>${cufeNote}</cbc:Note>
  <cbc:DocumentCurrencyCode
    listAgencyID="6"
    listAgencyName="United Nations Economic Commission for Europe"
    listID="ISO 4217 Alpha">COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${lineCount}</cbc:LineCountNumeric>

  <cac:AccountingSupplierParty>
    <cbc:AdditionalAccountID>1</cbc:AdditionalAccountID>
    ${partyXml({
      nit: supplierNit,
      name: supplierName,
      tradeName: supplierTradeName,
      regimeCode: supplierRegimeCode,
      liabilityCode: '7',
      taxLevelCode: supplierTaxLevelCode,
      address: supplierAddress,
      city: supplierCity,
      cityCode: supplierCityCode,
      dept: supplierDept,
      email: supplierEmail,
      phone: supplierPhone,
      schemeID: supplierSchemeID,
    })}
  </cac:AccountingSupplierParty>

  <cac:AccountingCustomerParty>
    <cbc:AdditionalAccountID>1</cbc:AdditionalAccountID>
    ${partyXml({
      nit: resolvedBuyerNit,
      name: buyerName || 'Consumidor Final',
      regimeCode: buyerRegimeCode,
      taxLevelCode: buyerTaxLevelCode,
      address: buyerAddress,
      city: buyerCity,
      cityCode: buyerCityCode,
      dept: buyerDept,
      email: buyerEmail,
      phone: buyerPhone,
      schemeID: buyerSchemeID,
    })}
  </cac:AccountingCustomerParty>

  <cac:PaymentMeans>
    <cbc:ID>${paymentMeans}</cbc:ID>
    <cbc:PaymentMeansCode>${paymentMeansCode}</cbc:PaymentMeansCode>
    <cbc:PaymentDueDate>${issueDate}</cbc:PaymentDueDate>
  </cac:PaymentMeans>

  ${taxTotalsXml(items)}

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="COP">${lineExtension.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="COP">${taxExclusive.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="COP">${taxInclusive.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="COP">${Number(discountAmount || 0).toFixed(2)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="COP">${payable.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>

  ${invoiceLinesXml(items)}
</Invoice>`;

  return { xml, cufe, qrCode, securityCode: secCode };
}

/* ──────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────── */
function escXml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getColombiaDateTime() {
  const now = new Date();
  // Colombia UTC-5
  const offset = -5 * 60;
  const local = new Date(now.getTime() + offset * 60000);
  const pad = n => String(n).padStart(2, '0');
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}-05:00`;
  return { date, time };
}

module.exports = {
  buildInvoiceXml,
  buildCreditNoteXml,
  buildDebitNoteXml,
  buildCufe,
  buildCude,
  buildSoftwareSecurityCode,
  buildQrCode,
  getColombiaDateTime,
  escXml,
};
/* ──────────────────────────────────────────────────────────
 * CUDE (Código Único de Nota Crédito/Débito) – SHA-384
 * Mismo algoritmo que CUFE pero con la llave técnica del
 * documento de referencia y el tipo de nota (91=NC, 92=ND)
 * ────────────────────────────────────────────────────────── */
function buildCude({ noteNumber, issueDate, issueTime,
  subtotal, totalAmount, taxAmount19, taxAmount5, taxAmount0,
  nitEmisor, nitAdquiriente, technicalKey, noteType }) {
  const fmt2 = (n) => Number(n || 0).toFixed(2);
  const plain = [
    noteNumber, issueDate, issueTime,
    fmt2(subtotal),
    '01', fmt2(taxAmount19),
    '04', fmt2(taxAmount5),
    '03', fmt2(taxAmount0),
    fmt2(totalAmount),
    nitEmisor, nitAdquiriente, technicalKey,
  ].join('');
  return crypto.createHash('sha384').update(plain).digest('hex');
}

/* ──────────────────────────────────────────────────────────
 * buildCreditNoteXml — Nota Crédito UBL 2.1 (tipo 91)
 *
 * Parámetros adicionales vs buildInvoiceXml:
 *   noteNumber       — número de la NC, ej. NC000001
 *   correctedInvoiceNumber — CUFE de la factura que corrige
 *   correctedInvoiceCufe
 *   correctedInvoiceDate
 *   discrepancyCode  — código de corrección (1–7, ver AT)
 *   discrepancyDesc  — descripción del motivo
 * ────────────────────────────────────────────────────────── */
function buildCreditNoteXml({
  noteNumber, issueDate, issueTime, notes,
  items, subtotal, taxAmount, discountAmount = 0, totalAmount,
  paymentMeans = '1', paymentMeansCode = '10',

  supplierNit, supplierDv, supplierName, supplierTradeName,
  supplierAddress, supplierCity, supplierCityCode, supplierDept,
  supplierPhone, supplierEmail,
  supplierRegimeCode = '48', supplierTaxLevelCode = 'R-99-PN', supplierSchemeID = '31',

  buyerNit, buyerName, buyerAddress, buyerCity, buyerCityCode, buyerDept,
  buyerPhone, buyerEmail,
  buyerSchemeID = '13', buyerTaxLevelCode = 'R-99-PN', buyerRegimeCode = '49',

  softwareId, softwareProviderId, softwarePin, technicalKey,
  resolutionNumber, resolutionStartDate, resolutionEndDate,
  resolutionPrefix, resolutionFrom, resolutionTo,
  environment = 'test', customizationID = '22',

  // Referencia a la factura corregida
  correctedInvoiceNumber, correctedInvoiceCufe, correctedInvoiceDate,
  discrepancyCode = '1',
  discrepancyDesc = 'Devolución parcial de los bienes',

  signaturePlaceholder = '',
}) {
  const profileExecutionID = environment === 'production' ? '1' : '2';
  const resolvedBuyerNit   = buyerNit || '222222222222';
  const secCode = buildSoftwareSecurityCode(softwareId, softwarePin, noteNumber);
  const cude = buildCude({
    noteNumber, issueDate, issueTime,
    subtotal, totalAmount,
    taxAmount19: taxAmount, taxAmount5: 0, taxAmount0: 0,
    nitEmisor: supplierNit, nitAdquiriente: resolvedBuyerNit,
    technicalKey, noteType: '91',
  });

  const qrBase = environment === 'production'
    ? 'https://catalogo-vpfe.dian.gov.co'
    : 'https://catalogo-vpfe-hab.dian.gov.co';
  const emDate = issueDate.replace(/-/g, '');
  const partition = `co|${emDate.substring(4, 6)}|${cude.substring(0, 2)}`;
  const qrCode = [
    `NroFactura=${noteNumber}`,
    `NitFacturador=${supplierNit}`,
    `NitAdquiriente=${resolvedBuyerNit}`,
    `FechaFactura=${issueDate}`,
    `ValorTotalFactura=${Number(totalAmount).toFixed(2)}`,
    `CUFE=${cude}`,
    `URL=${qrBase}/Document/FindDocument?documentKey=${cude}&partitionKey=${partition}&emissionDate=${emDate}`,
  ].join('\n\t\t\t\t\t\t\t\t');

  const fmt2 = (n) => Number(n || 0).toFixed(2);
  const supplierParty = partyXml({
    nit: supplierNit, name: supplierName, tradeName: supplierTradeName,
    regimeCode: supplierRegimeCode, liabilityCode: supplierRegimeCode,
    taxLevelCode: supplierTaxLevelCode, address: supplierAddress,
    city: supplierCity, cityCode: supplierCityCode, dept: supplierDept,
    email: supplierEmail, phone: supplierPhone, schemeID: supplierSchemeID,
  });
  const buyerParty = partyXml({
    nit: resolvedBuyerNit, name: buyerName || 'Consumidor Final',
    taxLevelCode: buyerTaxLevelCode, address: buyerAddress || '',
    city: buyerCity || '', cityCode: buyerCityCode || '11001',
    dept: buyerDept || '', email: buyerEmail || '', phone: buyerPhone || '',
    schemeID: buyerSchemeID,
  });

  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
  xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sts:DianExtensions>
          <sts:InvoiceControl>
            <sts:InvoiceAuthorization>${escXml(resolutionNumber)}</sts:InvoiceAuthorization>
            <sts:AuthorizationPeriod>
              <cbc:StartDate>${resolutionStartDate}</cbc:StartDate>
              <cbc:EndDate>${resolutionEndDate}</cbc:EndDate>
            </sts:AuthorizationPeriod>
            <sts:AuthorizedInvoices>
              <sts:Prefix>${escXml(resolutionPrefix)}</sts:Prefix>
              <sts:From>${resolutionFrom}</sts:From>
              <sts:To>${resolutionTo}</sts:To>
            </sts:AuthorizedInvoices>
          </sts:InvoiceControl>
          <sts:InvoiceSource>
            <cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>
          </sts:InvoiceSource>
          <sts:SoftwareProvider>
            <sts:ProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="4" schemeName="31">${escXml(softwareProviderId || supplierNit)}</sts:ProviderID>
            <sts:SoftwareID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${escXml(softwareId)}</sts:SoftwareID>
          </sts:SoftwareProvider>
          <sts:SoftwareSecurityCode schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${secCode}</sts:SoftwareSecurityCode>
          <sts:AuthorizationProvider>
            <sts:AuthorizationProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="4" schemeName="31">800197268</sts:AuthorizationProviderID>
          </sts:AuthorizationProvider>
          <sts:QRCode>${escXml(qrCode)}</sts:QRCode>
        </sts:DianExtensions>
      </ext:ExtensionContent>
    </ext:UBLExtension>
    <ext:UBLExtension>
      <ext:ExtensionContent>${signaturePlaceholder}</ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>${customizationID}</cbc:CustomizationID>
  <cbc:ProfileID>DIAN 2.1</cbc:ProfileID>
  <cbc:ProfileExecutionID>${profileExecutionID}</cbc:ProfileExecutionID>
  <cbc:ID>${escXml(noteNumber)}</cbc:ID>
  <cbc:UUID schemeID="CUDE-SHA384" schemeName="CUDE">${cude}</cbc:UUID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:CreditNoteTypeCode listAgencyID="195" listAgencyName="CO, DIAN" listSchemeURI="https://www.dian.gov.co/contratos/facturaelectronica/v1/InvoiceType">91</cbc:CreditNoteTypeCode>
  ${notes ? `<cbc:Note>${escXml(notes)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${items.length}</cbc:LineCountNumeric>
  <cac:DiscrepancyResponse>
    <cbc:ReferenceID>${escXml(correctedInvoiceNumber)}</cbc:ReferenceID>
    <cbc:ResponseCode>${discrepancyCode}</cbc:ResponseCode>
    <cbc:Description>${escXml(discrepancyDesc)}</cbc:Description>
  </cac:DiscrepancyResponse>
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${escXml(correctedInvoiceNumber)}</cbc:ID>
      <cbc:UUID>${escXml(correctedInvoiceCufe)}</cbc:UUID>
      <cbc:IssueDate>${correctedInvoiceDate}</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  <cac:AccountingSupplierParty>
    <cbc:AdditionalAccountID>${supplierSchemeID === '31' ? '1' : '2'}</cbc:AdditionalAccountID>
    ${supplierParty}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cbc:AdditionalAccountID>${buyerSchemeID === '31' ? '1' : '2'}</cbc:AdditionalAccountID>
    ${buyerParty}
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:ID>${paymentMeans}</cbc:ID>
    <cbc:PaymentMeansCode>${paymentMeansCode}</cbc:PaymentMeansCode>
    <cbc:PaymentDueDate>${issueDate}</cbc:PaymentDueDate>
  </cac:PaymentMeans>
  ${taxTotalsXml(items)}
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="COP">${fmt2(subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="COP">${fmt2(subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="COP">${fmt2(totalAmount)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="COP">${fmt2(discountAmount)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="COP">${fmt2(totalAmount)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${creditNoteLinesXml(items)}
</CreditNote>`,
    cude,
    qrCode,
  };
}

/* ──────────────────────────────────────────────────────────
 * buildDebitNoteXml — Nota Débito UBL 2.1 (tipo 92)
 * ────────────────────────────────────────────────────────── */
function buildDebitNoteXml({
  noteNumber, issueDate, issueTime, notes,
  items, subtotal, taxAmount, discountAmount = 0, totalAmount,
  paymentMeans = '1', paymentMeansCode = '10',

  supplierNit, supplierDv, supplierName, supplierTradeName,
  supplierAddress, supplierCity, supplierCityCode, supplierDept,
  supplierPhone, supplierEmail,
  supplierRegimeCode = '48', supplierTaxLevelCode = 'R-99-PN', supplierSchemeID = '31',

  buyerNit, buyerName, buyerAddress, buyerCity, buyerCityCode, buyerDept,
  buyerPhone, buyerEmail,
  buyerSchemeID = '13', buyerTaxLevelCode = 'R-99-PN', buyerRegimeCode = '49',

  softwareId, softwareProviderId, softwarePin, technicalKey,
  resolutionNumber, resolutionStartDate, resolutionEndDate,
  resolutionPrefix, resolutionFrom, resolutionTo,
  environment = 'test', customizationID = '22',

  correctedInvoiceNumber, correctedInvoiceCufe, correctedInvoiceDate,
  discrepancyCode = '1',
  discrepancyDesc = 'Intereses',

  signaturePlaceholder = '',
}) {
  const profileExecutionID = environment === 'production' ? '1' : '2';
  const resolvedBuyerNit   = buyerNit || '222222222222';
  const secCode = buildSoftwareSecurityCode(softwareId, softwarePin, noteNumber);
  const cude = buildCude({
    noteNumber, issueDate, issueTime,
    subtotal, totalAmount,
    taxAmount19: taxAmount, taxAmount5: 0, taxAmount0: 0,
    nitEmisor: supplierNit, nitAdquiriente: resolvedBuyerNit,
    technicalKey, noteType: '92',
  });

  const qrBase = environment === 'production'
    ? 'https://catalogo-vpfe.dian.gov.co'
    : 'https://catalogo-vpfe-hab.dian.gov.co';
  const emDate = issueDate.replace(/-/g, '');
  const partition = `co|${emDate.substring(4, 6)}|${cude.substring(0, 2)}`;
  const qrCode = [
    `NroFactura=${noteNumber}`,
    `NitFacturador=${supplierNit}`,
    `NitAdquiriente=${resolvedBuyerNit}`,
    `FechaFactura=${issueDate}`,
    `ValorTotalFactura=${Number(totalAmount).toFixed(2)}`,
    `CUFE=${cude}`,
    `URL=${qrBase}/Document/FindDocument?documentKey=${cude}&partitionKey=${partition}&emissionDate=${emDate}`,
  ].join('\n\t\t\t\t\t\t\t\t');

  const fmt2 = (n) => Number(n || 0).toFixed(2);
  const supplierParty = partyXml({
    nit: supplierNit, name: supplierName, tradeName: supplierTradeName,
    regimeCode: supplierRegimeCode, liabilityCode: supplierRegimeCode,
    taxLevelCode: supplierTaxLevelCode, address: supplierAddress,
    city: supplierCity, cityCode: supplierCityCode, dept: supplierDept,
    email: supplierEmail, phone: supplierPhone, schemeID: supplierSchemeID,
  });
  const buyerParty = partyXml({
    nit: resolvedBuyerNit, name: buyerName || 'Consumidor Final',
    taxLevelCode: buyerTaxLevelCode, address: buyerAddress || '',
    city: buyerCity || '', cityCode: buyerCityCode || '11001',
    dept: buyerDept || '', email: buyerEmail || '', phone: buyerPhone || '',
    schemeID: buyerSchemeID,
  });

  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<DebitNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
  xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sts:DianExtensions>
          <sts:InvoiceControl>
            <sts:InvoiceAuthorization>${escXml(resolutionNumber)}</sts:InvoiceAuthorization>
            <sts:AuthorizationPeriod>
              <cbc:StartDate>${resolutionStartDate}</cbc:StartDate>
              <cbc:EndDate>${resolutionEndDate}</cbc:EndDate>
            </sts:AuthorizationPeriod>
            <sts:AuthorizedInvoices>
              <sts:Prefix>${escXml(resolutionPrefix)}</sts:Prefix>
              <sts:From>${resolutionFrom}</sts:From>
              <sts:To>${resolutionTo}</sts:To>
            </sts:AuthorizedInvoices>
          </sts:InvoiceControl>
          <sts:InvoiceSource>
            <cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>
          </sts:InvoiceSource>
          <sts:SoftwareProvider>
            <sts:ProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="4" schemeName="31">${escXml(softwareProviderId || supplierNit)}</sts:ProviderID>
            <sts:SoftwareID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${escXml(softwareId)}</sts:SoftwareID>
          </sts:SoftwareProvider>
          <sts:SoftwareSecurityCode schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${secCode}</sts:SoftwareSecurityCode>
          <sts:AuthorizationProvider>
            <sts:AuthorizationProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="4" schemeName="31">800197268</sts:AuthorizationProviderID>
          </sts:AuthorizationProvider>
          <sts:QRCode>${escXml(qrCode)}</sts:QRCode>
        </sts:DianExtensions>
      </ext:ExtensionContent>
    </ext:UBLExtension>
    <ext:UBLExtension>
      <ext:ExtensionContent>${signaturePlaceholder}</ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>${customizationID}</cbc:CustomizationID>
  <cbc:ProfileID>DIAN 2.1</cbc:ProfileID>
  <cbc:ProfileExecutionID>${profileExecutionID}</cbc:ProfileExecutionID>
  <cbc:ID>${escXml(noteNumber)}</cbc:ID>
  <cbc:UUID schemeID="CUDE-SHA384" schemeName="CUDE">${cude}</cbc:UUID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  ${notes ? `<cbc:Note>${escXml(notes)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${items.length}</cbc:LineCountNumeric>
  <cac:DiscrepancyResponse>
    <cbc:ReferenceID>${escXml(correctedInvoiceNumber)}</cbc:ReferenceID>
    <cbc:ResponseCode>${discrepancyCode}</cbc:ResponseCode>
    <cbc:Description>${escXml(discrepancyDesc)}</cbc:Description>
  </cac:DiscrepancyResponse>
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${escXml(correctedInvoiceNumber)}</cbc:ID>
      <cbc:UUID>${escXml(correctedInvoiceCufe)}</cbc:UUID>
      <cbc:IssueDate>${correctedInvoiceDate}</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  <cac:AccountingSupplierParty>
    <cbc:AdditionalAccountID>${supplierSchemeID === '31' ? '1' : '2'}</cbc:AdditionalAccountID>
    ${supplierParty}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cbc:AdditionalAccountID>${buyerSchemeID === '31' ? '1' : '2'}</cbc:AdditionalAccountID>
    ${buyerParty}
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:ID>${paymentMeans}</cbc:ID>
    <cbc:PaymentMeansCode>${paymentMeansCode}</cbc:PaymentMeansCode>
    <cbc:PaymentDueDate>${issueDate}</cbc:PaymentDueDate>
  </cac:PaymentMeans>
  ${taxTotalsXml(items)}
  <cac:RequestedMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="COP">${fmt2(subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="COP">${fmt2(subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="COP">${fmt2(totalAmount)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="COP">${fmt2(discountAmount)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="COP">${fmt2(totalAmount)}</cbc:PayableAmount>
  </cac:RequestedMonetaryTotal>
  ${debitNoteLinesXml(items)}
</DebitNote>`,
    cude,
    qrCode,
  };
}

/* ──────────────────────────────────────────────────────────
 * Líneas de Nota Crédito (CreditNoteLine)
 * ────────────────────────────────────────────────────────── */
function creditNoteLinesXml(items) {
  const fmt2 = (n) => Number(n || 0).toFixed(2);
  return items.map((it, idx) => {
    const lineTotal = Number(it.subtotal || (it.quantity * it.unit_price) || 0);
    const taxRate   = Number(it.tax_rate || 0);
    const taxAmt    = Number(it.tax_amount || 0);
    const unitCode  = it.unit_code || 'EA';
    return `
  <cac:CreditNoteLine>
    <cbc:ID>${idx + 1}</cbc:ID>
    <cbc:CreditedQuantity unitCode="${unitCode}">${Number(it.quantity || 1).toFixed(2)}</cbc:CreditedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">${fmt2(lineTotal)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">${fmt2(taxAmt)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">${fmt2(lineTotal)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">${fmt2(taxAmt)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>${taxRate.toFixed(2)}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>01</cbc:ID>
            <cbc:Name>IVA</cbc:Name>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>${escXml(it.description || it.name || 'Producto')}</cbc:Description>
      <cac:StandardItemIdentification>
        <cbc:ID schemeID="999">${escXml(it.id || String(idx + 1))}</cbc:ID>
      </cac:StandardItemIdentification>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="COP">${fmt2(it.unit_price || 0)}</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="${unitCode}">1.00</cbc:BaseQuantity>
    </cac:Price>
  </cac:CreditNoteLine>`;
  }).join('');
}

/* ──────────────────────────────────────────────────────────
 * Líneas de Nota Débito (DebitNoteLine)
 * ────────────────────────────────────────────────────────── */
function debitNoteLinesXml(items) {
  const fmt2 = (n) => Number(n || 0).toFixed(2);
  return items.map((it, idx) => {
    const lineTotal = Number(it.subtotal || (it.quantity * it.unit_price) || 0);
    const taxRate   = Number(it.tax_rate || 0);
    const taxAmt    = Number(it.tax_amount || 0);
    const unitCode  = it.unit_code || 'EA';
    return `
  <cac:DebitNoteLine>
    <cbc:ID>${idx + 1}</cbc:ID>
    <cbc:DebitedQuantity unitCode="${unitCode}">${Number(it.quantity || 1).toFixed(2)}</cbc:DebitedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">${fmt2(lineTotal)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">${fmt2(taxAmt)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">${fmt2(lineTotal)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">${fmt2(taxAmt)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>${taxRate.toFixed(2)}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>01</cbc:ID>
            <cbc:Name>IVA</cbc:Name>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>${escXml(it.description || it.name || 'Producto')}</cbc:Description>
      <cac:StandardItemIdentification>
        <cbc:ID schemeID="999">${escXml(it.id || String(idx + 1))}</cbc:ID>
      </cac:StandardItemIdentification>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="COP">${fmt2(it.unit_price || 0)}</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="${unitCode}">1.00</cbc:BaseQuantity>
    </cac:Price>
  </cac:DebitNoteLine>`;
  }).join('');
}