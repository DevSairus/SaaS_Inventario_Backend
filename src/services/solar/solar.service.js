// backend/src/services/solar/solar.service.js
//
// Cotizador solar integrado (Fase 3 del módulo Proyectos): estudio →
// cotización (COT-) → proyecto con lista de materiales y presupuesto.
//
// Servicios externos (con alternativa manual si fallan):
//   - Geocodificación: OpenStreetMap Nominatim (política de uso: User-Agent
//     propio y máximo 1 consulta por segundo; se cachea).
//   - Radiación: NASA POWER, climatología mensual ALLSKY_SFC_SW_DWN
//     (kWh/m²/día = horas sol pico); se cachea por coordenada.
//   - OCR de la factura de energía: servicio OCR propio (ocr-service/, en
//     Railway junto al backend; ver services/ocr/ocrClient.js).
//
// La cotización se crea con el mismo endpoint de ventas (POST /api/sales,
// document_type 'cotizacion') para usar sus impuestos, AIU y numeración: aquí
// se arma el cuerpo (quotePayload) y luego se vincula (linkQuote).

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');
const {
  SolarSetting, SolarStudy, Product, Customer, Sale, Project, ProjectBudgetLine, User,
} = require('../../models');
const { calculate, budgetFromResults } = require('./solarCalc');
const { parseEnergyBill } = require('./energyBillParser');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const USER_AGENT = 'Pitbox-ERP/1.0 (cotizador solar; soporte@pitbox.com.co)';

const DEFAULT_CONDITIONS = [
  'Tiempo de ejecución: 60 días hábiles desde el anticipo.',
  'Trámite RETIE: 20 días hábiles. Trámite ante el operador de red: hasta 60 días hábiles.',
  'Garantía de obra: 3 años. Mantenimiento preventivo incluido el primer año.',
  'La producción es una estimación con radiación promedio histórica (NASA POWER); la real depende del clima de cada año.',
].join('\n');

// ── Parámetros ────────────────────────────────────────────────────────
const SETTINGS_FIELDS = [
  'price_per_kwp', 'labor_pct', 'electrical_pct', 'consulting_pct', 'service_tax_pct', 'performance_ratio',
  'default_hsp', 'dc_ac_ratio', 'panel_product_id', 'panel_watts', 'inverter_product_id', 'use_aiu',
  'aiu_admin_pct', 'aiu_unforeseen_pct', 'aiu_profit_pct', 'validity_days', 'payment_terms', 'conditions',
  'public_enabled', 'public_title', 'public_intro', 'public_price_range_pct', 'public_default_tariff',
  'public_privacy_url', 'public_notify_emails', 'public_whatsapp',
];
const productAttrs = ['id', 'sku', 'name', 'base_price', 'sale_price', 'average_cost', 'last_purchase_cost', 'has_tax', 'tax_percentage', 'price_includes_tax', 'tax_config', 'current_stock', 'product_type'];

async function getSettings(tenantId) {
  const [settings] = await SolarSetting.findOrCreate({
    where: { tenant_id: tenantId },
    defaults: { tenant_id: tenantId, conditions: DEFAULT_CONDITIONS, payment_terms: [
      { pct: 50, label: 'Anticipo al inicio' }, { pct: 20, label: 'Llegada de equipos' },
      { pct: 20, label: 'Fin de la instalación' }, { pct: 10, label: 'Inyección a la red' },
    ] },
  });
  await settings.reload({
    include: [
      { model: Product, as: 'panel_product', attributes: productAttrs },
      { model: Product, as: 'inverter_product', attributes: productAttrs },
    ],
  });
  const json = settings.toJSON();
  json.ocr_available = require('../ocr/ocrClient').isConfigured();
  // ocr_api_key (OCR.space) ya no se usa: la lectura es con el OCR propio.
  delete json.ocr_api_key;
  json.tenant_aiu_enabled = await tenantAiuEnabled(tenantId);
  return json;
}

async function tenantAiuEnabled(tenantId) {
  const { Tenant } = require('../../models');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['tax_config'] });
  return Boolean(tenant?.tax_config?.aiu?.enabled);
}

async function updateSettings(tenantId, userId, body) {
  const data = {};
  for (const k of SETTINGS_FIELDS) if (body[k] !== undefined) data[k] = body[k];
  const pcts = ['labor_pct', 'electrical_pct', 'consulting_pct', 'service_tax_pct', 'aiu_admin_pct', 'aiu_unforeseen_pct', 'aiu_profit_pct'];
  for (const k of pcts) {
    if (data[k] === undefined) continue;
    const n = Number(data[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw httpError(400, 'Los porcentajes van de 0 a 100');
    data[k] = n;
  }
  if (data.price_per_kwp !== undefined && !(Number(data.price_per_kwp) >= 0)) throw httpError(400, 'Precio por kWp inválido');
  if (data.performance_ratio !== undefined) {
    const pr = Number(data.performance_ratio);
    if (!(pr >= 0.4 && pr <= 1)) throw httpError(400, 'La eficiencia del sistema va de 0,40 a 1,00');
  }
  if (data.panel_watts !== undefined && !(Number(data.panel_watts) >= 100 && Number(data.panel_watts) <= 1000)) throw httpError(400, 'La potencia del panel va de 100 a 1000 W');
  if (data.payment_terms !== undefined) {
    if (!Array.isArray(data.payment_terms)) throw httpError(400, 'Forma de pago inválida');
    data.payment_terms = data.payment_terms
      .map((p) => ({ pct: Number(p.pct), label: String(p.label || '').trim().slice(0, 80) }))
      .filter((p) => p.pct > 0 && p.label);
    const sum = data.payment_terms.reduce((s, p) => s + p.pct, 0);
    if (data.payment_terms.length && Math.abs(sum - 100) > 0.01) throw httpError(400, `Los pagos deben sumar 100 % (suman ${sum} %)`);
  }
  if (data.use_aiu && !(await tenantAiuEnabled(tenantId))) {
    throw httpError(400, 'La facturación AIU no está habilitada para la empresa: actívala en Ajustes → Impuestos o cotiza sin AIU');
  }
  if (data.use_aiu || (data.aiu_profit_pct !== undefined && data.aiu_profit_pct <= 0)) {
    const current = await getSettings(tenantId);
    const profit = data.aiu_profit_pct ?? Number(current.aiu_profit_pct);
    if ((data.use_aiu ?? current.use_aiu) && !(profit > 0)) throw httpError(400, 'Con AIU la Utilidad debe ser mayor a 0 (es la base del IVA)');
  }
  // Simulador público
  if (data.public_price_range_pct !== undefined) {
    const n = Number(data.public_price_range_pct);
    if (!(n >= 0 && n <= 50)) throw httpError(400, 'El rango de precio va de 0 % a 50 %');
    data.public_price_range_pct = n;
  }
  if (data.public_default_tariff !== undefined && !(Number(data.public_default_tariff) > 100 && Number(data.public_default_tariff) < 3000)) {
    throw httpError(400, 'La tarifa por defecto debe estar entre 100 y 3.000 $/kWh');
  }
  for (const k of ['public_title', 'public_intro', 'public_whatsapp']) {
    if (data[k] !== undefined) data[k] = String(data[k] || '').trim() || null;
  }
  if (data.public_privacy_url !== undefined) {
    const url = String(data.public_privacy_url || '').trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw httpError(400, 'La política de datos debe ser un enlace http(s)');
    data.public_privacy_url = url || null;
  }
  if (data.public_notify_emails !== undefined) {
    const emails = String(data.public_notify_emails || '').split(/[,;\s]+/).filter(Boolean);
    if (emails.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) throw httpError(400, 'Revisa los correos de aviso');
    data.public_notify_emails = emails.join(', ') || null;
  }
  if (data.public_enabled) {
    const current = await SolarSetting.findByPk(tenantId);
    const privacy = data.public_privacy_url !== undefined ? data.public_privacy_url : current?.public_privacy_url;
    if (!privacy) throw httpError(400, 'Para publicar el simulador indica el enlace a la política de tratamiento de datos (Ley 1581)');
  }
  for (const k of ['panel_product_id', 'inverter_product_id']) {
    if (!data[k]) { if (data[k] !== undefined) data[k] = null; continue; }
    const ok = await Product.count({ where: { id: data[k], tenant_id: tenantId } });
    if (!ok) throw httpError(400, 'Producto no encontrado');
  }
  await getSettings(tenantId);
  await SolarSetting.update({ ...data, updated_by: userId }, { where: { tenant_id: tenantId } });
  return getSettings(tenantId);
}

// ── Servicios externos ────────────────────────────────────────────────
const geoCache = new Map();
const irradianceCache = new Map();

async function fetchJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// En OpenStreetMap cada municipio colombiano tiene dos límites: el municipio
// entero (con la zona rural; su centro puede quedar a 5-15 km de la ciudad) y
// el "Perímetro urbano" / "Casco urbano" / "X ciudad". Por municipio se queda
// el punto de la población, luego el perímetro urbano y por último el
// municipio entero. Barrios, veredas y lugares sueltos pasan tal cual.
const URBAN_PREFIX = /^(?:per[ií]metro\s+urbano|casco\s+urbano)(?:\s+de)?\s+/i;
const URBAN_SUFFIX = /\s+ciudad$/i;
const MUNICIPAL = new Set(['municipality', 'county', 'subregion', 'state_district']);
const SETTLEMENT = new Set(['city', 'town', 'village']);
const baseName = (s) => String(s || '').replace(URBAN_PREFIX, '').replace(URBAN_SUFFIX, '').trim();
const normName = (s) => baseName(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function geocodeRank(r) {
  if (r.class === 'place') return 0;
  if (URBAN_PREFIX.test(r.name || '') || URBAN_SUFFIX.test(r.name || '')) return 1;
  if (SETTLEMENT.has(r.addresstype)) return 2;
  if (MUNICIPAL.has(r.addresstype)) return 3;
  return null; // barrio, vereda, calle…: sin agrupar
}

function pickGeocodeResults(rows) {
  const groups = new Map();
  const loose = [];
  rows.forEach((r, i) => {
    const k = geocodeRank(r);
    if (k === null) { loose.push({ r, k, i }); return; }
    const key = `${normName(r.name)}|${r.address?.state || ''}`;
    const prev = groups.get(key);
    if (!prev || k < prev.k) groups.set(key, { r, k, i: prev ? prev.i : i });
  });
  // Un resultado suelto con el nombre de un municipio ya encontrado es el mismo
  // municipio con otro tipo de límite: se descarta.
  const names = new Set([...groups.keys()].map((k) => k.split('|')[0]));
  return [...groups.values(), ...loose.filter(({ r }) => !names.has(normName(r.name)))]
    .sort((a, b) => a.i - b.i)
    .slice(0, 5)
    .map(({ r, k }) => {
      const department = r.address?.state || null;
      const city = k === null
        ? r.address?.city || r.address?.town || r.address?.village || r.address?.municipality || null
        : baseName(r.name) || null;
      return {
        label: k === null ? r.display_name : [city, department].filter(Boolean).join(', '),
        latitude: Number(r.lat),
        longitude: Number(r.lon),
        city,
        department,
      };
    });
}

async function geocode(query) {
  const q = String(query || '').trim();
  if (q.length < 3) throw httpError(400, 'Escribe una ciudad o dirección');
  const key = q.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=10&countrycodes=co&addressdetails=1&q=${encodeURIComponent(q)}`;
    const rows = await fetchJson(url, { headers: { 'Accept-Language': 'es' } });
    const results = pickGeocodeResults(rows);
    geoCache.set(key, results);
    return results;
  } catch (error) {
    logger.warn(`[solar] Geocodificación "${q}": ${error.message}`);
    throw httpError(502, 'No se pudo consultar el mapa (OpenStreetMap). Ingresa la latitud y longitud a mano.');
  }
}

async function irradiance(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!(la >= -5 && la <= 14 && lo >= -82 && lo <= -66)) throw httpError(400, 'Las coordenadas deben estar en Colombia');
  const key = `${la.toFixed(2)},${lo.toFixed(2)}`;
  if (irradianceCache.has(key)) return irradianceCache.get(key);
  try {
    const url = 'https://power.larc.nasa.gov/api/temporal/climatology/point'
      + `?parameters=ALLSKY_SFC_SW_DWN&community=RE&longitude=${lo.toFixed(4)}&latitude=${la.toFixed(4)}&format=JSON`;
    const data = await fetchJson(url, { timeoutMs: 25000 });
    const p = data?.properties?.parameter?.ALLSKY_SFC_SW_DWN;
    if (!p) throw new Error('Respuesta sin datos');
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    // La climatología trae los meses por nombre (JAN..DEC); versiones viejas, por número.
    const monthly = months.map((m, i) => round2(num(p[m] ?? p[String(i + 1).padStart(2, '0')])));
    if (monthly.some((v) => !(v > 0))) throw new Error('Datos mensuales incompletos');
    const annual = round2(num(p.ANN) || monthly.reduce((s, v) => s + v, 0) / 12);
    const result = { hsp: annual, hsp_monthly: monthly, source: 'nasa_power' };
    irradianceCache.set(key, result);
    return result;
  } catch (error) {
    logger.warn(`[solar] NASA POWER ${key}: ${error.message}`);
    throw httpError(502, 'No se pudo consultar la radiación solar (NASA POWER). Usa las horas sol pico por defecto o ingrésalas a mano.');
  }
}

async function ocrBill(tenantId, file) {
  if (!file) throw httpError(400, 'Adjunta la factura (PDF o imagen)');
  const { extractText } = require('../ocr/ocrClient');
  const { text } = await extractText({ buffer: file.buffer, filename: file.originalname, mimeType: file.mimetype, documentId: `solar-${tenantId}` });
  if (!text.trim()) throw httpError(422, 'No se detectó texto en la factura. Prueba con una imagen más nítida o ingresa los datos a mano.');
  return { fields: parseEnergyBill(text), text: text.slice(0, 20000) };
}

// ── Cálculo con productos del catálogo ────────────────────────────────
// Precio neto (sin IVA) y tarifa de IVA de un producto, como lo cotizaría ventas.
function productPricing(p) {
  if (!p) return null;
  const status = p.tax_config?.iva_status;
  const hasTax = p.has_tax !== false && status !== 'excluido';
  const rate = hasTax && status !== 'exento' ? num(p.tax_percentage) : 0;
  const listPrice = num(p.base_price) || num(p.sale_price);
  const net = hasTax && p.price_includes_tax ? listPrice / (1 + rate / 100) : listPrice;
  return {
    product_id: p.id, name: p.name, sku: p.sku, unit_price: round2(net), list_price: listPrice, tax_pct: rate,
    unit_cost: num(p.average_cost) || num(p.last_purchase_cost) || null, stock: num(p.current_stock),
  };
}

async function loadProducts(tenantId, ids) {
  const clean = [...new Set(ids.filter(Boolean))];
  if (!clean.length) return new Map();
  const rows = await Product.findAll({ where: { id: clean, tenant_id: tenantId }, attributes: productAttrs });
  return new Map(rows.map((p) => [p.id, p]));
}

/**
 * inputs: { monthly_kwh, tariff_kwh, coverage_pct, hsp, hsp_monthly, roof, orientation, tilt, shading_pct,
 *           panel_product_id, panel_watts, inverter_product_id, inverter_quantity, extras: [{ product_id, quantity }] }
 */
async function computeStudy(tenantId, inputs) {
  const settings = await getSettings(tenantId);
  const panelId = inputs.panel_product_id || settings.panel_product_id;
  const inverterId = inputs.inverter_product_id === null ? null : (inputs.inverter_product_id || settings.inverter_product_id);
  const extras = Array.isArray(inputs.extras) ? inputs.extras.filter((e) => e.product_id && num(e.quantity) > 0) : [];
  const products = await loadProducts(tenantId, [panelId, inverterId, ...extras.map((e) => e.product_id)]);
  if (panelId && !products.has(panelId)) throw httpError(400, 'El panel elegido no existe en el catálogo');

  const panelProduct = productPricing(products.get(panelId));
  const panel = panelProduct
    ? { ...panelProduct, watts: num(inputs.panel_watts) || num(settings.panel_watts) }
    : { product_id: null, name: `Panel solar ${num(inputs.panel_watts) || settings.panel_watts} W`, watts: num(inputs.panel_watts) || num(settings.panel_watts), unit_price: 0, tax_pct: 0 };
  const inverterProduct = inverterId ? productPricing(products.get(inverterId)) : null;
  const results = calculate({
    ...inputs,
    panel,
    inverter: inverterProduct ? { ...inverterProduct, quantity: num(inputs.inverter_quantity) || 1 } : null,
    extras: extras.map((e) => ({ ...productPricing(products.get(e.product_id)), quantity: num(e.quantity) })).filter((e) => e.product_id),
  }, settings);
  // Precio de lista por línea (el que se envía a la cotización) y stock.
  for (const l of results.lines) {
    if (!l.product_id) continue;
    const p = productPricing(products.get(l.product_id));
    l.list_price = p.list_price;
    l.sku = p.sku;
    l.stock = p.stock;
  }
  const warnings = [];
  if (!panelProduct) warnings.push('Sin panel del catálogo: elige uno (o configúralo por defecto) para que el equipo tenga precio.');
  else if (!(panelProduct.unit_price > 0)) warnings.push(`El panel «${panelProduct.name}» no tiene precio de venta.`);
  if (!inverterProduct) warnings.push(`Sin inversor del catálogo: elige uno de unos ${results.suggested_inverter_kw} kW.`);
  for (const l of results.lines.filter((x) => x.product_id && x.stock < x.quantity)) {
    warnings.push(`${l.name}: hay ${l.stock} en inventario y se necesitan ${l.quantity}.`);
  }
  return { results, warnings, settings };
}

// ── Estudios ──────────────────────────────────────────────────────────
async function nextStudyNumber(tenantId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `solar_studies:${tenantId}` }, transaction });
  const rows = await SolarStudy.findAll({ where: { tenant_id: tenantId, number: { [Op.like]: 'SOL-%' } }, attributes: ['number'], transaction });
  const max = rows.reduce((m, r) => Math.max(m, parseInt(String(r.number).split('-')[1], 10) || 0), 0);
  return `SOL-${String(max + 1).padStart(4, '0')}`;
}

const STUDY_FIELDS = ['customer_id', 'title', 'system_type', 'city', 'department', 'address', 'latitude', 'longitude', 'hsp', 'hsp_monthly', 'hsp_source', 'monthly_kwh', 'tariff_kwh', 'bill_data', 'notes'];
const INPUT_FIELDS = ['coverage_pct', 'roof', 'orientation', 'tilt', 'shading_pct', 'panel_product_id', 'panel_watts', 'inverter_product_id', 'inverter_quantity', 'extras'];

async function saveStudy(tenantId, userId, id, body) {
  const data = {};
  for (const k of STUDY_FIELDS) if (body[k] !== undefined) data[k] = body[k] === '' ? null : body[k];
  if (data.customer_id) {
    const ok = await Customer.count({ where: { id: data.customer_id, tenant_id: tenantId } });
    if (!ok) throw httpError(400, 'Cliente no encontrado');
  }
  if (data.system_type && !['ongrid', 'offgrid', 'hybrid'].includes(data.system_type)) throw httpError(400, 'Tipo de sistema inválido');
  if (data.hsp_monthly && (!Array.isArray(data.hsp_monthly) || data.hsp_monthly.length !== 12)) data.hsp_monthly = null;

  return sequelize.transaction(async (t) => {
    let study = id ? await SolarStudy.findOne({ where: { id, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE }) : null;
    if (id && !study) throw httpError(404, 'Estudio no encontrado');
    if (study?.status === 'project') throw httpError(409, 'El estudio ya tiene proyecto: crea un estudio nuevo para cotizar de nuevo');
    const inputs = { ...(study?.inputs || {}) };
    for (const k of INPUT_FIELDS) if (body[k] !== undefined) inputs[k] = body[k];
    const merged = { ...(study ? study.toJSON() : {}), ...data };
    const { results } = await computeStudy(tenantId, {
      ...inputs, monthly_kwh: merged.monthly_kwh, tariff_kwh: merged.tariff_kwh, hsp: merged.hsp, hsp_monthly: merged.hsp_monthly,
    });
    const values = { ...data, inputs, results, kwp: results.kwp, total_amount: results.total };
    if (!study) {
      study = await SolarStudy.create({ ...values, tenant_id: tenantId, number: await nextStudyNumber(tenantId, t), created_by: userId }, { transaction: t });
    } else {
      // Cambiar un estudio ya cotizado no cambia la cotización: queda avisado.
      await study.update(values, { transaction: t });
    }
    return study;
  });
}

async function listStudies(tenantId, query = {}) {
  const where = { tenant_id: tenantId };
  if (query.status) where.status = query.status;
  if (query.search) {
    const q = `%${String(query.search).trim()}%`;
    where[Op.or] = [{ number: { [Op.iLike]: q } }, { title: { [Op.iLike]: q } }, { city: { [Op.iLike]: q } }];
  }
  return SolarStudy.findAll({
    where,
    attributes: { exclude: ['bill_data', 'results', 'hsp_monthly'] },
    include: [
      { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] },
      { model: Sale, as: 'quote', attributes: ['id', 'sale_number', 'quote_number', 'quote_status', 'status', 'document_type'] },
      { model: Project, as: 'project', attributes: ['id', 'code', 'name', 'status'] },
      { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] },
    ],
    order: [['created_at', 'DESC']],
    limit: 200,
  });
}

async function getStudy(tenantId, id) {
  const study = await SolarStudy.findOne({
    where: { id, tenant_id: tenantId },
    include: [
      { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'email', 'phone', 'city', 'address'] },
      { model: Sale, as: 'quote', attributes: ['id', 'sale_number', 'quote_number', 'quote_status', 'status', 'document_type', 'total_amount'] },
      { model: Project, as: 'project', attributes: ['id', 'code', 'name', 'status'] },
    ],
  });
  if (!study) throw httpError(404, 'Estudio no encontrado');
  return study;
}

// ── Cotización ────────────────────────────────────────────────────────
/** Cuerpo para POST /api/sales (cotización) con las líneas del estudio. */
async function quotePayload(tenantId, id) {
  const study = await getStudy(tenantId, id);
  if (!study.customer_id) throw httpError(400, 'Elige el cliente del estudio antes de cotizar');
  if (study.quote_id && study.quote) throw httpError(409, `El estudio ya tiene la cotización ${study.quote.quote_number || study.quote.sale_number}`);
  const { results, settings } = await computeStudy(tenantId, {
    ...study.inputs, monthly_kwh: study.monthly_kwh, tariff_kwh: study.tariff_kwh, hsp: study.hsp, hsp_monthly: study.hsp_monthly,
  });
  if (!(results.total > 0)) throw httpError(400, 'La cotización quedaría en cero: revisa los precios del panel y de los servicios');
  const validUntil = new Date(Date.now() + num(settings.validity_days || 30) * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const items = results.lines.map((l) => (l.product_id
    ? { item_type: 'product', product_id: l.product_id, quantity: l.quantity, unit_price: l.list_price ?? l.unit_price }
    : { item_type: 'free_line', product_name: l.name, quantity: l.quantity, unit_price: l.unit_price, tax_percentage: l.tax_pct }));
  const payment = (settings.payment_terms || []).map((p) => `${p.pct} % ${p.label}`).join(' · ');
  const notes = [
    `Sistema solar ${results.kwp} kWp (${results.panels} paneles de ${results.panel_watts} W). Producción estimada ${Math.round(results.production_month).toLocaleString('es-CO')} kWh/mes; ahorro estimado ${Math.round(results.savings_month).toLocaleString('es-CO')} $/mes. Estudio ${study.number}.`,
    payment ? `Forma de pago: ${payment}.` : null,
    settings.conditions || null,
  ].filter(Boolean).join('\n');
  return {
    customer_id: study.customer_id,
    document_type: 'cotizacion',
    quote_valid_until: validUntil,
    items,
    notes,
    ...(settings.use_aiu ? {
      aiu_enabled: true,
      aiu_admin_pct: num(settings.aiu_admin_pct),
      aiu_unforeseen_pct: num(settings.aiu_unforeseen_pct),
      aiu_profit_pct: num(settings.aiu_profit_pct),
      aiu_object: `Suministro e instalación de sistema solar fotovoltaico de ${results.kwp} kWp`,
    } : {}),
  };
}

async function linkQuote(tenantId, id, quoteId) {
  const study = await getStudy(tenantId, id);
  const quote = await Sale.findOne({ where: { id: quoteId, tenant_id: tenantId, document_type: 'cotizacion' } });
  if (!quote) throw httpError(400, 'Cotización no encontrada');
  await study.update({ quote_id: quote.id, status: study.status === 'project' ? 'project' : 'quoted' });
  return getStudy(tenantId, id);
}

// ── Proyecto ──────────────────────────────────────────────────────────
/**
 * Crea el proyecto desde la cotización del estudio (mismo camino que
 * "proyecto desde cotización"), con la lista de materiales (paneles,
 * inversor y otros equipos del catálogo) y el presupuesto de costos.
 */
async function createProjectFromStudy(req, id) {
  const tenantId = req.user.tenant_id;
  const study = await getStudy(tenantId, id);
  if (study.project_id && study.project) throw httpError(409, `El estudio ya tiene el proyecto ${study.project.code}`);
  if (!study.quote_id) throw httpError(400, 'Primero crea la cotización del estudio');
  const projectsService = require('../projects/projects.service');
  const bomService = require('../projects/projectBom.service');
  const results = study.results || {};

  const project = await projectsService.createProject(req, {
    name: study.title || `Sistema solar ${results.kwp} kWp${study.customer ? ` - ${study.customer.business_name || [study.customer.first_name, study.customer.last_name].filter(Boolean).join(' ')}` : ''}`.slice(0, 200),
    customer_id: study.customer_id,
    quote_id: study.quote_id,
    type: study.system_type === 'offgrid' ? 'offgrid' : 'ongrid',
    city: study.city,
    site_address: study.address,
    capacity_kwp: results.kwp,
    notes: `Creado desde el estudio solar ${study.number}.`,
    create_warehouse: true,
  });

  // Lista de materiales con los equipos del catálogo (actualiza el presupuesto de materiales).
  const bomRows = (results.lines || []).filter((l) => l.product_id).map((l) => ({
    product_id: l.product_id, quantity: l.quantity, input_description: l.name, match_status: 'manual',
    unit_cost: l.unit_cost != null && l.unit_cost > 0 ? l.unit_cost : null,
  }));
  if (bomRows.length) await bomService.saveBom(tenantId, project, { rows: bomRows, mode: 'replace', update_budget: true }, req.user.id);

  // Presupuesto de los servicios (el material eléctrico va en materiales).
  const services = (results.lines || []).filter((l) => !l.product_id);
  if (services.length) {
    await ProjectBudgetLine.bulkCreate(services.map((l) => ({
      tenant_id: tenantId, project_id: project.id, category: l.category, description: `${l.name} (estudio ${study.number})`,
      budget_amount: round2(l.subtotal), source: 'quote', created_by: req.user.id,
    })));
  }
  await study.update({ project_id: project.id, status: 'project' });
  return { project, budget: budgetFromResults(results), bom_lines: bomRows.length };
}

module.exports = {
  getSettings, updateSettings, geocode, irradiance, ocrBill, computeStudy, saveStudy, listStudies, getStudy,
  quotePayload, linkQuote, createProjectFromStudy, productPricing, DEFAULT_CONDITIONS,
};
