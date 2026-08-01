/**
 * Envía un evento de prueba real (firmado) desde un tenant hacia el Core
 * Ensambladora, usando la credencial guardada por activateTestTenant.js.
 * Cierra el entregable de Fase 0: "autenticación funcionando entre ambos
 * con un evento de prueba", en el sentido CSA/PDV -> Ensambladora.
 *
 * Uso:
 *   node src/scripts/ensambladora/sendTestEvent.js <tenant_id>
 *
 * Requiere ENSAMBLADORA_CORE_URL en el .env apuntando al Core corriendo
 * (ej. http://localhost:4100).
 */
require('dotenv').config();
const { sequelize } = require('../../models');
const { sendEventToCore } = require('../../services/ensambladora/syncOutboundClient');

async function main() {
  const [, , tenantId] = process.argv;

  if (!tenantId) {
    console.error('Uso: node src/scripts/ensambladora/sendTestEvent.js <tenant_id>');
    process.exit(1);
  }

  const result = await sendEventToCore({
    tenantId,
    tipoEvento: 'prueba.fase0',
    entidadTipo: 'prueba',
    entidadId: null,
    payload: { mensaje: 'Evento de prueba de cierre de Fase 0 (Pitbox -> Core)' },
  });

  console.log(result);
  console.log(
    result.ok
      ? '\n✅ Autenticación (API key + HMAC) y sincronización Pitbox -> Core funcionando.'
      : '\n❌ Algo falló — revisar ENSAMBLADORA_CORE_URL, credenciales, o que el Core esté corriendo.'
  );

  await sequelize.close();
}

main().catch((error) => {
  console.error('Error enviando evento de prueba:', error);
  process.exit(1);
});
