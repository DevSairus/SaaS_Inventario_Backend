// backend/src/data/exogena-catalogs.js
//
// Catálogo estático de Información Exógena DIAN — Fase 4 del plan de
// Contabilidad Pitbox. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
//
// Basado en la "Caja de herramientas Exógena 2026" (Resolución 000227 de
// 23-09-2025, anexos técnicos por formato). El usuario confirmó excluir
// 1037 (litógrafos/tipógrafos) y 1034 (estados financieros consolidados de
// grupos empresariales) del catálogo seleccionable: no aplican al perfil de
// tenants de Pitbox (talleres/concesionarios) y no se implementan salvo que
// aparezca un caso real.
//
// `dataSource`:
//   'auto'    → Pitbox ya tiene la data operativa y genera el registro solo
//               (Purchase/Sale/PayrollDocument), agregado por tercero.
//   'manual'  → Pitbox no tiene ni puede derivar la data (ver plan Fase 4
//               Grupo C/1004): se captura a mano vía ExogenaManualRecord.
//   'pending' → todavía no implementado en esta fase (queda con el
//               checklist visible pero el botón "Generar" deshabilitado).
const EXOGENA_FORMATS = [
  { code: '1001', name: 'Pagos o abonos en cuenta y retenciones practicadas', version: 10, dataSource: 'auto', needsConceptMapping: true },
  { code: '1003', name: 'Retenciones en la fuente que le practicaron', version: 7, dataSource: 'auto', needsConceptMapping: false },
  { code: '1004', name: 'Descuentos tributarios solicitados', version: 8, dataSource: 'manual', needsConceptMapping: false },
  { code: '1005', name: 'IVA descontable', version: 8, dataSource: 'auto', needsConceptMapping: false },
  { code: '1006', name: 'IVA generado e impuesto nacional al consumo', version: 8, dataSource: 'auto', needsConceptMapping: false },
  { code: '1007', name: 'Ingresos recibidos en el año', version: 9, dataSource: 'auto', needsConceptMapping: true },
  { code: '1008', name: 'Saldo de cuentas por cobrar (deudores)', version: 7, dataSource: 'auto', needsConceptMapping: false },
  { code: '1009', name: 'Saldo de cuentas por pagar (pasivos)', version: 7, dataSource: 'auto', needsConceptMapping: false },
  { code: '1010', name: 'Información de socios, accionistas, comuneros y/o cooperados', version: 9, dataSource: 'manual', needsConceptMapping: false },
  { code: '1011', name: 'Declaraciones tributarias, rentas exentas, costos y deducciones', version: 6, dataSource: 'manual', needsConceptMapping: false },
  { code: '1012', name: 'Saldos de cuentas de ahorro, corrientes, inversiones y acciones', version: 7, dataSource: 'auto', needsConceptMapping: false },
  { code: '1647', name: 'Ingresos recibidos por cuenta de terceros', version: 2, dataSource: 'manual', needsConceptMapping: false },
  { code: '2276', name: 'Certificado de ingresos y retenciones (empleados)', version: 4, dataSource: 'auto', needsConceptMapping: false },
];

const EXOGENA_FORMAT_BY_CODE = Object.fromEntries(EXOGENA_FORMATS.map((f) => [f.code, f]));

// Tabla "Tipos de Documento" de los anexos técnicos de Exógena (estable año
// a año, alineada con el schemeID de facturación electrónica desde la
// Resolución 000162/2023 — ver comentario en thirdPartyMapper.js sobre el
// pass-through de Customer/Supplier.document_type).
const EXOGENA_DOCUMENT_TYPES = [
  { code: '11', label: 'Registro civil' },
  { code: '12', label: 'Tarjeta de identidad' },
  { code: '13', label: 'Cédula de ciudadanía' },
  { code: '21', label: 'Tarjeta de extranjería' },
  { code: '22', label: 'Cédula de extranjería' },
  { code: '31', label: 'NIT' },
  { code: '41', label: 'Pasaporte' },
  { code: '42', label: 'Documento de identificación extranjero' },
  { code: '43', label: 'Sin identificación del exterior' },
  { code: '44', label: 'NIT de otro país' },
  { code: '46', label: 'Carné diplomático' },
  { code: '47', label: 'NUIP' },
  { code: '48', label: 'PEP (Permiso Especial de Permanencia)' },
  { code: '50', label: 'NIT del apoderado' },
];

const COLOMBIA_COUNTRY_CODE = '169';

module.exports = {
  EXOGENA_FORMATS,
  EXOGENA_FORMAT_BY_CODE,
  EXOGENA_DOCUMENT_TYPES,
  COLOMBIA_COUNTRY_CODE,
};
