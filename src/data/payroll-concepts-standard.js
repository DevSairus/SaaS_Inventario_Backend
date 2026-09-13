/**
 * Catálogo estándar de conceptos de nómina — set básico para arrancar
 *
 * Cubre las categorías DIAN más comunes (ver DIAN_CATEGORY_MAP en
 * payrollService.js) que dependen de una NOVEDAD capturada manualmente por
 * periodo/empleado -- horas extra, bonificaciones, comisiones, libranzas,
 * etc. NO incluye Básico, Auxilio de Transporte, Salud, Pensión ni Fondo de
 * Solidaridad Pensional: esos son devengados/deducciones LEGALES que
 * payrollService.js#liquidarEmpleado calcula automáticamente a partir de
 * Employee (base_salary, transport_allowance_eligible) — no son
 * PayrollConcept y no deben seedearse aquí (crear un concepto con esos
 * nombres solo confundiría al usuario, ya que no haría nada al aplicarlo).
 *
 * Todos quedan is_active=true, auto_apply=false (se aplican solo cuando el
 * usuario captura la novedad correspondiente) y calculation_type='manual'
 * (el valor se captura por evento, no se calcula solo desde default_value).
 * El tenant puede editar/desactivar/crear más desde PayrollConceptsPage.jsx.
 */

const PAYROLL_CONCEPTS_STANDARD = [
  // ══════════════ DEVENGADOS ══════════════
  { code: 'HED',    name: 'Hora Extra Diurna',                    concept_type: 'devengado', dian_category: 'HEDs',         sort_order: 10 },
  { code: 'HEN',    name: 'Hora Extra Nocturna',                  concept_type: 'devengado', dian_category: 'HENs',         sort_order: 20 },
  { code: 'HRN',    name: 'Recargo Nocturno',                     concept_type: 'devengado', dian_category: 'HRNs',         sort_order: 30 },
  { code: 'HEDDF',  name: 'Hora Extra Diurna Dominical/Festivo',  concept_type: 'devengado', dian_category: 'HEDDFs',       sort_order: 40 },
  { code: 'HRDDF',  name: 'Recargo Diurno Dominical/Festivo',     concept_type: 'devengado', dian_category: 'HRDDFs',       sort_order: 50 },
  { code: 'COM',    name: 'Comisiones',                           concept_type: 'devengado', dian_category: 'Comisiones',   sort_order: 60 },
  { code: 'BON',    name: 'Bonificaciones',                       concept_type: 'devengado', dian_category: 'Bonificaciones', sort_order: 70 },
  { code: 'AUX',    name: 'Auxilios (no constitutivos de salario)', concept_type: 'devengado', dian_category: 'Auxilios',   sort_order: 80 },
  { code: 'INC',    name: 'Incapacidades',                        concept_type: 'devengado', dian_category: 'Incapacidades', sort_order: 90 },
  { code: 'VAC',    name: 'Vacaciones',                           concept_type: 'devengado', dian_category: 'Vacaciones',   sort_order: 100 },
  { code: 'LICR',   name: 'Licencias',                            concept_type: 'devengado', dian_category: 'Licencias',    sort_order: 110 },

  // ══════════════ DEDUCCIONES ══════════════
  { code: 'LIB',    name: 'Libranza',                             concept_type: 'deduccion', dian_category: 'Libranza',        sort_order: 200 },
  { code: 'SIND',   name: 'Cuota Sindical',                       concept_type: 'deduccion', dian_category: 'Sindicatos',      sort_order: 210 },
  { code: 'RETFTE', name: 'Retención en la Fuente',                concept_type: 'deduccion', dian_category: 'RetencionFuente', sort_order: 220 },
  { code: 'PENVOL', name: 'Pensión Voluntaria',                    concept_type: 'deduccion', dian_category: 'PensionVoluntaria', sort_order: 230 },
  { code: 'COOP',   name: 'Cooperativa',                           concept_type: 'deduccion', dian_category: 'Cooperativa',     sort_order: 240 },
  { code: 'EDUC',   name: 'Educación',                             concept_type: 'deduccion', dian_category: 'Educacion',       sort_order: 250 },
];

module.exports = { PAYROLL_CONCEPTS_STANDARD };
