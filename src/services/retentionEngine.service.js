// backend/src/services/retentionEngine.service.js
//
// Motor de retenciones PRACTICADAS por el tenant en sus compras/gastos.
// Reemplaza el esquema anterior (conceptos de ReteFuente configurados en el
// proveedor) por el modelo tributario correcto:
//
//  1. Perfil del tenant (tax_config.fiscal_profile):
//     - Régimen Simple (RST): no practica ReteFuente a título de renta
//       (art. 911 E.T.; salvo pagos laborales, que no pasan por aquí).
//     - Agente de ReteIVA (grandes contribuyentes, entidades públicas o
//       designados por la DIAN): solo ellos practican ReteIVA.
//     - UVT del año: para convertir las bases mínimas.
//  2. Perfil del proveedor (supplier.retention_config + columnas):
//     - Exento: no se le practica ninguna retención.
//     - Autorretenedor de renta: ReteFuente en $0 (ReteIVA/ReteICA siguen).
//     - Régimen Simple: no es sujeto de ReteFuente a título de renta.
//     - Gran contribuyente: no se le practica ReteIVA.
//     - Persona natural declarante / no declarante / jurídica: define la tarifa.
//  3. Concepto por ítem: producto → categoría → proveedor (por defecto) →
//     tipo (servicio = "Servicios generales", lo demás = "Compras generales").
//     La base mínima (UVT) se compara contra la SUMA de lo comprado bajo ese
//     concepto en la compra.
//  4. ReteICA: tarifa municipal en ‰ configurada en el proveedor (sigue
//     siendo por proveedor: depende del municipio y la actividad).
//
// Devuelve las líneas aplicadas + `notes` legibles que explican por qué una
// retención aplica o no (se muestran en el formulario de compra).

'use strict';

const {
  DEFAULT_RETENTION_CONCEPTS,
  DEFAULT_CONCEPT_BY_TYPE,
  DEFAULT_EXPENSE_CATEGORY_CONCEPTS,
  DEFAULT_UVT_VALUE,
} = require('../data/retention-concepts-default');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(n) || 0);

/** Perfil tributario del tenant para compras, con valores por defecto. */
function resolveFiscalProfile(taxConfig = {}) {
  const fp = taxConfig.fiscal_profile || {};
  const legacyReteIva = (taxConfig.retentions || []).find((r) => r.code === '05');
  const concepts = Array.isArray(taxConfig.retention_concepts) && taxConfig.retention_concepts.length
    ? taxConfig.retention_concepts
    : DEFAULT_RETENTION_CONCEPTS;
  return {
    regime: fp.regime === 'simple' ? 'simple' : 'ordinario',
    is_gran_contribuyente: !!fp.is_gran_contribuyente,
    // Sin configurar: se respeta lo que ya tenía el tenant (ReteIVA activa
    // en la configuración tributaria anterior).
    is_agente_reteiva: fp.is_agente_reteiva !== undefined
      ? !!fp.is_agente_reteiva
      : (!!fp.is_gran_contribuyente || legacyReteIva?.enabled === true),
    reteiva_rate: Number(fp.reteiva_rate ?? legacyReteIva?.rate ?? 15) || 15,
    uvt_value: Number(fp.uvt_value) > 0 ? Number(fp.uvt_value) : DEFAULT_UVT_VALUE,
    concepts,
    expense_category_concepts: { ...DEFAULT_EXPENSE_CATEGORY_CONCEPTS, ...(taxConfig.expense_category_concepts || {}) },
  };
}

/** Perfil tributario del proveedor. */
function resolveSupplierProfile(supplier = {}) {
  const rc = supplier.retention_config || {};
  const personType = supplier.person_type === 'natural' ? 'natural' : 'juridica';
  return {
    is_exento: !!rc.is_exento,
    is_autoretenedor: !!rc.is_autoretenedor,
    is_gran_contribuyente: !!rc.is_gran_contribuyente,
    // Las personas jurídicas siempre declaran; para naturales se asume
    // declarante salvo que se marque lo contrario.
    is_declarante: personType === 'juridica' ? true : rc.is_declarante !== false,
    person_type: personType,
    is_simple: supplier.tax_regime === 'simple',
    default_concept_id: rc.default_concept_id || null,
    ica: (Array.isArray(rc.retentions) ? rc.retentions : []).filter((r) => r.code === '06' && Number(r.rate) > 0),
  };
}

function conceptRate(concept, sp) {
  if (!concept) return 0;
  if (sp.person_type === 'juridica') return Number(concept.rate_juridica ?? concept.rate ?? 0);
  return Number(sp.is_declarante ? (concept.rate_natural_declarante ?? concept.rate_juridica ?? concept.rate) : (concept.rate_natural_no_declarante ?? concept.rate_natural_declarante ?? concept.rate_juridica ?? concept.rate)) || 0;
}

/**
 * Concepto de cada ítem: producto → categoría → proveedor → tipo.
 * items: [{ product_id, subtotal, tax_amount }] → devuelve los mismos ítems
 * con `concept_id`.
 */
async function resolveItemConcepts(items, { tenantId, supplierProfile, conceptIds, transaction }) {
  const { Product, Category } = require('../models');
  const ids = [...new Set(items.map((i) => i.product_id).filter(Boolean))];
  const products = ids.length
    ? await Product.findAll({ where: { id: ids, tenant_id: tenantId }, attributes: ['id', 'product_type', 'category_id', 'retention_concept'], transaction })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const catIds = [...new Set(products.map((p) => p.category_id).filter(Boolean))];
  const cats = catIds.length
    ? await Category.findAll({ where: { id: catIds }, attributes: ['id', 'retention_concept'], transaction })
    : [];
  const catById = new Map(cats.map((c) => [c.id, c]));
  const valid = (id) => (id && conceptIds.has(id) ? id : null);

  return items.map((it) => {
    const p = byId.get(it.product_id);
    const byType = p?.product_type === 'service' ? DEFAULT_CONCEPT_BY_TYPE.service : DEFAULT_CONCEPT_BY_TYPE.default;
    const concept_id = valid(it.concept_id)
      || valid(p?.retention_concept)
      || valid(catById.get(p?.category_id)?.retention_concept)
      || valid(supplierProfile.default_concept_id)
      || byType;
    return { ...it, concept_id };
  });
}

/**
 * Cálculo puro (sin BD). items: [{ concept_id, subtotal, tax_amount }].
 * requested: líneas editadas a mano en el formulario (opcional) — se
 * respetan, pero sin violar las exclusiones legales del perfil.
 */
function computeRetentions({ profile, supplierProfile: sp, items, requested }) {
  const notes = [];
  const lines = [];
  const conceptById = new Map(profile.concepts.map((c) => [c.id, c]));
  const baseSubtotal = items.reduce((s, i) => s + Number(i.subtotal || 0), 0);
  const baseIva = items.reduce((s, i) => s + Number(i.tax_amount || 0), 0);

  const allowRenta = !(profile.regime === 'simple' || sp.is_autoretenedor || sp.is_simple || sp.is_exento);
  const allowIva = profile.is_agente_reteiva && !sp.is_gran_contribuyente && !sp.is_exento;

  if (sp.is_exento) {
    notes.push('Proveedor exento de retención: no se le practica ninguna.');
  } else {
    if (profile.regime === 'simple') notes.push('Tu empresa está en el Régimen Simple: no practica retención en la fuente por renta.');
    else if (sp.is_autoretenedor) notes.push('Proveedor autorretenedor de renta: ReteFuente en $0 (él mismo se retiene).');
    else if (sp.is_simple) notes.push('Proveedor del Régimen Simple: no es sujeto de retención en la fuente por renta.');
    if (baseIva > 0) {
      if (!profile.is_agente_reteiva) notes.push('Tu empresa no es agente de ReteIVA: no se practica ReteIVA.');
      else if (sp.is_gran_contribuyente) notes.push('Proveedor gran contribuyente: no se le practica ReteIVA.');
    }
  }

  if (Array.isArray(requested)) {
    // Líneas manuales: se respetan concepto/tarifa/base, filtrando lo que la
    // ley no permite para este proveedor/tenant.
    for (const r of requested) {
      if (!r || !['07', '05', '06'].includes(r.code) || !(Number(r.rate) > 0)) continue;
      if (sp.is_exento) continue;
      if (r.code === '07' && !allowRenta) continue;
      if (r.code === '05' && !allowIva) continue;
      const hasBase = r.base !== undefined && r.base !== null && r.base !== '';
      const base = hasBase ? Math.max(Number(r.base) || 0, 0) : (r.code === '05' ? baseIva : baseSubtotal);
      const amount = round2(base * Number(r.rate) / (r.code === '06' ? 1000 : 100));
      if (amount <= 0) continue;
      lines.push({
        code: r.code, concept_id: r.concept_id || null, retention_id: r.retention_id || null,
        concept: String(r.concept || '').trim() || (conceptById.get(r.concept_id)?.name) || r.code,
        rate: Number(r.rate), base: round2(base), amount, account_id: r.account_id || conceptById.get(r.concept_id)?.account_id || null,
        manual: true,
      });
    }
  } else if (!sp.is_exento) {
    // ── ReteFuente por concepto ──
    if (allowRenta) {
      const groups = new Map();
      for (const it of items) {
        const key = it.concept_id || 'compras';
        groups.set(key, (groups.get(key) || 0) + Number(it.subtotal || 0));
      }
      for (const [conceptId, base] of groups) {
        const concept = conceptById.get(conceptId);
        if (!concept) { notes.push(`Concepto "${conceptId}" no existe en el catálogo: sin ReteFuente para esos ítems.`); continue; }
        const rate = conceptRate(concept, sp);
        const minBase = Number(concept.min_base_uvt || 0) * profile.uvt_value;
        if (!(rate > 0)) { notes.push(`${concept.name}: tarifa 0% para este tipo de proveedor.`); continue; }
        if (base < minBase) {
          notes.push(`${concept.name}: base ${money(base)} menor a la mínima de ${concept.min_base_uvt} UVT (${money(minBase)}) — no aplica ReteFuente.`);
          continue;
        }
        lines.push({
          code: '07', concept_id: concept.id, concept: concept.name, rate, base: round2(base),
          amount: round2(base * rate / 100), account_id: concept.account_id || null,
        });
      }
    }
    // ── ReteIVA ──
    if (allowIva && baseIva > 0) {
      lines.push({ code: '05', concept_id: 'reteiva', concept: 'ReteIVA', rate: profile.reteiva_rate, base: round2(baseIva), amount: round2(baseIva * profile.reteiva_rate / 100), account_id: null });
    }
    // ── ReteICA (tarifa municipal del proveedor) ──
    for (const ica of sp.ica.filter((r) => r.is_default !== false)) {
      const minBase = Number(ica.min_base || 0);
      if (baseSubtotal < minBase) { notes.push(`ReteICA ${ica.concept || ''}: base menor a la mínima (${money(minBase)}).`); continue; }
      lines.push({
        code: '06', retention_id: ica.id || null, concept_id: null, concept: ica.concept || 'ReteICA', rate: Number(ica.rate),
        base: round2(baseSubtotal), amount: round2(baseSubtotal * Number(ica.rate) / 1000), account_id: ica.account_id || null,
      });
    }
  }

  const sum = (code) => round2(lines.filter((l) => l.code === code).reduce((s, l) => s + l.amount, 0));
  const rateOf = (code, divisor) => {
    const ls = lines.filter((l) => l.code === code);
    if (ls.length === 1) return ls[0].rate;
    const base = ls.reduce((s, l) => s + l.base, 0);
    return base > 0 ? round2(sum(code) * divisor / base) : 0;
  };
  const result = {
    retefuente: { rate: rateOf('07', 100), amount: sum('07') },
    reteiva: { rate: rateOf('05', 100), amount: sum('05') },
    reteica: { rate: rateOf('06', 1000), amount: sum('06') },
    lines: lines.filter((l) => l.amount > 0),
    notes,
  };
  result.total = round2(result.retefuente.amount + result.reteiva.amount + result.reteica.amount);
  return result;
}

/**
 * Cálculo completo para una compra: carga perfiles y conceptos por ítem.
 * items: [{ product_id, subtotal, tax_amount }]
 */
async function computePurchaseRetentions({ tenantId, taxConfig, supplier, items, requested, transaction }) {
  const profile = resolveFiscalProfile(taxConfig || {});
  const supplierProfile = resolveSupplierProfile(supplier || {});
  const conceptIds = new Set(profile.concepts.map((c) => c.id));
  const withConcepts = await resolveItemConcepts(items, { tenantId, supplierProfile, conceptIds, transaction });
  return computeRetentions({ profile, supplierProfile, items: withConcepts, requested });
}

/** Sugerencia para un gasto: concepto según la categoría del gasto. */
function computeExpenseRetentions({ taxConfig, supplier, category, subtotal, tax_amount }) {
  const profile = resolveFiscalProfile(taxConfig || {});
  const supplierProfile = resolveSupplierProfile(supplier || {});
  const conceptId = profile.expense_category_concepts[category];
  const result = computeRetentions({
    profile,
    supplierProfile,
    items: conceptId ? [{ concept_id: conceptId, subtotal, tax_amount }] : [{ concept_id: '__none__', subtotal: 0, tax_amount }],
  });
  if (!conceptId) {
    result.notes = result.notes.filter((n) => !n.includes('__none__'));
    result.notes.push('Esta categoría de gasto no tiene concepto de ReteFuente asignado.');
  }
  return { ...result, concept_id: conceptId || null };
}

module.exports = {
  resolveFiscalProfile,
  resolveSupplierProfile,
  resolveItemConcepts,
  computeRetentions,
  computePurchaseRetentions,
  computeExpenseRetentions,
};
