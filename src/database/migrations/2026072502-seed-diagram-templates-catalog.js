'use strict';

const DIAGRAM_TEMPLATES_CATALOG = require('../../data/diagram-templates-catalog');

// Siembra los diagramas base (autos/camionetas) como biblioteca compartida
// global (tenant_id = NULL), disponible para todos los talleres — ver
// propuesta, sección 2.4. Idempotente: si ya existe un diagrama con la
// misma combinación vehicle_type + system + configuration (y tenant_id
// NULL), se omite en vez de duplicarlo.
module.exports = {
  up: async (queryInterface) => {
    for (const tpl of DIAGRAM_TEMPLATES_CATALOG) {
      const [[existing]] = await queryInterface.sequelize.query(
        `SELECT id FROM diagram_templates
         WHERE tenant_id IS NULL AND vehicle_type = :vehicle_type
           AND system = :system AND configuration = :configuration`,
        { replacements: { vehicle_type: tpl.vehicle_type, system: tpl.system, configuration: tpl.configuration } }
      );
      if (existing) continue;

      // Nota: esta migración corre ANTES que 2026072602 (agrega la columna
      // image_path), así que a propósito no la referenciamos aquí — el
      // servicio seedDiagramTemplates (corre al iniciar el server, después
      // de todas las migraciones) se encarga de poblar image_path tanto en
      // filas nuevas como existentes.
      await queryInterface.sequelize.query(
        `INSERT INTO diagram_templates
           (id, tenant_id, vehicle_type, system, configuration, name, description,
            svg_content, view_box, points, is_active, created_at, updated_at)
         VALUES
           (gen_random_uuid(), NULL, :vehicle_type, :system, :configuration, :name, :description,
            :svg_content, :view_box, :points, true, NOW(), NOW())`,
        {
          replacements: {
            vehicle_type: tpl.vehicle_type,
            system: tpl.system,
            configuration: tpl.configuration,
            name: tpl.name,
            description: tpl.description,
            svg_content: tpl.svg_content || null,
            view_box: tpl.view_box,
            points: JSON.stringify(tpl.points),
          },
        }
      );
    }
  },

  down: async (queryInterface) => {
    for (const tpl of DIAGRAM_TEMPLATES_CATALOG) {
      await queryInterface.sequelize.query(
        `DELETE FROM diagram_templates
         WHERE tenant_id IS NULL AND vehicle_type = :vehicle_type
           AND system = :system AND configuration = :configuration`,
        { replacements: { vehicle_type: tpl.vehicle_type, system: tpl.system, configuration: tpl.configuration } }
      );
    }
  },
};
