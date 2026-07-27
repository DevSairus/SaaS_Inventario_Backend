const { sequelize } = require('../config/database');
const logger = require('../config/logger');

/**
 * Siembra/actualiza los diagramas base del catálogo.
 * - Inserta los que no existen (por vehicle_type + system + configuration con tenant_id NULL)
 * - Actualiza el svg_content y points de los que ya existen SOLO si nadie los personalizó
 *   a mano (is_customized = false) — ver nota abajo.
 * Idempotente. Se ejecuta al iniciar el server después de las migraciones.
 *
 * IMPORTANTE — no destructivo: antes esta función pisaba SIEMPRE image_path/points/
 * svg_content de cada fila existente con lo que hubiera en el catálogo estático,
 * incluso si un admin había calibrado la imagen WEBP o agregado líneas guía
 * (label_dx/label_dy) manualmente vía PATCH /:id/image o PATCH /:id/points. Como
 * el catálogo nunca llegó a tener image_path, eso terminaba borrando en cada
 * reinicio cualquier calibración manual hecha en la base. Ahora, en cuanto una
 * fila se marca is_customized = true (lo hacen esos dos endpoints), el seed la
 * deja en paz: solo la sigue tocando mientras is_customized = false.
 */
async function seedDiagramTemplates() {
  const catalog = require('../data/diagram-templates-catalog');
  let inserted = 0;
  let updated = 0;
  let skippedCustomized = 0;

  for (const tpl of catalog) {
    const [[existing]] = await sequelize.query(
      `SELECT id, is_customized FROM diagram_templates
       WHERE tenant_id IS NULL AND vehicle_type = :vt AND system = :sys AND configuration = :cfg`,
      { replacements: { vt: tpl.vehicle_type, sys: tpl.system, cfg: tpl.configuration } }
    );

    if (existing) {
      if (existing.is_customized) {
        // Un admin ya calibró image_path y/o points a mano — no lo pisamos.
        skippedCustomized++;
        continue;
      }

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

    // Insertar nuevo — nace sin personalizar, gobernado por el catálogo hasta
    // que alguien lo edite desde el panel admin.
    await sequelize.query(
      `INSERT INTO diagram_templates
         (id, tenant_id, vehicle_type, system, configuration, name, description,
          svg_content, image_path, view_box, points, is_active, is_customized, created_at, updated_at)
       VALUES (gen_random_uuid(), NULL, :vt, :sys, :cfg, :name, :desc,
               :svg, :img, :vb, :pts, true, false, NOW(), NOW())`,
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

  if (inserted > 0 || updated > 0 || skippedCustomized > 0) {
    logger.info(
      `[Seed] Diagram templates: ${inserted} nuevos, ${updated} actualizados, ` +
      `${skippedCustomized} personalizados (sin tocar)`
    );
  } else {
    logger.info(`[Seed] Diagram templates: ${catalog.length} verificados, todos al día`);
  }
}

module.exports = { seedDiagramTemplates };
