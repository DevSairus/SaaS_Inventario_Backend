const {
  validateStageItems, normalizeSignatures,
} = require('../services/projects/projectStages.service');
const { generateDispatchActaPdf } = require('../services/projects/projectDispatchActaPdf.service');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sig = `data:image/png;base64,${PNG_1X1}`;

const lines = [
  { id: 'a', line_no: 1, qty_required: 100 },
  { id: 'b', line_no: 2, qty_required: 10 },
];

describe('validateStageItems', () => {
  test('acepta y redondea a 4 decimales', () => {
    expect(validateStageItems([{ item_id: 'a', qty_planned: '40.12345' }], { lines }))
      .toEqual([{ bom_item_id: 'a', qty_planned: 40.1235 }]);
  });

  test('lista vacía es válida (etapa sin líneas todavía)', () => {
    expect(validateStageItems([], { lines })).toEqual([]);
  });

  test('rechaza una línea que no es del proyecto', () => {
    expect(() => validateStageItems([{ item_id: 'zzz', qty_planned: 1 }], { lines })).toThrow('no pertenece');
  });

  test.each([0, -3, 'x', null])('rechaza cantidad %p', (q) => {
    expect(() => validateStageItems([{ item_id: 'a', qty_planned: q }], { lines })).toThrow('mayor que cero');
  });

  test('rechaza línea repetida', () => {
    expect(() => validateStageItems([{ item_id: 'a', qty_planned: 1 }, { item_id: 'a', qty_planned: 2 }], { lines })).toThrow('repetida');
  });

  test('no deja pasar de lo requerido sumando otras etapas', () => {
    const plannedElsewhere = new Map([['a', 70]]);
    expect(() => validateStageItems([{ item_id: 'a', qty_planned: 31 }], { lines, plannedElsewhere }))
      .toThrow('Línea 1: solo quedan 30 por asignar');
    expect(validateStageItems([{ item_id: 'a', qty_planned: 30 }], { lines, plannedElsewhere })).toHaveLength(1);
  });

  test('no permite planear menos de lo ya despachado en la etapa', () => {
    const dispatchedHere = new Map([['a', 25]]);
    expect(() => validateStageItems([{ item_id: 'a', qty_planned: 20 }], { lines, dispatchedHere })).toThrow('ya se despacharon 25');
    expect(validateStageItems([{ item_id: 'a', qty_planned: 25 }], { lines, dispatchedHere })).toHaveLength(1);
  });

  test('no permite sacar de la etapa una línea con despachos', () => {
    const dispatchedHere = new Map([['b', 3]]);
    expect(() => validateStageItems([{ item_id: 'a', qty_planned: 5 }], { lines, dispatchedHere })).toThrow('no puede quitarse');
  });

  test('exige lista', () => {
    expect(() => validateStageItems('x', { lines })).toThrow('deben ser una lista');
  });
});

describe('normalizeSignatures', () => {
  const ok = { role: 'almacen', name: '  Ana Pérez ', document: ' 123 ', signature: sig };

  test('sin firmas → []', () => {
    expect(normalizeSignatures(undefined)).toEqual([]);
    expect(normalizeSignatures(null)).toEqual([]);
    expect(normalizeSignatures([])).toEqual([]);
  });

  test('normaliza nombre y documento', () => {
    expect(normalizeSignatures([ok])).toEqual([{ role: 'almacen', name: 'Ana Pérez', document: '123', signature: sig }]);
  });

  test('rol inválido, rol repetido, sin nombre, firma inválida', () => {
    expect(() => normalizeSignatures([{ ...ok, role: 'gerente' }])).toThrow('Rol de firma inválido');
    expect(() => normalizeSignatures([ok, ok])).toThrow('firma una sola vez');
    expect(() => normalizeSignatures([{ ...ok, name: ' ' }])).toThrow('nombre de quien firma');
    expect(() => normalizeSignatures([{ ...ok, signature: 'hola' }])).toThrow('Firma inválida');
    expect(() => normalizeSignatures([{ ...ok, signature: '' }])).toThrow('es obligatoria');
  });

  test('máximo tres firmas y debe ser lista', () => {
    expect(() => normalizeSignatures('x')).toThrow('deben ser una lista');
    const four = ['almacen', 'transportador', 'encargado_obra', 'almacen'].map((role) => ({ ...ok, role }));
    expect(() => normalizeSignatures(four)).toThrow('Demasiadas');
  });
});

describe('generateDispatchActaPdf', () => {
  const base = {
    project: { code: 'PRY-001', name: 'Torre Norte' },
    tenant: { company_name: 'Solier SAS', tax_id: '900123456' },
  };
  const data = (signatures) => ({
    dispatch: { dispatch_no: 'DSP-000001', dispatched_at: new Date('2026-11-13T15:00:00Z'), notes: 'Entrega en portería' },
    stage: { stage_no: 2, name: 'Estructura' }, stageProgress: { pct: 40 },
    transfer: { transfer_number: 'TRF-0007' },
    fromWarehouse: 'Bodega principal', toWarehouse: 'Obra Torre Norte', createdBy: 'Ana Pérez',
    lines: Array.from({ length: 45 }, (_, i) => ({ line_no: i + 1, sku: `SKU${i}`, name: `Material ${i}`, unit: 'UN', qty_sent: 10.5, qty_received: i % 2 ? 10.5 : null })),
    signatures,
  });

  test('genera un PDF sin firmas (todas pendientes) y con varias páginas', async () => {
    const pdf = await generateDispatchActaPdf({ ...base, data: data([]) });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
  });

  test('genera un PDF con firmas dibujadas', async () => {
    const signatures = ['almacen', 'transportador', 'encargado_obra'].map((role) => ({
      role, signed_name: 'Firmante', signed_document: '123', signature: sig, signed_at: new Date(),
    }));
    const pdf = await generateDispatchActaPdf({ ...base, data: data(signatures) });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('tolera una firma ilegible sin romper el acta', async () => {
    const pdf = await generateDispatchActaPdf({
      ...base,
      data: data([{ role: 'almacen', signed_name: 'X', signature: 'data:image/png;base64,AAAA', signed_at: new Date() }]),
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
