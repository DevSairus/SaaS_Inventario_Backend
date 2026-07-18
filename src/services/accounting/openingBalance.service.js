// backend/src/services/accounting/openingBalance.service.js
//
// Carga de saldos iniciales (apertura contable) para un tenant que ya
// operaba antes de usar Pitbox: cartera por cobrar (CxC) y por pagar (CxP)
// por cliente/proveedor, cuentas generales (caja, bancos, activos fijos,
// patrimonio) e inventario existente con su costo.
//
// Enfoque de "cuenta puente": en vez de exigir un único asiento perfecto el
// primer día, cada carga (un cliente, un proveedor, una cuenta, un lote de
// inventario) genera su PROPIO asiento balanceado y posteado de inmediato,
// contra la cuenta puente 'opening_balance_suspense' (380505, patrimonio).
// Esa cuenta acumula el neto de todo lo cargado; closeBridgeAccount() lo
// traslada al final a la cuenta de patrimonio que el usuario elija.
//
// Cada función corre dentro de la transacción que le pase el controller —
// así, si algo falla a mitad de camino (ej. el asiento no cuadra), no queda
// ni el OpeningBalance ni el movimiento de inventario a medias.

const { createDraftEntry, postEntry, getMappedAccountId, reverseEntry } = require('./journalEntry.service');

/**
 * Saldo inicial de cartera por cobrar (lo que un cliente ya debía antes de
 * Pitbox). Débito a la cuenta control de clientes (con third_party_id para
 * que aparezca en el auxiliar de ese cliente), crédito a la cuenta puente.
 */
async function createReceivableOpeningBalance(tenantId, params, userId, transaction) {
  const { OpeningBalance } = require('../../models');
  const { customer_id, total_amount, issue_date, due_date, reference, description, branch_id } = params;

  if (!customer_id) throw new Error('Falta el cliente para el saldo inicial de cartera');
  if (!(Number(total_amount) > 0)) throw new Error('El monto del saldo inicial debe ser mayor a cero');
  if (!issue_date) throw new Error('Falta la fecha original de la deuda');

  const receivableAccountId = await getMappedAccountId(tenantId, 'sale_receivable', transaction);
  const suspenseAccountId = await getMappedAccountId(tenantId, 'opening_balance_suspense', transaction);

  const entry = await createDraftEntry(
    tenantId,
    {
      branchId: branch_id,
      entryDate: issue_date,
      sourceType: 'opening_balance',
      description: description || `Saldo inicial de cartera — ${reference || 'cliente'}`,
      lines: [
        { account_id: receivableAccountId, debit: total_amount, credit: 0, third_party_id: customer_id, description: reference || 'Saldo inicial de cartera' },
        { account_id: suspenseAccountId, debit: 0, credit: total_amount, description: 'Contrapartida saldo inicial' },
      ],
      createdBy: userId,
    },
    transaction
  );
  await postEntry(entry.id, tenantId, userId, transaction);

  const openingBalance = await OpeningBalance.create(
    {
      tenant_id: tenantId,
      branch_id: branch_id || null,
      type: 'receivable',
      customer_id,
      reference: reference || null,
      description: description || null,
      issue_date,
      due_date: due_date || null,
      total_amount,
      journal_entry_id: entry.id,
      created_by: userId || null,
    },
    { transaction }
  );

  return openingBalance;
}

/**
 * Saldo inicial de cuentas por pagar (lo que ya se le debía a un proveedor
 * antes de Pitbox). Simétrico al de cartera: crédito a la cuenta control de
 * proveedores, débito a la cuenta puente.
 */
async function createPayableOpeningBalance(tenantId, params, userId, transaction) {
  const { OpeningBalance } = require('../../models');
  const { supplier_id, total_amount, issue_date, due_date, reference, description, branch_id } = params;

  if (!supplier_id) throw new Error('Falta el proveedor para el saldo inicial de cuentas por pagar');
  if (!(Number(total_amount) > 0)) throw new Error('El monto del saldo inicial debe ser mayor a cero');
  if (!issue_date) throw new Error('Falta la fecha original de la deuda');

  const payableAccountId = await getMappedAccountId(tenantId, 'purchase_payable', transaction);
  const suspenseAccountId = await getMappedAccountId(tenantId, 'opening_balance_suspense', transaction);

  const entry = await createDraftEntry(
    tenantId,
    {
      branchId: branch_id,
      entryDate: issue_date,
      sourceType: 'opening_balance',
      description: description || `Saldo inicial de cuentas por pagar — ${reference || 'proveedor'}`,
      lines: [
        { account_id: suspenseAccountId, debit: total_amount, credit: 0, description: 'Contrapartida saldo inicial' },
        { account_id: payableAccountId, debit: 0, credit: total_amount, third_party_id: supplier_id, description: reference || 'Saldo inicial de cuentas por pagar' },
      ],
      createdBy: userId,
    },
    transaction
  );
  await postEntry(entry.id, tenantId, userId, transaction);

  const openingBalance = await OpeningBalance.create(
    {
      tenant_id: tenantId,
      branch_id: branch_id || null,
      type: 'payable',
      supplier_id,
      reference: reference || null,
      description: description || null,
      issue_date,
      due_date: due_date || null,
      total_amount,
      journal_entry_id: entry.id,
      created_by: userId || null,
    },
    { transaction }
  );

  return openingBalance;
}

/**
 * Saldo inicial de una cuenta contable general (caja, bancos, activos fijos,
 * patrimonio existente, etc.) que no tiene subledger de cliente/proveedor.
 * `side`: 'debit' | 'credit' — a qué lado va `account_id` (ej. caja con
 * saldo positivo = debit; un pasivo financiero existente = credit).
 */
async function createAccountOpeningBalance(tenantId, params, userId, transaction) {
  const { account_id, amount, side, entry_date, description, branch_id } = params;

  if (!account_id) throw new Error('Falta la cuenta contable');
  if (!(Number(amount) > 0)) throw new Error('El monto del saldo inicial debe ser mayor a cero');
  if (!['debit', 'credit'].includes(side)) throw new Error('El lado del asiento debe ser "debit" o "credit"');
  if (!entry_date) throw new Error('Falta la fecha del saldo inicial');

  const suspenseAccountId = await getMappedAccountId(tenantId, 'opening_balance_suspense', transaction);

  const mainLine = side === 'debit'
    ? { account_id, debit: amount, credit: 0 }
    : { account_id, debit: 0, credit: amount };
  const suspenseLine = side === 'debit'
    ? { account_id: suspenseAccountId, debit: 0, credit: amount }
    : { account_id: suspenseAccountId, debit: amount, credit: 0 };

  const entry = await createDraftEntry(
    tenantId,
    {
      branchId: branch_id,
      entryDate: entry_date,
      sourceType: 'opening_balance',
      description: description || 'Saldo inicial de cuenta contable',
      lines: [
        { ...mainLine, description: description || 'Saldo inicial' },
        { ...suspenseLine, description: 'Contrapartida saldo inicial' },
      ],
      createdBy: userId,
    },
    transaction
  );
  await postEntry(entry.id, tenantId, userId, transaction);
  return entry;
}

/**
 * Saldo inicial de inventario: carga el stock físico existente de cada
 * producto con su costo. Actualiza current_stock/average_cost vía
 * createMovement (mismo helper que usan compras/ventas) y genera UN asiento
 * por el valor total cargado (débito inventario, crédito cuenta puente).
 *
 * `items`: [{ product_id, warehouse_id?, quantity, unit_cost }]
 */
async function createInventoryOpeningBalance(tenantId, params, userId, transaction) {
  const { createMovement } = require('../../controllers/inventory/movements.controller');
  const { Product } = require('../../models');
  const { items, entry_date, branch_id, description } = params;

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Se necesita al menos un producto para cargar inventario inicial');
  }
  if (!entry_date) throw new Error('Falta la fecha del saldo inicial de inventario');
  if (!userId) throw new Error('Falta el usuario que registra el saldo inicial de inventario');

  let totalValue = 0;
  for (const item of items) {
    if (!item.product_id) throw new Error('Falta product_id en un item de inventario inicial');
    if (!(Number(item.quantity) > 0)) throw new Error(`Cantidad inválida para el producto ${item.product_id}`);
    if (!(Number(item.unit_cost) >= 0)) throw new Error(`Costo inválido para el producto ${item.product_id}`);

    if (!item.warehouse_id) {
      const product = await Product.findOne({ where: { id: item.product_id, tenant_id: tenantId }, transaction });
      if (!product) throw new Error(`Producto ${item.product_id} no encontrado`);
      if (!product.warehouse_id) {
        throw new Error(`El producto "${product.name || item.product_id}" no tiene bodega asignada — indica warehouse_id para cargar su saldo inicial`);
      }
    }

    await createMovement(
      {
        tenant_id: tenantId,
        movement_type: 'entrada',
        movement_reason: 'initial_stock',
        reference_type: 'opening_balance',
        product_id: item.product_id,
        warehouse_id: item.warehouse_id || null,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        user_id: userId,
        movement_date: entry_date,
        notes: 'Carga de saldo inicial de inventario',
      },
      transaction
    );

    totalValue += Number(item.quantity) * Number(item.unit_cost);
  }

  if (totalValue <= 0) {
    throw new Error('El valor total del inventario inicial debe ser mayor a cero');
  }

  const inventoryAccountId = await getMappedAccountId(tenantId, 'purchase_inventory', transaction);
  const suspenseAccountId = await getMappedAccountId(tenantId, 'opening_balance_suspense', transaction);

  const entry = await createDraftEntry(
    tenantId,
    {
      branchId: branch_id,
      entryDate: entry_date,
      sourceType: 'opening_balance',
      description: description || `Saldo inicial de inventario (${items.length} producto(s))`,
      lines: [
        { account_id: inventoryAccountId, debit: totalValue, credit: 0, description: 'Inventario inicial' },
        { account_id: suspenseAccountId, debit: 0, credit: totalValue, description: 'Contrapartida saldo inicial' },
      ],
      createdBy: userId,
    },
    transaction
  );
  await postEntry(entry.id, tenantId, userId, transaction);

  return { entry, totalValue, itemsLoaded: items.length };
}

/**
 * Saldo actual de la cuenta puente — cero significa que todo lo cargado
 * hasta ahora ya está balanceado (no queda nada pendiente de "cerrar").
 */
async function getBridgeAccountStatus(tenantId, transaction) {
  const { sequelize } = require('../../config/database');

  const suspenseAccountId = await getMappedAccountId(tenantId, 'opening_balance_suspense', transaction);

  const [[row]] = await sequelize.query(
    `SELECT
       COALESCE(SUM(l.debit), 0) AS total_debit,
       COALESCE(SUM(l.credit), 0) AS total_credit
     FROM journal_entry_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = :accountId AND e.status = 'posted'`,
    { replacements: { accountId: suspenseAccountId }, transaction }
  );

  const totalDebit = Number(row.total_debit);
  const totalCredit = Number(row.total_credit);
  // Cuenta de patrimonio: saldo natural es crédito. balance > 0 significa
  // que hay más pasivo+patrimonio cargado que activo — falta cargar activo
  // (caja, cartera, inventario) para que cierre en cero; balance < 0 es lo
  // contrario (falta cargar pasivo/patrimonio).
  return { account_id: suspenseAccountId, balance: totalCredit - totalDebit, total_debit: totalDebit, total_credit: totalCredit };
}

/**
 * Cierra la cuenta puente moviendo su saldo neto a la cuenta de patrimonio
 * que el usuario elija (capital social, utilidades acumuladas, etc.).
 */
async function closeBridgeAccount(tenantId, params, userId, transaction) {
  const { target_account_id, entry_date, description } = params;
  if (!target_account_id) throw new Error('Falta la cuenta de patrimonio destino');

  const { balance, account_id: suspenseAccountId } = await getBridgeAccountStatus(tenantId, transaction);
  if (Math.abs(balance) < 0.01) {
    throw new Error('La cuenta puente ya está en cero — no hay nada que cerrar');
  }

  // balance > 0 (crédito neto en la puente) -> hay que debitarla y
  // acreditar la cuenta destino de patrimonio; balance < 0, al revés.
  const amount = Math.abs(balance);
  const lines = balance > 0
    ? [
        { account_id: suspenseAccountId, debit: amount, credit: 0, description: 'Cierre cuenta puente saldos iniciales' },
        { account_id: target_account_id, debit: 0, credit: amount, description: 'Cierre cuenta puente saldos iniciales' },
      ]
    : [
        { account_id: target_account_id, debit: amount, credit: 0, description: 'Cierre cuenta puente saldos iniciales' },
        { account_id: suspenseAccountId, debit: 0, credit: amount, description: 'Cierre cuenta puente saldos iniciales' },
      ];

  const entry = await createDraftEntry(
    tenantId,
    {
      entryDate: entry_date || new Date().toISOString().slice(0, 10),
      sourceType: 'opening_balance',
      description: description || 'Cierre de la cuenta puente de saldos iniciales',
      lines,
      createdBy: userId,
    },
    transaction
  );
  await postEntry(entry.id, tenantId, userId, transaction);
  return entry;
}

/**
 * Anula un saldo inicial de cartera/CxP cargado por error: reversa/anula su
 * asiento contable (según esté draft o posted — ver reverseEntry) y marca la
 * fila como voided para que deje de aparecer en Cartera/CxP.
 */
async function voidOpeningBalance(openingBalanceId, tenantId, userId, reason, transaction) {
  const { OpeningBalance } = require('../../models');

  const openingBalance = await OpeningBalance.findOne({ where: { id: openingBalanceId, tenant_id: tenantId }, transaction });
  if (!openingBalance) throw new Error('Saldo inicial no encontrado');
  if (openingBalance.status === 'voided') throw new Error('Este saldo inicial ya está anulado');

  await reverseEntry(openingBalance.journal_entry_id, tenantId, userId, reason || 'Saldo inicial anulado por corrección', transaction);

  await openingBalance.update(
    { status: 'voided', voided_at: new Date(), voided_by: userId || null, void_reason: reason || null },
    { transaction }
  );

  return openingBalance;
}

module.exports = {
  createReceivableOpeningBalance,
  createPayableOpeningBalance,
  createAccountOpeningBalance,
  createInventoryOpeningBalance,
  getBridgeAccountStatus,
  closeBridgeAccount,
  voidOpeningBalance,
};
