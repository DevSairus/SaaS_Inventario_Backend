// backend/src/services/accounting/thirdPartySetup.service.js
//
// 3.2 — Cuando se crea un cliente o proveedor, contabilidad debe enterarse para
// revisar su configuración (régimen, responsabilidades, retenciones, cuentas).
//   1. El tercero queda 'pending' (accounting_setup_status).
//   2. Se envía un correo a los usuarios con rol contador de la empresa.
//   3. Aparece en la lista de pendientes hasta que se marca 'configured'.
// El correo es best-effort: si falla, el alta del tercero no se afecta.
'use strict';

const logger = require('../../config/logger');

const KINDS = {
  customer: { label: 'cliente', model: 'Customer' },
  supplier: { label: 'proveedor', model: 'Supplier' },
};

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function displayName(record) {
  return record.business_name || record.trade_name || record.name
    || [record.first_name, record.last_name].filter(Boolean).join(' ') || 'Sin nombre';
}

function buildEmail(kind, record, creatorName) {
  const label = KINDS[kind].label;
  const name = displayName(record);
  const subject = `Nuevo ${label} por configurar: ${name}`;
  const html = `
    <p>Se creó un nuevo ${label} y está pendiente de revisión contable.</p>
    <ul>
      <li><b>Nombre:</b> ${escapeHtml(name)}</li>
      <li><b>NIT/CC:</b> ${escapeHtml(record.tax_id || '—')}</li>
      ${creatorName ? `<li><b>Creado por:</b> ${escapeHtml(creatorName)}</li>` : ''}
    </ul>
    <p>Revise su régimen, responsabilidades fiscales y retenciones, y márquelo como configurado en Contabilidad.</p>`;
  return { subject, html };
}

/** Correos de los contadores activos de la empresa (sin repetidos ni vacíos). */
async function accountantEmails(tenantId) {
  const { User } = require('../../models');
  const users = await User.findAll({
    where: { tenant_id: tenantId, role: 'accountant', is_active: true },
    attributes: ['email'],
  });
  return [...new Set(users.map((u) => String(u.email || '').trim().toLowerCase()).filter(Boolean))];
}

/**
 * Avisa a contabilidad del alta de un tercero. Nunca lanza.
 * @returns {Promise<{ notified: number }>}
 */
async function notifyNewThirdParty(tenantId, kind, record, { creatorName = null } = {}) {
  try {
    if (!KINDS[kind]) return { notified: 0 };
    const to = await accountantEmails(tenantId);
    if (to.length === 0) return { notified: 0 };
    const { sendEmail } = require('../emailService');
    const { subject, html } = buildEmail(kind, record, creatorName);
    await sendEmail({ to, subject, html });
    return { notified: to.length };
  } catch (error) {
    logger.warn(`[3.2] No se pudo avisar a contabilidad del nuevo ${kind}: ${error.message}`);
    return { notified: 0 };
  }
}

/** Campos que se agregan al crear el tercero. Se fuerzan en el servidor (no vienen del body). */
const pendingFields = () => ({ accounting_setup_status: 'pending', accounting_setup_at: null, accounting_setup_by: null });

async function listPending(tenantId) {
  const models = require('../../models');
  const out = [];
  for (const [kind, spec] of Object.entries(KINDS)) {
    // eslint-disable-next-line no-await-in-loop -- dos consultas, no vale la pena paralelizar
    const rows = await models[spec.model].findAll({
      where: { tenant_id: tenantId, accounting_setup_status: 'pending' },
      order: [['created_at', 'DESC']],
      limit: 200,
    });
    rows.forEach((r) => out.push({
      kind, id: r.id, name: displayName(r), tax_id: r.tax_id || null, created_at: r.created_at || r.createdAt || null,
    }));
  }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function markConfigured(tenantId, kind, id, userId) {
  if (!KINDS[kind]) {
    const err = new Error('Tipo de tercero inválido (use customer o supplier)');
    err.statusCode = 400;
    throw err;
  }
  const record = await require('../../models')[KINDS[kind].model].findOne({ where: { id, tenant_id: tenantId } });
  if (!record) {
    const err = new Error('Tercero no encontrado');
    err.statusCode = 404;
    throw err;
  }
  await record.update({ accounting_setup_status: 'configured', accounting_setup_at: new Date(), accounting_setup_by: userId || null });
  return record;
}

module.exports = { KINDS, buildEmail, notifyNewThirdParty, pendingFields, listPending, markConfigured };
