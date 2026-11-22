'use strict';

// NIIF para Pymes — fase 1 (ver data/niifRubros.js).
//
//   chart_of_accounts.niif_rubro  rubro de presentación fijado por el
//                                 contador (null = heredado del padre o
//                                 regla por prefijo PUC).
//
// Siembra las cuentas que la NIIF necesita y el PUC de Pitbox no traía
// (deterioro de cartera e inventarios, impuesto diferido, provisiones,
// adopción por primera vez, ORI, diferencia en cambio, impuesto de renta).
// Solo crea una cuenta si existe su padre: un plan de cuentas atípico no se
// fuerza, y no toca asientos ni periodos.

const NIIF_ACCOUNTS = [
  { code: '1399', name: 'Deterioro acumulado de cuentas por cobrar (CR)', type: 'activo', parent: '13', leaf: false },
  { code: '139905', name: 'Deterioro de clientes (CR)', type: 'activo', parent: '1399', leaf: true },
  { code: '1499', name: 'Deterioro de inventarios (CR)', type: 'activo', parent: '14', leaf: false },
  { code: '149905', name: 'Deterioro de inventarios a valor neto realizable (CR)', type: 'activo', parent: '1499', leaf: true },
  { code: '17', name: 'Diferidos', type: 'activo', parent: '1', leaf: false },
  { code: '1710', name: 'Cargos diferidos', type: 'activo', parent: '17', leaf: false },
  { code: '171076', name: 'Impuesto diferido activo', type: 'activo', parent: '1710', leaf: true },

  { code: '26', name: 'Pasivos estimados y provisiones', type: 'pasivo', parent: '2', leaf: false },
  { code: '2695', name: 'Provisiones diversas', type: 'pasivo', parent: '26', leaf: false },
  { code: '269595', name: 'Otras provisiones', type: 'pasivo', parent: '2695', leaf: true },
  { code: '27', name: 'Diferidos', type: 'pasivo', parent: '2', leaf: false },
  { code: '2725', name: 'Impuestos diferidos', type: 'pasivo', parent: '27', leaf: false },
  { code: '272505', name: 'Impuesto diferido pasivo', type: 'pasivo', parent: '2725', leaf: true },

  { code: '3730', name: 'Ajustes por adopción de NIIF', type: 'patrimonio', parent: '37', leaf: false },
  { code: '373005', name: 'Ganancias acumuladas por adopción NIIF', type: 'patrimonio', parent: '3730', leaf: true },
  { code: '3830', name: 'Otro resultado integral', type: 'patrimonio', parent: '38', leaf: false },
  { code: '383005', name: 'Superávit por revaluación de propiedades, planta y equipo (ORI)', type: 'patrimonio', parent: '3830', leaf: true },

  { code: '421020', name: 'Diferencia en cambio (ingreso)', type: 'ingreso', parent: '42', leaf: true },
  { code: '425055', name: 'Recuperación de deterioro de cuentas por cobrar', type: 'ingreso', parent: '42', leaf: true },
  { code: '425060', name: 'Recuperación de deterioro de inventarios', type: 'ingreso', parent: '42', leaf: true },

  { code: '519910', name: 'Deterioro de cuentas por cobrar', type: 'gasto', parent: '51', leaf: true },
  { code: '519920', name: 'Deterioro de inventarios (valor neto realizable)', type: 'gasto', parent: '51', leaf: true },
  { code: '530525', name: 'Diferencia en cambio (gasto)', type: 'gasto', parent: '53', leaf: true },
  { code: '54', name: 'Impuesto de renta y complementarios', type: 'gasto', parent: '5', leaf: false },
  { code: '5405', name: 'Impuesto de renta y complementarios', type: 'gasto', parent: '54', leaf: false },
  { code: '540505', name: 'Impuesto de renta corriente', type: 'gasto', parent: '5405', leaf: true },
  { code: '540510', name: 'Impuesto de renta diferido', type: 'gasto', parent: '5405', leaf: true },
];

module.exports = {
  NIIF_ACCOUNTS,
  up: async (queryInterface, Sequelize, context) => {
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements });

    await q(`ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS niif_rubro VARCHAR(40)`);

    const [tenants] = context?.tenantId
      ? await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts WHERE tenant_id = :tenantId`, { tenantId: context.tenantId })
      : await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts`);

    for (const { tenant_id } of tenants) {
      for (const acc of NIIF_ACCOUNTS) {
        const [[existing]] = await q(
          `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code LIMIT 1`,
          { tenantId: tenant_id, code: acc.code }
        );
        if (existing) continue;
        const [[parent]] = await q(
          `SELECT id, level, accepts_entries, account_type FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code LIMIT 1`,
          { tenantId: tenant_id, code: acc.parent }
        );
        // Sin padre, o un padre auxiliar (recibe movimientos) o de otro tipo:
        // no se cuelga nada de él.
        if (!parent || parent.accepts_entries || parent.account_type !== acc.type) continue;
        await q(
          `INSERT INTO chart_of_accounts
             (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
           VALUES (gen_random_uuid(), :tenantId, :code, :name, :type, :parentId, :level, :leaf, true, NOW(), NOW())`,
          { tenantId: tenant_id, code: acc.code, name: acc.name, type: acc.type, parentId: parent.id, level: Number(parent.level || 1) + 1, leaf: acc.leaf }
        );
      }
    }
  },

  down: async (queryInterface) => {
    // Las cuentas sembradas se dejan: pueden tener movimientos.
    await queryInterface.sequelize.query(`ALTER TABLE chart_of_accounts DROP COLUMN IF EXISTS niif_rubro`);
  },
};
