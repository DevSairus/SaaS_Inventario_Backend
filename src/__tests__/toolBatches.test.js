const { normalizeBatchItems, labelError, SIGN_ROLES } = require('../services/tools/toolBatches.service');
const { generateToolBatchActaPdf } = require('../services/tools/toolBatchActaPdf.service');
const { generateDispatchActaPdf } = require('../services/projects/projectDispatchActaPdf.service');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sig = `data:image/png;base64,${PNG_1X1}`;

describe('normalizeBatchItems · entrega', () => {
  test('aplica valores por defecto y limpia notas', () => {
    expect(normalizeBatchItems('delivery', [{ tool_id: 't1' }, { tool_id: 't2', quantity: '3', delivery_condition: 'damaged', delivery_notes: '  rayón  ' }]))
      .toEqual([
        { tool_id: 't1', quantity: 1, delivery_condition: 'good', delivery_notes: null },
        { tool_id: 't2', quantity: 3, delivery_condition: 'damaged', delivery_notes: 'rayón' },
      ]);
  });

  test.each([[0], [-1], [1.5], ['x']])('rechaza cantidad %p', (q) => {
    expect(() => normalizeBatchItems('delivery', [{ tool_id: 't1', quantity: q }])).toThrow('Ítem 1: la cantidad debe ser un entero mayor que cero');
  });

  test('rechaza estado inválido, ítem sin herramienta y repetidos', () => {
    expect(() => normalizeBatchItems('delivery', [{ tool_id: 't1', delivery_condition: 'lost' }])).toThrow('estado de entrega inválido');
    expect(() => normalizeBatchItems('delivery', [{ tool_id: 't1' }, {}])).toThrow('Ítem 2: falta la herramienta');
    expect(() => normalizeBatchItems('delivery', [{ tool_id: 't1' }, { tool_id: 't1' }])).toThrow('Ítem 2: la herramienta está repetida');
  });
});

describe('normalizeBatchItems · devolución', () => {
  test('aplica valores por defecto', () => {
    expect(normalizeBatchItems('return', [{ assignment_id: 'a1' }, { assignment_id: 'a2', return_condition: 'lost', lost_quantity: '2', return_notes: 'se cayó' }]))
      .toEqual([
        { assignment_id: 'a1', return_condition: 'good', lost_quantity: 0, return_notes: null },
        { assignment_id: 'a2', return_condition: 'lost', lost_quantity: 2, return_notes: 'se cayó' },
      ]);
  });

  test('rechaza estado, perdidas inválidas y repetidos', () => {
    expect(() => normalizeBatchItems('return', [{ assignment_id: 'a1', return_condition: 'roto' }])).toThrow('estado de devolución inválido');
    expect(() => normalizeBatchItems('return', [{ assignment_id: 'a1', lost_quantity: -1 }])).toThrow('unidades perdidas');
    expect(() => normalizeBatchItems('return', [{ assignment_id: 'a1', lost_quantity: 1.5 }])).toThrow('unidades perdidas');
    expect(() => normalizeBatchItems('return', [{ assignment_id: 'a1' }, { assignment_id: 'a1' }])).toThrow('la entrega está repetida');
  });
});

describe('normalizeBatchItems · general', () => {
  test('tipo inválido, vacío y demasiados ítems', () => {
    expect(() => normalizeBatchItems('otro', [{ tool_id: 'a' }])).toThrow('de entrega o de devolución');
    expect(() => normalizeBatchItems('delivery', [])).toThrow('Marca al menos una herramienta');
    expect(() => normalizeBatchItems('delivery', 'x')).toThrow('Marca al menos una herramienta');
    const many = Array.from({ length: 201 }, (_, i) => ({ tool_id: `t${i}` }));
    expect(() => normalizeBatchItems('delivery', many)).toThrow('hasta 200');
  });
});

describe('labelError', () => {
  test('antepone la herramienta a los errores de negocio y conserva el status', () => {
    const e = labelError(Object.assign(new Error('La herramienta ya está asignada'), { statusCode: 409 }), 'TAL-001 · Taladro');
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('TAL-001 · Taladro: La herramienta ya está asignada');
  });
  test('deja pasar errores inesperados sin tocar', () => {
    const raw = new Error('boom');
    expect(labelError(raw, 'x')).toBe(raw);
  });
});

describe('SIGN_ROLES', () => {
  test('los dos tipos de lote usan los tres roles, en distinto orden', () => {
    for (const kind of ['delivery', 'return']) {
      expect(SIGN_ROLES[kind].map(([r]) => r).sort()).toEqual(['almacen', 'encargado_obra', 'transportador']);
    }
    expect(SIGN_ROLES.delivery[0][0]).toBe('almacen');
    expect(SIGN_ROLES.return[0][0]).toBe('encargado_obra');
  });
});

describe('PDF del acta de lote', () => {
  const tenant = { company_name: 'Solier SAS', tax_id: '900123456' };
  const mk = (kind, signatures) => ({
    data: {
      batch: { kind, batch_no: 'LOT-000004', batch_date: '2026-11-13', responsible_name: 'Carlos Ruiz', responsible_document: '555', notes: 'Piso 3' },
      project: { code: 'PRY-001', name: 'Torre Norte' }, stage: { stage_no: 2, name: 'Estructura' }, createdBy: 'Ana Pérez',
      lines: Array.from({ length: 40 }, (_, i) => ({
        code: `HER-${i}`, name: `Herramienta ${i}`, serial: `SN${i}`, quantity: 1 + (i % 3),
        delivery_condition: 'good', delivery_notes: '', return_condition: i % 5 ? 'good' : 'damaged', lost_quantity: i % 7 ? 0 : 1, return_notes: 'golpe',
      })),
      signatures,
    },
    tenant,
  });
  const all = ['almacen', 'transportador', 'encargado_obra'].map((role) => ({ role, signed_name: 'Firmante', signed_document: '1', signature: sig, signed_at: new Date() }));

  test.each(['delivery', 'return'])('genera PDF de %s con y sin firmas', async (kind) => {
    for (const sigs of [[], all]) {
      const pdf = await generateToolBatchActaPdf(mk(kind, sigs));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  test('genera PDF sin etapa ni herramientas', async () => {
    const m = mk('delivery', []);
    m.data.stage = null; m.data.lines = [];
    expect((await generateToolBatchActaPdf(m)).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('regresión: PDF de despacho tras compartir el bloque de firmas', () => {
  test('sigue generando con firmas y pendientes', async () => {
    const pdf = await generateDispatchActaPdf({
      project: { code: 'P', name: 'N' }, tenant: { company_name: 'X' },
      data: {
        dispatch: { dispatch_no: 'DSP-000001', dispatched_at: new Date() }, stage: null, transfer: null, lines: [],
        signatures: [{ role: 'almacen', signed_name: 'A', signature: sig, signed_at: new Date() }],
      },
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
