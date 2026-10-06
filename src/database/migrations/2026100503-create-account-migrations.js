'use strict';

// Migración de movimientos de una cuenta a otra (solo contabilidad:
// admin/accountant). Ver services/accounting/accountMigration.service.js.
//
// Dos modos:
//   reclassification: asiento nuevo (source_type 'reclassification') que
//     saca el saldo neto de la cuenta origen y lo lleva a la destino, por
//     tercero y sede. No toca los asientos originales; sirve aunque el
//     rango incluya períodos cerrados.
//   direct: cambia la cuenta de las líneas existentes (UPDATE
//     journal_entry_lines.account_id). Solo si TODOS los asientos afectados
//     están en períodos abiertos. line_ids guarda exactamente qué se movió.
//
// Esta tabla es la bitácora de cada ejecución.

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      CREATE TABLE IF NOT EXISTS account_migrations (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        mode VARCHAR(20) NOT NULL CHECK (mode IN ('reclassification', 'direct')),
        from_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
        to_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
        date_from DATE NOT NULL,
        date_to DATE NOT NULL,
        filters JSONB NOT NULL DEFAULT '{}'::jsonb,
        lines_count INTEGER NOT NULL DEFAULT 0,
        total_debit DECIMAL(18,2) NOT NULL DEFAULT 0,
        total_credit DECIMAL(18,2) NOT NULL DEFAULT 0,
        line_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        entry_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        mappings_updated JSONB NOT NULL DEFAULT '[]'::jsonb,
        reason TEXT NOT NULL,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS account_migrations_tenant_idx ON account_migrations (tenant_id, created_at DESC)`);
    console.log('[Migration] account_migrations');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS account_migrations`);
  },
};
