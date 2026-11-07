const { parseBomText, parseLocaleNumber } = require('../services/projects/bomParser');
const { shortageOf, reservableOf } = require('../services/projects/projectBom.service');

describe('parseLocaleNumber', () => {
  test.each([
    ['12', 12],
    ['12,5', 12.5],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['1.500', 1500],
    ['1.5', 1.5],
    ['$ 3.500.000', 3500000],
    ['2.000.000,50', 2000000.5],
    ['abc', null],
    ['', null],
  ])('%s → %s', (raw, expected) => {
    expect(parseLocaleNumber(raw)).toBe(expected);
  });
});

describe('parseBomText', () => {
  test('con encabezado: columnas por nombre, en cualquier orden', () => {
    const text = [
      'Descripción\tCódigo\tUnd\tCantidad\tCosto unitario',
      'Panel solar 550W mono\tPAN-550\tUND\t24\t650.000',
      'Inversor híbrido 10kW\tINV-10K\tUND\t1\t8.500.000,00',
      'Cable solar 6mm\tCAB-6\tMT\t120,5\t',
    ].join('\n');
    const { rows, errors, header } = parseBomText(text);
    expect(header).toBe(true);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ line_no: 1, input_code: 'PAN-550', input_description: 'Panel solar 550W mono', unit: 'UND', quantity: 24, unit_cost: 650000 });
    expect(rows[1]).toMatchObject({ input_code: 'INV-10K', quantity: 1, unit_cost: 8500000 });
    expect(rows[2]).toMatchObject({ input_code: 'CAB-6', unit: 'MT', quantity: 120.5, unit_cost: null });
  });

  test('sin encabezado: código, descripción, cantidad, unidad, costo', () => {
    const text = 'PAN-550\tPanel 550W\t24\tUND\t650000\r\nINV-10K\tInversor 10kW\t1\tUND\t8500000';
    const { rows, header } = parseBomText(text);
    expect(header).toBe(false);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ input_code: 'PAN-550', input_description: 'Panel 550W', quantity: 24, unit: 'UND', unit_cost: 650000 });
  });

  test('sin encabezado y dos columnas: código o descripción + cantidad', () => {
    const { rows } = parseBomText('PAN-550\t24\nCable solar rojo 6mm\t100');
    expect(rows[0]).toMatchObject({ input_code: 'PAN-550', input_description: null, quantity: 24 });
    expect(rows[1]).toMatchObject({ input_code: null, input_description: 'Cable solar rojo 6mm', quantity: 100 });
  });

  test('líneas con cantidad inválida van a errores, el resto se lee', () => {
    const text = 'Código\tDescripción\tCantidad\nA1\tUno\t2\nA2\tDos\tx\nA3\tTres\t0\n\nA4\tCuatro\t1';
    const { rows, errors } = parseBomText(text);
    expect(rows.map((r) => r.input_code)).toEqual(['A1', 'A4']);
    expect(errors.map((e) => e.line_no)).toEqual([2, 3]);
  });

  test('punto y coma como separador (CSV regional)', () => {
    const { rows } = parseBomText('Código;Descripción;Cantidad\nA1;Uno;3');
    expect(rows[0]).toMatchObject({ input_code: 'A1', quantity: 3 });
  });

  test('sin columna de cantidad: error claro', () => {
    const { rows, errors } = parseBomText('solo texto\notra línea');
    expect(rows).toEqual([]);
    expect(errors[0].message).toMatch(/cantidad/i);
  });
});

describe('cantidades del BOM', () => {
  const line = (o) => ({ qty_required: 10, qty_reserved: 0, qty_dispatched: 0, qty_ordered: 0, ...o });
  test('faltante = requerido − despachado − reservado − pedido', () => {
    expect(shortageOf(line({ qty_reserved: 3, qty_dispatched: 2, qty_ordered: 1 }))).toBe(4);
    expect(shortageOf(line({ qty_reserved: 6, qty_dispatched: 6 }))).toBe(0);
  });
  test('reservable = requerido − despachado − ya reservado', () => {
    expect(reservableOf(line({ qty_reserved: 3, qty_dispatched: 2 }))).toBe(5);
    expect(reservableOf(line({ qty_dispatched: 10 }))).toBe(0);
  });
});

describe('lo que ya está en la obra cuenta como entregado', () => {
  const { allocateOnSite, deliveredOf } = require('../services/projects/projectBom.service');
  const line = (o) => ({ qty_required: 4, qty_reserved: 0, qty_dispatched: 0, qty_ordered: 0, ...o });

  test('traslado manual de 4 a la obra: nada que reservar ni pedir', () => {
    expect(reservableOf(line({}), 4)).toBe(0);
    expect(shortageOf(line({}), 4)).toBe(0);
  });
  test('entregado = máximo entre despachado y saldo en obra', () => {
    expect(deliveredOf(line({ qty_dispatched: 3 }), 1)).toBe(3);
    expect(deliveredOf(line({ qty_dispatched: 1 }), 3)).toBe(3);
  });
  test('el saldo de un producto se reparte en orden entre sus líneas', () => {
    const lines = [
      { id: 'a', product_id: 'p', qty_required: 3 },
      { id: 'b', product_id: 'p', qty_required: 5 },
      { id: 'c', product_id: 'q', qty_required: 2 },
    ];
    const r = allocateOnSite(lines, new Map([['p', 6]]));
    expect([r.get('a'), r.get('b'), r.get('c')]).toEqual([3, 3, 0]);
  });
});
