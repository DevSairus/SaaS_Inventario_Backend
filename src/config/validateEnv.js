/**
 * Valida que las variables de entorno críticas estén presentes al arranque.
 * Si falta alguna, el servidor no arranca y muestra un error claro.
 */
const REQUIRED_VARS = [
  { key: 'JWT_SECRET',        description: 'Clave secreta para firmar JWT' },
  { key: 'DATABASE_URL',      description: 'URL de conexión a PostgreSQL',
    alternatives: ['POSTGRES_URL', 'POSTGRES_HOST'] },
  { key: 'GMAIL_USER',        description: 'Usuario Gmail para envío de emails' },
  { key: 'GMAIL_APP_PASSWORD', description: 'App password de Gmail' },
];

function validateEnv() {
  // Solo validar en producción — localmente las vars pueden tener nombres distintos
  if (process.env.NODE_ENV !== 'production') return;
  const missing = [];

  for (const v of REQUIRED_VARS) {
    const hasMain = !!process.env[v.key];
    const hasAlt  = v.alternatives?.some(alt => !!process.env[alt]);

    if (!hasMain && !hasAlt) {
      missing.push(`  ✗ ${v.key} — ${v.description}`);
    }
  }

  if (missing.length > 0) {
    console.error('\n❌ ERROR: Variables de entorno faltantes:\n');
    missing.forEach(m => console.error(m));
    console.error('\nEl servidor no puede arrancar sin estas variables.\n');
    process.exit(1);
  }

  console.log('✅ Variables de entorno validadas correctamente');
}

module.exports = validateEnv;