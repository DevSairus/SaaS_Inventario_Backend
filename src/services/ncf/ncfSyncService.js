// backend/src/services/ncf/ncfSyncService.js
// Sincronización de facturación centralizada CON EL NÚCLEO NCF -- es por
// SISTEMA COMPLETO, no tenant por tenant: recorre todo `public.tenants`
// (activos, con suscripción vigente) en una sola pasada y envía/actualiza
// la prefactura de cada uno. No existe -- ni debe existir -- una pantalla
// de "activar por tenant"; el único interruptor es NcfConfig.is_active.
//
// Se genera la prefactura con ANTICIPATION_DAYS de anticipación a
// next_billing_date (por defecto 7), para que el tenant tenga margen de
// pagar antes de la fecha de corte. Corre automático todos los días
// (ver routes/cron.routes.js -> /api/cron/ncf-sync) y también se puede
// disparar a mano desde el panel -- es la misma función en los dos casos.
//
// Todos los datos fiscales salen directo de `tenants` (business_name,
// tax_id, email, phone, address) + las 2 columnas que sí hacían falta y no
// existían en ningún lado (ncf_ciudad, ncf_regimen_code) -- ver migración
// 2026071502-ncf-columns-en-tenants.js. Nada de tabla aparte.
const { Op } = require('sequelize');
const Tenant = require('../../models/Tenant');
const TenantSubscription = require('../../models/subscriptions/TenantSubscription');
const SubscriptionPlan = require('../../models/subscriptions/SubscriptionPlan');
const ncfClient = require('./ncfClient');
const logger = require('../../config/logger');

const ANTICIPATION_DAYS = Number(process.env.NCF_ANTICIPATION_DAYS || 7);
const GRACE_DAYS = Number(process.env.NCF_SUSPENSION_GRACE_DAYS || 2);

/** Separa "900123456-7" en { numero: "900123456", dv: "7" }. Si no trae
 * guion, usa dian_config.dv si existe, o deja dv vacío (el Núcleo lo pide
 * pero no siempre es obligatorio según el tipo de documento). */
function partirTaxId(taxId, dianConfig) {
  if (!taxId) return { numero: '', dv: dianConfig?.dv || '' };
  const match = String(taxId).match(/^(\d+)-?(\d)?$/);
  if (!match) return { numero: taxId, dv: dianConfig?.dv || '' };
  return { numero: match[1], dv: match[2] || dianConfig?.dv || '' };
}

/** Identificador estable del CICLO que se está facturando -- se basa en la
 * fecha de corte (next_billing_date), no en "hoy". Así, sin importar
 * cuántos días antes corra el cron, siempre genera el MISMO external_ref
 * para ese ciclo -- es lo que permite detectar "ya se sincronizó este
 * ciclo" y no reenviar todos los días entre hoy y el vencimiento. */
function periodoDelCiclo(nextBillingDate) {
  const d = new Date(nextBillingDate);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Arma el payload de prefactura para un tenant a partir de su fila en
 * `tenants` + su TenantSubscription activa. Devuelve null si el tenant no
 * tiene con qué facturarlo (sin suscripción activa) -- se salta, no es error.
 */
function construirPrefactura(tenant) {
  const sub = tenant.subscriptions?.[0];
  if (!sub || !sub.next_billing_date) return null;

  const { numero, dv } = partirTaxId(tenant.tax_id, tenant.dian_config);
  const periodo = periodoDelCiclo(sub.next_billing_date);
  const externalRef = `PBX-SUB-${tenant.id}-${periodo}`;

  const subtotal = Number(sub.amount);
  // Servicios SaaS/nube -- excluidos de IVA para este negocio, a diferencia
  // de una venta de bien o servicio gravado normal. Antes se cobraba 19%
  // de más sobre cada suscripción.
  const iva = 0;

  return {
    externalRef,
    cliente: {
      tipo_documento: 'NIT',
      numero_documento: numero,
      dv,
      razon_social: tenant.business_name || tenant.company_name,
      email: tenant.email,
      telefono: tenant.phone || '',
      direccion: tenant.address || '',
      ciudad: tenant.ncf_ciudad || '',
      regimen_code: tenant.ncf_regimen_code || 'O-47',
    },
    items: [{
      descripcion: `Suscripción Pitbox - ${sub.plan?.name || 'Plan'} - ${sub.billing_cycle === 'yearly' ? 'Anual' : 'Mensual'} (vence ${new Date(sub.next_billing_date).toLocaleDateString('es-CO')})`,
      cantidad: 1,
      valor_unitario: subtotal,
      iva,
    }],
    fechaLimitePago: new Date(sub.next_billing_date).toISOString().slice(0, 10),
    moneda: sub.currency || 'COP',
  };
}

/**
 * Sincroniza TODO el sistema de una: recorre los tenants activos cuya
 * fecha de corte cae dentro de la ventana de anticipación (por defecto
 * los próximos 7 días, más cualquiera que ya esté vencido sin sincronizar)
 * y envía/actualiza su prefactura en el Núcleo.
 *
 * @param {boolean} forzar - si es true, ignora la ventana de anticipación
 *   y el chequeo de "ya sincronizado este ciclo" -- para pruebas o para
 *   forzar un reenvío puntual desde el panel.
 */
async function sincronizarTodosLosTenants({ forzar = false } = {}) {
  const config = await ncfClient.getConfig();
  if (!config?.is_active) {
    throw new Error('La conexión con el Núcleo NCF no está activa. Actívala primero en Facturación Núcleo (NCF).');
  }

  const limite = new Date();
  limite.setDate(limite.getDate() + ANTICIPATION_DAYS);

  const tenants = await Tenant.findAll({
    where: {
      is_active: true,
      subscription_status: { [Op.in]: ['active', 'past_due', 'trial'] },
      // Control fino por tenant: aunque el job/botón corra, solo se procesan
      // los que ya se marcaron "Listo a sincronizar" (después de cargarles
      // ciudad/tarifa/fecha de cobro) -- ver panel Facturación Núcleo (NCF).
      ncf_sync_enabled: true,
    },
    include: [{
      model: TenantSubscription,
      as: 'subscriptions',
      where: {
        status: { [Op.in]: ['active', 'past_due'] },
        ...(forzar ? {} : { next_billing_date: { [Op.lte]: limite } }),
      },
      required: true, // sin suscripción vigente dentro de la ventana, no hay nada que sincronizar
      limit: 1,
      order: [['created_at', 'DESC']],
      include: [{ model: SubscriptionPlan, as: 'plan', required: false }],
    }],
  });

  const resultados = [];

  for (const tenant of tenants) {
    const payload = construirPrefactura(tenant);

    if (!payload) {
      resultados.push({
        tenant_id: tenant.id,
        tenant: tenant.business_name || tenant.company_name,
        ok: null,
        status: 'sin_suscripcion',
        message: 'No tiene una suscripción vigente con fecha de corte -- se omite',
      });
      continue;
    }

    // "Ya sincronizado" solo debe frenar reenvíos de un ciclo que salió bien
    // (pendiente de pago, pagado, facturado...) -- si el intento anterior de
    // ESTE MISMO ciclo quedó 'rejected' o 'error' (ej. faltaba la ciudad del
    // tenant), hay que reintentarlo solo, sin necesitar el botón "forzar":
    // ya se corrigió el dato, pero el ciclo (external_ref) es el mismo.
    const cicloAnteriorFallido = ['rejected', 'error'].includes(tenant.ncf_last_status);
    if (!forzar && !cicloAnteriorFallido && tenant.ncf_external_ref === payload.externalRef) {
      resultados.push({
        tenant_id: tenant.id,
        tenant: tenant.business_name || tenant.company_name,
        ok: null,
        status: 'ya_sincronizado',
        message: `Ya se generó la prefactura de este ciclo (vence ${payload.fechaLimitePago}) -- no se reenvía`,
      });
      continue;
    }

    try {
      const data = await ncfClient.enviarPrefactura(payload);
      await tenant.update({
        ncf_external_ref: payload.externalRef,
        ncf_last_sync_at: new Date(),
        ncf_last_status: data.status,
        ncf_payment_link_url: data.payment_link_url || tenant.ncf_payment_link_url,
        ncf_last_error: data.status === 'rejected' ? data.rejection_reason : null,
      });
      resultados.push({
        tenant_id: tenant.id,
        tenant: tenant.business_name || tenant.company_name,
        ok: data.status !== 'rejected',
        status: data.status,
        message: data.rejection_reason || `Enviado -- vence ${payload.fechaLimitePago}`,
      });
    } catch (err) {
      await tenant.update({
        ncf_last_sync_at: new Date(),
        ncf_last_status: 'error',
        ncf_last_error: err.response?.data?.error || err.message,
      });
      logger.error(`[NCF Sync] Error con tenant ${tenant.id}: ${err.message}`);
      resultados.push({
        tenant_id: tenant.id,
        tenant: tenant.business_name || tenant.company_name,
        ok: false,
        status: 'error',
        message: err.response?.data?.error || err.message,
      });
    }
  }

  logger.info(`[NCF Sync] Sincronización completa: ${resultados.length} tenants evaluados (ventana ${ANTICIPATION_DAYS}d, forzar=${forzar})`);
  return resultados;
}

/**
 * Suspende (por impago) a los tenants cuya fecha de corte + los días de
 * gracia (NCF_SUSPENSION_GRACE_DAYS, por defecto 2) ya pasaron y siguen
 * sin pagar según el último estado que reportó el Núcleo. Corre en el
 * mismo cron diario que sincronizarTodosLosTenants -- ver scheduler.js.
 *
 * "Sin pagar" = ncf_last_status no es 'paid' ni 'invoiced'. Si el tenant
 * no usa facturación centralizada (nunca se le generó una prefactura,
 * ncf_external_ref null), se omite -- no hay de dónde saber si pagó o no
 * por este canal, y no es este job el que debe decidir sobre esos casos.
 */
async function revisarSuspensiones() {
  const limite = new Date();
  limite.setDate(limite.getDate() - GRACE_DAYS);

  const tenants = await Tenant.findAll({
    where: {
      is_active: true,
      subscription_status: 'active', // 'past_due' no es un valor válido acá, ver nota en ncfWebhook.controller.js
      ncf_external_ref: { [Op.ne]: null },
      ncf_last_status: { [Op.notIn]: ['paid', 'invoiced'] },
    },
    include: [{
      model: TenantSubscription,
      as: 'subscriptions',
      where: {
        status: { [Op.in]: ['active', 'past_due'] },
        next_billing_date: { [Op.lte]: limite },
      },
      required: true,
      limit: 1,
      order: [['created_at', 'DESC']],
    }],
  });

  const suspendidos = [];

  for (const tenant of tenants) {
    const sub = tenant.subscriptions[0];

    await tenant.update({ subscription_status: 'suspended' });
    await sub.update({ status: 'suspended' });

    logger.warn(`[NCF Sync] Tenant ${tenant.id} (${tenant.business_name || tenant.company_name}) suspendido por impago -- venció ${new Date(sub.next_billing_date).toLocaleDateString('es-CO')}, gracia de ${GRACE_DAYS} días agotada`);

    try {
      const emailService = require('../emailService');
      await emailService.sendSubscriptionSuspendedEmail(tenant.id, {
        fecha_vencimiento: sub.next_billing_date,
        payment_link_url: tenant.ncf_payment_link_url,
      });
    } catch (e) {
      logger.error(`[NCF Sync] Error notificando suspensión a tenant ${tenant.id}: ${e.message}`);
    }

    suspendidos.push({ tenant_id: tenant.id, tenant: tenant.business_name || tenant.company_name });
  }

  if (suspendidos.length > 0) {
    logger.warn(`[NCF Sync] ${suspendidos.length} tenant(s) suspendido(s) por impago`);
  }

  return suspendidos;
}

/**
 * Avanza next_billing_date al siguiente ciclo (mensual/anual) -- se llama
 * al confirmar el pago (ver ncfWebhook.controller.js). Sin esto, el mismo
 * ciclo quedaría marcado como "ya sincronizado" para siempre y el tenant
 * nunca volvería a facturarse.
 */
function calcularProximoCiclo(fechaActual, billingCycle) {
  const next = new Date(fechaActual);
  if (billingCycle === 'yearly') next.setFullYear(next.getFullYear() + 1);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

module.exports = {
  sincronizarTodosLosTenants,
  revisarSuspensiones,
  construirPrefactura,
  periodoDelCiclo,
  calcularProximoCiclo,
};
