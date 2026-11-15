// Nómina electrónica contra la caja de herramientas oficial de la DIAN
// (Anexo Técnico V1.0, XSD NominaIndividual/NominaIndividualDeAjuste 1.0.6
// y XML de ejemplo). Cada caso fue un rechazo seguro antes del 2026-11-15:
// firma fuera de ext:ExtensionContent, SchemaLocation y SegundoApellido
// ausentes, Eliminar con elementos que su XSD no admite y CUNE de Eliminar
// con los totales reales. Validado también contra el XSD con lxml.
const crypto = require('crypto');

jest.mock('../services/dian/dianApiService', () => ({
  sendNominaSync: jest.fn(async () => ({ isValid: true, via: 'sync' })),
  sendTestSetAsync: jest.fn(async () => ({ isValid: true, via: 'testset' })),
  getStatus: jest.fn(),
}));
jest.mock('../services/dian/dianKitAdapter', () => ({ getKit: () => ({ config: { certificateData: {} } }) }));
jest.mock('@dian-kit/core', () => ({ signXml: jest.fn(async ({ xml }) => ({ signedXml: xml })) }));

const { buildPayrollXml, buildPayrollAdjustmentXml } = require('../services/dian/payrollXmlBuilder');
const dianApiService = require('../services/dian/dianApiService');
const { assertPayrollDianConfig, submitPayrollDocument } = require('../services/dian/payrollDianAdapter');

const cfg = {
  environment: 'test', nit: '900373979', dv: '1', company_name: 'TALLER DEMO SAS', dept: '11', city_code: '11001', address: 'Calle 1 # 2-3',
  software_id_nomina: 'fa326ca7-c1f8-40d3-a6fc-24d7c1040607', software_pin_nomina: '12345',
  certificate_p12_base64: 'MIIB', certificate_password: 'x',
};
const tenant = { id: 't1', company_name: 'TALLER DEMO SAS', dian_config: cfg };
const employee = {
  document_type: '13', document_number: '1020304050', first_name: 'Ana', other_names: null, first_surname: 'Pérez', second_surname: null,
  worker_type: '01', worker_subtype: '00', high_risk_pension: false, contract_type: '1', salary_type: 'ordinario', base_salary: '2500000.00',
  employee_code: '002', payment_method: 'transfer', payment_form: '1', bank_name: 'Bancolombia', account_type: 'savings', account_number: '123',
  hire_date: '2026-02-01', work_country: 'CO', work_city_code: null, work_address: null,
};
const period = { period_type: 'quincenal', start_date: '2026-11-16', end_date: '2026-11-30', payment_date: '2026-11-30' };
const liquidation = {
  devengados: { basico: { diasTrabajados: 15, sueldoTrabajado: 1250000 }, transporte: { auxilioTransporte: 249094.99999999997 } },
  deducciones: { salud: { porcentaje: 4, deduccion: 50000 }, fondoPension: { porcentaje: 4, deduccion: 50000 } },
  devengadosTotal: 1499095, deduccionesTotal: 100000, tiempoLaboradoDias: 15, softwareSecurityCode: 'abc', paymentDates: ['2026-11-30'],
};
const numbering = { prefix: 'NE', consecutivo: '101' };
const attr = (xml, el, name) => (xml.match(new RegExp(`<${el}\\b[^>]*\\s${name}="([^"]*)"`)) || [])[1];
const sha384 = (s) => crypto.createHash('sha384').update(s).digest('hex');

describe('NominaIndividual (XSD 1.0.6 y Anexo V1.0)', () => {
  const { xml, cune } = buildPayrollXml({ tenant, employee, period, liquidation, numbering });

  it('deja la marca de la firma DENTRO de ext:ExtensionContent y declara ext en la raíz', () => {
    expect(xml).toContain('<ext:ExtensionContent><!--FIRMA DIGITAL XAdES-BES AQUÍ--></ext:ExtensionContent>');
    expect(xml).toMatch(/<NominaIndividual[^>]*xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"/);
    expect(xml).not.toContain('<ext:UBLExtensions xmlns:ext=');
  });

  it('lleva el atributo SchemaLocation que exige el XSD', () => {
    expect(xml).toMatch(/<NominaIndividual[^>]*\sSchemaLocation=""/);
  });

  it('SegundoApellido del trabajador va aunque esté vacío (NIE048, 1..1)', () => {
    expect(attr(xml, 'Trabajador', 'SegundoApellido')).toBe('');
  });

  it('QR del catálogo de habilitación en pruebas', () => {
    expect(xml).toContain(`<CodigoQR>https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${cune}</CodigoQR>`);
  });

  it('CUNE = SHA-384 de los valores que el Anexo toma del propio XML (8.1.1.4)', () => {
    const plain = attr(xml, 'NumeroSecuenciaXML', 'Numero') + attr(xml, 'InformacionGeneral', 'FechaGen') + attr(xml, 'InformacionGeneral', 'HoraGen')
      + '1499095.00' + '100000.00' + '1399095.00' + '900373979' + '1020304050' + '102' + '12345' + '2';
    expect(cune).toBe(sha384(plain));
  });
});

describe('NominaIndividualDeAjuste', () => {
  const predecessor = { numeroPred: 'NE101', cunePred: 'a'.repeat(96), fechaGenPred: '2026-11-15' };

  it('Reemplazar repite el documento completo con TipoXML 103', () => {
    const { xml } = buildPayrollAdjustmentXml({ tenant, employee, period, liquidation, numbering: { prefix: 'NA', consecutivo: '1' }, adjustmentType: 'replace', predecessor });
    expect(xml).toContain('<Reemplazar>');
    expect(xml).toContain('<Trabajador ');
    expect(xml).toContain('<DevengadosTotal>1499095.00</DevengadosTotal>');
    expect(attr(xml, 'InformacionGeneral', 'TipoXML')).toBe('103');
  });

  it('Eliminar solo lleva lo que admite su XSD y su CUNE usa totales 0.00 y DocEmp 0', () => {
    const { xml, cune } = buildPayrollAdjustmentXml({ tenant, employee, period, liquidation, numbering: { prefix: 'NA', consecutivo: '2' }, adjustmentType: 'delete', predecessor });
    const branch = xml.slice(xml.indexOf('<Eliminar>'), xml.indexOf('</Eliminar>'));
    const tags = [...branch.matchAll(/\n\s*<([A-Za-z]+)/g)].map((m) => m[1]);
    expect(tags).toEqual(['EliminandoPredecesor', 'NumeroSecuenciaXML', 'LugarGeneracionXML', 'ProveedorXML', 'CodigoQR', 'InformacionGeneral', 'Empleador']);
    expect(attr(xml, 'NumeroSecuenciaXML', 'CodigoTrabajador')).toBeUndefined();
    expect(attr(xml, 'InformacionGeneral', 'PeriodoNomina')).toBeUndefined();
    expect(attr(xml, 'InformacionGeneral', 'TipoMoneda')).toBeUndefined();
    const plain = 'NA2' + attr(xml, 'InformacionGeneral', 'FechaGen') + attr(xml, 'InformacionGeneral', 'HoraGen')
      + '0.00' + '0.00' + '0.00' + '900373979' + '0' + '103' + '12345' + '2';
    expect(cune).toBe(sha384(plain));
  });
});

describe('configuración y envío', () => {
  beforeEach(() => jest.clearAllMocks());

  it('no deja emitir sin software ni PIN de nómina', () => {
    expect(() => assertPayrollDianConfig({ ...cfg, software_id_nomina: '', software_pin_nomina: '' }))
      .toThrow(/Software ID de nómina.*PIN del software de nómina/);
    expect(() => assertPayrollDianConfig({ environment: 'simulation' })).not.toThrow();
  });

  it('en pruebas con TestSetId de la resolución va al set de pruebas (SendTestSetAsync)', async () => {
    const r = await submitPayrollDocument({ tenant, employee, period, liquidation, numbering: { ...numbering, testSetId: 'set-123' } });
    expect(r.dianResponse.via).toBe('testset');
    expect(dianApiService.sendTestSetAsync).toHaveBeenCalledWith(expect.objectContaining({ testSetId: 'set-123', environment: 'test' }));
  });

  it('en producción va por SendNominaSync', async () => {
    const r = await submitPayrollDocument({ tenant: { ...tenant, dian_config: { ...cfg, environment: 'production' } }, employee, period, liquidation, numbering: { ...numbering, testSetId: 'set-123' } });
    expect(r.dianResponse.via).toBe('sync');
    expect(dianApiService.sendNominaSync).toHaveBeenCalledWith(expect.objectContaining({ environment: 'production' }));
  });
});
