# Pitbox — cambios aplicados (Fases 0/1/2/3/4)

## Fase 0 — routing de creación de tenants y bandeja de soporte
- MODIFICADO  src/routes/superadmin.routes.js — dispara cutoverTenant() al crear un tenant
- MODIFICADO  src/routes/superadmin/support.routes.js — reescrito: monta tickets/stats/FAQ de superadmin en vez de duplicar el router de tenants
- ELIMINADO   src/controllers/superadmin.controller.js — código huérfano, nunca enrutado

## Fase 1 — SQL crudo que no resolvía el schema del tenant (18 archivos)
Contabilidad: libroDiario, libroMayor, libroAuxiliar, libroIva, withholdingReport,
financialReports, agingReport, cashFlowIndirect (controllers) + cashReconciliation,
fiscalPeriod, openingBalance (services).
Ventas: voidSale.js, customerReturns.controller.js.
Inventario: categories, products, reports, vehicleApplications (controllers).
Diagnóstico: services/dian/diagnose-movements.js (reescrito para recorrer
public + cada schema de tenant).

## Fase 2 — jobs en background sin contexto de tenant
- MODIFICADO  src/middleware/autoCheckAlerts.middleware.js — checkAllStockAlerts ahora recorre cada tenant en su schema
- MODIFICADO  src/services/vehicleReminderService.js — runVehicleReminders ahora recorre cada tenant en su schema
- MODIFICADO  src/config/registerTenantSchemaHooks.js — agregado NcfConfig a PUBLIC_SCHEMA_MODELS (hueco latente, sin impacto real todavía)

## Fase 3 — propagación de migraciones futuras a schemas ya provisionados
- NUEVO       src/scripts/migrateAllTenantSchemas.js
- MODIFICADO  src/server.js — lo conecta después de runMigrations(), en ambas ramas de arranque (Railway/local y Vercel)

## Fase 4 — limpieza
- RENOMBRADO  src/database/migrations/0260202120100-create-supplier-returns.js
              -> 20260202120100-create-supplier-returns.js
- RENOMBRADO  src/database/migrations/YYYYMMDDHHMMSS-create-customer-returns.js
              -> 20260103000000-create-customer-returns.js
- NUEVO       src/database/migrations/RENAME-sequelize-migrations-rows.sql
              *** OBLIGATORIO correr esto contra la BD real (public + cada
              schema de tenant) ANTES de desplegar el rename de arriba ***
- MODIFICADO  src/scripts/provisionTenantSchema.js — quitado el SORT_KEY_OVERRIDES, ya no hace falta
- ELIMINADO   src/scripts/fix-user-tenant.js — credenciales locales hardcodeadas, sin uso real

## Antes de desplegar, EN ESTE ORDEN
1. Correr RENAME-sequelize-migrations-rows.sql contra production (public) y
   contra cada schema de tenant ya provisionado.
2. Recién ahí desplegar el código de este zip.
3. Confirmar en logs de arranque: "[Migrator] Schemas de tenant: N/N al día".

## Pendiente / próximos pasos (no incluido en este zip)
- Vercel: migrateAllTenantSchemas() corre en cada cold start -- confirmar si
  esa rama sigue en uso real o es código muerto (todo apunta a que Pitbox
  corre en Railway persistente).
- config/database.js: rama de pool pensada para Vercel serverless (max: 2)
  convive con el modelo real de conexión persistente -- revisar y simplificar
  cuando se confirme el punto anterior.
- Fase 5 (visibilidad operativa en superadmin), Fase 6 (política de rollback
  con deletes no replicables) y Fase 7 (retomar cutovers reales de forma
  incremental) siguen pendientes del plan original.


El proceso correcto, en orden:

SLUG DE PRUEBA: Amortiguadores y freno de Oriente

0. Desplegar lo que ya está corregido, en este orden exacto

Correr RENAME-sequelize-migrations-rows.sql contra tu base real (public; no hace falta tocar ningún schema de tenant todavía porque no hay ninguno provisionado en serio).
Recién ahí desplegar el código del último zip.
Confirmar en los logs de arranque: [Migrator] Schemas de tenant: 0/0 al día (o 1/1 si el tenant de prueba ya tiene schema) — sin errores.

1. Validar el pipeline completo con el tenant de prueba

node src/scripts/cutoverTenant.js <slug-del-tenant-de-prueba>

Esto hace, en orden, con checkpoint entre cada paso:

provisionTenantSchema — crea tenant_<slug> y corre todas las migraciones dentro.
migrateTenantData — copia los datos y verifica conteos; si algo no cuadra, tira error y no sigue (no llega al paso 3).
Solo si 1 y 2 salieron bien: activa schema_name en public.tenants. A partir de la siguiente request, ese tenant ya vive en su schema.

Las filas viejas en public no se borran en este paso — quedan de respaldo a propósito.

Con el tenant de prueba ya cortado, probá en vivo (esto es lo que antes no se podía confiar):

Entrá con ese tenant y generá Libro Diario, Libro Mayor, un reporte de inventario, una devolución de cliente — todo lo que corregimos en la Fase 1.
Si querés confirmar los jobs en background sin esperar al cron, podés invocar checkAllStockAlerts() / runVehicleReminders() a mano desde una consola de Node.
node src/scripts/diagnose-movements.js (o el nombre que quede tras el rename, revisa la ruta exacta: src/services/dian/diagnose-movements.js) te muestra ahora public + cada schema de tenant por separado — útil para confirmar que los datos están donde deben.

2. Recién con eso validado, cortar el tenant real

node src/scripts/cutoverTenant.js <slug-del-tenant-real>

Antes de correrlo contra el real, dos cosas que no son opcionales:

Backup: si usás Neon, crea un branch antes (te da un punto de restauración instantáneo e independiente del propio rollback del sistema). Si no, un pg_dump del tenant.
Corrélo en una ventana de bajo uso — migrateTenantData es una copia consistente pero el tenant sigue operando sobre public mientras tanto; cualquier fila creada después de que termine la copia y antes de que se active schema_name no se replica sola (por eso conviene una ventana corta y tranquila, no por un límite técnico del script).

3. Los primeros días después del corte real

Dejá las filas en public sin tocar — es tu red de seguridad. rollbackTenant.js <slug> las usa para volver atrás si hace falta (con la limitación ya documentada: no replica deletes hechos después del corte).
Solo cuando estés seguro de que todo funciona bien en producción real (no solo en el reporte de conteos), corré cleanupTenantPublicData.js <slug> para borrar el duplicado de public. Ese script solo borra si el conteo coincide exacto; si no, salta la tabla y la marca para revisión manual — no hay riesgo de que borre de más.