// backend/src/scripts/backfillRetentionCorrectionEntries.js
//
// Fase 0 de Declaraciones Periódicas / Formulario 350 — ver
// Contabilidad-Declaraciones-Periodicas-Analisis-y-Plan.md §2.5 y §3.2.
//
// generatePurchaseEntry/generateExpenseEntry, ANTES del fix de este mismo
// commit, acreditaban el total_amount completo a la cuenta por pagar/caja,
// ignorando retefuente/reteiva/reteica. Este script busca, por tenant, los
// asientos YA CONTABILIZADOS de compras/gastos con retención que todavía
// no reflejan esa corrección (no tienen línea en 236505/236710/236805) y
// genera un asiento de RECLASIFICACIÓN por cada uno:
//
//   débito  cuenta que quedó sobrestimada (la misma que se acreditó de más
//           en el asiento original — payable o caja/bancos)
//   crédito 236505 / 236710 / 236805 según corresponda
//
// No se toca ni se reversa el asiento original (inmutabilidad de asientos
// ya contabilizados) -- se agrega uno nuevo que corrige el saldo desde hoy
// en adelante. Se fecha HOY (no en la fecha original de la compra/gasto),
// mismo criterio que reverseEntry() en journalEntry.service.js para no
// pelear con períodos fiscales ya cerrados.
//
// DRY-RUN POR DEFECTO -- solo reporta qué se corregiría y por cuánto.
// Uso:
//   node src/scripts/backfillRetentionCorrectionEntries.js                 (reporta, no escribe nada)
//   node src/scripts/backfillRetentionCorrectionEntries.js --apply         (aplica a todos los tenants)
//   node src/scripts/backfillRetentionCorrectionEntries.js --apply --tenant=<slug>  (un solo tenant)

require('dotenv').config();
const { sequelize } = require('../config/database');
const { runWithTenantSchema } = require('../config/tenantContext');
const { createDraftEntry, postEntry, getMappedAccountId } = require('../services/accounting/journalEntry.service');

const RETENTION_ACCOUNT_CODES = ['236505', '236710', '236805'];

async function findUncorrectedDocuments(Model, sourceType, tenantId) {
  const { JournalEntry, JournalEntryLine, ChartOfAccount } = require('../models');
  const { Op } = require('sequelize');

  const docs = await Model.findAll({ where: { tenant_id: tenantId, total_retentions: { [Op.gt]: 0 } } });
  const results = [];

  for (const doc of docs) {
    const entry = await JournalEntry.findOne({
      where: { tenant_id: tenantId, source_type: sourceType, source_id: doc.id, status: { [Op.ne]: 'voided' } },
      order: [['createdAt', 'DESC']],
    });
    if (!entry) continue; // sin asiento todavía -- no es este script el que lo crea

    const lines = await JournalEntryLine.findAll({ where: { entry_id: entry.id }, include: [{ model: ChartOfAccount, as: 'account', attributes: ['code'] }] });
    const alreadyCorrected = lines.some((l) => RETENTION_ACCOUNT_CODES.includes(l.account?.code));
    if (alreadyCorrected) continue;

    // La línea que se acreditó de más: la de mayor crédito de ese asiento
    // (payable o caja/bancos -- la misma que generatePurchaseEntry/
    // generateExpenseEntry usaron antes del fix).
    const overstatedLine = lines.reduce((max, l) => (Number(l.credit) > Number(max?.credit || 0) ? l : max), null);
    if (!overstatedLine) continue;

    results.push({ doc, entry, overstatedLine });
  }

  return results;
}

async function correctTenant(tenant, { apply }) {
  const { Purchase, Expense } = require('../models');

  const purchaseIssues = await findUncorrectedDocuments(Purchase, 'purchase', tenant.id);
  const expenseIssues = await findUncorrectedDocuments(Expense, 'expense', tenant.id);
  const all = [...purchaseIssues.map((x) => ({ ...x, kind: 'purchase' })), ...expenseIssues.map((x) => ({ ...x, kind: 'expense' }))];

  if (all.length === 0) {
    return { tenant: tenant.slug, affected: 0, total_corrected: 0, entries_created: [] };
  }

  let totalCorrected = 0;
  const entriesCreated = [];

  for (const { doc, overstatedLine, kind } of all) {
    const retefuente = Number(doc.retefuente_amount || 0);
    const reteiva = Number(doc.reteiva_amount || 0);
    const reteica = Number(doc.reteica_amount || 0);
    const totalRetentions = retefuente + reteiva + reteica;
    if (totalRetentions <= 0) continue;

    totalCorrected += totalRetentions;

    if (!apply) continue;

    const lines = [
      {
        account_id: overstatedLine.account_id,
        debit: totalRetentions,
        credit: 0,
        description: 'Reclasificación: retención ya practicada, no contabilizada en su momento',
        third_party_id: overstatedLine.third_party_id || null,
      },
    ];
    if (retefuente > 0) lines.push({ account_id: await getMappedAccountId(tenant.id, `${kind}_retefuente_payable`), debit: 0, credit: retefuente, description: 'Retención en la fuente (ajuste retroactivo)' });
    if (reteiva > 0) lines.push({ account_id: await getMappedAccountId(tenant.id, `${kind}_reteiva_payable`), debit: 0, credit: reteiva, description: 'IVA retenido (ajuste retroactivo)' });
    if (reteica > 0) lines.push({ account_id: await getMappedAccountId(tenant.id, `${kind}_reteica_payable`), debit: 0, credit: reteica, description: 'ICA retenido (ajuste retroactivo)' });

    const docNumber = doc.purchase_number || doc.expense_number || doc.id;
    const draft = await createDraftEntry(tenant.id, {
      entryDate: new Date(), // hoy, no la fecha original -- evita períodos cerrados
      sourceType: `${kind}_retention_correction`,
      sourceId: doc.id,
      description: `Ajuste retroactivo de retenciones — ${kind} ${docNumber}`,
      lines,
    });
    const posted = await postEntry(draft.id, tenant.id, null);
    entriesCreated.push({ kind, doc_id: doc.id, doc_number: docNumber, entry_id: posted.id, amount: totalRetentions });
  }

  return { tenant: tenant.slug, affected: all.length, total_corrected: totalCorrected, entries_created: entriesCreated };
}

async function run() {
  const apply = process.argv.includes('--apply');
  const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
  const onlySlug = tenantArg ? tenantArg.split('=')[1] : null;

  const [tenants] = await sequelize.query(
    `SELECT id, slug, schema_name FROM public.tenants ${onlySlug ? 'WHERE slug = :slug' : ''} ORDER BY slug ASC`,
    onlySlug ? { replacements: { slug: onlySlug } } : {}
  );

  const results = [];
  for (const tenant of tenants) {
    try {
      const outcome = tenant.schema_name
        ? await runWithTenantSchema(tenant.schema_name, () => correctTenant(tenant, { apply }))
        : await correctTenant(tenant, { apply });
      results.push(outcome);
    } catch (err) {
      console.error(`[backfillRetentionCorrectionEntries] Error en tenant "${tenant.slug}":`, err.message);
      results.push({ tenant: tenant.slug, error: err.message });
    }
  }

  const totalAffected = results.reduce((s, r) => s + (r.affected || 0), 0);
  const totalAmount = results.reduce((s, r) => s + (r.total_corrected || 0), 0);

  console.log(`\n${apply ? '✅ APLICADO' : '🔍 DRY-RUN (nada se escribió — corre con --apply para aplicar)'}`);
  console.log(`Tenants revisados: ${results.length} · Documentos afectados: ${totalAffected} · Monto total a reclasificar: ${totalAmount.toFixed(2)}\n`);
  console.log(JSON.stringify(results.filter((r) => r.affected > 0 || r.error), null, 2));
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error corriendo backfillRetentionCorrectionEntries:', err);
      process.exit(1);
    });
}

module.exports = { run };
