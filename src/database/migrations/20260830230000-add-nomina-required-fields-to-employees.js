'use strict';

// El Anexo Técnico de Nómina Electrónica (Resolución 000013/2021) exige
// varios atributos de <Trabajador> y <Pago> que la migración original de
// employees (20260830040000-create-payroll-core-tables.js) no cubrió:
//
//   - SubTipoTrabajador (NIE042, obligatorio 1-1) — sub-clasificación PILA,
//     va junto a worker_type (que ya existe y mapea a TipoTrabajador).
//   - AltoRiesgoPension (NIE043, obligatorio 1-1, booleano).
//   - CodigoTrabajador (NIE063, opcional) — código interno del empleador,
//     útil también como referencia en NumeroSecuenciaXML.
//   - Forma de pago (NIE064, tabla 5.3.3.1: Contado/Crédito) — es un
//     concepto DISTINTO de payment_method (que ya existe y mapea a Método,
//     tabla 5.3.3.2: transferencia/efectivo/cheque). No se puede derivar
//     uno del otro.
//   - Lugar de trabajo (NIE050-053, obligatorios 1-1): país/departamento/
//     municipio/dirección de donde trabaja el empleado, que el Anexo trata
//     como un dato INDEPENDIENTE de la dirección personal/de residencia
//     (country/state/city/city_code/address, que ya existen). Se agregan
//     como columnas nullable con fallback: si el tenant no las diligencia,
//     payrollService.js usa la dirección del Empleador (caso típico de
//     PyME donde todos trabajan en la sede) — ver comentario en
//     payrollXmlBuilder.js#trabajadorXml().
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE employees
        ADD COLUMN IF NOT EXISTS worker_subtype VARCHAR(5) NOT NULL DEFAULT '00',
        ADD COLUMN IF NOT EXISTS high_risk_pension BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS employee_code VARCHAR(30),
        ADD COLUMN IF NOT EXISTS payment_form VARCHAR(5) NOT NULL DEFAULT '1'
          CHECK (payment_form IN ('1','2')),
        ADD COLUMN IF NOT EXISTS work_country VARCHAR(2) NOT NULL DEFAULT 'CO',
        ADD COLUMN IF NOT EXISTS work_state VARCHAR(100),
        ADD COLUMN IF NOT EXISTS work_city VARCHAR(100),
        ADD COLUMN IF NOT EXISTS work_city_code VARCHAR(5),
        ADD COLUMN IF NOT EXISTS work_address TEXT
    `);
    console.log('[Migration] employees: campos de Nómina Electrónica agregados (worker_subtype, high_risk_pension, employee_code, payment_form, work_*)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE employees
        DROP COLUMN IF EXISTS worker_subtype,
        DROP COLUMN IF EXISTS high_risk_pension,
        DROP COLUMN IF EXISTS employee_code,
        DROP COLUMN IF EXISTS payment_form,
        DROP COLUMN IF EXISTS work_country,
        DROP COLUMN IF EXISTS work_state,
        DROP COLUMN IF EXISTS work_city,
        DROP COLUMN IF EXISTS work_city_code,
        DROP COLUMN IF EXISTS work_address
    `);
  },
};
