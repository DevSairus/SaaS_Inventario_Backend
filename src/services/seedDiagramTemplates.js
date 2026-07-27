const { sequelize } = require('../config/database');
const logger = require('../config/logger');

/**
 * Siembra/actualiza los diagramas base del catálogo.
 * - Inserta los que no existen (por vehicle_type + system + configuration con tenant_id NULL)
 * - Actualiza el svg_content y points de los que ya existen si cambiaron
 * Idempotente. Se ejecuta al iniciar el server después de las migraciones.
 */
async function seedDiagramTemplates() {
  const catalog = require('../data/diagram-templates-catalog');
  let inserted = 0;
  let updated = 0;

  for (const tpl of catalog) {
    const [[existing]] = await sequelize.query(
      `SELECT id, svg_content FROM diagram_templates
       WHERE tenant_id IS NULL AND vehicle_type = :vt AND system = :sys AND configuration = :cfg`,
      { replacements: { vt: tpl.vehicle_type, sys: tpl.system, cfg: tpl.configuration } }
    );

    if (existing) {
      // Siempre actualizar para asegurar contenido fresco
      await sequelize.query(
        `UPDATE diagram_templates
         SET svg_content = :svg, image_path = :img, view_box = :vb, points = :pts,
             name = :name, description = :desc, updated_at = NOW()
         WHERE id = :id`,
        {
          replacements: {
            id: existing.id,
            svg: tpl.svg_content || null, img: tpl.image_path || null, vb: tpl.view_box,
            pts: JSON.stringify(tpl.points),
            name: tpl.name, desc: tpl.description,
          },
        }
      );
      updated++;
      continue;
    }

    // Insertar nuevo
    await sequelize.query(
      `INSERT INTO diagram_templates
         (id, tenant_id, vehicle_type, system, configuration, name, description,
          svg_content, image_path, view_box, points, is_active, created_at, updated_at)
       VALUES (gen_random_uuid(), NULL, :vt, :sys, :cfg, :name, :desc,
               :svg, :img, :vb, :pts, true, NOW(), NOW())`,
      {
        replacements: {
          vt: tpl.vehicle_type, sys: tpl.system, cfg: tpl.configuration,
          name: tpl.name, desc: tpl.description,
          svg: tpl.svg_content || null, img: tpl.image_path || null, vb: tpl.view_box,
          pts: JSON.stringify(tpl.points),
        },
      }
    );
    inserted++;
  }

  if (inserted > 0 || updated > 0) {
    logger.info(`[Seed] Diagram templates: ${inserted} nuevos, ${updated} actualizados`);
  } else {
    logger.info(`[Seed] Diagram templates: ${catalog.length} verificados, todos al día`);
  }
}

module.exports = { seedDiagramTemplates };
