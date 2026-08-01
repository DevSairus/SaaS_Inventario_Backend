/**
 * Activa el módulo Ensambladora para un tenant y guarda las credenciales de
 * sincronización que emitió el Core (salida de seedTestCsaPdv.js del lado
 * Core Ensambladora).
 *
 * Uso:
 *   node src/scripts/ensambladora/activateTestTenant.js <tenant_id> <api_key> <hmac_secret> [csa_pdv_id_externo]
 */
require('dotenv').config();
const { sequelize, Tenant, EnsambladoraSyncCredential } = require('../../models');

async function main() {
  const [, , tenantId, apiKey, hmacSecret, csaPdvIdExterno] = process.argv;

  if (!tenantId || !apiKey || !hmacSecret) {
    console.error('Uso: node src/scripts/ensambladora/activateTestTenant.js <tenant_id> <api_key> <hmac_secret> [csa_pdv_id_externo]');
    process.exit(1);
  }

  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) {
    console.error(`No existe el tenant ${tenantId}`);
    process.exit(1);
  }

  const modulesEnabled = new Set(tenant.modules_enabled || []);
  modulesEnabled.add('ensambladora');
  await tenant.update({ modules_enabled: [...modulesEnabled] });

  const [credential] = await EnsambladoraSyncCredential.upsert({
    tenant_id: tenantId,
    csa_pdv_id_externo: csaPdvIdExterno || null,
    api_key: apiKey,
    hmac_secret: hmacSecret,
    estado: 'activo',
  });

  console.log(`Módulo "ensambladora" activo para el tenant ${tenant.slug || tenant.id}.`);
  console.log('Credencial de sincronización guardada:', credential.id);

  await sequelize.close();
}

main().catch((error) => {
  console.error('Error activando el módulo Ensambladora para el tenant de prueba:', error);
  process.exit(1);
});
