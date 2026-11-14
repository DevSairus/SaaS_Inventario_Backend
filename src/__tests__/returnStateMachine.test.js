// 3.5 / 4.2 — Máquina de estados de devoluciones de venta y de compra.
const fs = require('fs');
const path = require('path');
const sm = require('../services/returns/returnStateMachine');

describe('transiciones', () => {
  test.each([
    ['pending', 'approved', true],
    ['pending', 'rejected', true],
    ['approved', 'reversed', true],
    ['pending', 'reversed', false],
    ['approved', 'rejected', false],
    ['approved', 'pending', false],
    ['rejected', 'approved', false],
    ['reversed', 'approved', false],
    ['reversed', 'pending', false],
  ])('%s → %s = %s', (from, to, ok) => {
    expect(sm.canTransition(from, to)).toBe(ok);
    if (ok) expect(() => sm.assertTransition(from, to)).not.toThrow();
    else expect(() => sm.assertTransition(from, to)).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('rechazada y revertida son finales', () => {
    expect(sm.TRANSITIONS.rejected).toEqual([]);
    expect(sm.TRANSITIONS.reversed).toEqual([]);
  });
  test('todos los estados tienen etiqueta y destinos válidos', () => {
    sm.STATES.forEach((s) => {
      expect(sm.LABELS[s]).toBeTruthy();
      sm.TRANSITIONS[s].forEach((t) => expect(sm.STATES).toContain(t));
    });
  });
});

// Modelo falso que guarda los hooks, para ejercitarlos como lo haría Sequelize.
function fakeModel() {
  const hooks = {};
  return { hooks, addHook: (name, _id, fn) => { hooks[name] = fn; } };
}
const instance = (data, changes = {}) => ({
  ...data,
  changed: (f) => f in changes,
  previous: (f) => changes[f],
});

describe('hooks de bitácora', () => {
  const create = jest.fn(async () => ({}));
  const Event = { create };
  let M;
  beforeEach(() => { create.mockClear(); M = fakeModel(); sm.attachReturnStateMachine(M, 'customer', () => Event); });

  test('crear en pending o approved (anulación de venta) está permitido; otro estado no', () => {
    expect(() => M.hooks.beforeCreate({ status: 'pending' })).not.toThrow();
    expect(() => M.hooks.beforeCreate({ status: 'approved' })).not.toThrow();
    expect(() => M.hooks.beforeCreate({})).not.toThrow();
    expect(() => M.hooks.beforeCreate({ status: 'reversed' })).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('al crear registra el estado inicial con quién la creó', async () => {
    await M.hooks.afterCreate({ id: 'r1', tenant_id: 't1', status: 'pending', created_by: 'u1' }, { transaction: 'tx' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 't1', return_type: 'customer', return_id: 'r1', from_status: null, to_status: 'pending', user_id: 'u1' }),
      { transaction: 'tx' });
  });

  test('beforeUpdate rechaza una transición inválida y deja pasar una válida o sin cambio de estado', () => {
    expect(() => M.hooks.beforeUpdate(instance({ status: 'approved' }, { status: 'rejected' }))).toThrow(/Rechazada/);
    expect(() => M.hooks.beforeUpdate(instance({ status: 'rejected' }, { status: 'pending' }))).not.toThrow();
    expect(() => M.hooks.beforeUpdate(instance({ status: 'approved', notes: 'x' }, { notes: 'y' }))).not.toThrow();
  });

  test('al aprobar, rechazar y reversar registra responsable y nota', async () => {
    await M.hooks.afterUpdate(instance({ id: 'r1', tenant_id: 't1', status: 'approved', approved_by: 'u2' }, { status: 'pending' }), { transaction: 'tx' });
    await M.hooks.afterUpdate(instance({ id: 'r2', tenant_id: 't1', status: 'rejected', rejected_by: 'u3', rejection_reason: 'sin factura' }, { status: 'pending' }), {});
    await M.hooks.afterUpdate(instance({ id: 'r3', tenant_id: 't1', status: 'reversed', reversed_by: 'u4', reversal_reason: 'error' }, { status: 'approved' }), {});
    const rows = create.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({ from_status: 'pending', to_status: 'approved', user_id: 'u2', note: null });
    expect(rows[1]).toMatchObject({ to_status: 'rejected', user_id: 'u3', note: 'sin factura' });
    expect(rows[2]).toMatchObject({ from_status: 'approved', to_status: 'reversed', user_id: 'u4', note: 'error' });
  });

  test('un update sin cambio de estado no escribe bitácora', async () => {
    await M.hooks.afterUpdate(instance({ id: 'r1', tenant_id: 't1', status: 'pending' }, { notes: 'a' }), {});
    expect(create).not.toHaveBeenCalled();
  });
});

describe('línea de tiempo', () => {
  test('eventos + hitos (nota crédito / nota de ajuste)', () => {
    const t = sm.buildTimeline(
      [{ to_status: 'pending', from_status: null, user_id: 'u1', note: null, created_at: 'd1' }, { to_status: 'approved', from_status: 'pending', user_id: 'u2', note: null, created_at: 'd2' }],
      { credit_note_sale_id: 'nc1' });
    expect(t.events.map((e) => e.label)).toEqual(['Pendiente', 'Aprobada']);
    expect(t.milestones).toEqual([expect.objectContaining({ key: 'credit_note', ref_id: 'nc1' })]);
    expect(sm.buildTimeline([], { support_adjustment_id: 'sa1' }).milestones[0].key).toBe('support_adjustment');
  });
});

describe('modelo único de devoluciones de venta (4.2)', () => {
  test('ya no existe el duplicado en models/inventory', () => {
    const dir = path.join(__dirname, '..', 'models', 'inventory');
    expect(fs.existsSync(path.join(dir, 'CustomerReturn.js'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'CustomerReturnItem.js'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '..', 'models', 'sales', 'CustomerReturn.js'))).toBe(true);
  });
});
