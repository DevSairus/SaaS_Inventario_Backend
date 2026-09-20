'use strict';

// Conciliación Bancaria — Fase 3 del plan de Contabilidad Pitbox.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 3.
// Mismo patrón estructural que 2026091501-create-fixed-assets.js /
// 2026091503-create-loans.js: tablas compartidas (tenant_id -> public.tenants),
// no schema-per-tenant (la migración de schema-per-tenant sigue revertida).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Gap previo señalado en el plan: hoy solo existe una cuenta PUC
      // genérica de Bancos (111005) en account_mapping -- no hay forma de
      // distinguir contablemente 2 cuentas bancarias de bancos distintos de
      // un mismo tenant. `chart_of_account_id` es la subcuenta dedicada
      // (ej. 111005-01) que se crea automáticamente al dar de alta esta fila.
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS bank_accounts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,

          bank_name VARCHAR(100) NOT NULL,
          account_number VARCHAR(30) NOT NULL,
          account_alias VARCHAR(100),

          chart_of_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,

          is_active BOOLEAN NOT NULL DEFAULT true,
          created_by UUID REFERENCES "public"."users"(id),

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // Recuerda el mapeo de columnas elegido la primera vez que se importa
      // un extracto de un banco (por file_signature = hash de los headers
      // detectados), para que las siguientes importaciones del mismo banco
      // no vuelvan a pedirlo. Único por (bank_account_id, file_signature):
      // el mismo layout podría repetirse en más de una cuenta del mismo
      // banco, pero cada cuenta bancaria guarda su propia plantilla.
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS bank_import_templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE ON UPDATE CASCADE,

          file_signature VARCHAR(64) NOT NULL,
          column_mapping JSONB NOT NULL,
          date_format VARCHAR(20) NOT NULL DEFAULT 'DD/MM/YYYY',
          amount_format JSONB NOT NULL DEFAULT '{"decimal_separator": ",", "mode": "unico"}'::jsonb,

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // Movimientos importados del extracto real del banco. `amount`
      // positivo = entrada, negativo = salida (mismo signo que ya usa
      // cashReconciliation.service.js para caja/bancos). `raw_row` guarda la
      // fila original completa (JSONB) por si hay que auditar un import.
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS bank_transactions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE ON UPDATE CASCADE,

          transaction_date DATE NOT NULL,
          description VARCHAR(255),
          amount DECIMAL(15,2) NOT NULL,
          reference VARCHAR(100),
          raw_row JSONB,

          reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'pendiente'
            CHECK (reconciliation_status IN ('pendiente', 'conciliada', 'ignorada')),

          -- No hay FK real a journal_entry_lines porque esa tabla no tiene
          -- índice único ni PK aparte de id (sí la tiene) -- sí se puede,
          -- pero se deja ON DELETE SET NULL para que borrar/reversar un
          -- asiento no rompa el import, solo deje la conciliación pendiente
          -- de nuevo.
          matched_journal_entry_line_id UUID REFERENCES journal_entry_lines(id) ON DELETE SET NULL,

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS bank_accounts_tenant_id_idx ON bank_accounts (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS bank_import_templates_tenant_id_idx ON bank_import_templates (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS bank_import_templates_account_sig_idx ON bank_import_templates (bank_account_id, file_signature)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS bank_transactions_tenant_id_idx ON bank_transactions (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS bank_transactions_account_status_idx ON bank_transactions (bank_account_id, reconciliation_status)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS bank_transactions_date_idx ON bank_transactions (bank_account_id, transaction_date)`,
        { transaction }
      );
      // Evita duplicar el mismo movimiento si el usuario sube el mismo
      // extracto dos veces (mismo criterio de "único por" que ya usan
      // FixedAssetDepreciationEntry/LoanInstallment): misma cuenta, fecha,
      // monto, descripción y referencia = mismo movimiento.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_dedupe_idx ON bank_transactions
           (bank_account_id, transaction_date, amount, COALESCE(reference, ''), COALESCE(description, ''))`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS bank_transactions`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS bank_import_templates`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS bank_accounts`);
  },
};
