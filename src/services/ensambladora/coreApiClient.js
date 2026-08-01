// backend/src/services/ensambladora/coreApiClient.js
//
// Consultas síncronas del CSA directas al Core Ensambladora (contrato de
// sincronización, sección 4) -- distintas de los eventos push de
// syncOutboundClient.js. Solo requieren X-Api-Key (el Core las autentica con
// requireCsaApiKey, sin HMAC, porque son lecturas/validaciones, no eventos
// con payload que otro sistema deba poder auditar con firma).
const { EnsambladoraSyncCredential } = require('../../models');

class VehiculoNoEncontradoError extends Error {}

async function getCredentialActiva(tenantId) {
  const credential = await EnsambladoraSyncCredential.findOne({ where: { tenant_id: tenantId, estado: 'activo' } });
  if (!credential) {
    throw new Error(`El tenant ${tenantId} no tiene credenciales activas de sincronización con la Ensambladora`);
  }
  return credential;
}

function coreBaseUrl() {
  const url = process.env.ENSAMBLADORA_CORE_URL;
  if (!url) throw new Error('ENSAMBLADORA_CORE_URL no está configurado');
  return url.replace(/\/$/, '');
}

/**
 * GET /vehiculos/{vin} en el Core. Lanza VehiculoNoEncontradoError si el
 * Core responde 404 (VIN no existe en el catálogo de ninguna ensambladora
 * afiliada a este CSA).
 */
async function consultarVehiculoPorVin(tenantId, vin) {
  const credential = await getCredentialActiva(tenantId);

  const response = await fetch(`${coreBaseUrl()}/api/vehiculos/${encodeURIComponent(vin)}`, {
    method: 'GET',
    headers: { 'X-Api-Key': credential.api_key },
  });

  if (response.status === 404) {
    throw new VehiculoNoEncontradoError(`No existe un vehículo con VIN ${vin} en el Core`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Core Ensambladora respondió ${response.status}: ${text}`);
  }

  const body = await response.json();
  return body.data;
}

/**
 * POST /vehiculos/{vin}/validar-disponibilidad en el Core. SIEMPRE en línea
 * -- no se sirve del cache, es la validación crítica previa a confirmar una
 * venta (contrato, sección 4). Si falla por red, el llamador decide qué
 * hacer (ej. dejar la venta "pendiente de validar" -- se conecta en Fase 2,
 * cuando exista el modelo de venta).
 */
async function validarDisponibilidadEnCore(tenantId, vin) {
  const credential = await getCredentialActiva(tenantId);

  const response = await fetch(`${coreBaseUrl()}/api/vehiculos/${encodeURIComponent(vin)}/validar-disponibilidad`, {
    method: 'POST',
    headers: { 'X-Api-Key': credential.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Core Ensambladora respondió ${response.status}: ${text}`);
  }

  return response.json(); // { disponible, motivo }
}

module.exports = { consultarVehiculoPorVin, validarDisponibilidadEnCore, VehiculoNoEncontradoError };
