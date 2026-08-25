'use strict';

// hide_workorder_tax (Taller: OT interna + link público + PDF de OT) se
// separó de hide_remision_tax (Ventas: remisión/factura), que antes hacía
// las dos cosas -- ver WorkOrderDetailPage.jsx, WorkOrderPublicPage.jsx y
// workshopPdfService.js. Como los dos flags ahora tienen su propio default
// (true = oculto), un tenant que ya tenía hide_remision_tax en false
// (mostrando IVA) vería el IVA de sus OT ocultarse de golpe al desplegar,
// aunque nunca haya tocado nada -- un cambio de configuración disparado por
// un deploy, que no se debe permitir.
//
// Esta migración congela, para cada tenant que TODAVÍA NO tenga
// hide_workorder_tax seteado explícitamente, el mismo valor efectivo que
// tenía hide_remision_tax (o el default `true` si tampoco existía). Así el
// comportamiento visible no cambia para nadie; el que quiera separarlos de
// verdad lo hace luego a mano desde Configuración.
//
// `tenants` es tabla global en schema `public` (no per-tenant-schema), así
// que cuando esto corre en el contexto de aprovisionar UN tenant nuevo
// (context.tenantId presente) se filtra a ese único tenant -- igual que en
// 2026070904-seed-accounting-for-existing-tenants.js -- aunque para un
// tenant recién creado el resultado es un no-op (ambos flags nacen en su
// default `true`).
module.exports = {
  up: async (queryInterface, Sequelize, context) => {
    const tenantFilter = context?.tenantId ? 'AND id = :tenantId' : '';

    await queryInterface.sequelize.query(
      `
      UPDATE "public"."tenants"
      SET features = jsonb_set(
        COALESCE(features, '{}'::jsonb),
        '{hide_workorder_tax}',
        to_jsonb(COALESCE((features->>'hide_remision_tax')::boolean, true)),
        true
      )
      WHERE (features IS NULL OR NOT (features ? 'hide_workorder_tax'))
      ${tenantFilter};
      `,
      { replacements: { tenantId: context?.tenantId } }
    );
  },

  down: async () => {
    // No se revierte: quitar hide_workorder_tax haría que todos los tenants
    // vuelvan a caer en el default (true = oculto), que es exactamente el
    // cambio de configuración no solicitado que esta migración existe para
    // evitar. Si de verdad hace falta revertir, hacerlo a mano por tenant.
  },
};
