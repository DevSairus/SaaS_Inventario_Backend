'use strict';

// Activos Fijos y Depreciación — Fase 1 del plan de Contabilidad Pitbox.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 1.
// Mismo patrón estructural que 2026082101-create-customer-advances.js:
// tablas compartidas (tenant_id -> public.tenants), no schema-per-tenant —
// igual que el resto del motor contable (chart_of_accounts, journal_entries).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS fixed_assets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          branch_id UUID REFERENCES branches(id) ON DELETE SET NULL ON UPDATE CASCADE,

          name VARCHAR(150) NOT NULL,
          category VARCHAR(30) NOT NULL DEFAULT 'otro'
            CHECK (category IN ('vehiculo', 'maquinaria', 'equipo_computo', 'muebles_enseres', 'otro')),

          acquisition_cost DECIMAL(15,2) NOT NULL CHECK (acquisition_cost > 0),
          acquisition_date DATE NOT NULL,
          useful_life_months INTEGER NOT NULL CHECK (useful_life_months > 0),
          salvage_value DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),

          -- ENUM de un solo valor por ahora a propósito (ver plan Fase 1):
          -- deja el campo listo para 'saldos_decrecientes'/'unidades_producidas'
          -- después sin tener que migrar de nuevo.
          depreciation_method VARCHAR(20) NOT NULL DEFAULT 'linea_recta'
            CHECK (depreciation_method IN ('linea_recta')),

          -- Cuenta del activo bruto y de su depreciación acumulada: se eligen
          -- por activo (no vía account_mappings global) porque varían por
          -- categoría/subcuenta -- ej. 1592 puede necesitar más de una
          -- subcuenta si el tenant separa depreciación acumulada por tipo
          -- de activo.
          asset_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          accumulated_depreciation_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,

          status VARCHAR(20) NOT NULL DEFAULT 'activo'
            CHECK (status IN ('activo', 'totalmente_depreciado', 'dado_de_baja')),

          disposal_date DATE,
          disposal_reason TEXT,

          created_by UUID REFERENCES "public"."users"(id),

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS fixed_asset_depreciation_entries (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          fixed_asset_id UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE ON UPDATE CASCADE,

          -- 'YYYY-MM'. VARCHAR en vez de DATE: el período no tiene "día", y
          -- comparar/ordenar strings 'YYYY-MM' es cronológicamente correcto.
          period VARCHAR(7) NOT NULL,

          amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
          accumulated_after DECIMAL(15,2) NOT NULL,

          journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS fixed_assets_tenant_id_idx ON fixed_assets (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS fixed_assets_tenant_status_idx ON fixed_assets (tenant_id, status)`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS fixed_asset_depreciation_entries_tenant_id_idx ON fixed_asset_depreciation_entries (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS fixed_asset_dep_entries_asset_idx ON fixed_asset_depreciation_entries (fixed_asset_id)`,
        { transaction }
      );
      // Único por (fixed_asset_id, period) -- evita doble depreciación del
      // mismo mes si el job corre dos veces (ver también advisory lock del
      // scheduler, que ya previene la causa más común de esto).
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS fixed_asset_dep_entries_asset_period_idx ON fixed_asset_depreciation_entries (fixed_asset_id, period)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS fixed_asset_depreciation_entries`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS fixed_assets`);
  },
};
