// src/scripts/recalcSalePricesByMargin.js
//
// Recalcula el precio de venta (base_price) de los productos con margen de
// ganancia, con la fórmula vigente desde 2026-10-27 (utils/salePricing.js):
// margen SOBRE LA VENTA, precio = costo / (1 − margen), más IVA + INC cuando
// el producto maneja el precio con impuestos incluidos. Hasta esa fecha se
// calculaba como recargo sobre el costo (costo × (1 + margen)) y sin sumar el
// IVA de los precios con IVA incluido, así que los precios quedaron cortos.
//
// Costo base: último costo de compra; si el producto nunca se ha comprado, el
// costo promedio (mismo criterio que el precio sugerido del formulario).
//
// Igual que al recibir compras, por defecto el precio NUNCA baja: los que
// bajarían se informan y se conservan (--allow-decrease para bajarlos también).
//
// También corrige las alertas de costo activas con precio conservado
// (cost_alerts.price_held): su suggested_price se calculó con la fórmula
// anterior y "Aplicar precio" lo dejaría más bajo de lo debido. Se recalcula
// sobre el costo de la alerta; si con la fórmula nueva el precio ya no baja,
// la alerta se resuelve.
//
// Uso: node src/scripts/recalcSalePricesByMargin.js                  (vista previa, no cambia nada)
//      node src/scripts/recalcSalePricesByMargin.js --tenant=slug    (solo ese tenant)
//      node src/scripts/recalcSalePricesByMargin.js --csv=ruta.csv   (detalle por producto; por defecto en la carpeta temporal)
//      node src/scripts/recalcSalePricesByMargin.js --apply          (aplica los cambios)
//      node src/scripts/recalcSalePricesByMargin.js --apply --allow-decrease

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const { runWithTenantSchema } = require('../config/tenantContext');
const { suggestedSalePrice, isValidMargin } = require('../utils/salePricing');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const APPLY = process.argv.includes('--apply');
const ALLOW_DECREASE = process.argv.includes('--allow-decrease');
const ONLY_TENANT = arg('tenant');
const CSV_PATH = arg('csv') || path.join(os.tmpdir(), `recalc-precios-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`);
const EPS = 0.005;

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const money = (n) => Number(n).toLocaleString('es-CO', { maximumFractionDigits: 2 });

async function recalcTenant(tenant) {
  const { Product, CostAlert } = require('../models');
  const rows = [];
  const stats = { sube: 0, baja: 0, conservado: 0, igual: 0, sin_costo: 0, margen_invalido: 0, alertas_recalculadas: 0, alertas_resueltas: 0 };

  const products = await Product.findAll({
    where: { tenant_id: tenant.id, profit_margin_percentage: { [Op.gt]: 0 } },
    order: [['sku', 'ASC']],
  });

  const t = APPLY ? await sequelize.transaction() : null;
  try {
    for (const p of products) {
      const margin = parseFloat(p.profit_margin_percentage);
      const lastCost = parseFloat(p.last_purchase_cost) || 0;
      const cost = lastCost > 0 ? lastCost : parseFloat(p.average_cost) || 0;
      const current = parseFloat(p.base_price) || 0;
      const row = {
        sku: p.sku, name: p.name, active: p.is_active ? 'sí' : 'no', margin,
        cost_source: lastCost > 0 ? 'último costo' : 'costo promedio', cost,
        price_includes_tax: p.price_includes_tax ? 'sí' : 'no', current, suggested: null, final: current, action: '',
      };

      if (!isValidMargin(margin)) { row.action = 'margen ≥ 100 %: revisar a mano'; stats.margen_invalido += 1; rows.push(row); continue; }
      if (!(cost > 0)) { row.action = 'sin costo'; stats.sin_costo += 1; rows.push(row); continue; }

      const suggested = suggestedSalePrice(cost, margin, p);
      row.suggested = suggested;
      if (Math.abs(suggested - current) < EPS) {
        row.action = 'igual'; stats.igual += 1;
      } else if (suggested > current || current <= 0) {
        row.action = 'sube'; row.final = suggested; stats.sube += 1;
      } else if (ALLOW_DECREASE) {
        row.action = 'baja'; row.final = suggested; stats.baja += 1;
      } else {
        row.action = 'bajaría: se conserva'; stats.conservado += 1;
      }
      if (APPLY && row.final !== current) await p.update({ base_price: row.final }, { transaction: t });
      rows.push(row);
    }

    // Alertas de precio conservado con el sugerido de la fórmula anterior.
    const byId = new Map(products.map((p) => [p.id, p]));
    const alerts = await CostAlert.findAll({ where: { tenant_id: tenant.id, status: 'active', price_held: true }, transaction: t });
    for (const alert of alerts) {
      const p = byId.get(alert.product_id);
      if (!p) continue;
      const suggested = suggestedSalePrice(alert.new_cost, p.profit_margin_percentage, p);
      if (suggested === null) continue;
      const finalPrice = rows.find((r) => r.sku === p.sku)?.final ?? (parseFloat(p.base_price) || 0);
      if (suggested >= finalPrice - EPS) {
        stats.alertas_resueltas += 1;
        if (APPLY) {
          await alert.update({
            status: 'resolved', resolved_date: new Date(),
            resolution_notes: 'Resuelta al recalcular precios con margen sobre la venta: el precio ya no baja',
          }, { transaction: t });
        }
      } else if (Math.abs(suggested - parseFloat(alert.suggested_price)) >= EPS) {
        stats.alertas_recalculadas += 1;
        if (APPLY) await alert.update({ suggested_price: suggested }, { transaction: t });
      }
    }

    if (t) await t.commit();
  } catch (err) {
    if (t) await t.rollback();
    throw err;
  }
  return { rows, stats };
}

async function main() {
  const [tenants] = await sequelize.query(
    `SELECT id, slug, schema_name FROM public.tenants ${ONLY_TENANT ? 'WHERE slug = :slug' : ''} ORDER BY slug ASC`,
    { replacements: { slug: ONLY_TENANT } }
  );
  if (!tenants.length) { console.log(ONLY_TENANT ? `No existe el tenant ${ONLY_TENANT}` : 'No hay tenants'); process.exit(1); }

  const header = ['tenant', 'sku', 'producto', 'activo', 'margen_%', 'costo_base', 'costo', 'precio_incluye_iva', 'precio_actual', 'precio_sugerido', 'precio_final', 'accion'];
  const lines = [header.join(';')];

  console.log(`${APPLY ? 'APLICANDO' : 'VISTA PREVIA'} — margen sobre la venta${ALLOW_DECREASE ? ', bajando precios también' : ', sin bajar precios'}\n`);
  for (const tenant of tenants) {
    try {
      const { rows, stats } = tenant.schema_name
        ? await runWithTenantSchema(tenant.schema_name, () => recalcTenant(tenant))
        : await recalcTenant(tenant);
      for (const r of rows) {
        lines.push([tenant.slug, r.sku, r.name, r.active, r.margin, r.cost_source, r.cost, r.price_includes_tax, r.current, r.suggested ?? '', r.final, r.action].map(csvCell).join(';'));
      }
      if (!rows.length) { console.log(`${tenant.slug}: sin productos con margen`); continue; }
      const changed = rows.filter((r) => r.final !== r.current);
      const delta = changed.reduce((s, r) => s + (r.final - r.current), 0);
      console.log(`${tenant.slug}: ${rows.length} con margen — sube ${stats.sube}, ${ALLOW_DECREASE ? `baja ${stats.baja}` : `se conserva (bajaría) ${stats.conservado}`}, igual ${stats.igual}, sin costo ${stats.sin_costo}, margen ≥100 % ${stats.margen_invalido}`);
      if (stats.alertas_recalculadas || stats.alertas_resueltas) {
        console.log(`   alertas de precio conservado: ${stats.alertas_recalculadas} con sugerido corregido, ${stats.alertas_resueltas} se resuelven`);
      }
      for (const r of changed.sort((a, b) => (b.final - b.current) - (a.final - a.current)).slice(0, 5)) {
        console.log(`   ${r.sku} ${r.name}: $${money(r.current)} → $${money(r.final)}`);
      }
      if (changed.length > 5) console.log(`   … y ${changed.length - 5} más (suma de diferencias por unidad $${money(delta)})`);
    } catch (err) {
      console.error(`${tenant.slug}: error -- ${err.message}`);
    }
  }

  fs.writeFileSync(CSV_PATH, '﻿' + lines.join('\n'), 'utf8');
  console.log(`\nDetalle por producto: ${CSV_PATH}`);
  if (!APPLY) console.log('Solo vista previa: no se cambió nada. Para aplicar: --apply');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
