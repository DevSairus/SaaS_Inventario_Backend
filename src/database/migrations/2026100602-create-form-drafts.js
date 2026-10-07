'use strict';

// Borradores de formularios (venta, cotización, ingreso de OT) sincronizados
// con el servidor para poder continuarlos desde otro equipo o navegador. El
// mismo borrador vive primero en localStorage del equipo (ver
// frontend/src/hooks/useFormDraft.js); esta tabla es la copia compartida.
// No son ventas: no consumen numeración, no apartan stock ni aparecen en
// listados o reportes. Uno por (tenant, usuario, formulario).

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      CREATE TABLE IF NOT EXISTS form_drafts (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        user_id UUID NOT NULL,
        scope VARCHAR(150) NOT NULL,
        data JSONB NOT NULL,
        meta JSONB,
        saved_at TIMESTAMPTZ NOT NULL,
        device_id VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS form_drafts_owner_scope_uq ON form_drafts (tenant_id, user_id, scope)`);
    await q.query(`CREATE INDEX IF NOT EXISTS form_drafts_saved_at_idx ON form_drafts (saved_at)`);
    console.log('[Migration] form_drafts');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS form_drafts`);
  },
};
