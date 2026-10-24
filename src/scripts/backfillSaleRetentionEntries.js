// src/scripts/backfillSaleRetentionEntries.js
//
// Asientos faltantes de retenciones que practicaron los clientes.
// Hasta 2026-10-24, generateSaleRetentionEntry fallaba en silencio en los
// tenants sin las cuentas 135520/135517/135518 mapeadas (solo las creaba la
// configuración de ICA): la retención bajaba la cartera de la venta pero no
// se contabilizaba. Este script busca en cada tenant las retenciones
// registradas (payment_history con source 'retention') que no tienen asiento
// (journal_entries source_type 'payment' / source_id = payment_id) y las
// contabiliza con su fecha original. Idempotente: si ya existe, no la repite.
//
// Uso: node src/scripts/backfillSaleRetentionEntries.js           (solo informa)
//      node src/scripts/backfillSaleRetentionEntries.js --apply   (genera los asientos)

require('dotenv').config();
const { sequelize } = require('../config/database');
const { runWithTenantSchema } = require('../config/tenantContext');

async function backfillTenant(tenant, apply) {
  const { Sale, JournalEntry } = require('../models');
  const { generateSaleRetentionEntry } = require('../services/accounting/autoEntries.service');
  const sales = await Sale.findAll({
    where: sequelize.literal(`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payment_history) = 'array' THEN payment_history ELSE '[]'::jsonb END) e WHERE e->>'source' = 'retention')`),
  });
  const missing = [];
  for (const sale of sales) {
    for (const p of sale.payment_history || []) {
      if (p.source !== 'retention' || !p.payment_id) continue;
      const exists = await JournalEntry.count({ where: { source_type: 'payment', source_id: p.payment_id } });
      if (!exists) missing.push({ sale, payment: p });
    }
  }
  let created = 0;
  if (apply) {
    for (const { sale, payment } of missing) {
      const entry = await generateSaleRetentionEntry(
        { payment_id: payment.payment_id, date: payment.date, retentions: payment.retentions || {} },
        sale, tenant.id, payment.user_id || null
      );
      if (entry) created += 1;
    }
  }
  return { slug: tenant.slug, missing: missing.length, created, sales: [...new Set(missing.map(m => m.sale.sale_number))] };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const [tenants] = await sequelize.query(`SELECT id, slug, schema_name FROM public.tenants ORDER BY slug ASC`);
  for (const t of tenants) {
    try {
      const r = t.schema_name
        ? await runWithTenantSchema(t.schema_name, () => backfillTenant(t, apply))
        : await backfillTenant(t, apply);
      console.log(`${r.slug}: ${r.missing} retención(es) sin asiento${apply ? `, ${r.created} asiento(s) creado(s)` : ''}${r.sales.length ? ` — ${r.sales.join(', ')}` : ''}`);
    } catch (err) {
      console.error(`${t.slug}: error -- ${err.message}`);
    }
  }
  if (!apply) console.log('\nSolo informe. Para generar los asientos: --apply');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
