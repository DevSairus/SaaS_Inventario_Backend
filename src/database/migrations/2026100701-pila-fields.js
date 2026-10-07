'use strict';

// Datos para generar la planilla PILA (archivo plano tipo 2 de la
// Resolución 2388 de 2016) -- ver services/payroll/pila/.
//
//   suppliers.pila_code: código de la administradora en PILA (EPS037,
//     230301, 25-14, CCF03, 14-11...), distinto del NIT.
//   employees: centro de trabajo y actividad económica ARL (Decreto 768 de
//     2022, 7 dígitos), tarifa ARL exacta si difiere de la de su clase.
//   payroll_settings: tipo de aportante, forma de presentación, sucursal,
//     actividad económica ARL por defecto y jornada semanal (para el valor
//     de la hora y las horas laboradas; vacía = máxima legal de la Ley 2101).
//
// Además corrige employees.worker_type: Pitbox usaba códigos propios que no
// son los de la tabla 5.5.3 DIAN (= tipo de cotizante PILA): '03'/'04'
// aprendiz lectivo/productivo son 12/19; '06' cooperado es 31; '02'
// "pensionado" en la tabla es servicio doméstico -- el pensionado es un
// dependiente (01) con subtipo 01.

const PILA_CODES = [
  // EPS
  ['900156264', 'EPS037'], ['800088702', 'EPS010'], ['800251440', 'EPS005'], ['800130907', 'EPS002'],
  ['830003564', 'EPS017'], ['860066942', 'EPS008'], ['830113831', 'EPS001'], ['805001157', 'EPS018'],
  // Pensión
  ['900336004', '25-14'], ['800224808', '230301'], ['800138188', '230201'], ['800149496', '231001'], ['800148514', '230901'],
];

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pila_code VARCHAR(10)`);
    await q.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pila_work_center VARCHAR(9)`);
    await q.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS arl_economic_activity VARCHAR(7)`);
    await q.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS arl_rate DECIMAL(9,7)`);
    await q.query(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS weekly_hours DECIMAL(4,1)`);
    await q.query(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS pila_contributor_type VARCHAR(2) NOT NULL DEFAULT '01'`);
    await q.query(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS pila_presentation_form VARCHAR(1) NOT NULL DEFAULT 'U'`);
    await q.query(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS pila_branch_code VARCHAR(10)`);
    await q.query(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS pila_branch_name VARCHAR(40)`);
    await q.query(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS arl_economic_activity VARCHAR(7)`);

    for (const [nit, code] of PILA_CODES) {
      await q.query(
        `UPDATE suppliers SET pila_code = :code WHERE pila_code IS NULL AND regexp_replace(COALESCE(tax_id, ''), '\\D', '', 'g') = :nit`,
        { replacements: { code, nit } }
      );
      // Con DV pegado (10 dígitos)
      await q.query(
        `UPDATE suppliers SET pila_code = :code WHERE pila_code IS NULL AND length(regexp_replace(COALESCE(tax_id, ''), '\\D', '', 'g')) = :len AND left(regexp_replace(COALESCE(tax_id, ''), '\\D', '', 'g'), :base) = :nit`,
        { replacements: { code, nit, len: nit.length + 1, base: nit.length } }
      );
    }

    await q.query(`UPDATE employees SET worker_type = '12' WHERE worker_type = '03'`);
    await q.query(`UPDATE employees SET worker_type = '19' WHERE worker_type = '04'`);
    await q.query(`UPDATE employees SET worker_type = '31' WHERE worker_type = '06'`);
    await q.query(`UPDATE employees SET worker_type = '01', worker_subtype = CASE WHEN worker_subtype IN ('00', '') THEN '01' ELSE worker_subtype END WHERE worker_type = '02'`);
    console.log('[Migration] campos PILA');
  },
  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE suppliers DROP COLUMN IF EXISTS pila_code`);
    for (const c of ['pila_work_center', 'arl_economic_activity', 'arl_rate']) await q.query(`ALTER TABLE employees DROP COLUMN IF EXISTS ${c}`);
    for (const c of ['weekly_hours', 'pila_contributor_type', 'pila_presentation_form', 'pila_branch_code', 'pila_branch_name', 'arl_economic_activity']) {
      await q.query(`ALTER TABLE payroll_settings DROP COLUMN IF EXISTS ${c}`);
    }
  },
};
