// backend/src/services/solar/solarPublic.service.js
//
// Simulador solar público (módulo Proyectos): una página por empresa
// (/simulador/<slug>) que se puede incrustar en su sitio web. El visitante ve
// gratis la potencia, la producción y el ahorro estimados; para ver el rango
// de inversión y el retorno deja sus datos con autorización de tratamiento
// (Ley 1581). Con eso se crean el cliente, el estudio solar en borrador, la
// oportunidad en el CRM (si el módulo está activo) y se avisa por correo.
//
// Todo es ESTIMADO: el aviso (DISCLAIMER) lo devuelve config y lo muestra la
// página siempre; el precio va como rango (± public_price_range_pct).
//
// Protección: límites por IP (middleware/rateLimiter.js), campo trampa
// (website) y, si está configurado TURNSTILE_SECRET_KEY, Cloudflare Turnstile.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');
const { runWithTenantSchema } = require('../../config/tenantContext');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// Rango redondeado a cientos de miles: un valor "exacto" se lee como oferta.
const roundRange = (n) => Math.round(n / 100000) * 100000;

const DISCLAIMER = 'Valores estimados con fines informativos, calculados con la radiación solar promedio de tu ubicación y supuestos generales de instalación. '
  + 'No constituyen una oferta comercial ni un compromiso de precio, diseño, producción o ahorro. '
  + 'La propuesta formal requiere una visita técnica y puede variar según el sitio, los equipos disponibles y los trámites.';

const consentText = (company, privacyUrl) => `Autorizo a ${company} a tratar mis datos personales (nombre, teléfono, correo, ciudad y dirección del inmueble) `
  + 'para contactarme, agendar una visita técnica y enviarme información y cotizaciones sobre sistemas de energía solar, conforme a su política de tratamiento de datos '
  + `(${privacyUrl}) y a la Ley 1581 de 2012. Puedo conocer, actualizar, rectificar o suprimir mis datos y revocar esta autorización en cualquier momento.`;

// ── Empresa por slug ──────────────────────────────────────────────────
async function resolveTenant(slug) {
  if (!/^[a-z0-9-]{2,80}$/i.test(String(slug || ''))) throw httpError(404, 'Simulador no encontrado');
  const [rows] = await sequelize.query(
    `SELECT id, schema_name, company_name, business_name, logo_url, primary_color, phone, email, is_active
       FROM "public"."tenants" WHERE slug = :slug LIMIT 1`,
    { replacements: { slug: String(slug).toLowerCase() } },
  );
  const t = rows[0];
  if (!t || t.is_active === false) throw httpError(404, 'Simulador no encontrado');
  const { getEffectiveModulesForTenantId } = require('../moduleAccess');
  const modules = await getEffectiveModulesForTenantId(t.id);
  if (!modules.includes('projects')) throw httpError(404, 'Simulador no encontrado');
  return { ...t, modules };
}

async function withTenant(slug, fn) {
  const tenant = await resolveTenant(slug);
  return runWithTenantSchema(tenant.schema_name || null, async () => {
    const { SolarSetting } = require('../../models');
    const settings = await SolarSetting.findByPk(tenant.id);
    if (!settings?.public_enabled) throw httpError(404, 'El simulador no está disponible');
    return fn(tenant, settings);
  });
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) throw httpError(400, 'Completa la verificación de seguridad');
  try {
    const form = new URLSearchParams({ secret, response: String(token) });
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(10000) });
    const body = await res.json();
    if (!body.success) throw httpError(400, 'No pudimos verificar que no eres un robot: recarga la página e intenta de nuevo');
    return true;
  } catch (error) {
    if (error.statusCode) throw error;
    logger.warn(`[solar-public] Turnstile: ${error.message}`);
    return true; // si Cloudflare no responde, no se bloquea al visitante (quedan los límites por IP)
  }
}

// ── Configuración visible ─────────────────────────────────────────────
function config(slug) {
  return withTenant(slug, async (tenant, settings) => {
    const company = tenant.business_name || tenant.company_name;
    return {
      company,
      logo_url: tenant.logo_url || null,
      primary_color: tenant.primary_color || null,
      title: settings.public_title || 'Calcula tu sistema de energía solar',
      intro: settings.public_intro || 'Con tu consumo de energía y tu ubicación te mostramos cuántos paneles necesitas, cuánta energía producirían y cuánto podrías ahorrar.',
      price_range_pct: num(settings.public_price_range_pct),
      default_tariff: num(settings.public_default_tariff),
      privacy_url: settings.public_privacy_url,
      whatsapp: settings.public_whatsapp || null,
      disclaimer: DISCLAIMER,
      consent_text: consentText(company, settings.public_privacy_url),
      ocr_available: require('../ocr/ocrClient').isConfigured(),
      turnstile_site_key: process.env.TURNSTILE_SITE_KEY || null,
    };
  });
}

// ── Estimado ──────────────────────────────────────────────────────────
function studyInputs(body, settings) {
  const segment = body.segment === 'comercial' ? 'comercial' : 'residencial';
  const tariff = num(body.tariff_kwh) > 100 && num(body.tariff_kwh) < 3000 ? num(body.tariff_kwh) : num(settings.public_default_tariff) || 900;
  let monthlyKwh = num(body.monthly_kwh);
  if (!(monthlyKwh > 0) && num(body.bill_amount) > 0) monthlyKwh = Math.round(num(body.bill_amount) / tariff);
  if (!(monthlyKwh >= 30 && monthlyKwh <= 200000)) throw httpError(400, 'Indica tu consumo mensual (kWh) o el valor de tu factura');
  const hspMonthly = Array.isArray(body.hsp_monthly) && body.hsp_monthly.length === 12 && body.hsp_monthly.every((v) => num(v) > 0 && num(v) < 10)
    ? body.hsp_monthly.map(num) : null;
  const hsp = num(body.hsp) > 1 && num(body.hsp) < 10 ? num(body.hsp) : null;
  return {
    segment,
    monthly_kwh: monthlyKwh,
    tariff_kwh: tariff,
    coverage_pct: 100,
    hsp,
    hsp_monthly: hspMonthly,
    roof: ['inclinado', 'plano', 'industrial', 'mixto'].includes(body.roof) ? body.roof : (segment === 'comercial' ? 'industrial' : 'inclinado'),
    orientation: 'norte',
    tilt: 10,
    shading_pct: 5,
  };
}

const publicResult = (r, inputs) => ({
  monthly_kwh: inputs.monthly_kwh,
  tariff_kwh: inputs.tariff_kwh,
  kwp: r.kwp,
  panels: r.panels,
  panel_watts: r.panel_watts,
  hsp: r.hsp,
  production_month: r.production_month,
  production_monthly: r.production_monthly,
  production_year: r.production_year,
  target_kwh: r.target_kwh,
  coverage_pct: r.coverage_pct,
  savings_month: r.savings_month,
  savings_year: r.savings_year,
});

function priceRange(r, settings) {
  if (!(r.total > 0) || !r.lines.some((l) => l.kind === 'panel' && l.unit_price > 0)) return null;
  const pct = num(settings.public_price_range_pct) / 100;
  const min = roundRange(r.total * (1 - pct));
  const max = roundRange(r.total * (1 + pct));
  return {
    price_min: min,
    price_max: max,
    payback_years_min: r.savings_month > 0 ? Math.round((min / r.savings_month / 12) * 10) / 10 : null,
    payback_years_max: r.savings_month > 0 ? Math.round((max / r.savings_month / 12) * 10) / 10 : null,
    tax_deduction_note: 'Los proyectos de energía solar pueden acceder a beneficios tributarios de la Ley 1715 de 2014 (deducción en renta, exclusión de IVA y exención de aranceles), sujetos a certificación de la UPME.',
  };
}

function estimate(slug, body) {
  return withTenant(slug, async (tenant, settings) => {
    const inputs = studyInputs(body, settings);
    const { results } = await require('./solar.service').computeStudy(tenant.id, inputs);
    return publicResult(results, inputs);
  });
}

// ── Interesado ────────────────────────────────────────────────────────
function cleanContact(body) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 150);
  const phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 150);
  const city = String(body.city || '').trim().slice(0, 120);
  const address = String(body.address || '').trim().replace(/\s+/g, ' ').slice(0, 255);
  if (name.length < 3) throw httpError(400, 'Escribe tu nombre');
  if (phone.replace(/\D/g, '').length < 7) throw httpError(400, 'Escribe un teléfono de contacto válido');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Revisa tu correo');
  if (body.consent !== true) throw httpError(400, 'Para continuar debes autorizar el tratamiento de tus datos');
  return { name, phone, email: email || null, city: city || null, address: address || null };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function notify(tenant, settings, lead, study, result) {
  try {
    const { User } = require('../../models');
    let to = String(settings.public_notify_emails || '').split(/[,;\s]+/).filter(Boolean);
    if (!to.length) {
      const users = await User.findAll({ where: { tenant_id: tenant.id, is_active: true, role: { [Op.in]: ['admin', 'manager'] } }, attributes: ['email'] });
      to = users.map((u) => u.email).filter(Boolean);
    }
    if (!to.length) return;
    const base = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');
    const money = (n) => `$ ${Math.round(n).toLocaleString('es-CO')}`;
    await require('../emailService').sendEmail({
      to,
      subject: `Nuevo interesado en energía solar: ${lead.name}`,
      html: `<p>Llegó un interesado desde el simulador solar de tu sitio web:</p>
        <ul>
          <li><strong>${esc(lead.name)}</strong> · ${esc(lead.phone)}${lead.email ? ` · ${esc(lead.email)}` : ''}${lead.city ? ` · ${esc(lead.city)}` : ''}</li>
          ${lead.address ? `<li>Dirección del inmueble: ${esc(lead.address)}</li>` : ''}
          <li>Consumo: ${Math.round(num(lead.monthly_kwh)).toLocaleString('es-CO')} kWh/mes (${lead.segment})</li>
          <li>Sistema estimado: ${Number(result.kwp).toLocaleString('es-CO')} kWp (${result.panels} paneles)${lead.price_min ? ` · inversión estimada ${money(lead.price_min)} a ${money(lead.price_max)}` : ''}</li>
        </ul>
        ${base ? `<p><a href="${base}/solar/${study.id}">Abrir el estudio ${study.number}</a> · <a href="${base}/solar/leads">Ver interesados</a></p>` : ''}`,
    });
  } catch (error) {
    logger.warn(`[solar-public] No se pudo avisar el interesado ${lead.id}: ${error.message}`);
  }
}

async function createLead(slug, body, meta) {
  if (body.website) throw httpError(400, 'Solicitud inválida'); // campo trampa para bots
  const contact = cleanContact(body);
  await verifyTurnstile(body.turnstile_token, meta.ip);
  return withTenant(slug, async (tenant, settings) => {
    const { Customer, Opportunity, CustomerInteraction, SolarLead } = require('../../models');
    const solar = require('./solar.service');
    const inputs = studyInputs(body, settings);
    const { results } = await solar.computeStudy(tenant.id, inputs);
    const range = priceRange(results, settings);

    // Cliente: el que ya tenga ese teléfono o correo, o uno nuevo.
    let customer = await Customer.findOne({ where: { tenant_id: tenant.id, [Op.or]: [{ phone: contact.phone }, { mobile: contact.phone }, ...(contact.email ? [{ email: contact.email }] : [])] } });
    if (!customer) {
      const parts = contact.name.split(' ');
      customer = await Customer.create({
        tenant_id: tenant.id, first_name: parts[0], last_name: parts.slice(1).join(' ') || '', phone: contact.phone,
        email: contact.email, city: contact.city, address: contact.address, customer_type: 'individual', is_active: true,
      });
    } else if (contact.address && !customer.address) {
      await customer.update({ address: contact.address });
    }

    const lat = num(body.latitude); const lon = num(body.longitude);
    const study = await solar.saveStudy(tenant.id, null, null, {
      customer_id: customer.id,
      title: `Simulador web — ${contact.name}`.slice(0, 200),
      system_type: 'ongrid',
      city: contact.city || String(body.place_city || '').slice(0, 120) || null,
      department: String(body.place_department || '').slice(0, 120) || null,
      address: contact.address,
      latitude: lat >= -5 && lat <= 14 ? lat : null,
      longitude: lon >= -82 && lon <= -66 ? lon : null,
      hsp: inputs.hsp, hsp_monthly: inputs.hsp_monthly, hsp_source: inputs.hsp_monthly ? 'nasa_power' : null,
      monthly_kwh: inputs.monthly_kwh, tariff_kwh: inputs.tariff_kwh,
      bill_data: body.bill_data && typeof body.bill_data === 'object' ? body.bill_data : null,
      notes: `Captado por el simulador web (${inputs.segment}).`,
      coverage_pct: inputs.coverage_pct, roof: inputs.roof, orientation: inputs.orientation, tilt: inputs.tilt, shading_pct: inputs.shading_pct,
    });

    let opportunityId = null;
    if (tenant.modules.includes('crm')) {
      try {
        const opportunity = await Opportunity.create({
          tenant_id: tenant.id, customer_id: customer.id, source: 'web', stage: 'nuevo', stage_changed_at: new Date(),
          expected_value: results.total > 0 ? round2(results.total) : null,
        });
        opportunityId = opportunity.id;
        await CustomerInteraction.create({
          tenant_id: tenant.id, customer_id: customer.id, user_id: null, type: 'nota', outcome: 'sin_respuesta',
          summary: `Simulador solar web: ${inputs.monthly_kwh} kWh/mes, sistema estimado ${results.kwp} kWp (${results.panels} paneles). Estudio ${study.number}.`,
        });
        await require('../crmAutomationEngine').applyOpportunityCreatedRules(tenant.id, opportunity);
      } catch (error) {
        logger.warn(`[solar-public] Oportunidad del interesado ${customer.id}: ${error.message}`);
      }
    }

    const lead = await SolarLead.create({
      tenant_id: tenant.id, study_id: study.id, customer_id: customer.id, opportunity_id: opportunityId,
      ...contact, segment: inputs.segment, monthly_kwh: inputs.monthly_kwh, kwp: results.kwp,
      price_min: range?.price_min ?? null, price_max: range?.price_max ?? null,
      consent_text: consentText(tenant.business_name || tenant.company_name, settings.public_privacy_url),
      consent_at: new Date(), consent_ip: String(meta.ip || '').slice(0, 64) || null,
      user_agent: String(meta.userAgent || '').slice(0, 300) || null, referrer: String(meta.referrer || '').slice(0, 500) || null,
    });
    setImmediate(() => runWithTenantSchema(tenant.schema_name || null, () => notify(tenant, settings, lead, study, results)));

    return {
      ...publicResult(results, inputs),
      ...(range || { price_min: null, price_max: null }),
      lead_id: lead.id,
      whatsapp: settings.public_whatsapp || null,
      message: `Gracias, ${contact.name.split(' ')[0]}. Un asesor de ${tenant.business_name || tenant.company_name} te contactará para revisar tu caso y preparar la propuesta formal.`,
    };
  });
}

// ── Lectura de la factura ─────────────────────────────────────────────
async function readBill(slug, file, body, meta) {
  if (!file) throw httpError(400, 'Adjunta la factura (PDF o foto)');
  await verifyTurnstile(body.turnstile_token, meta.ip);
  return withTenant(slug, async (tenant) => {
    const { extractText } = require('../ocr/ocrClient');
    const { parseEnergyBill } = require('./energyBillParser');
    const { text } = await extractText({ buffer: file.buffer, filename: file.originalname, mimeType: file.mimetype, documentId: `solar-public-${tenant.id}` });
    const f = parseEnergyBill(text);
    // Al público solo lo útil para el cálculo (no se devuelve el texto completo).
    return {
      monthly_kwh: f.monthly_kwh || null, last_month_kwh: f.last_month_kwh || null, history_kwh: f.history_kwh || null,
      tariff_kwh: f.tariff_kwh || null, city: f.city || null, address: f.address || null, segment: f.segment || null, operator: f.operator || null,
      no_energy: Boolean(f.no_energy),
    };
  });
}

module.exports = { config, estimate, createLead, readBill, DISCLAIMER, consentText, priceRange, studyInputs };
