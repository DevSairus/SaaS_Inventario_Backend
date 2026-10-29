// src/scripts/convertMarkupToMargin.js
//
// Para tenants que escribieron el margen de ganancia pensando en un RECARGO
// sobre el costo (precio = costo × (1 + m), la fórmula anterior al
// 2026-10-27) y no en un margen sobre la venta (utils/salePricing.js). Con la
// fórmula nueva esos márgenes disparan los precios (90 % = costo × 10).
//
// Convierte cada margen al equivalente sobre la venta, m' = m / (1 + m), que
// da el mismo precio que daba el recargo: 30 → 23,08; 90 → 47,37; 150 → 60.
// NO cambia precios: solo el margen, para que la próxima compra (o el script
// recalcSalePricesByMargin) calcule precios parecidos a los que ya tenían.
//
// Para orientar la decisión, la vista previa compara el precio actual con el
// que daría cada interpretación: si se parece al del recargo, el margen se
// escribió como recargo.
//
// Uso: node src/scripts/convertMarkupToMargin.js --tenant=slug              (vista previa)
//      node src/scripts/convertMarkupToMargin.js --tenant=slug --csv=ruta
//      node src/scripts/convertMarkupToMargin.js --tenant=slug --apply

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sequelize } = require('../config/database');
const { getCurrentSchema, runWithTenantSchema } = require('../config/tenantContext');
const { suggestedSalePrice } = require('../utils/salePricing');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const APPLY = process.argv.includes('--apply');
const TENANT = arg('tenant');
const CSV_PATH = arg('csv') || path.join(os.tmpdir(), `convertir-margenes-${TENANT}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`);

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function run(tenant) {
  const schema = getCurrentSchema() || 'public';
  const [products] = await sequelize.query(`
    SELECT id, sku, name, is_active, profit_margin_percentage, base_price, average_cost, last_purchase_cost,
           price_includes_tax, has_tax, tax_percentage, tax_config
    FROM "${schema}"."products"
    WHERE tenant_id = :tenant_id AND profit_margin_percentage > 0
    ORDER BY sku
  `, { replacements: { tenant_id: tenant.id } });

  const rows = [];
  const stats = { total: products.length, closer_markup: 0, closer_margin: 0, no_cost: 0 };
  for (const p of products) {
    const markup = parseFloat(p.profit_margin_percentage);
    const newMargin = round2((markup / (100 + markup)) * 100);
    const lastCost = parseFloat(p.last_purchase_cost) || 0;
    const cost = lastCost > 0 ? lastCost : parseFloat(p.average_cost) || 0;
    const current = parseFloat(p.base_price) || 0;
    const asMarkup = cost > 0 ? round2(cost * (1 + markup / 100)) : null;
    const asMargin = cost > 0 && markup < 100 ? suggestedSalePrice(cost, markup, p) : null;
    const withNew = cost > 0 ? suggestedSalePrice(cost, newMargin, p) : null;
    let looksLike = '';
    if (!(cost > 0) || !(current > 0)) { looksLike = 'sin costo o precio'; stats.no_cost += 1; }
    else if (asMargin === null || Math.abs(current - asMarkup) <= Math.abs(current - asMargin)) { looksLike = 'recargo'; stats.closer_markup += 1; }
    else { looksLike = 'margen'; stats.closer_margin += 1; }
    rows.push({ p, markup, newMargin, cost, current, asMarkup, asMargin, withNew, looksLike });
  }

  if (APPLY) {
    const t = await sequelize.transaction();
    try {
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const values = chunk.map((r) => `('${r.p.id}', ${Number(r.newMargin)})`).join(',');
        await sequelize.query(`
          UPDATE "${schema}"."products" AS p
          SET profit_margin_percentage = v.margin, updated_at = NOW()
          FROM (VALUES ${values}) AS v(id, margin)
          WHERE p.id = v.id::uuid AND p.tenant_id = :tenant_id
        `, { replacements: { tenant_id: tenant.id }, transaction: t });
      }
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }
  return { rows, stats };
}

async function main() {
  if (!TENANT) { console.log('Indica --tenant=slug'); process.exit(1); }
  const [[tenant]] = await sequelize.query('SELECT id, slug, schema_name FROM public.tenants WHERE slug = :slug', { replacements: { slug: TENANT } });
  if (!tenant) { console.log(`No existe el tenant ${TENANT}`); process.exit(1); }

  const { rows, stats } = tenant.schema_name ? await runWithTenantSchema(tenant.schema_name, () => run(tenant)) : await run(tenant);

  const header = ['sku', 'producto', 'activo', 'margen_actual', 'margen_nuevo', 'costo', 'precio_actual', 'precio_si_recargo', 'precio_si_margen_actual', 'precio_con_margen_nuevo', 'parece'];
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push([r.p.sku, r.p.name, r.p.is_active ? 'sí' : 'no', r.markup, r.newMargin, r.cost, r.current, r.asMarkup ?? '', r.asMargin ?? '', r.withNew ?? '', r.looksLike].map(csvCell).join(';'));
  }
  fs.writeFileSync(CSV_PATH, '﻿' + lines.join('\n'), 'utf8');

  console.log(`${APPLY ? 'APLICADO' : 'VISTA PREVIA'} — ${tenant.slug}: ${stats.total} productos con margen`);
  console.log(`   el precio actual se parece más al del recargo: ${stats.closer_markup}; al del margen sobre la venta: ${stats.closer_margin}; sin costo o precio: ${stats.no_cost}`);
  const dist = {};
  for (const r of rows) dist[`${r.markup} → ${r.newMargin}`] = (dist[`${r.markup} → ${r.newMargin}`] || 0) + 1;
  console.log('   conversiones más comunes:', Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n})`).join(', '));
  console.log(`Detalle por producto: ${CSV_PATH}`);
  if (!APPLY) console.log('Solo vista previa: no se cambió nada. Para aplicar: --apply');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
