// backend/src/services/exogena/format1012.service.js
//
// Formato 1012 — Saldos de cuentas de ahorro/corrientes/inversiones y
// acciones. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo B.
// Anexo técnico: T3.27 (F1012 v7, Resolución 000227/2025).
//
// A diferencia de los demás formatos, aquí el TERCERO reportado es la
// entidad financiera (el banco), no un cliente/proveedor -- así lo exige el
// Artículo 1.3.5.10.1: "razón social, identificación... de la entidad
// financiera". Concepto 1110 "saldo de cuenta corriente y/o ahorro
// nacional" (ítem 1 de la tabla de conceptos de ese artículo) es el único
// aplicable: Pitbox no maneja inversiones en bonos/CDT/acciones vía este
// módulo.
//
// El saldo a 31 de diciembre se calcula sumando débitos-créditos de los
// asientos `posted` en la subcuenta PUC dedicada de cada BankAccount
// (BankAccount.chart_of_account_id, Fase 3) hasta esa fecha inclusive --
// mismo criterio que cualquier reporte de saldo contable (Balance General,
// Libro Mayor).
//
// Requiere BankAccount.bank_tax_id (NIT del banco) -- campo nuevo agregado
// en esta fase porque antes solo se guardaba el nombre del banco. Sin él,
// la cuenta se excluye (`skipped`) en vez de inventar un NIT.
//
// Atributos según XSD: cpt, tdoc, nid, dv, apl1, apl2, nom1, nom2, raz,
// pais, val.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { calculateNitDv } = require('../../utils/nitDv');
const { COLOMBIA_COUNTRY_CODE } = require('../../data/exogena-catalogs');

const CONCEPT_SAVINGS_CHECKING_NATIONAL = '1110';

async function buildRecords(tenantId, year) {
  const schema = getCurrentSchema() || 'public';
  const cutoff = `${year}-12-31`;

  const rows = await sequelize.query(
    `SELECT ba.id AS bank_account_id, ba.bank_name, ba.bank_tax_id,
            COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS balance
     FROM "${schema}"."bank_accounts" ba
     LEFT JOIN "${schema}"."journal_entries" je
       ON je.status = 'posted' AND je.entry_date <= :cutoff
     LEFT JOIN "${schema}"."journal_entry_lines" l
       ON l.entry_id = je.id AND l.account_id = ba.chart_of_account_id
     WHERE ba.tenant_id = :tenantId
     GROUP BY ba.id, ba.bank_name, ba.bank_tax_id`,
    { replacements: { tenantId, cutoff }, type: QueryTypes.SELECT }
  );

  const skipped = [];
  const records = [];
  for (const row of rows) {
    if (!row.bank_tax_id) {
      skipped.push({ reason: 'banco_sin_nit', bank_account_id: row.bank_account_id, bank_name: row.bank_name });
      continue;
    }
    const nid = String(row.bank_tax_id).replace(/\D/g, '');
    records.push({
      cpt: CONCEPT_SAVINGS_CHECKING_NATIONAL,
      tdoc: '31', // Bancos colombianos siempre reportan con NIT.
      nid,
      dv: calculateNitDv(nid),
      raz: row.bank_name,
      pais: COLOMBIA_COUNTRY_CODE,
      // El esquema exige un valor positivo -- un saldo contable negativo
      // (sobregiro) no tiene casilla propia en este formato, se reporta en
      // 0 en vez de un negativo inválido para el XSD.
      val: Math.max(0, Math.round(Number(row.balance || 0))),
    });
  }

  return { records, skipped };
}

module.exports = {
  formatCode: '1012',
  version: 7,
  recordElementName: 'dectri',
  totalValueField: 'val',
  buildRecords,
};
