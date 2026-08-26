// Preferencias visuales del workspace WhatsApp (asesor parametriza su UI).
const DEFAULT_WA_WORKSPACE_PREFS = {
  show_follow_up: true,
  show_priority: true,
  show_pin: true,
  show_marks: true,
  show_internal_note: true,
  show_ai_suggest: true,
  show_ai_summarize: true,
  show_window_status: true,
  show_customer_link: true,
  show_assign: true,
  show_demo_simulate: true,
};

const MARK_OPTIONS = [
  { key: 'waiting_customer', label: 'Esperando cliente', color: 'amber' },
  { key: 'quote_sent', label: 'Cotización enviada', color: 'sky' },
  { key: 'hot_lead', label: 'Lead caliente', color: 'red' },
  { key: 'payment_pending', label: 'Pago pendiente', color: 'violet' },
  { key: 'appointment', label: 'Cita agendada', color: 'emerald' },
];

function mergePrefs(stored) {
  return { ...DEFAULT_WA_WORKSPACE_PREFS, ...(stored || {}) };
}

function windowStatus(lastInboundAt) {
  if (!lastInboundAt) {
    return { open: false, expires_at: null, label: 'Ventana cerrada — usar plantilla' };
  }
  const start = new Date(lastInboundAt).getTime();
  const expires = start + 24 * 60 * 60 * 1000;
  const open = Date.now() < expires;
  return {
    open,
    expires_at: new Date(expires).toISOString(),
    label: open ? 'Ventana 24h abierta' : 'Ventana cerrada — usar plantilla',
  };
}

module.exports = {
  DEFAULT_WA_WORKSPACE_PREFS,
  MARK_OPTIONS,
  mergePrefs,
  windowStatus,
};
