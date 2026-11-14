// backend/src/services/returns/returnHistory.js
// Historial de estados de una devolución (venta o compra) para el detalle y el
// endpoint GET /:id/history. Ver returnStateMachine.js.

'use strict';

const { buildTimeline, statusLabel, TRANSITIONS } = require('./returnStateMachine');

async function loadReturnHistory({ returnType, ret, tenantId }) {
  const { ReturnStatusEvent, User } = require('../../models');
  const events = await ReturnStatusEvent.findAll({
    where: { tenant_id: tenantId, return_type: returnType, return_id: ret.id },
    order: [['created_at', 'ASC']],
    raw: true,
  });
  const userIds = [...new Set(events.map((e) => e.user_id).filter(Boolean))];
  const users = userIds.length
    ? await User.findAll({ where: { id: userIds }, attributes: ['id', 'first_name', 'last_name'], raw: true })
    : [];
  const nameById = new Map(users.map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(' ') || null]));

  const timeline = buildTimeline(events, ret);
  timeline.events = timeline.events.map((e) => ({ ...e, user_name: nameById.get(e.user_id) || null }));
  return {
    current_status: ret.status,
    current_label: statusLabel(ret.status),
    next_statuses: (TRANSITIONS[ret.status] || []).map((s) => ({ status: s, label: statusLabel(s) })),
    ...timeline,
  };
}

module.exports = { loadReturnHistory };
