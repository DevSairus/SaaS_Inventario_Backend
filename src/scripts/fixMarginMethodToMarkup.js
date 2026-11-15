// src/scripts/fixMarginMethodToMarkup.js
//
// Para un tenant que escribió sus márgenes como RECARGO sobre el costo pero
// quedó con el método "sobre la venta" (el de por defecto desde 2026-10-27):
// un margen de 90 % se volvió costo / 0,10 = 10 veces el costo en cada compra
// recibida. Pasa el tenant a margin_method = 'markup' y corrige SOLO lo que
// el método equivocado tocó, dejando registro en un Ajuste de precio (AJP-).
//
// Cada producto con margen se clasifica por el ÚLTIMO evento que fijó su precio:
//   - inflado: la última compra (desde --since) recalculó el precio con la
//     fórmula sobre la venta (el precio actual coincide con ella) -> el precio
//     pasa a costo × (1 + margen). El margen no cambia.
//   - precio de la compra: esa línea traía precio de venta escrito a mano -> el
//     precio se conserva; el margen guardado (calculado sobre la venta) se
//     convierte al recargo equivalente para ese mismo precio.
//   - ajuste AJP con margen: el último cambio fue un AJP que cambió el margen
//     con el método sobre la venta -> igual: precio se conserva, margen se convierte.
//   - sin cambio: precio puesto a mano, de antes de --since o que no viene de
//     la fórmula. No se toca.
//   - --skip-sku: productos con datos dudosos; no se tocan y se reportan.
// Las alertas de "precio retenido" activas se recalculan con el recargo (o se
// resuelven si el precio ya no baja).
//
// Uso (vista previa, no escribe nada; deja un CSV):
//   node src/scripts/fixMarginMethodToMarkup.js --tenant=lemans-motos
//        [--since=2026-10-27] [--skip-sku=999,MP-37327-A,MP-004250] [--csv=ruta.csv]
// Aplicar (una transacción: si algo falla no cambia nada):
//   ... --apply --user=correo@del.admin
//
// Solo cambia business_config.margin_method, products.base_price,
// products.profit_margin_percentage/margin_inherited (en las conversiones) y
// cost_alerts; registra el AJP. No toca stock, costos ni contabilidad.

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sequelize } = require('../config/database');
const { runWithTenantSchema } = require('../config/tenantContext');
const { suggestedSalePrice, impliedMargin, isValidMargin, normalizeMarginMethod } = require('../utils/salePricing');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const APPLY = process.argv.includes('--apply');
const SLUG = arg('tenant');
const SINCE = arg('since') || '2026-10-27';
const SKIP_SKUS = new Set((arg('skip-sku') || '').split(',').map((s) => s.trim()).filter(Boolean));
const USER_EMAIL = arg('user');
const CSV_PATH = arg('csv') || path.join(os.tmpdir(), `correccion-margenes-${SLUG}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`);
const TOLERANCE = 1; // pesos: el precio "viene de la fórmula" si difiere menos de esto
const EPS = 0.005;
const REASON = 'Corrección: los márgenes de la empresa son recargo sobre el costo; precios recalculados por error con margen sobre la venta';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? null : parseFloat(v));
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const money = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString('es-CO', { maximumFractionDigits: 2 }));

async function plan(tenant, schema, t) {
  const q = (sql, replacements = {}) => sequelize.query(sql, { replacements: { tenantId: tenant.id, since: SINCE, ...replacements }, transaction: t }).then(([r]) => r);
  const S = `"${schema}"`;

  const products = await q(`
    SELECT id, sku, name, is_active, base_price, last_purchase_cost, last_purchase_date, average_cost,
           profit_margin_percentage, margin_inherited, price_includes_tax, has_tax, tax_percentage, tax_config
    FROM ${S}.products WHERE tenant_id = :tenantId
      AND (profit_margin_percentage > 0 OR id IN (SELECT product_id FROM ${S}.purchase_items WHERE sale_price > 0))
    ORDER BY sku`);

  // Última línea de compra RECIBIDA por producto y último ajuste AJP por producto.
  const lastLines = new Map((await q(`
    SELECT DISTINCT ON (pi.product_id) pi.product_id, pi.sale_price, pi.profit_margin_pct, pi.unit_cost,
           p.purchase_number, COALESCE(p.received_date, p.purchase_date) AS at
    FROM ${S}.purchase_items pi JOIN ${S}.purchases p ON p.id = pi.purchase_id
    WHERE p.tenant_id = :tenantId AND p.status = 'received' AND pi.product_id IS NOT NULL
    ORDER BY pi.product_id, COALESCE(p.received_date, p.purchase_date) DESC, p.created_at DESC`)).map((r) => [r.product_id, r]));
  const lastAjp = new Map((await q(`
    SELECT DISTINCT ON (i.product_id) i.product_id, i.margin_changed, i.margin_method, i.reference_cost, i.new_price,
           a.adjustment_number, a.created_at AS at
    FROM ${S}.price_adjustment_items i JOIN ${S}.price_adjustments a ON a.id = i.adjustment_id
    WHERE a.tenant_id = :tenantId
    ORDER BY i.product_id, a.created_at DESC`)).map((r) => [r.product_id, r]));

  const rows = [];
  for (const p of products) {
    const margin = num(p.profit_margin_percentage) || 0;
    const last = num(p.last_purchase_cost) || 0;
    const cost = last > 0 ? last : num(p.average_cost) || 0;
    const price = num(p.base_price) || 0;
    const line = lastLines.get(p.id);
    const ajp = lastAjp.get(p.id);
    const lineAt = line?.at ? new Date(line.at) : null;
    const ajpAt = ajp?.at ? new Date(ajp.at) : null;
    const onSale = cost > 0 && margin > 0 ? suggestedSalePrice(cost, margin, p, 'on_sale') : null;
    const markup = cost > 0 && margin > 0 ? suggestedSalePrice(cost, margin, p, 'markup') : null;
    const row = {
      id: p.id, sku: p.sku, name: p.name, activo: p.is_active ? 'sí' : 'no', margen: margin, margen_heredado: p.margin_inherited ? 'sí' : 'no',
      costo: cost, precio_actual: price, precio_sobre_venta: onSale, precio_recargo: markup,
      ultima_compra: line ? `${line.purchase_number} ${lineAt ? lineAt.toISOString().slice(0, 10) : ''}` : '',
      ultimo_ajp: ajp ? `${ajp.adjustment_number} ${ajpAt.toISOString().slice(0, 10)}` : '',
      caso: '', precio_nuevo: price, margen_nuevo: margin,
    };
    const sinceDate = new Date(`${SINCE}T00:00:00`);
    // Fecha del último costo registrado por CUALQUIER vía: compra recibida o
    // entrada rápida de inventario con motivo compra (esa no deja línea de compra).
    const lastCostAt = p.last_purchase_date ? new Date(`${String(p.last_purchase_date).slice(0, 10)}T00:00:00`) : null;
    const recentCost = lastCostAt && lastCostAt >= sinceDate;
    const lastEventIsAjp = ajpAt && (!lineAt || ajpAt > lineAt) && (!lastCostAt || ajpAt >= lastCostAt);
    // La línea de compra es la que fijó el último costo si es de ese mismo día o después.
    const lineIsLastCost = line && lineAt && lastCostAt && lineAt >= lastCostAt;

    if (SKIP_SKUS.has(p.sku)) {
      row.caso = 'excluido: revisar datos a mano';
    } else if (lastEventIsAjp) {
      if (ajp.margin_changed && normalizeMarginMethod(ajp.margin_method) === 'on_sale' && cost > 0) {
        const m = impliedMargin(num(ajp.reference_cost) || cost, price, p, 'markup');
        if (m !== null && Math.abs(m - margin) >= EPS) { row.caso = 'ajuste AJP con margen: se convierte el margen'; row.margen_nuevo = m; }
        else row.caso = m === null ? 'ajuste AJP: margen no convertible (precio bajo el costo), revisar' : 'sin cambio';
      } else row.caso = 'sin cambio (último cambio fue un ajuste de precio a mano)';
    } else if (recentCost && lineIsLastCost && num(line.sale_price) > 0) {
      const m = cost > 0 ? impliedMargin(cost, price, p, 'markup') : null;
      if (m !== null && Math.abs(m - margin) >= EPS) { row.caso = 'precio escrito en la compra: se convierte el margen'; row.margen_nuevo = m; }
      else row.caso = m === null ? 'precio de la compra: margen no convertible, revisar' : 'sin cambio';
    } else if (recentCost && onSale !== null && Math.abs(price - onSale) <= TOLERANCE) {
      if (markup !== null && isValidMargin(margin, 'markup')) { row.caso = 'inflado por la fórmula: baja al recargo'; row.precio_nuevo = markup; }
      else row.caso = 'inflado pero margen fuera de rango, revisar';
    } else {
      row.caso = 'sin cambio';
    }
    rows.push(row);
  }

  // Alertas de precio retenido activas: su sugerido se calculó sobre la venta.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const alerts = await q(`SELECT id, product_id, new_cost, suggested_price FROM ${S}.cost_alerts
    WHERE tenant_id = :tenantId AND status = 'active' AND price_held = true`);
  const alertPlan = [];
  for (const a of alerts) {
    const r = byId.get(a.product_id);
    const p = productById.get(a.product_id);
    if (!r || !p) continue;
    const suggested = suggestedSalePrice(a.new_cost, r.margen_nuevo, p, 'markup');
    if (suggested === null) continue;
    if (suggested >= r.precio_nuevo - EPS) alertPlan.push({ id: a.id, product_id: a.product_id, action: 'resolve' });
    else if (Math.abs(suggested - num(a.suggested_price)) >= EPS) alertPlan.push({ id: a.id, product_id: a.product_id, action: 'update', suggested });
  }
  return { rows, alertPlan };
}

async function apply(tenant, schema, rows, alertPlan, t) {
  const S = `"${schema}"`;
  const q = (sql, replacements = {}) => sequelize.query(sql, { replacements: { tenantId: tenant.id, ...replacements }, transaction: t });

  const [[user]] = await q(`SELECT id FROM public.users WHERE email = :email`, { email: USER_EMAIL });
  if (!user) throw new Error(`No existe el usuario ${USER_EMAIL}`);

  // 1. Método de cálculo: recargo.
  await q(`UPDATE public.tenants SET business_config = jsonb_set(COALESCE(business_config::jsonb, '{}'::jsonb), '{margin_method}', '"markup"')
           WHERE id = :tenantId`);

  // 2. Ajuste de precio AJP- con todas las líneas (precio y/o margen).
  const changes = rows.filter((r) => Math.abs(r.precio_nuevo - r.precio_actual) >= EPS || Math.abs(r.margen_nuevo - r.margen) >= EPS);
  if (!changes.length) return { adjustment: null, changes: 0 };
  await q(`SELECT pg_advisory_xact_lock(hashtext(:key))`, { key: `price_adjustments:${tenant.id}` });
  const [[lastAdj]] = await q(`SELECT adjustment_number FROM ${S}.price_adjustments WHERE tenant_id = :tenantId AND adjustment_number LIKE 'AJP-%'
                               ORDER BY adjustment_number DESC LIMIT 1`);
  const n = lastAdj ? (parseInt(String(lastAdj.adjustment_number).split('-')[1], 10) || 0) + 1 : 1;
  const number = `AJP-${String(n).padStart(6, '0')}`;
  const [[adj]] = await q(`
    INSERT INTO ${S}.price_adjustments (id, tenant_id, adjustment_number, reason, notes, items_count, created_by, created_at, updated_at)
    VALUES (gen_random_uuid(), :tenantId, :number, :reason, :notes, :count, :userId, NOW(), NOW()) RETURNING id`,
  { number, reason: REASON, notes: `Script fixMarginMethodToMarkup (desde ${SINCE}). El método de cálculo de la empresa pasó a recargo sobre el costo.`, count: changes.length, userId: user.id });

  for (const r of changes) {
    const marginChanged = Math.abs(r.margen_nuevo - r.margen) >= EPS;
    await q(`
      INSERT INTO ${S}.price_adjustment_items (id, tenant_id, adjustment_id, product_id, sku, product_name, previous_price, new_price,
        reference_cost, cost_source, margin_pct, margin_method, previous_margin_pct, margin_changed, suggested_price, price_includes_tax,
        last_purchase_cost, average_cost, created_at, updated_at)
      SELECT gen_random_uuid(), :tenantId, :adjId, p.id, p.sku, p.name, :prev, :next, :cost,
        CASE WHEN p.last_purchase_cost > 0 THEN 'last_purchase' ELSE 'average' END, :margin, 'markup', :prevMargin, :marginChanged,
        :suggested, p.price_includes_tax, COALESCE(p.last_purchase_cost, 0), COALESCE(p.average_cost, 0), NOW(), NOW()
      FROM ${S}.products p WHERE p.id = :id AND p.tenant_id = :tenantId`,
    { adjId: adj.id, id: r.id, prev: r.precio_actual, next: r.precio_nuevo, cost: r.costo || null, margin: r.margen_nuevo,
      prevMargin: r.margen, marginChanged, suggested: r.precio_recargo });
    await q(`
      UPDATE ${S}.products SET base_price = :next,
        profit_margin_percentage = CASE WHEN :marginChanged THEN :margin ELSE profit_margin_percentage END,
        margin_inherited = CASE WHEN :marginChanged THEN false ELSE margin_inherited END, updated_at = NOW()
      WHERE id = :id AND tenant_id = :tenantId AND base_price = :prev`,
    { id: r.id, next: r.precio_nuevo, prev: r.precio_actual, margin: r.margen_nuevo, marginChanged });
  }
  // Ningún precio cambió entre la vista previa y ahora (se compara con el leído).
  const [[{ applied }]] = await q(`SELECT count(*)::int AS applied FROM ${S}.price_adjustment_items i JOIN ${S}.products p ON p.id = i.product_id
    WHERE i.adjustment_id = :adjId AND p.base_price = i.new_price`, { adjId: adj.id });
  if (applied !== changes.length) throw new Error(`Solo ${applied} de ${changes.length} precios quedaron aplicados (alguien cambió precios mientras corría): no se cambió nada`);

  // 3. Alertas de precio retenido.
  for (const a of alertPlan) {
    if (a.action === 'resolve') {
      await q(`UPDATE ${S}.cost_alerts SET status = 'resolved', resolved_date = NOW(), resolved_by = :userId,
               resolution_notes = :note WHERE id = :id`, { id: a.id, userId: user.id, note: `Resuelta en ${number}: con recargo el precio ya no baja` });
    } else {
      await q(`UPDATE ${S}.cost_alerts SET suggested_price = :s WHERE id = :id`, { id: a.id, s: a.suggested });
    }
  }
  return { adjustment: number, changes: changes.length };
}

async function main() {
  if (!SLUG) { console.error('Falta --tenant=slug'); process.exit(1); }
  if (APPLY && !USER_EMAIL) { console.error('Para aplicar indica --user=correo (queda como autor del ajuste AJP)'); process.exit(1); }
  const [[tenant]] = await sequelize.query('SELECT id, slug, schema_name, business_config FROM public.tenants WHERE slug = :slug', { replacements: { slug: SLUG } });
  if (!tenant) { console.error(`No existe el tenant ${SLUG}`); process.exit(1); }
  const schema = tenant.schema_name || 'public';
  console.log(`${APPLY ? 'APLICANDO' : 'VISTA PREVIA (no cambia nada)'} — ${SLUG} (schema ${schema}), método actual: ${normalizeMarginMethod(tenant.business_config?.margin_method)}, desde ${SINCE}`);

  await runWithTenantSchema(tenant.schema_name, async () => {
    const t = await sequelize.transaction();
    try {
      if (!APPLY) await sequelize.query('SET TRANSACTION READ ONLY', { transaction: t });
      const { rows, alertPlan } = await plan(tenant, schema, t);

      const header = ['sku', 'producto', 'activo', 'margen_%', 'margen_heredado', 'costo', 'precio_actual', 'precio_con_formula_sobre_venta', 'precio_con_recargo', 'ultima_compra', 'ultimo_ajp', 'caso', 'precio_nuevo', 'margen_nuevo_%'];
      const lines = [header.join(';'), ...rows.map((r) => [r.sku, r.name, r.activo, r.margen, r.margen_heredado, r.costo, r.precio_actual, r.precio_sobre_venta ?? '', r.precio_recargo ?? '', r.ultima_compra, r.ultimo_ajp, r.caso, r.precio_nuevo, r.margen_nuevo].map(csvCell).join(';'))];
      fs.writeFileSync(CSV_PATH, '﻿' + lines.join('\n'), 'utf8');

      const byCase = rows.reduce((m, r) => m.set(r.caso, (m.get(r.caso) || 0) + 1), new Map());
      console.log(`\n${rows.length} productos con margen:`);
      for (const [c, n] of [...byCase].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${c}`);
      const lowered = rows.filter((r) => r.precio_nuevo < r.precio_actual - EPS);
      console.log(`\nPrecios que bajan: ${lowered.length}. Mayores bajas:`);
      for (const r of lowered.sort((a, b) => (b.precio_actual - b.precio_nuevo) - (a.precio_actual - a.precio_nuevo)).slice(0, 8)) {
        console.log(`  ${r.sku} ${r.name.slice(0, 40)}: $${money(r.precio_actual)} -> $${money(r.precio_nuevo)} (costo $${money(r.costo)}, margen ${r.margen} %)`);
      }
      console.log(`Alertas de precio retenido: ${alertPlan.filter((a) => a.action === 'resolve').length} se resuelven, ${alertPlan.filter((a) => a.action === 'update').length} se recalculan`);
      for (const a of alertPlan) {
        const r = rows.find((x) => x.id === a.product_id);
        if (r) console.log(`  ${a.action === 'resolve' ? 'se resuelve' : 'se recalcula'}: ${r.sku} ${r.name.slice(0, 40)} (precio ${money(r.precio_nuevo)}${a.suggested ? `, sugerido ${money(a.suggested)}` : ''})`);
      }
      console.log(`\nDetalle por producto: ${CSV_PATH}`);

      if (APPLY) {
        const res = await apply(tenant, schema, rows, alertPlan, t);
        await t.commit();
        console.log(`\n✅ Aplicado: método = recargo; ${res.changes} producto(s) en ${res.adjustment || '(sin cambios de precio)'}`);
      } else {
        await t.rollback();
        console.log('\nSolo vista previa: no se cambió nada. Para aplicar: --apply --user=correo');
      }
    } catch (err) {
      await t.rollback().catch(() => {});
      throw err;
    }
  });
  process.exit(0);
}

main().catch((err) => { console.error('❌', err.message); process.exit(1); });
