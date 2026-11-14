// backend/src/services/returns/returnStateMachine.js
//
// Estados de las devoluciones de venta (CustomerReturn) y de compra
// (SupplierReturn): una sola máquina para las dos (req. 3.5 / 4.2).
//
//   pending ──► approved ──► reversed
//      └──────► rejected
//
// approved mueve inventario y genera asiento; rejected y reversed son finales.
// La nota crédito (venta) y la Nota de Ajuste (compra) no son estados: son
// hitos de una devolución aprobada y se muestran en la línea de tiempo.
//
// Se engancha como hook del modelo para cubrir TODOS los caminos que cambian
// el estado (aprobar, rechazar, reversar, anular venta) sin repetir la regla en
// cada controlador: beforeUpdate rechaza transiciones inválidas y
// afterCreate/afterUpdate dejan la bitácora en return_status_events.

'use strict';

const STATES = ['pending', 'approved', 'rejected', 'reversed'];

const LABELS = {
  pending: 'Pendiente',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  reversed: 'Reversada',
};

const TRANSITIONS = {
  pending: ['approved', 'rejected'],
  approved: ['reversed'],
  rejected: [],
  reversed: [],
};

// Estados con los que puede NACER una devolución (anular una venta la crea ya aprobada).
const INITIAL_STATES = ['pending', 'approved'];

const statusLabel = (s) => LABELS[s] || s;

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

function transitionError(from, to) {
  const err = new Error(`No se puede pasar una devolución de "${statusLabel(from)}" a "${statusLabel(to)}"`);
  err.status = 400;
  return err;
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) throw transitionError(from, to);
}

/** Quién y por qué, según los campos que cada controlador ya llena junto con el estado. */
function actorAndNote(inst, toStatus) {
  switch (toStatus) {
    case 'approved': return { user: inst.approved_by || inst.created_by || null, note: null };
    case 'rejected': return { user: inst.rejected_by || null, note: inst.rejection_reason || null };
    case 'reversed': return { user: inst.reversed_by || null, note: inst.reversal_reason || null };
    default: return { user: inst.created_by || null, note: null };
  }
}

/**
 * Engancha la máquina a un modelo de devolución. `getEventModel` es perezoso
 * para no crear dependencias circulares entre modelos.
 */
function attachReturnStateMachine(Model, returnType, getEventModel) {
  const log = async (inst, from, to, options) => {
    const { user, note } = actorAndNote(inst, to);
    await getEventModel().create({
      tenant_id: inst.tenant_id,
      return_type: returnType,
      return_id: inst.id,
      from_status: from,
      to_status: to,
      user_id: user,
      note,
    }, { transaction: options && options.transaction });
  };

  Model.addHook('beforeCreate', `${returnType}ReturnInitialState`, (inst) => {
    const s = inst.status || 'pending';
    if (!INITIAL_STATES.includes(s)) {
      const err = new Error(`Una devolución no puede crearse en estado "${statusLabel(s)}"`);
      err.status = 400;
      throw err;
    }
  });

  Model.addHook('afterCreate', `${returnType}ReturnLogCreate`, async (inst, options) => {
    await log(inst, null, inst.status || 'pending', options);
  });

  Model.addHook('beforeUpdate', `${returnType}ReturnGuard`, (inst) => {
    if (!inst.changed('status')) return;
    assertTransition(inst.previous('status'), inst.status);
  });

  Model.addHook('afterUpdate', `${returnType}ReturnLogUpdate`, async (inst, options) => {
    if (!inst.changed('status')) return;
    await log(inst, inst.previous('status'), inst.status, options);
  });
}

/**
 * Línea de tiempo para el detalle: eventos de la bitácora más los hitos
 * (nota crédito / nota de ajuste / saldo a favor) de la devolución ya cargada.
 */
function buildTimeline(events, ret = {}) {
  const items = events.map((e) => ({
    type: 'status',
    status: e.to_status,
    label: statusLabel(e.to_status),
    from_status: e.from_status,
    user_id: e.user_id,
    note: e.note,
    at: e.created_at,
  }));
  const milestones = [];
  if (ret.credit_note_sale_id) milestones.push({ type: 'milestone', key: 'credit_note', label: 'Nota crédito electrónica emitida', ref_id: ret.credit_note_sale_id });
  if (ret.support_adjustment_id) milestones.push({ type: 'milestone', key: 'support_adjustment', label: 'Nota de Ajuste al Documento Soporte emitida', ref_id: ret.support_adjustment_id });
  return { events: items, milestones };
}

module.exports = {
  STATES, LABELS, TRANSITIONS, INITIAL_STATES,
  statusLabel, canTransition, assertTransition, attachReturnStateMachine, buildTimeline,
};
