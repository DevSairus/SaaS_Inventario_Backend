'use strict';

// 5.2 — Cuentas bancarias por clasificación: tipo (corriente, ahorros, moneda
// extranjera) y moneda. Las cuentas existentes quedan como 'corriente' en COP,
// que es lo que eran: todas colgaban de 111005 (Bancos - Moneda Nacional).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. IF EXISTS porque también corre en `public`.

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE IF EXISTS bank_accounts ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) NOT NULL DEFAULT 'corriente'`);
    await q(`ALTER TABLE IF EXISTS bank_accounts ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'COP'`);
    await q(`
      DO $$ BEGIN
        IF to_regclass('bank_accounts') IS NOT NULL THEN
          ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_account_type_check;
          ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_account_type_check
            CHECK (account_type IN ('corriente', 'ahorros', 'moneda_extranjera'));
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE IF EXISTS bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_account_type_check`);
    await q(`ALTER TABLE IF EXISTS bank_accounts DROP COLUMN IF EXISTS currency`);
    await q(`ALTER TABLE IF EXISTS bank_accounts DROP COLUMN IF EXISTS account_type`);
  },
};
