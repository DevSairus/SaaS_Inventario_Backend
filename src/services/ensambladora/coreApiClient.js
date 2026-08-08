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
 * GET /vehiculos/buscar?placa=... en el Core -- misma forma de respuesta que
 * consultarVehiculoPorVin (contrato, sección 1), solo que resuelto por placa.
 * Lanza VehiculoNoEncontradoError si el Core responde 404 (ninguna placa
 * coincide, o el vehículo aún no está matriculado -- no distingue entre
 * ambos casos, ver sección 3 del contrato).
 */
async function consultarVehiculoPorPlaca(tenantId, placa) {
  const credential = await getCredentialActiva(tenantId);

  const response = await fetch(`${coreBaseUrl()}/api/vehiculos/buscar?placa=${encodeURIComponent(placa)}`, {
    method: 'GET',
    headers: { 'X-Api-Key': credential.api_key },
  });

  if (response.status === 404) {
    throw new VehiculoNoEncontradoError(`No existe ningún vehículo con placa ${placa} en el Core`);
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

/**
 * GET genérico hacia el namespace /csa-pdv/* del Core (self-service:
 * liquidaciones propias y tarifario vigente -- Fase 5). Mismo esquema de
 * auth que las demás consultas síncronas (solo X-Api-Key).
 */
async function getCsaPdvSelf(tenantId, path) {
  const credential = await getCredentialActiva(tenantId);

  const response = await fetch(`${coreBaseUrl()}/api/csa-pdv${path}`, {
    method: 'GET',
    headers: { 'X-Api-Key': credential.api_key },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Core Ensambladora respondió ${response.status}: ${text}`);
  }

  const body = await response.json();
  return body.data;
}

async function consultarLiquidaciones(tenantId) {
  return getCsaPdvSelf(tenantId, '/liquidaciones');
}

async function consultarLiquidacion(tenantId, liquidacionId) {
  return getCsaPdvSelf(tenantId, `/liquidaciones/${encodeURIComponent(liquidacionId)}`);
}

async function consultarTarifarioVigente(tenantId, marcaId) {
  return getCsaPdvSelf(tenantId, `/tarifario?marca_id=${encodeURIComponent(marcaId)}`);
}

/**
 * GET /csa-pdv/politicas-mantenimiento?linea_id=... -- todas las políticas
 * de revisión configuradas para una línea (no solo `proxima_revision`, que
 * ya trae GET /vehiculos/{vin}). Necesario para el selector de "política"
 * del formulario de mantenimiento cuando el taller registra una revisión
 * fuera de secuencia -- ver requerimientos-pitbox-formulario-mantenimiento.md,
 * sección 1.1bis. `linea_id` sale de `vehiculo.linea.id`.
 */
async function consultarPoliticasMantenimiento(tenantId, lineaId) {
  return getCsaPdvSelf(tenantId, `/politicas-mantenimiento?linea_id=${encodeURIComponent(lineaId)}`);
}

/**
 * GET /csa-pdv/catalogo-piezas?marca_id=...&linea_id=... -- catálogo de
 * piezas de la marca, para el multi-selector de "piezas usadas" del
 * formulario de mantenimiento (sección 1.3 del mismo documento) y del
 * formulario de garantías. `lineaId` es opcional -- si se pasa, el Core
 * filtra a piezas de toda la marca más las asociadas puntualmente a esa
 * línea (ver resolverPiezaPorCodigo, eventoSyncHandlers.js del Core). Solo
 * para que el técnico elija un código válido -- el Core es quien revalida
 * contra este mismo catálogo al procesar revision.completada/
 * garantia.radicada, no hace falta revalidar acá.
 */
async function consultarCatalogoPiezas(tenantId, marcaId, lineaId) {
  const query = lineaId
    ? `marca_id=${encodeURIComponent(marcaId)}&linea_id=${encodeURIComponent(lineaId)}`
    : `marca_id=${encodeURIComponent(marcaId)}`;
  return getCsaPdvSelf(tenantId, `/catalogo-piezas?${query}`);
}

async function consultarBoletines(tenantId, marcaId) {
  return getCsaPdvSelf(tenantId, `/boletines?marca_id=${encodeURIComponent(marcaId)}`);
}

/**
 * GET /csa-pdv/garantias -- listado global de garantías radicadas por este
 * CSA con su estado real de negocio (aprobada/rechazada/devuelta/etc.), a
 * diferencia de listarPorVin (garantias.controller.js local) que solo trae
 * el sync_estado de sincronización, no el estado de negocio.
 */
async function consultarGarantias(tenantId) {
  return getCsaPdvSelf(tenantId, '/garantias');
}

/**
 * GET /csa-pdv/garantias/:id -- detalle de una garantía puntual, con los
 * `id` de cada item (necesarios para reenviarGarantia, que corrige/elimina
 * renglones existentes en vez de solo agregar).
 */
async function consultarGarantia(tenantId, id) {
  return getCsaPdvSelf(tenantId, `/garantias/${encodeURIComponent(id)}`);
}

async function consultarTecnico(tenantId, documento) {
  return getCsaPdvSelf(tenantId, `/tecnicos/${encodeURIComponent(documento)}`);
}

/**
 * GET /csa-pdv/marcas -- marcas de la ensambladora de este CSA, para el
 * selector de "Cotizar" (no hay vehículo del cual heredar la marca todavía).
 */
async function consultarMarcas(tenantId) {
  return getCsaPdvSelf(tenantId, '/marcas');
}

/**
 * GET /csa-pdv/lineas?marca_id=... -- líneas de una marca, con
 * `precio_lista` incluido (autofill al armar una cotización).
 */
async function consultarLineas(tenantId, marcaId) {
  return getCsaPdvSelf(tenantId, `/lineas?marca_id=${encodeURIComponent(marcaId)}`);
}

module.exports = {
  consultarVehiculoPorVin,
  consultarVehiculoPorPlaca,
  validarDisponibilidadEnCore,
  consultarLiquidaciones,
  consultarLiquidacion,
  consultarTarifarioVigente,
  consultarBoletines,
  consultarTecnico,
  consultarPoliticasMantenimiento,
  consultarCatalogoPiezas,
  consultarMarcas,
  consultarLineas,
  consultarGarantias,
  consultarGarantia,
  VehiculoNoEncontradoError,
};
