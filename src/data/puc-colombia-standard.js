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
  { code: '133015', name: 'Anticipos a Trabajadores', type: 'activo', parent_code: '13', accepts_entries: true },
  { code: '1355', name: 'Anticipo de Impuestos y Contribuciones', type: 'activo', parent_code: '13', accepts_entries: false },
  { code: '135515', name: 'IVA Descontable', type: 'activo', parent_code: '1355', accepts_entries: true },
  { code: '135520', name: 'Retención en la Fuente (a favor)', type: 'activo', parent_code: '1355', accepts_entries: true },
  { code: '135517', name: 'Impuesto a las Ventas Retenido', type: 'activo', parent_code: '1355', accepts_entries: true },
  { code: '135518', name: 'Impuesto de Industria y Comercio Retenido', type: 'activo', parent_code: '1355', accepts_entries: true },

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
  { code: '236810', name: 'Autorretención de ICA por Pagar', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '237005', name: 'Aportes de Seguridad Social por Pagar', type: 'pasivo', parent_code: '23', accepts_entries: true },
  // Retenciones y aportes de nómina (comprobantes de nómina -- ver
  // services/payroll/payrollAccountingService.js).
  { code: '237006', name: 'Aportes a ARL por Pagar', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '237010', name: 'Aportes Parafiscales por Pagar (Caja, SENA, ICBF)', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '237025', name: 'Embargos Judiciales', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '237030', name: 'Libranzas', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '237035', name: 'Sindicatos', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '237040', name: 'Cooperativas', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '237095', name: 'Otras Retenciones de Nómina', type: 'pasivo', parent_code: '23', accepts_entries: true },
  { code: '238030', name: 'Fondos de Cesantías y/o Pensiones', type: 'pasivo', parent_code: '23', accepts_entries: true },

  { code: '24', name: 'Impuestos, Gravámenes y Tasas', type: 'pasivo', parent_code: '2', accepts_entries: false },
  { code: '240805', name: 'IVA por Pagar (Generado)', type: 'pasivo', parent_code: '24', accepts_entries: true },
  { code: '240405', name: 'Impuesto de Renta y Complementarios', type: 'pasivo', parent_code: '24', accepts_entries: true },
  { code: '241205', name: 'Impuesto de Industria y Comercio por Pagar', type: 'pasivo', parent_code: '24', accepts_entries: true },

  { code: '25', name: 'Obligaciones Laborales', type: 'pasivo', parent_code: '2', accepts_entries: false },
  { code: '250505', name: 'Salarios por Pagar', type: 'pasivo', parent_code: '25', accepts_entries: true },
  { code: '251005', name: 'Cesantías Consolidadas', type: 'pasivo', parent_code: '25', accepts_entries: true },
  { code: '251505', name: 'Intereses sobre Cesantías', type: 'pasivo', parent_code: '25', accepts_entries: true },
  { code: '252005', name: 'Prima de Servicios', type: 'pasivo', parent_code: '25', accepts_entries: true },
  { code: '252505', name: 'Vacaciones Consolidadas', type: 'pasivo', parent_code: '25', accepts_entries: true },

  { code: '28', name: 'Otros Pasivos', type: 'pasivo', parent_code: '2', accepts_entries: false },
  { code: '2805', name: 'Anticipos y Avances Recibidos', type: 'pasivo', parent_code: '28', accepts_entries: false },
  { code: '280505', name: 'Anticipos de Clientes', type: 'pasivo', parent_code: '2805', accepts_entries: true },

  // ══════════════ CLASE 3 — PATRIMONIO ══════════════
  { code: '3', name: 'PATRIMONIO', type: 'patrimonio', parent_code: null, accepts_entries: false },
  { code: '31', name: 'Capital Social', type: 'patrimonio', parent_code: '3', accepts_entries: false },
  { code: '311505', name: 'Aportes Sociales', type: 'patrimonio', parent_code: '31', accepts_entries: true },
  { code: '36', name: 'Resultados del Ejercicio', type: 'patrimonio', parent_code: '3', accepts_entries: false },
  { code: '360505', name: 'Utilidad del Ejercicio', type: 'patrimonio', parent_code: '36', accepts_entries: true },
  { code: '37', name: 'Resultados de Ejercicios Anteriores', type: 'patrimonio', parent_code: '3', accepts_entries: false },
  { code: '370505', name: 'Utilidades Acumuladas', type: 'patrimonio', parent_code: '37', accepts_entries: true },
  // Cuenta puente usada solo mientras se cargan los saldos iniciales de
  // apertura (cartera/proveedores/cuentas/inventario) -- ver
  // services/accounting/openingBalance.service.js. Cada saldo inicial se
  // contabiliza contra esta cuenta y se cierra manualmente cuando ya se
  // cargaron todos los saldos (bridge-status/close).
  { code: '38', name: 'Superávit de Capital', type: 'patrimonio', parent_code: '3', accepts_entries: false },
  { code: '380505', name: 'Cuenta Puente — Saldos de Apertura', type: 'patrimonio', parent_code: '38', accepts_entries: true },

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
  { code: '511505', name: 'Impuesto de Industria y Comercio', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510510', name: 'Comisiones a Técnicos (Mano de Obra)', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510515', name: 'Horas Extras y Recargos', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510527', name: 'Auxilio de Transporte', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510530', name: 'Cesantías', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510533', name: 'Intereses sobre Cesantías', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510536', name: 'Prima de Servicios', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510539', name: 'Vacaciones', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510545', name: 'Auxilios', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510548', name: 'Bonificaciones', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510551', name: 'Dotación y Suministro a Trabajadores', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510560', name: 'Indemnizaciones Laborales', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510568', name: 'Aportes a Administradoras de Riesgos Laborales', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510569', name: 'Aportes a Entidades Promotoras de Salud (EPS)', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510570', name: 'Aportes a Fondos de Pensiones', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510572', name: 'Aportes Cajas de Compensación Familiar', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510575', name: 'Aportes ICBF', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510578', name: 'Aportes SENA', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '510595', name: 'Otros Gastos de Personal', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '511005', name: 'Honorarios', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '512005', name: 'Arrendamientos', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '513005', name: 'Seguros', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '513505', name: 'Servicios Públicos', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '514505', name: 'Mantenimiento y Reparaciones', type: 'gasto', parent_code: '51', accepts_entries: true },
  { code: '516005', name: 'Depreciación', type: 'gasto', parent_code: '51', accepts_entries: true },
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
  // Retenciones PRACTICADAS por el tenant al proveedor (Fase 0 de
  // Declaraciones Periódicas / Formulario 350): antes de este mapeo,
  // generatePurchaseEntry acreditaba el total_amount completo a la cuenta
  // por pagar/caja, ignorando que parte de ese valor no se le paga al
  // proveedor sino que se le debe a la DIAN -- ver 236505/236710/236805,
  // ya sembradas en este mismo catálogo pero sin mapeo hasta ahora.
  purchase_retefuente_payable: '236505', // Retención en la Fuente por Pagar
  purchase_reteiva_payable: '236710',    // IVA Retenido por Pagar
  purchase_reteica_payable: '236805',    // Retención de ICA por Pagar

  expense_payable: '233505',            // gasto no pagado -> costos y gastos por pagar
  expense_cash_account: '110505',
  expense_bank_account: '111005',
  // Mismo caso que en compras, aplicado a gastos (Expense también calcula
  // retefuente/reteiva/reteica y total_retentions desde Fase C).
  expense_retefuente_payable: '236505',
  expense_reteiva_payable: '236710',
  expense_reteica_payable: '236805',

  // Diferencias de cierre de caja: sobrante -> ingreso diverso, faltante -> gasto diverso.
  // La cuenta de caja/bancos que se ajusta reutiliza sale_cash_account / sale_bank_account.
  cash_session_surplus: '429505',
  cash_session_shortage: '519599',

  // Ajustes de inventario confirmados (manuales o de toma física) y consumo
  // interno: mismo criterio de "diferencia no explicada" que cash_session_*
  // -- reutilizan las cuentas genéricas de Ingresos/Gastos Diversos en vez de
  // abrir una subcuenta nueva por motivo (merma, robo, daño...).
  inventory_adjustment_surplus: '429505',
  inventory_adjustment_shortage: '519599',
  internal_consumption_expense: '519599',

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
  // Comisión de técnicos: es costo de la mano de obra vendida, no gasto
  // administrativo -- reclasificada de 510510 (gasto operativo) a 615595
  // (Costo de Servicios Taller, la misma cuenta de sale_cogs_service) para
  // que la Utilidad Bruta del Estado de Resultados no quede inflada. La
  // cuenta 510510 sigue en el plan de cuentas (ya sembrada en tenants
  // existentes) por si algún tenant la reasigna manualmente.
  'expense_category:comisiones_tecnicos': '615595',
  'expense_category:otro': '519599',

  // Nómina electrónica (submitPayrollPeriod / generatePayrollEntry): el
  // gasto de personal ya tenía cuenta (expense_category:nomina, 510506) pero
  // faltaban las dos contrapartidas del pasivo -- lo retenido al empleado
  // para EPS/AFP (que la empresa debe remitir, no gastar) y el neto que
  // efectivamente se le debe pagar.
  payroll_social_security_payable: '237005',
  payroll_net_payable: '250505',

  // Comprobantes de nómina por empleado/concepto, aportes del empleador y
  // provisiones por fondo, y desembolso (payrollAccountingService.js).
  // payroll_social_security_payable (arriba) queda como la cuenta de EPS.
  // Comisiones vía nómina: mismo criterio que comisiones_tecnicos (costo de
  // la mano de obra vendida, no gasto administrativo).
  'payroll_expense:basico': '510506',
  'payroll_expense:horas_extra': '510515',
  'payroll_expense:comisiones': '615595',
  'payroll_expense:transporte': '510527',
  'payroll_expense:cesantias': '510530',
  'payroll_expense:intereses_cesantias': '510533',
  'payroll_expense:prima': '510536',
  'payroll_expense:vacaciones': '510539',
  'payroll_expense:auxilios': '510545',
  'payroll_expense:bonificaciones': '510548',
  'payroll_expense:dotacion': '510551',
  'payroll_expense:indemnizaciones': '510560',
  'payroll_expense:incapacidades_licencias': '510506',
  'payroll_expense:otros': '510595',
  'payroll_employer:eps': '510569',
  'payroll_employer:pension': '510570',
  'payroll_employer:arl': '510568',
  'payroll_employer:ccf': '510572',
  'payroll_employer:icbf': '510575',
  'payroll_employer:sena': '510578',
  payroll_pension_payable: '238030',
  payroll_arl_payable: '237006',
  payroll_parafiscales_payable: '237010',
  payroll_retefuente_payable: '236505',
  payroll_garnishments_payable: '237025',
  payroll_libranzas_payable: '237030',
  payroll_union_dues_payable: '237035',
  payroll_cooperative_payable: '237040',
  payroll_voluntary_pension_payable: '238030',
  payroll_advances_receivable: '133015',
  payroll_other_deductions_payable: '237095',
  'payroll_provision:cesantias': '251005',
  'payroll_provision:intereses_cesantias': '251505',
  'payroll_provision:prima': '252005',
  'payroll_provision:vacaciones': '252505',
  payroll_payment_bank: '111005',

  // Cierre de ejercicio (3.3 del análisis contable): traslada el resultado
  // del año (ingresos - costos - gastos) a patrimonio.
  year_end_result: '360505',        // Utilidad del Ejercicio (año que se está cerrando)
  year_end_accumulated: '370505',   // Utilidades Acumuladas (años anteriores ya cerrados)

  opening_balance_suspense: '380505', // Cuenta puente para saldos iniciales (cartera, cuentas, inventario)

  // Anticipos de Clientes (pasivo): lo que la empresa "debe" a sus clientes
  // por dinero recibido antes de facturar. Ver Anticipos-Clientes-Analisis-y-Plan.md §7.
  customer_advance_liability: '280505',

  // ICA (services/tax/ica.service.js) y retenciones que practican los
  // clientes sobre las ventas (registro de retenciones en cartera).
  sale_retefuente_receivable: '135520',
  sale_reteiva_receivable: '135517',
  sale_reteica_receivable: '135518',
  ica_expense: '511505',
  ica_payable: '241205',
  autoica_receivable: '135518',
  autoica_payable: '236810',

  // Activos Fijos — gasto de depreciación mensual (Fase 1 de
  // Contabilidad-Plan-Ejecucion-Fases-1-4.md). Las 5 categorías comparten
  // por defecto la misma cuenta base 516005 -- el tenant puede separar por
  // subcuenta y remapear cada categoría individualmente desde Mapeo de
  // Cuentas si necesita más detalle en el estado de resultados.
  'fixed_asset_depreciation_expense:vehiculo': '516005',
  'fixed_asset_depreciation_expense:maquinaria': '516005',
  'fixed_asset_depreciation_expense:equipo_computo': '516005',
  'fixed_asset_depreciation_expense:muebles_enseres': '516005',
  'fixed_asset_depreciation_expense:otro': '516005',
};

module.exports = { PUC_COLOMBIA_STANDARD, DEFAULT_ACCOUNT_MAPPINGS };
