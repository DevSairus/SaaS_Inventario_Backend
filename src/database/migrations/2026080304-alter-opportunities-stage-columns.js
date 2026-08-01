'use strict';

// CRM Fase B.4 — opportunities.stage / lost_reason dejan de ser ENUM fijo de
// Postgres y pasan a VARCHAR libre: guardan el `key` (slug) de la fila
// correspondiente en crm_pipeline_stages / crm_loss_reasons de ese tenant.
// Los valores actuales ('nuevo', 'perdido', 'precio', ...) siguen siendo
// válidos como texto sin tocar los datos — el seed de
// 2026080305-seed-crm-pipeline-defaults.js crea justamente esas mismas keys.
//
// Notas:
// - Se usa information_schema en vez de queryInterface.describeTable()
//   porque describeTable() dispara un bug de Sequelize/Postgres en este
//   entorno (subconsulta de PK devolviendo más de un registro).
// - information_schema.columns lista tablas de TODOS los schemas, no solo
//   el actual — hay que filtrar explícitamente por table_schema = current_schema()
//   o esta migración toma por error los metadatos de otro tenant/schema
//   cuando corre bajo runWithTenantSchema (search_path apunta al schema del
//   tenant, pero information_schema no respeta ese scoping en el WHERE).
module.exports = {
  up: async (queryInterface) => {
    const [[stageCol]] = await queryInterface.sequelize.query(`
      SELECT udt_name, column_default FROM information_schema.columns
      WHERE table_name = 'opportunities' AND column_name = 'stage' AND table_schema = current_schema()
    `);
    if (stageCol && stageCol.udt_name !== 'varchar') {
      await queryInterface.sequelize.query(`
        ALTER TABLE "opportunities" ALTER COLUMN "stage" TYPE VARCHAR(50) USING "stage"::text;
      `);
    }
    // El DEFAULT 'nuevo' pudo quedar apuntando al ENUM (::enum_opportunities_stage)
    // aunque la columna ya se haya convertido en una corrida anterior — hay
    // que resetearlo como texto plano para poder soltar el tipo más abajo.
    if (stageCol && stageCol.column_default && stageCol.column_default.includes('enum_opportunities_stage')) {
      await queryInterface.sequelize.query(`
        ALTER TABLE "opportunities" ALTER COLUMN "stage" DROP DEFAULT;
        ALTER TABLE "opportunities" ALTER COLUMN "stage" SET DEFAULT 'nuevo';
      `);
    }

    const [[lostReasonCol]] = await queryInterface.sequelize.query(`
      SELECT udt_name FROM information_schema.columns
      WHERE table_name = 'opportunities' AND column_name = 'lost_reason' AND table_schema = current_schema()
    `);
    if (lostReasonCol && lostReasonCol.udt_name !== 'varchar') {
      await queryInterface.sequelize.query(`
        ALTER TABLE "opportunities" ALTER COLUMN "lost_reason" TYPE VARCHAR(50) USING "lost_reason"::text;
      `);
    }

    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_opportunities_stage";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_opportunities_lost_reason";');
  },

  down: async () => {
    // No-op — volver a ENUM requeriría garantizar que no existan keys custom
    // creadas por el tenant vía crm_pipeline_stages/crm_loss_reasons.
  },
};
