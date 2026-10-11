'use strict';

// Opciones por formato de Exógena (por tenant). Primera: qué hacer con las
// devoluciones aprobadas este año sobre documentos de AÑOS ANTERIORES en los
// formatos 1001 (pagos y retenciones practicadas) y 1003 (retenciones que le
// practicaron al tenant):
//   prior_year_returns: 'skip' (por defecto: lo del año anterior ya se
//   declaró, no se toca) | 'subtract' (se resta en el año de la devolución).
// La decisión es del contador del tenant; por eso es configurable.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE exogena_format_configs ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE exogena_format_configs DROP COLUMN IF EXISTS options`);
  },
};
