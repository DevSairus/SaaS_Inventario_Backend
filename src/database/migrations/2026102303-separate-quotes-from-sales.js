'use strict';

// Cotizaciones separadas de las ventas. Hasta ahora create() ignoraba el
// document_type='cotizacion' que manda el formulario de cotización: toda
// cotización nacía como un borrador de venta más (document_type NULL,
// número BORRADOR-<timestamp>) y se listaba/contaba como venta.
//
// - quote_valid_until: vigencia de la cotización (PDF, link público; al
//   vencer el cliente ya no puede aprobarla).
// - quote_number: número COT- que tenía la venta antes de convertirse en
//   remisión/factura (mismo patrón que remision_number) -- deja la traza
//   y permite seguir viendo la cotización convertida en el listado.
// - Backfill: los borradores sin tipo que ya funcionaban como cotización
//   (se compartieron al cliente -- quote_status lleno -- o están vinculados
//   a una oportunidad del CRM) pasan a document_type='cotizacion' con su
//   propio consecutivo COT-YYYY-NNNN.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('sales');

    if (!existingColumns.quote_valid_until) {
      await queryInterface.addColumn('sales', 'quote_valid_until', {
        type: Sequelize.DATEONLY,
        allowNull: true,
      });
    }
    if (!existingColumns.quote_number) {
      await queryInterface.addColumn('sales', 'quote_number', {
        type: Sequelize.STRING(50),
        allowNull: true,
      });
    }

    const [[{ has_opportunities }]] = await queryInterface.sequelize.query(
      `SELECT to_regclass('opportunities') IS NOT NULL AS has_opportunities`
    );
    const opportunityCondition = has_opportunities
      ? `OR EXISTS (SELECT 1 FROM opportunities o WHERE o.quote_sale_id = s.id)`
      : '';

    await queryInterface.sequelize.query(`
      WITH targets AS (
        SELECT s.id, s.tenant_id, s.created_at,
               EXTRACT(YEAR FROM COALESCE(s.created_at, NOW()))::int AS yr
        FROM sales s
        WHERE s.document_type IS NULL
          AND s.status = 'draft'
          AND (s.quote_status IS NOT NULL ${opportunityCondition})
      ),
      numbered AS (
        SELECT t.id, t.yr,
               ROW_NUMBER() OVER (PARTITION BY t.tenant_id, t.yr ORDER BY t.created_at, t.id)
               + COALESCE((
                   SELECT MAX(split_part(x.sale_number, '-', 3)::int)
                   FROM sales x
                   WHERE x.tenant_id = t.tenant_id
                     AND x.sale_number ~ ('^COT-' || t.yr || '-[0-9]+$')
                 ), 0) AS seq
        FROM targets t
      )
      UPDATE sales s
      SET document_type = 'cotizacion',
          sale_number   = 'COT-' || n.yr || '-' || lpad(n.seq::text, 4, '0'),
          quote_status  = COALESCE(s.quote_status, 'borrador')
      FROM numbered n
      WHERE s.id = n.id
    `);
  },

  down: async (queryInterface) => {
    // El backfill no se revierte (los números COT- ya pudieron compartirse
    // con el cliente) -- solo se quitan las columnas nuevas.
    await queryInterface.removeColumn('sales', 'quote_number');
    await queryInterface.removeColumn('sales', 'quote_valid_until');
  },
};
