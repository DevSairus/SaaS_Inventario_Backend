// src/scripts/migrateTenantData.js
//
// Uso: node src/scripts/migrateTenantData.js <tenant_slug>
//
// Requiere que provisionTenantSchema.js ya se haya corrido para ese tenant
// (el schema y las tablas deben existir y estar vacías).
//
// Copia cada fila de las tablas "por tenant" en public que tenga
// tenant_id = <id del tenant>, hacia la tabla homónima en su schema nuevo.
//
// IMPORTANTE: SÍ se copia la columna tenant_id tal cual (no se excluye).
// Las tablas nuevas se crearon con las mismas migraciones, así que esa
// columna sigue existiendo (y normalmente es NOT NULL) -> omitirla rompe
// el INSERT. El aislamiento real ahora lo da el schema; tenant_id queda
// como columna redundante que se elimina en un paso de limpieza aparte,
// cuando ya no haya ninguna duda de que la migración fue exitosa.
//
// El orden de copiado respeta las foreign keys (padres antes que hijos)
// vía un topological sort sobre information_schema.

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { schemaNameFor } = require('./provisionTenantSchema');
const { discoverTenantTables, tablesInOrder, buildIndirectSourceSql, buildIndirectCountSql } = require('./tenantScopedTables');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;

// Valores legacy en `public` que ya no son válidos contra el CHECK constraint
// del schema nuevo (dato viejo que quedó de antes de que el enum se
// endureciera, nunca limpiado). Se remapean SOLO en la copia hacia el
// tenant -- la fila original en `public` no se toca.
const COLUMN_VALUE_TRANSFORMS = {
  products: {
    // 915 filas en el sistema (126 de este tenant) tienen 'product', que ya
    // no es un valor válido de product_type (simple/variant/service/bundle/
    // raw_material) -- decisión: tratarlas como 'simple' (ítem físico
    // vendible genérico sin variantes).
    product_type: `CASE WHEN "product_type" = 'product' THEN 'simple' ELSE "product_type" END`,
    // Filas legacy en `public` tienen barcode = '' (string vacío) en vez de
    // NULL para "sin código de barras". El constraint tenant_barcode_unique
    // (tenant_id, barcode) del schema nuevo sí lo valida desde cero, y varios
    // '' repetidos para el mismo tenant lo violan. NULL sí puede repetirse
    // bajo UNIQUE -> normalizar '' a NULL preserva la semántica real.
    barcode: `NULLIF("barcode", '')`,
    // El check constraint de `unit_of_measure` en `public` es más laxo que el
    // del baseline: acepta sinónimos en español (cargados por UI/import en
    // algún momento) además de las abreviaturas canónicas. El schema nuevo
    // sólo valida las abreviaturas -> remapear cada sinónimo a su canónica.
    unit_of_measure: `CASE "unit_of_measure"
      WHEN 'unidad' THEN 'unit' WHEN 'unidades' THEN 'unit' WHEN 'pieza' THEN 'unit' WHEN 'piezas' THEN 'unit'
      WHEN 'kilo' THEN 'kg' WHEN 'kilos' THEN 'kg' WHEN 'kilogramo' THEN 'kg' WHEN 'kilogramos' THEN 'kg'
      WHEN 'gramo' THEN 'g' WHEN 'gramos' THEN 'g'
      WHEN 'libra' THEN 'lb' WHEN 'libras' THEN 'lb'
      WHEN 'onza' THEN 'oz' WHEN 'onzas' THEN 'oz'
      WHEN 'litro' THEN 'l' WHEN 'litros' THEN 'l'
      WHEN 'mililitro' THEN 'ml' WHEN 'mililitros' THEN 'ml'
      WHEN 'galon' THEN 'gal' WHEN 'galones' THEN 'gal'
      WHEN 'metro' THEN 'm' WHEN 'metros' THEN 'm'
      WHEN 'centimetro' THEN 'cm' WHEN 'centimetros' THEN 'cm'
      WHEN 'pie' THEN 'ft' WHEN 'pies' THEN 'ft'
      WHEN 'caja' THEN 'box' WHEN 'cajas' THEN 'box'
      WHEN 'paquete' THEN 'pack' WHEN 'paquetes' THEN 'pack'
      WHEN 'docena' THEN 'dozen' WHEN 'docenas' THEN 'dozen'
      ELSE "unit_of_measure" END`,
  },
};

// `diagram_templates` es una biblioteca híbrida: filas con tenant_id = NULL
// son un catálogo global "compartido" que CADA schema de tenant vuelve a
// sembrar de forma independiente (2026072502-seed-diagram-templates-catalog.js
// usa gen_random_uuid()) -> el mismo template lógico tiene un id DISTINTO en
// cada schema. Copiar diagram_template_id tal cual desde `public` rompe el FK.
// Se resuelve en REMAPPED_FK_COLUMNS con lógica dedicada (ver más abajo), no
// con un simple passthrough de id.
const REMAPPED_FK_COLUMNS = {
  work_order_diagnosis_marks: ['diagram_template_id'],
  sale_diagnosis_marks: ['diagram_template_id'],
};

// sales <-> work_orders se referencian mutuamente (work_orders.sale_id /
// quote_sale_id -> sales.id, sales.converted_to_work_order_id -> work_orders.id).
// No existe un orden de inserción de una sola pasada que respete ambas
// direcciones. Neon no permite `DISABLE TRIGGER ALL` a un rol no-superuser
// (bloquea los triggers de sistema de FK), así que estas columnas se
// insertan como NULL y se rellenan con un UPDATE después de que ambas
// tablas ya tengan todas sus filas.
const DEFERRED_FK_COLUMNS = {
  work_orders: ['sale_id', 'quote_sale_id'],
  sales: ['converted_to_work_order_id'],
};

// Columnas que existen en el schema del tenant (por el baseline crudo que usa
// provisionTenantSchema.js) pero NO existen en `public` -- no porque alguien
// las haya borrado, sino porque `CREATE TABLE IF NOT EXISTS` es un no-op
// cuando la tabla ya existía en `public` desde antes, con una estructura más
// vieja que nunca tuvo esa columna. El baseline sí la trae porque ahí crea
// la tabla desde cero. No hay valor real que copiar -- hay que generarlo.
// Cada función corre una vez DESPUÉS de insertar todas las filas de esa
// tabla (permite usar window functions/agregados sobre el propio destino).
//
// `tenant_id` es un caso aparte y se maneja siempre automático (ver más
// abajo): cualquier tabla indirecta con tenant_id en el schema pero no en
// public lo recibe del parámetro `tenantId` sin necesidad de listarla acá.
const GENERATED_COLUMNS = {
  purchase_items: {
    // No existe ni remotamente en public.purchase_items -- se reconstruye
    // como la posición relativa dentro de su compra (orden de captura) vía
    // ROW_NUMBER(). No es "el" line_number original (nunca existió en
    // public), pero preserva un orden estable y consistente por compra.
    line_number: (schemaName) => `
      UPDATE "${schemaName}"."purchase_items" pi
      SET line_number = sub.rn
      FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY purchase_id ORDER BY created_at, id) AS rn
        FROM "${schemaName}"."purchase_items"
      ) sub
      WHERE pi.id = sub.id
    `,
    // product_name/product_sku son snapshots del producto al momento de la
    // compra (denormalizados). public.purchase_items nunca los tuvo -- se
    // reconstruyen desde el estado ACTUAL de products (product_id ya se
    // copió tal cual, y products se migra antes por el orden topológico).
    // No es "el nombre que tenía en ese momento" (eso no existe en public),
    // pero es la mejor aproximación disponible.
    product_name: (schemaName) => `
      UPDATE "${schemaName}"."purchase_items" pi
      SET product_name = p.name
      FROM "${schemaName}"."products" p
      WHERE pi.product_id = p.id
    `,
    product_sku: (schemaName) => `
      UPDATE "${schemaName}"."purchase_items" pi
      SET product_sku = p.sku
      FROM "${schemaName}"."products" p
      WHERE pi.product_id = p.id
    `,
    // line_total es el nombre viejo de lo que public ya trackea como "total"
    // (columna agregada después junto a subtotal, ver comentario en el
    // CREATE TABLE del baseline). "total" ya se copia 1:1 por passthrough
    // normal (existe en ambos schemas) antes de que este backfill corra.
    line_total: (schemaName) => `
      UPDATE "${schemaName}"."purchase_items"
      SET line_total = COALESCE(total, 0)
    `,
  },
};

// El descubrimiento de tablas (directas por tenant_id propio + indirectas
// resueltas por FK transitiva, ej. customer_return_items -> sale_items) y el
// orden topológico ahora viven en tenantScopedTables.js, compartido con
// cleanupTenantPublicData.js y tenantPurgeService.js -- ver ese archivo para
// el porqué (bug de FK que dejaba tablas indirectas sin migrar ni limpiar).
//
// NOTA sobre vistas: discoverTenantTables ya filtra table_type='BASE TABLE'
// al buscar las directas, así que vistas con columna tenant_id (ej.
// v_product_prices_comparison) no entran acá.

async function migrateTenantData(slug, tenantId) {
  const schemaName = schemaNameFor(slug);
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    logging: false,
  });

  try {
    const { directTables, indirectTables, resolutionChains } = await discoverTenantTables(sequelize);
    const indirectSet = new Set(indirectTables);
    if (indirectTables.length) {
      console.log(`ℹ️  Tablas indirectas detectadas (sin tenant_id propio, resueltas por FK): ${indirectTables.join(', ')}`);
    }
    const ordered = await tablesInOrder(sequelize, [...directTables, ...indirectTables]);
    console.log(`Orden de copiado (${ordered.length} tablas):`, ordered.join(', '));

    const report = [];

    // Las columnas de DEFERRED_FK_COLUMNS/REMAPPED_FK_COLUMNS se insertan como
    // NULL y se rellenan después -- si la columna es NOT NULL en el schema
    // destino, hay que relajarla temporalmente o el INSERT falla antes de
    // llegar al backfill. Se restaura al final (si el backfill de verdad
    // llenó todas las filas; si no, el ALTER ... SET NOT NULL revienta y
    // avisa del problema en vez de dejar una columna NOT NULL mentirosa).
    const relaxedNotNull = [];
    for (const [table, columns] of [
      ...Object.entries(DEFERRED_FK_COLUMNS),
      ...Object.entries(REMAPPED_FK_COLUMNS),
    ]) {
      if (!ordered.includes(table)) continue;
      for (const column of columns) {
        const [[colInfo]] = await sequelize.query(`
          SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = '${schemaName}' AND table_name = '${table}' AND column_name = '${column}'
        `);
        if (colInfo && colInfo.is_nullable === 'NO') {
          await sequelize.query(`ALTER TABLE "${schemaName}"."${table}" ALTER COLUMN "${column}" DROP NOT NULL`);
          relaxedNotNull.push({ table, column });
        }
      }
    }

    // Idempotencia: si un intento anterior (parcial) ya copió filas hacia
    // este schema, un re-intento chocaría con duplicate key. `public` sigue
    // siendo la fuente de verdad (nunca se toca acá), así que es seguro
    // limpiar el destino y re-copiar desde cero en cada corrida. Hay que
    // borrar en orden INVERSO (hijos antes que padres) para no violar FKs
    // contra filas de otra tabla que ya haya quedado copiada de una corrida
    // previa y todavía no se re-copie en ESTA hasta más adelante en el loop.
    //
    // OJO: filtrar por `tenant_id IS NOT NULL`, no un DELETE a secas. Tablas
    // como `diagram_templates` son híbridas (catálogo global con tenant_id
    // NULL + personalizaciones por tenant) -- el catálogo global lo siembra
    // la migración correspondiente UNA vez por schema, no este script, y el
    // INSERT de abajo solo repone filas con tenant_id = este tenant. Un
    // DELETE sin filtro borraría el catálogo global y nunca lo repondría.
    for (const table of [...ordered].reverse()) {
      if (indirectSet.has(table)) {
        // No tiene tenant_id propio ni acá ni en public -- pero el schema
        // completo pertenece a un solo tenant, así que borrar sin filtro es
        // seguro (equivalente a "todas las filas de esta tabla en este schema").
        await sequelize.query(`DELETE FROM "${schemaName}"."${table}"`);
      } else {
        await sequelize.query(`DELETE FROM "${schemaName}"."${table}" WHERE tenant_id IS NOT NULL`);
      }
    }

    for (const table of ordered) {
      const [allCols] = await sequelize.query(`
        SELECT column_name, data_type, udt_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}'
        ORDER BY ordinal_position
      `);
      // El baseline es un snapshot histórico que a propósito dejó afuera
      // columnas legacy que ya quedaron obsoletas/reemplazadas (ej.
      // products.has_tax/tax_percentage/base_price -> tax_config). `public`
      // puede tener más columnas que el schema del tenant recién aprovisionado
      // -> copiar solo la intersección, no asumir paridad total.
      const [destColRows] = await sequelize.query(`
        SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = '${schemaName}' AND table_name = '${table}'
      `);
      const destColSet = new Set(destColRows.map(r => r.column_name));
      const cols = allCols.filter(c => destColSet.has(c.column_name));
      const deferredCols = new Set([...(DEFERRED_FK_COLUMNS[table] || []), ...(REMAPPED_FK_COLUMNS[table] || [])]);
      const colNames = cols.map(c => `"${c.column_name}"`).join(', ');
      // Los tipos ENUM de Postgres son por-schema: aunque public.vehicles.vehicle_type
      // y tenant_x.vehicles.vehicle_type se llamen igual (enum_vehicles_vehicle_type),
      // son tipos distintos (OID distinto) y Postgres no castea implícitamente entre
      // ellos. Para columnas USER-DEFINED (enum), forzar el cast vía texto contra el
      // tipo del schema DESTINO explícito. Las columnas en DEFERRED_FK_COLUMNS se
      // insertan como NULL (se rellenan después, una vez las dos tablas del ciclo
      // ya tienen todas sus filas).
      const isIndirect = indirectSet.has(table);
      const valueTransforms = COLUMN_VALUE_TRANSFORMS[table] || {};
      // Para indirectas, calificar cada columna simple con el alias t0 del
      // JOIN (buildIndirectSourceSql arma el FROM/JOIN sobre ese alias).
      const colRef = (name) => (isIndirect ? `t0."${name}"` : `"${name}"`);
      let selectExprs = cols.map(c => {
        if (deferredCols.has(c.column_name)) return 'NULL';
        if (valueTransforms[c.column_name]) return valueTransforms[c.column_name];
        return c.data_type === 'USER-DEFINED'
          ? `${colRef(c.column_name)}::text::"${schemaName}"."${c.udt_name}"`
          : colRef(c.column_name);
      }).join(', ');

      const [[{ count: sourceCount }]] = isIndirect
        ? await sequelize.query(buildIndirectCountSql(table, resolutionChains, 'public'), { replacements: { tenantId } })
        : await sequelize.query(
            `SELECT count(*) FROM "public"."${table}" WHERE tenant_id = :tenantId`,
            { replacements: { tenantId } }
          );

      if (Number(sourceCount) === 0) {
        report.push({ table, source: 0, copied: 0, ok: true });
        continue;
      }

      // Columnas que existen en destino pero no en `cols` (osea, no en
      // `public` en absoluto -- no es un tema de filtrado, la columna no
      // está). tenant_id se rellena siempre con el parámetro; las listadas
      // en GENERATED_COLUMNS se insertan NULL y se generan después; el resto
      // se deja NULL si es nullable, o revienta explícito si es NOT NULL sin
      // estrategia conocida (mejor eso que un 23502 críptico de Postgres).
      let finalColNames = colNames;
      let finalSelectExprs = selectExprs;
      const pendingBackfills = [];
      const relaxedForGenerated = [];
      for (const destCol of destColRows) {
        const name = destCol.column_name;
        if (cols.some((c) => c.column_name === name)) continue; // ya cubierta normal

        if (name === 'tenant_id') {
          finalColNames += `, "tenant_id"`;
          finalSelectExprs += `, :tenantId`;
          continue;
        }

        const generator = GENERATED_COLUMNS[table]?.[name];
        if (generator) {
          finalColNames += `, "${name}"`;
          finalSelectExprs += `, NULL`;
          if (destCol.is_nullable === 'NO') relaxedForGenerated.push(name);
          pendingBackfills.push(generator(schemaName));
          continue;
        }

        if (destCol.is_nullable === 'YES') continue; // se deja NULL, no rompe nada

        // NOT NULL pero con DEFAULT propio (ej. unit_of_measure DEFAULT
        // 'unit') -- no listar la columna en el INSERT y dejar que Postgres
        // aplique su default, en vez de tratarla como error.
        if (destCol.column_default) continue;

        throw new Error(
          `"${table}"."${name}" es NOT NULL en "${schemaName}" pero no existe en "public" ` +
          `y no tiene estrategia en GENERATED_COLUMNS (migrateTenantData.js). Hay que decidir ` +
          `a mano cómo poblarla antes de poder migrar esta tabla.`
        );
      }
      for (const name of relaxedForGenerated) {
        await sequelize.query(`ALTER TABLE "${schemaName}"."${table}" ALTER COLUMN "${name}" DROP NOT NULL`);
      }

      if (isIndirect) {
        await sequelize.query(
          `INSERT INTO "${schemaName}"."${table}" (${finalColNames})
           ${buildIndirectSourceSql(table, resolutionChains, finalSelectExprs)}`,
          { replacements: { tenantId } }
        );
      } else {
        await sequelize.query(
          `INSERT INTO "${schemaName}"."${table}" (${finalColNames})
           SELECT ${finalSelectExprs} FROM "public"."${table}" WHERE tenant_id = :tenantId`,
          { replacements: { tenantId } }
        );
      }

      for (const backfillSql of pendingBackfills) {
        await sequelize.query(backfillSql);
      }
      for (const name of relaxedForGenerated) {
        await sequelize.query(`ALTER TABLE "${schemaName}"."${table}" ALTER COLUMN "${name}" SET NOT NULL`);
      }

      const [[{ count: destCount }]] = await sequelize.query(
        `SELECT count(*) FROM "${schemaName}"."${table}"`
      );

      report.push({
        table,
        source: Number(sourceCount),
        copied: Number(destCount),
        ok: Number(sourceCount) === Number(destCount),
      });
    }

    // Backfill de las columnas de FK circular, ahora que ambas tablas del
    // ciclo tienen todas sus filas.
    for (const [table, columns] of Object.entries(DEFERRED_FK_COLUMNS)) {
      if (!ordered.includes(table)) continue;
      for (const column of columns) {
        await sequelize.query(`
          UPDATE "${schemaName}"."${table}" t
          SET "${column}" = p."${column}"
          FROM "public"."${table}" p
          WHERE t.id = p.id AND p.tenant_id = :tenantId AND p."${column}" IS NOT NULL
        `, { replacements: { tenantId } });
      }
    }

    // Backfill de diagram_template_id: si el template original era de ESTE
    // tenant (tenant_id = tenantId en public), el id se conserva igual (ya
    // se copió 1:1 al copiar la tabla diagram_templates). Si era del catálogo
    // global (tenant_id IS NULL en public), se remapea por clave natural
    // (vehicle_type + system + configuration) contra el catálogo recién
    // sembrado de ESTE schema, que tiene sus propios ids nuevos.
    for (const marksTable of ['work_order_diagnosis_marks', 'sale_diagnosis_marks']) {
      if (!ordered.includes(marksTable) || !ordered.includes('diagram_templates')) continue;
      await sequelize.query(`
        UPDATE "${schemaName}"."${marksTable}" t
        SET diagram_template_id = COALESCE(
          (SELECT dt.id FROM "${schemaName}"."diagram_templates" dt WHERE dt.id = pdt.id),
          (SELECT dt.id FROM "${schemaName}"."diagram_templates" dt
             WHERE dt.tenant_id IS NULL AND dt.vehicle_type = pdt.vehicle_type
               AND dt.system = pdt.system AND dt.configuration = pdt.configuration
             LIMIT 1)
        )
        FROM "public"."${marksTable}" p
        JOIN "public"."diagram_templates" pdt ON pdt.id = p.diagram_template_id
        WHERE t.id = p.id AND p.tenant_id = :tenantId AND p.diagram_template_id IS NOT NULL
      `, { replacements: { tenantId } });
    }

    for (const { table, column } of relaxedNotNull) {
      await sequelize.query(`ALTER TABLE "${schemaName}"."${table}" ALTER COLUMN "${column}" SET NOT NULL`);
    }

    console.table(report);
    const failed = report.filter(r => !r.ok);
    if (failed.length) {
      throw new Error(`Verificación falló en: ${failed.map(f => f.table).join(', ')}`);
    }
    console.log(`✅ Datos de "${slug}" copiados y verificados en "${schemaName}"`);
    return report;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  const slug = process.argv[2];
  const tenantId = process.argv[3];
  if (!slug || !tenantId) {
    console.error('Uso: node migrateTenantData.js <tenant_slug> <tenant_id_uuid>');
    process.exit(1);
  }
  migrateTenantData(slug, tenantId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error migrando datos:', err);
      process.exit(1);
    });
}

module.exports = { migrateTenantData };