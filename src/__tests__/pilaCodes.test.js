// Códigos PILA de las administradoras: son nacionales, así que se toman del
// catálogo por NIT cuando el proveedor del tenant no los tiene, y se
// resuelven por tipo (Compensar es EPS008 como EPS y CCF24 como caja).
const { pilaCodeFor, catalogEntry } = require('../services/payroll/pila/pilaCodes');
const { PAYROLL_FUNDS_COLOMBIA } = require('../data/payroll-funds-colombia');

describe('pilaCodeFor', () => {
  test('proveedor sin código: sale del catálogo por NIT (con o sin dígito de verificación)', () => {
    expect(pilaCodeFor({ tax_id: '860007336' }, 'ccf')).toBe('CCF22'); // Colsubsidio
    expect(pilaCodeFor({ tax_id: '890900841-4' }, 'ccf')).toBe('CCF04'); // Comfama
    expect(pilaCodeFor({ tax_id: '860011153' }, 'arl')).toBe('14-23'); // Positiva
    expect(pilaCodeFor({ tax_id: '900226715' }, 'eps')).toBe('EPS042'); // Coosalud
  });

  test('Compensar: un código por papel', () => {
    const compensar = { tax_id: '860066942', pila_code: 'EPS008' };
    expect(pilaCodeFor(compensar, 'eps')).toBe('EPS008');
    expect(pilaCodeFor(compensar, 'ccf')).toBe('CCF24');
  });

  test('el código propio del tenant manda si corresponde al tipo', () => {
    expect(pilaCodeFor({ tax_id: '860007336', pila_code: 'ccf99' }, 'ccf')).toBe('CCF99');
  });

  test('un código de otro tipo no se reporta: se usa el del catálogo o ninguno', () => {
    expect(pilaCodeFor({ tax_id: '999999999', pila_code: 'EPS037' }, 'ccf')).toBe('');
    expect(pilaCodeFor(null, 'eps')).toBe('');
  });
});

describe('catálogo', () => {
  test('toda EPS, pensión, caja y ARL tiene código con la forma de su tipo', () => {
    const shape = { eps: /^(EPS|ESS|EAS)\w+$/, afp: /^(\d{6}|25-\d{1,2})$/, ccf: /^CCF\d{2}$/, arl: /^14-\d{1,2}$/ };
    for (const f of PAYROLL_FUNDS_COLOMBIA) {
      for (const type of f.types.filter((t) => shape[t])) {
        expect([f.name, type, pilaCodeFor({ tax_id: f.tax_id }, type)]).toEqual([f.name, type, expect.stringMatching(shape[type])]);
      }
    }
  });

  test('sin códigos de caja repetidos', () => {
    const ccf = PAYROLL_FUNDS_COLOMBIA.filter((f) => f.types.includes('ccf')).map((f) => pilaCodeFor({ tax_id: f.tax_id }, 'ccf'));
    expect(new Set(ccf).size).toBe(ccf.length);
    expect(catalogEntry('830054904')).toMatchObject({ name: 'ARL Mapfre', inactive: true });
  });
});
