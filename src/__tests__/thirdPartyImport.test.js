// Tests de la importación de clientes y proveedores (lectura y validación, sin BD).
jest.mock('../config/database', () => ({ sequelize: { literal: jest.fn((x) => x) } }));
jest.mock('../models', () => ({}));

const ExcelJS = require('exceljs');
const { parseRow, docKey, resolveCity, toModel, buildTemplate, ENTITIES, parseDocumentType } = require('../services/importers/thirdPartyImport.service');

describe('docKey', () => {
  test('NIT con y sin dígito de verificación da la misma llave', () => {
    expect(docKey('900.123.456-7')).toBe('900123456');
    expect(docKey('900123456')).toBe('900123456');
    expect(docKey(' 1.110.456.789 ')).toBe('1110456789');
    expect(docKey('AB-123456')).toBe('AB123456'); // pasaporte: el guion no es DV
  });
});

describe('parseDocumentType', () => {
  test.each([
    ['CC', '13'], ['Cédula de extranjería', '22'], ['Documento de identificación extranjero', '42'],
    ['Documento de Identificación extranj', '42'], ['Documento de identificación extranjería', '42'], ['NIT', '31'],
    ['Permiso de Protección Temporal', '48'], ['PPT', '48'], ['PEP', '47'], ['NIT de otro país', '50'], ['C.C.', '13'], ['31', '31'],
  ])('%s → %s', (text, code) => expect(parseDocumentType(text)).toBe(code));
  test('texto desconocido no se adivina', () => expect(parseDocumentType('cualquier cosa')).toBeNull());
});

describe('resolveCity', () => {
  test('por código, por nombre y con departamento cuando el nombre se repite', () => {
    expect(resolveCity({ code: '73001' }).city.name).toBe('Ibagué');
    expect(resolveCity({ code: '5001' }).city.code).toBe('05001');
    expect(resolveCity({ city: 'ibague' }).city.code).toBe('73001');
    expect(resolveCity({ city: 'Bogotá' }).city.code).toBe('11001');
    expect(resolveCity({ city: 'Rionegro' }).error).toMatch(/departamento/);
    expect(resolveCity({ city: 'Rionegro', department: 'Antioquia' }).city.code).toBe('05615');
    expect(resolveCity({ city: 'Ciudad Gótica' }).error).toMatch(/No se encontró/);
  });
});

describe('parseRow clientes', () => {
  test('fila completa', () => {
    const { data, errors } = parseRow('customers', {
      document_type: 'CC', tax_id: '1.110.456.789', name: 'María Fernanda López', email: 'MARIA@Correo.com',
      mobile: '3001234567', city: 'Ibagué', credit_limit: '5.000.000', payment_terms: '30', withholding_agent: 'No', is_exento: 'Sí',
    });
    expect(errors).toEqual([]);
    expect(data).toMatchObject({ document_type: '13', tax_id: '1.110.456.789', email: 'maria@correo.com', city_code: '73001', state: 'Tolima', credit_limit: 5000000, payment_terms: 30, withholding_agent: false, is_exento: true, key: '1110456789' });
    const m = toModel('customers', data);
    expect(m).toMatchObject({ customer_type: 'individual', first_name: 'María', last_name: 'Fernanda López', retention_config: { is_exento: true, withholding_agent: false } });
  });

  test('NIT sin tipo de cliente queda como empresa con razón social', () => {
    const { data } = parseRow('customers', { document_type: 'NIT', tax_id: '900123456-7', name: 'Constructora ABC SAS' });
    expect(toModel('customers', data)).toMatchObject({ customer_type: 'company', first_name: 'Constructora ABC SAS', business_name: 'Constructora ABC SAS', document_type: '31' });
  });

  test('errores claros por celda', () => {
    const { errors } = parseRow('customers', { document_type: 'Cédula rara', name: 'X', email: 'no-es-correo', credit_limit: 'mucho', is_active: 'tal vez' });
    expect(errors.join(' | ')).toMatch(/Falta "Número de documento"/);
    expect(errors.join(' | ')).toMatch(/Tipo de documento "Cédula rara"/);
    expect(errors.join(' | ')).toMatch(/Correo inválido/);
    expect(errors.join(' | ')).toMatch(/Cupo de crédito/);
    expect(errors.join(' | ')).toMatch(/Activo" debe ser Sí o No/);
  });

  test('al actualizar solo cambia lo que vino y conserva la configuración de retenciones', () => {
    const { data } = parseRow('customers', { document_type: '13', tax_id: '123', name: 'Ana Ruiz', is_exento: 'No' });
    const m = toModel('customers', data, { forUpdate: true, existing: { customer_type: 'individual', retention_config: { withholding_agent: true, reteica_rate: 0.5 } } });
    expect(m.tax_id).toBeUndefined();
    expect(m.retention_config).toEqual({ withholding_agent: true, reteica_rate: 0.5, is_exento: false });
    expect(m.email).toBeUndefined();
  });
});

describe('parseRow proveedores', () => {
  test('listas y responsabilidades', () => {
    const { data, errors } = parseRow('suppliers', {
      document_type: 'NIT', tax_id: '900123456-7', name: 'Distribuidora Solar', tax_regime: 'No responsable de IVA',
      fiscal_responsibilities: 'o-13; O-15', is_obligated_to_invoice: 'No', account_type: 'Ahorros', city_code: '05001', is_declarante: 'Sí',
    });
    expect(errors).toEqual([]);
    const m = toModel('suppliers', data);
    expect(m).toMatchObject({
      name: 'Distribuidora Solar', business_name: 'Distribuidora Solar', person_type: 'juridica', tax_regime: 'no_responsable',
      fiscal_responsibilities: ['O-13', 'O-15'], is_obligated_to_invoice: false, account_type: 'savings', city_code: '05001', state: 'Antioquia',
      retention_config: { is_declarante: true },
    });
    expect(parseRow('suppliers', { document_type: 'NIT', tax_id: '1', name: 'X', tax_regime: 'Común' }).data.tax_regime).toBe('comun');
    expect(parseRow('suppliers', { document_type: 'NIT', tax_id: '1', name: 'X', tax_regime: 'Raro' }).errors[0]).toMatch(/Régimen/);
  });
});

describe('plantilla', () => {
  test.each(['customers', 'suppliers'])('%s: encabezados con * en obligatorias, instrucciones y municipios', async (entity) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildTemplate(entity));
    const ws = wb.getWorksheet(ENTITIES[entity].sheet);
    const headers = [];
    ws.getRow(1).eachCell((c) => headers.push(c.value));
    expect(headers.slice(0, 3)).toEqual(['Tipo de documento*', 'Número de documento*', ENTITIES[entity].columns[2].header + '*']);
    expect(wb.getWorksheet('Instrucciones').rowCount).toBeGreaterThan(10);
    expect(wb.getWorksheet('Municipios').rowCount).toBeGreaterThan(1100);
  });
});
