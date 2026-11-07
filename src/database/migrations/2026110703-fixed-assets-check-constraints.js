'use strict';

// Amplía las restricciones CHECK de fixed_assets a los métodos y categorías
// nuevos (migración 2026110702): la de 2026091501 solo admitía 'linea_recta'
// y las cinco categorías iniciales.

const METHODS = ['linea_recta', 'saldos_decrecientes', 'unidades_produccion', 'menor_cuantia', 'no_deprecia'];
const CATEGORIES = ['vehiculo', 'maquinaria', 'equipo_computo', 'equipo_comunicacion', 'muebles_enseres', 'construcciones', 'terrenos', 'otro'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_depreciation_method_check`);
    await q(`ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_depreciation_method_check CHECK (depreciation_method IN (${list(METHODS)}))`);
    await q(`ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_category_check`);
    await q(`ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_category_check CHECK (category IN (${list(CATEGORIES)}))`);
    await q(`ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_disposal_type_check`);
    await q(`ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_disposal_type_check CHECK (disposal_type IS NULL OR disposal_type IN ('retiro', 'venta'))`);
  },
  down: async () => {},
};
