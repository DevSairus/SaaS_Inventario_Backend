// backend/src/services/exogena/thirdPartyMapper.js
//
// Información Exógena DIAN — Fase 4 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
//
// Traduce Customer/Supplier (y sus campos ya denormalizados en Sale/Purchase)
// a los atributos de tercero que piden los anexos técnicos de Exógena
// (tdoc/nid/dv/apl1/apl2/nom1/nom2/raz/dir/dpto/mun/pais).
//
// Nota sobre `document_type`: Customer/Supplier.document_type ya guarda el
// schemeID DIAN de facturación electrónica (13, 31, 12, 21, 22, 41, 22...),
// y desde la Resolución 000162/2023 la DIAN unificó ese catálogo con la
// tabla "Tipos de Documento" de los anexos de Exógena (ver
// data/exogena-catalogs.js#EXOGENA_DOCUMENT_TYPES) -- por eso aquí se pasa
// tal cual (pass-through), sin tabla de conversión. Antes de la primera
// presentación real, vale la pena verificarlo contra la cartilla vigente.

const { calculateNitDv } = require('../../utils/nitDv');
const { COLOMBIA_COUNTRY_CODE } = require('../../data/exogena-catalogs');

function onlyDigitsAndLetters(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '');
}

function splitDeptMun(cityCode) {
  const code = String(cityCode || '').padStart(5, '0');
  if (!cityCode || code.length !== 5) return { dpto: null, mun: null };
  return { dpto: code.slice(0, 2), mun: code.slice(2, 5) };
}

// Heurística de partición de nombre completo para personas naturales sin
// nombre/apellido separados en el modelo (caso Supplier.name). Asume el
// orden habitual en Colombia (Nombre1 [Nombre2] Apellido1 [Apellido2]); si
// el dato viene distinto, el usuario puede corregirlo en la ficha del
// tercero -- esto es solo el mejor esfuerzo posible sin ese dato estructurado.
function splitFullName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { nom1: null, nom2: null, apl1: null, apl2: null };
  if (parts.length === 1) return { nom1: parts[0], nom2: null, apl1: null, apl2: null };
  if (parts.length === 2) return { nom1: parts[0], nom2: null, apl1: parts[1], apl2: null };
  if (parts.length === 3) return { nom1: parts[0], nom2: null, apl1: parts[1], apl2: parts[2] };
  return { nom1: parts[0], nom2: parts[1], apl1: parts[2], apl2: parts.slice(3).join(' ') };
}

/**
 * Tercero a partir de los campos denormalizados en Sale (customer_*) o de
 * un Customer directo.
 */
function mapCustomerToExogena({ tax_id, document_type, first_name, last_name, business_name, city_code, address }) {
  const isCompany = Boolean(business_name);
  const tdoc = document_type || '13';
  const nid = onlyDigitsAndLetters(tax_id);
  const { dpto, mun } = splitDeptMun(city_code);

  return {
    tdoc,
    nid,
    dv: tdoc === '31' ? calculateNitDv(nid) : null,
    ...(isCompany
      ? { raz: business_name }
      : { nom1: first_name || null, nom2: null, apl1: last_name || null, apl2: null }),
    dir: address || null,
    dpto,
    mun,
    pais: COLOMBIA_COUNTRY_CODE,
  };
}

/**
 * Tercero a partir de un Supplier.
 */
function mapSupplierToExogena({ tax_id, document_type, person_type, name, business_name, city_code, address }) {
  const isCompany = person_type ? person_type === 'juridica' : Boolean(business_name);
  const tdoc = document_type || (isCompany ? '31' : '13');
  const nid = onlyDigitsAndLetters(tax_id);
  const { dpto, mun } = splitDeptMun(city_code);
  const nameParts = isCompany ? {} : splitFullName(name);

  return {
    tdoc,
    nid,
    dv: tdoc === '31' ? calculateNitDv(nid) : null,
    ...(isCompany ? { raz: business_name || name } : nameParts),
    dir: address || null,
    dpto,
    mun,
    pais: COLOMBIA_COUNTRY_CODE,
  };
}

module.exports = { mapCustomerToExogena, mapSupplierToExogena, splitDeptMun, splitFullName };
