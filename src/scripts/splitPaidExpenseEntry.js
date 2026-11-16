// src/scripts/splitPaidExpenseEntry.js
//
// Gastos registrados con "Ya está pagado" antes del 2026-11-16 quedaron con UN
// solo asiento (gasto contra caja o bancos), sin asiento de pago aparte. Desde
// esa fecha se registran como cualquier gasto pagado después: asiento del gasto
// contra cuentas por pagar (2335) + asiento del pago (2335 contra caja/bancos).
//
// Este script deja un gasto viejo con los dos asientos. SOLO si su asiento
// sigue en BORRADOR (no toca nada contabilizado: un asiento ya revisado no se
// reescribe). El borrador se anula y se generan los dos nuevos, en borrador.
//
// Uso (vista previa, no escribe nada):
//   node src/scripts/splitPaidExpenseEntry.js --tenant=empresa-de-pruebas --expense=GAS-2026-00002
// Aplicar:
//   ... --apply --user=correo@del.admin

require('dotenv').config();
const { sequelize } = require('../config/database');
const { runWithTenantSchema } = require('../config/tenantContext');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const APPLY = process.argv.includes('--apply');

async function main() {
  const slug = arg('tenant');
  const number = arg('expense');
  if (!slug || !number) throw new Error('Uso: --tenant=<slug> --expense=<GAS-...> [--apply --user=<correo>]');
  const models = require('../models');
  const [[tenant]] = await sequelize.query('SELECT id, slug, schema_name FROM public.tenants WHERE slug = :slug', { replacements: { slug } });
  if (!tenant) throw new Error(`No existe el tenant ${slug}`);

  return runWithTenantSchema(tenant.schema_name || 'public', async () => {
    const { Expense, JournalEntry, JournalEntryLine, ChartOfAccount, User } = models;
    const expense = await Expense.findOne({ where: { tenant_id: tenant.id, expense_number: number } });
    if (!expense) throw new Error(`No existe el gasto ${number}`);
    const { isInitialPayment } = require('../services/finance/expensePayments.service');
    const history = expense.payment_history || [];
    const initialIdx = history.findIndex(isInitialPayment);
    if (initialIdx < 0) throw new Error(`${number} no tiene un pago al registrarlo con el esquema viejo: nada que separar.`);

    const entries = await JournalEntry.findAll({
      where: { tenant_id: tenant.id, source_type: 'expense', source_id: expense.id, status: ['draft', 'posted'] },
      include: [{ model: JournalEntryLine, as: 'lines', include: [{ model: ChartOfAccount, as: 'account', attributes: ['code'] }] }],
    });
    if (entries.length !== 1) throw new Error(`${number} tiene ${entries.length} asientos de gasto vigentes; se esperaba 1.`);
    const entry = entries[0];
    console.log(`${number} — ${expense.description} — ${expense.total_amount}`);
    console.log(`Asiento actual ${entry.entry_number} (${entry.status}):`, entry.lines.map((l) => `${l.account?.code} D${l.debit} C${l.credit}`).join(' | '));
    if (entry.status !== 'draft') throw new Error(`${entry.entry_number} ya está contabilizado: no se reescribe. Si hay que separarlo, hazlo con un asiento manual.`);

    console.log('Se anularía el borrador y se generarían: asiento del gasto contra 2335 (por pagar) y asiento del pago (2335 contra caja/bancos).');
    if (!APPLY) { console.log('Vista previa: no se cambió nada. Agrega --apply --user=<correo> para aplicar.'); return; }

    const user = await User.findOne({ where: { email: arg('user') } });
    if (!user) throw new Error('Indica --user=<correo> de un usuario existente');

    const t = await sequelize.transaction();
    try {
      await entry.update({ status: 'voided' }, { transaction: t });
      // El pago inicial pasa al esquema nuevo (lleva su propio asiento).
      const newHistory = history.map((p, i) => (i === initialIdx ? { ...p, id: p.id || require('crypto').randomUUID(), journal_entry_id: null } : p));
      await expense.update({ payment_history: newHistory }, { transaction: t });
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }

    const { generateExpenseEntry } = require('../services/accounting/autoEntries.service');
    const { recordExpensePaymentEntries } = require('../services/finance/expensePayments.service');
    const fresh = await Expense.findByPk(expense.id);
    const exp = await generateExpenseEntry(fresh, tenant.id, user.id, { rethrow: true });
    const pay = await recordExpensePaymentEntries(expense.id, tenant.id, user.id, { rethrow: true });
    console.log(`Listo: anulado ${entry.entry_number}; nuevo asiento del gasto ${exp?.entry_number}; asientos de pago generados: ${pay.generated}.`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('❌', e.message); process.exit(1); });
