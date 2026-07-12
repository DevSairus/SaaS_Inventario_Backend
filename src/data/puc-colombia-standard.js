/**
 * PUC Colombia — subconjunto estándar (Decreto 2650 de 1993)
 *
 * No es el PUC completo (que tiene miles de cuentas); es un subconjunto
 * práctico cubriendo lo que un comercio/taller/POS típico necesita para
 * arrancar. El tenant puede agregar/editar cuentas después desde el módulo
 * de contabilidad.
 *
 * accepts_entries: false = cuenta "padre" (agrupadora), no recibe movimientos
 * directos. true = cuenta de detalle, sí recibe movimientos.
 */

const PUC_COLOMBIA_STANDARD = [
  // ══════════════ CLASE 1 — ACTIVO ══════════════
  { code: '1', name: 'ACTIVO', type: 'activo', parent_code: null, accepts_entries: false },
  { code: '11', name: 'Disponible', type: 'activo', parent_code: '1', accepts_entries: false },
  { code: '1105', name: 'Caja', type: 'activo', parent_code: '11', accepts_entries: false },
  { code: '110505', name: 'Caja General', type: 'activo', parent_code: '1105', accepts_entries: true },
  { code: '1110', name: 'Bancos', type: 'activo', parent_code: '11', accepts_entries: false },
  { code: '111005', name: 'Bancos - Moneda Nacional', type: 'activo', parent_code: '1110', accepts_entries: true },

  { code: '13', name: 'Deudores', type: 'activo', parent_code: '1', accepts_entries: false },
  { code: '1305', name: 'Clientes', type: 'activo', parent_code: '13', accepts_entries: false },
  { code: '130505', name: 'Clientes Nacionales', type: 'activo', parent_code: '1305', accepts_entries: true },
  { code: '1355', name: 'Anticipo de Impuestos y Contribuciones', type: 'activo', parent_code: '13', accepts_entries: false },
  { code: '135515', name: 'IVA Descontable', type: 'activo', parent_code: '1355', accepts_entries: true },
  { code: '135520', name: 'Retención en la Fuente (a favor)', type: 'activo', parent_code: '1355', accepts_entries: true },

  { code: '14', name: 'Inventarios', type: 'activo', parent_code: '1', accepts_entries: false },
  { code: '1435', name: 'Mercancías No Fabricadas por la Empresa', type: 'activo', parent_code: '14', accepts_entries: false },
  { code: '143501', name: 'Inventario de Mercancías', type: 'activo', parent_code: '1435', accepts_entries: true },

  { code: '15', name: 'Propiedades, Planta y Equipo', type: 'activo', parent_code: '1', accepts_entries: false },
  { code: '1524', name: 'Equipo de Oficina', type: 'activo', parent_code: '15', accepts_entries: true },
  { code: '1528', name: 'Equipo de Computación y Comunicación', type: 'activo', parent_code: '15', accepts_entries: true },
  { code: '1592', name: 'Depreciación Acumulada (CR)', type: 'activo', parent_code: '15', accepts_entries: true },

  // ══════════════ CLASE 2 — PASIVO ══════════════
  { code: '2', name: 'PASIVO', type: 'pasivo', parent_code: null, accepts_entries: false },
  { code: '21', name: 'Obligaciones Financieras', type: 'pasivo', parent_code: '2', accepts_entries: false },
  { code: '210505', name: 'Bancos Nacionales', type: 'pasivo', parent_code: '21', accepts_entries: true },

  { code: '22', name: 'Proveedores', type: 'pasivo', parent_code: '2', accepts_entries: false },
  { code: '220505', name: 'Proveedores Nacionales', type: 'pasivo', parent_code: '22', accepts_entries: true },

  { code: '23', name: 'Cuentas por Pagar', type: 'pasivo', parent_code: '2', accepts_entries: false },
  { code: '233505', name: 'Costos y Gastos por Pagar', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '236505', name: 'Retención en la Fuente por Pagar', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '236710', name: 'IVA Retenido por Pagar', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '236805', name: 'Retención de ICA', type: 'pasivo', parent_code: '23', accepts_entries: true },

  { code: '24', name: 'Impuestos, Gravámenes y Tasas', type: 'pasivo', parent_code: '2', accepts_entries: false },
  { code: '240805', name: 'IVA por Pagar (Generado)', type: 'pasivo', parent_code: '24', accepts_entries: true },
  { code: '240405', name: 'Impuesto de Renta y Complementarios', type: 'pasivo', parent_code: '24', accepts_entries: true },

  { code: '25', name: 'Obligaciones Laborales', type: 'pasivo', parent_code: '2', accepts_entries: false },
  { code: '250505', name: 'Salarios por Pagar', type: 'pasivo', parent_code: '25', accepts_entries: true },
  { code: '251005', name: 'Cesantías Consolidadas', type: 'pasivo', parent_code: '25', accepts_entries: true },
  { code: '251505', name: 'Intereses sobre Cesantías', type: 'pasivo', parent_code: '25', accepts_entries: true },
  { code: '252005', name: 'Prima de Servicios', type: 'pasivo', parent_code: '25', accepts_entries: true },
  { code: '252505', name: 'Vacaciones Consolidadas', type: 'pasivo', parent_code: '25', accepts_entries: true },

  // ══════════════ CLASE 3 — PATRIMONIO ══════════════
  { code: '3', name: 'PATRIMONIO', type: 'patrimonio', parent_code: null, accepts_entries: false },
  { code: '31', name: 'Capital Social', type: 'patrimonio', parent_code: '3', accepts_entries: false },
  { code: '311505', name: 'Aportes Sociales', type: 'patrimonio', parent_code: '31', accepts_entries: true },
  { code: '36', name: 'Resultados del Ejercicio', type: 'patrimonio', parent_code: '3', accepts_entries: false },
  { code: '360505', name: 'Utilidad del Ejercicio', type: 'patrimonio', parent_code: '36', accepts_entries: true },
  { code: '37', name: 'Resultados de Ejercicios Anteriores', type: 'patrimonio', parent_code: '3', accepts_entries: false },
  { code: '370505', name: 'Utilidades Acumuladas', type: 'patrimonio', parent_code: '37', accepts_entries: true },

  // ══════════════ CLASE 4 — INGRESOS ══════════════
  { code: '4', name: 'INGRESOS', type: 'ingreso', parent_code: null, accepts_entries: false },
  { code: '41', name: 'Operacionales', type: 'ingreso', parent_code: '4', accepts_entries: false },
  { code: '413501', name: 'Venta de Mercancías', type: 'ingreso', parent_code: '41', accepts_entries: true },
  { code: '415595', name: 'Ingresos por Servicios (Taller)', type: 'ingreso', parent_code: '41', accepts_entries: true },
  { code: '42', name: 'No Operacionales', type: 'ingreso', parent_code: '4', accepts_entries: false },
  { code: '421005', name: 'Ingresos Financieros', type: 'ingreso', parent_code: '42', accepts_entries: true },
  { code: '429505', name: 'Ingresos Diversos', type: 'ingreso', parent_code: '42', accepts_entries: true },

  // ══════════════ CLASE 5 — GASTOS ══════════════
  { code: '5', name: 'GASTOS', type: 'gasto', parent_code: null, accepts_entries: false },
  { code: '51', name: 'Operacionales de Administración', type: 'gasto', parent_code: '5', accepts_entries: false },
  { code: '510506', name: 'Gastos de Personal (Nómina Admin.)', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '511005', name: 'Honorarios', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '512005', name: 'Arrendamientos', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '513005', name: 'Seguros', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '513505', name: 'Servicios Públicos', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '514505', name: 'Mantenimiento y Reparaciones', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '519515', name: 'Transporte, Fletes y Acarreos', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '519525', name: 'Impuestos Asumidos', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '519535', name: 'Publicidad y Propaganda (Marketing)', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '519540', name: 'Útiles, Papelería y Fotocopias', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '519599', name: 'Gastos Diversos', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '53', name: 'No Operacionales', type: 'gasto', parent_code: '5', accepts_entries: false },
  { code: '530505', name: 'Gastos Financieros (Intereses)', type: 'gasto', parent_code: '53', accepts_entries: true },

  // ══════════════ CLASE 6 — COSTOS DE VENTAS ══════════════
  { code: '6', name: 'COSTOS DE VENTAS', type: 'costo', parent_code: null, accepts_entries: false },
  { code: '61', name: 'Costo de Ventas y de Prestación de Servicios', type: 'costo', parent_code: '6', accepts_entries: false },
  { code: '613501', name: 'Costo de Mercancía Vendida', type: 'costo', parent_code: '61', accepts_entries: true },
  { code: '615595', name: 'Costo de Servicios (Taller)', type: 'costo', parent_code: '61', accepts_entries: true },
];

// Mapeo de eventos del sistema -> código de cuenta por defecto.
// El account_mappings de cada tenant se seedea con esto y luego es editable.
const DEFAULT_ACCOUNT_MAPPINGS = {
  sale_cash_account: '110505',          // pago de contado -> Caja
  sale_bank_account: '111005',          // pago con tarjeta/transferencia -> Bancos
  sale_receivable: '130505',            // venta a crédito -> Clientes
  sale_revenue_product: '413501',       // ingreso por venta de mercancía
  sale_revenue_service: '415595',       // ingreso por servicios de taller
  sale_tax_iva: '240805',               // IVA generado en la venta
  sale_cogs_product: '613501',          // costo de la mercancía vendida
  sale_cogs_service: '615595',          // costo de servicios de taller

  purchase_inventory: '143501',         // compra de mercancía -> inventario
  purchase_payable: '220505',           // compra a crédito -> proveedores
  purchase_cash_account: '110505',      // compra de contado -> Caja
  purchase_iva_descontable: '135515',   // IVA descontable de la compra

  expense_payable: '233505',            // gasto no pagado -> costos y gastos por pagar
  expense_cash_account: '110505',
  expense_bank_account: '111005',

  // Diferencias de cierre de caja: sobrante -> ingreso diverso, faltante -> gasto diverso.
  // La cuenta de caja/bancos que se ajusta reutiliza sale_cash_account / sale_bank_account.
  cash_session_surplus: '429505',
  cash_session_shortage: '519599',

  // Mapeo por categoría de Expense.category (los 11 valores del enum)
  'expense_category:arriendo': '512005',
  'expense_category:servicios_publicos': '513505',
  'expense_category:nomina': '510506',
  'expense_category:mantenimiento': '514505',
  'expense_category:transporte': '519515',
  'expense_category:impuestos': '519525',
  'expense_category:marketing': '519535',
  'expense_category:insumos_oficina': '519540',
  'expense_category:seguros': '513005',
  'expense_category:honorarios': '511005',
  'expense_category:otro': '519599',

  // Cierre de ejercicio (3.3 del análisis contable): traslada el resultado
  // del año (ingresos - costos - gastos) a patrimonio.
  year_end_result: '360505',        // Utilidad del Ejercicio (año que se está cerrando)
  year_end_accumulated: '370505',   // Utilidades Acumuladas (años anteriores ya cerrados)
};

module.exports = { PUC_COLOMBIA_STANDARD, DEFAULT_ACCOUNT_MAPPINGS };
