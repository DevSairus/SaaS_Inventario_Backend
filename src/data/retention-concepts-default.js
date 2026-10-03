// backend/src/data/retention-concepts-default.js
//
// Catálogo por defecto de conceptos de retención en la fuente (renta) para
// compras. Cada tenant lo puede modificar en Configuración → Tributaria
// (tenant.tax_config.retention_concepts); este archivo solo es el punto de
// partida. Las tarifas y bases son las de uso común y CAMBIAN por decreto
// (ej. Decreto 0572 de 2025): el tenant o su contador deben verificarlas.
//
// La tarifa depende de quién recibe el pago:
//   rate_juridica             persona jurídica
//   rate_natural_declarante   persona natural declarante de renta
//   rate_natural_no_declarante persona natural NO declarante
// La base mínima va en UVT (se convierte con tax_config.fiscal_profile.uvt_value)
// y se compara contra la suma de lo comprado bajo ese concepto en la misma
// compra.

'use strict';

const DEFAULT_RETENTION_CONCEPTS = [
  { id: 'compras', name: 'Compras generales', rate_juridica: 2.5, rate_natural_declarante: 2.5, rate_natural_no_declarante: 3.5, min_base_uvt: 10 },
  { id: 'servicios', name: 'Servicios generales', rate_juridica: 4, rate_natural_declarante: 4, rate_natural_no_declarante: 6, min_base_uvt: 4 },
  { id: 'honorarios', name: 'Honorarios y comisiones', rate_juridica: 11, rate_natural_declarante: 10, rate_natural_no_declarante: 10, min_base_uvt: 0 },
  { id: 'arrendamiento_inmuebles', name: 'Arrendamiento de bienes inmuebles', rate_juridica: 3.5, rate_natural_declarante: 3.5, rate_natural_no_declarante: 3.5, min_base_uvt: 10 },
  { id: 'arrendamiento_muebles', name: 'Arrendamiento de bienes muebles', rate_juridica: 4, rate_natural_declarante: 4, rate_natural_no_declarante: 4, min_base_uvt: 0 },
  { id: 'transporte_carga', name: 'Transporte de carga', rate_juridica: 1, rate_natural_declarante: 1, rate_natural_no_declarante: 1, min_base_uvt: 4 },
  { id: 'aseo_vigilancia', name: 'Servicios de aseo y vigilancia', rate_juridica: 2, rate_natural_declarante: 2, rate_natural_no_declarante: 2, min_base_uvt: 4 },
  { id: 'hoteles_restaurantes', name: 'Hoteles y restaurantes', rate_juridica: 3.5, rate_natural_declarante: 3.5, rate_natural_no_declarante: 3.5, min_base_uvt: 4 },
  { id: 'combustibles', name: 'Compra de combustibles derivados del petróleo', rate_juridica: 0.1, rate_natural_declarante: 0.1, rate_natural_no_declarante: 0.1, min_base_uvt: 0 },
];

// Concepto por defecto según el tipo de producto, cuando ni el producto ni
// su categoría ni el proveedor indican uno.
const DEFAULT_CONCEPT_BY_TYPE = { service: 'servicios', default: 'compras' };

// Concepto sugerido por categoría de gasto (Finanzas → Gastos).
const DEFAULT_EXPENSE_CATEGORY_CONCEPTS = {
  honorarios: 'honorarios',
  comisiones_tecnicos: 'honorarios',
  arriendo: 'arrendamiento_inmuebles',
  transporte: 'transporte_carga',
  mantenimiento: 'servicios',
  marketing: 'servicios',
  seguros: null,          // las primas de seguros no tienen ReteFuente general
  servicios_publicos: null,
  impuestos: null,
  nomina: null,
  insumos_oficina: 'compras',
  otro: 'servicios',
};

// UVT 2026 (Resolución DIAN 000238 de 2025). Editable por tenant: se
// actualiza cada año.
const DEFAULT_UVT_VALUE = 52374;

module.exports = {
  DEFAULT_RETENTION_CONCEPTS,
  DEFAULT_CONCEPT_BY_TYPE,
  DEFAULT_EXPENSE_CATEGORY_CONCEPTS,
  DEFAULT_UVT_VALUE,
};
