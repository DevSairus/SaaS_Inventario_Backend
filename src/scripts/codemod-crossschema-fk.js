// scripts/codemod-crossschema-fk.js
//
// Corre UNA VEZ, localmente, sobre tu repo real (no en el contenedor de
// producción). Reescribe src/database/migrations/*.js para que las
// referencias a tablas que se quedan en `public` (tenants, users,
// subscription_plans) queden explícitamente calificadas con su schema.
//
// Por qué: al provisionar un schema de tenant, el search_path apunta
// SOLO al schema del tenant (a propósito, para evitar que "CREATE TABLE
// IF NOT EXISTS" colisione con tablas del mismo nombre en public). Pero
// eso significa que una referencia sin calificar como
// `references: { model: 'tenants', key: 'id' }` no encuentra la tabla
// `tenants`, porque esa vive en public. La solución es decirle a
// Sequelize explícitamente en qué schema está el modelo referenciado:
//
//   references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' }
//
// Esto es 100% compatible con cómo corren tus migraciones HOY en public
// (public.tenants sigue siendo public.tenants), así que no cambia nada
// del comportamiento actual, solo lo hace explícito.
//
// Uso:
//   node scripts/codemod-crossschema-fk.js            (dry-run, solo muestra qué tocaría)
//   node scripts/codemod-crossschema-fk.js --write     (aplica los cambios)

const fs = require('fs');
const path = require('path');

// Usa el directorio DESDE DONDE SE EJECUTA el comando (la raíz del repo
// backend, ej. D:\Desarrollo\Pitbox\backend), no la carpeta donde vive
// este archivo — así no importa si lo guardaste en scripts/ o en
// src/scripts/, mientras lo corras parado en la raíz del repo.
const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'database', 'migrations');
const WRITE = process.argv.includes('--write');

// Tablas que se quedan en `public` y por lo tanto necesitan calificación
// explícita cuando son referenciadas desde una migración que puede correr
// dentro de un schema de tenant.
const PUBLIC_ONLY_MODELS = ['tenants', 'users', 'subscription_plans'];

function buildReplacements(quote) {
  return PUBLIC_ONLY_MODELS.map((name) => ({
    // Coincide con: model: 'tenants'   /   model: "tenants"
    from: new RegExp(`model:\\s*${quote}${name}${quote}`, 'g'),
    to: `model: { tableName: ${quote}${name}${quote}, schema: ${quote}public${quote} }`,
    name,
  }));
}

function processFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  let content = original;
  const hits = [];

  for (const quote of [`'`, `"`]) {
    for (const { from, to, name } of buildReplacements(quote)) {
      const matches = content.match(from);
      if (matches) {
        hits.push({ name, count: matches.length });
        content = content.replace(from, to);
      }
    }
  }

  if (hits.length > 0) {
    console.log(`${path.basename(filePath)}: ${hits.map(h => `${h.name}×${h.count}`).join(', ')}`);
    if (WRITE) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }

  return hits.length > 0;
}

function main() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js'));
  let touchedFiles = 0;

  for (const file of files) {
    const touched = processFile(path.join(MIGRATIONS_DIR, file));
    if (touched) touchedFiles++;
  }

  console.log(`\n${touchedFiles} archivo(s) ${WRITE ? 'modificados' : 'que se modificarían (dry-run)'}.`);
  if (!WRITE) {
    console.log('Corre de nuevo con --write para aplicar los cambios.');
  }
}

main();