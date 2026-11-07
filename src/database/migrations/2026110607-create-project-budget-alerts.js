'use strict';

// Alertas de sobrecosto (Fase 2 del módulo Proyectos). Ver
// services/projects/projectAlerts.service.js.
//
//   projects.alert_warning_pct / alert_critical_pct: umbrales del proyecto
//     (por defecto 80 % y 100 % del presupuesto).
//   project_budget_alerts: una alerta abierta por proyecto, categoría y
//     nivel (índice único parcial). Se avisa una vez al abrirse y se
//     resuelve sola si lo ejecutado vuelve a quedar por debajo.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`ALTER TABLE IF EXISTS projects ADD COLUMN IF NOT EXISTS alert_warning_pct DECIMAL(5, 2) NOT NULL DEFAULT 80`);
      await q(`ALTER TABLE IF EXISTS projects ADD COLUMN IF NOT EXISTS alert_critical_pct DECIMAL(5, 2) NOT NULL DEFAULT 100`);
      await q(`
        CREATE TABLE IF NOT EXISTS project_budget_alerts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          category VARCHAR(20) NOT NULL CHECK (category IN ('total', 'materials', 'labor', 'services', 'other')),
          level VARCHAR(20) NOT NULL CHECK (level IN ('warning', 'critical')),
          budget DECIMAL(15, 2) NOT NULL,
          executed DECIMAL(15, 2) NOT NULL,
          executed_pct DECIMAL(7, 2) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
          notified_at TIMESTAMP WITH TIME ZONE,
          resolved_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS project_budget_alerts_open_idx ON project_budget_alerts (project_id, category, level) WHERE status = 'open'`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP TABLE IF EXISTS project_budget_alerts`);
    await q(`ALTER TABLE IF EXISTS projects DROP COLUMN IF EXISTS alert_critical_pct`);
    await q(`ALTER TABLE IF EXISTS projects DROP COLUMN IF EXISTS alert_warning_pct`);
  },
};
