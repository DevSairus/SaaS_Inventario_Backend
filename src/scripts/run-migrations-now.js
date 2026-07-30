// src/scripts/run-migrations-now.js
//
// server.js corre las migraciones al arrancar, pero envuelve el error en
// un try/catch que solo hace console.error y sigue -- si algo falla ahí,
// el server queda funcionando "a medias" sin frenar, y el error se pierde
// entre el resto del log de arranque. Este script corre EXACTAMENTE lo
// mismo, pero solo, y revienta visiblemente si algo falla.
//
// Uso: node src/scripts/run-migrations-now.js

require('dotenv').config();
const { testConnection } = require('../config/database');
const { runMigrations } = require('../database/migrator');

async function main() {
  console.log('Probando conexión...');
  const connected = await testConnection();
  if (!connected) {
    console.error('❌ No se pudo conectar a la base de datos. Revisa DATABASE_URL en tu .env.');
    process.exit(1);
  }
  console.log('✅ Conectado.\n');

  console.log('Corriendo migraciones...');
  const executed = await runMigrations(); // si falla, esto SÍ tira el error completo, sin try/catch de por medio
  console.log(`\n✅ Listo. ${executed.length} migración(es) ejecutada(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Error corriendo migraciones:');
  console.error(err);
  process.exit(1);
});