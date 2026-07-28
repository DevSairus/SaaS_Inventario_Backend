const { sequelize } = require('../config/database');
const logger = require('../config/logger');

/**
 * Siembra/actualiza los diagramas base del catálogo EN UN SCHEMA DADO.
 * - Inserta los que no existen (por vehicle_type + system + configuration con tenant_id NULL)
 * - Actualiza el svg_content y points de los que ya existen SOLO si nadie los personalizó
 *   a mano (is_customized = false) — ver nota abajo.
 * Idempotente.
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
async function seedDiagramTemplatesInSchema(schema) {
  const catalog = require('../data/diagram-templates-catalog');
  const table = `"${schema}"."diagram_templates"`;
  let inserted = 0;
  let updated = 0;
  let skippedCustomized = 0;

  for (const tpl of catalog) {
    const [[existing]] = await sequelize.query(
      `SELECT id, is_customized FROM ${table}
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
        `UPDATE ${table}
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
      `INSERT INTO ${table}
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
      `[Seed] Diagram templates (${schema}): ${inserted} nuevos, ${updated} actualizados, ` +
      `${skippedCustomized} personalizados (sin tocar)`
    );
  } else {
    logger.info(`[Seed] Diagram templates (${schema}): ${catalog.length} verificados, todos al día`);
  }
}

/**
 * Corre el seed en `public` Y en el schema dedicado de CADA tenant ya
 * cortado (tenants.schema_name != null).
 *
 * Por qué hace falta esto y no alcanza con sembrar `public`: en la
 * arquitectura schema-per-tenant, `diagram_templates` es una biblioteca
 * híbrida que provisionTenantSchema.js siembra UNA sola vez por schema (vía
 * la migración 2026072502-seed-diagram-templates-catalog.js) con ids
 * propios por schema (gen_random_uuid() en cada uno) -- nunca con
 * image_path, a propósito (ver esa migración). Antes, este servicio solo
 * tocaba `public.diagram_templates` sin calificar schema, así que cualquier
 * actualización posterior del catálogo (ej. agregar/renombrar los WEBP)
 * nunca llegaba a los tenants ya cortados -- sus filas quedaban con
 * image_path NULL para siempre, aunque `public` sí se actualizara en cada
 * arranque. Pasó desapercibido mientras el ruteo por schema estaba roto
 * (ver registerTenantSchemaHooks.js): todos los tenants leían igual de
 * `public` sin darse cuenta. Al arreglar el ruteo, la falta de sync quedó
 * expuesta como imágenes de diagrama en blanco para tenants ya migrados.
 */
async function seedDiagramTemplates() {
  await seedDiagramTemplatesInSchema('public');

  const [tenants] = await sequelize.query(
    `SELECT DISTINCT schema_name FROM public.tenants WHERE schema_name IS NOT NULL`
  );
  for (const { schema_name } of tenants) {
    try {
      await seedDiagramTemplatesInSchema(schema_name);
    } catch (err) {
      logger.error(`[Seed] Error sembrando diagram templates en schema "${schema_name}": ${err.message}`);
    }
  }
}

module.exports = { seedDiagramTemplates, seedDiagramTemplatesInSchema };
