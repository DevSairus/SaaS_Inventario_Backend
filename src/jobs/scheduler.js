// backend/src/jobs/scheduler.js
// Reemplaza la dependencia de Vercel Cron (que no existe en Railway) por
// un scheduler DENTRO del propio proceso -- Pitbox corre como servidor
// persistente en Railway (no serverless), así que no hace falta un
// servicio de cron aparte ni configurar nada en un dashboard: el mismo
// proceso que atiende la API también dispara estos jobs en los horarios
// de siempre.
//
// Los endpoints HTTP /api/cron/* (protegidos con CRON_SECRET) se dejan
// intactos como respaldo -- útiles para disparar un job a mano o desde un
// servicio externo si algún día se prefiere sacar el scheduler de acá.
//
// Se puede apagar por completo con ENABLE_CRON_SCHEDULER=false (por si se
// decide usar Railway Cron Job / un servicio externo en su lugar, para no
// terminar corriendo el mismo job dos veces).
const cron = require('node-cron');
const logger = console; // este proyecto usa console.log/error directo en los jobs existentes

const JOBS = [
  {
    name: 'vehicle-reminders',
    schedule: '0 8 * * *', // 8:00am hora Colombia -- se interpreta en America/Bogota (ver timezone abajo)
    run: async () => {
      const { runVehicleReminders } = require('../services/vehicleReminderService');
      return runVehicleReminders();
    },
  },
  {
    name: 'crm-lifecycle',
    schedule: '30 5 * * *', // 5:30am hora Colombia — antes de que arranque operación
    run: async () => {
      const { runCrmLifecycleJob } = require('../services/crmLifecycleService');
      const result = await runCrmLifecycleJob();
      return [result]; // envuelto en array para que el log de "elementos" del scheduler tenga sentido
    },
  },
  {
    name: 'crm-automation-rules',
    schedule: '*/30 * * * *', // cada 30 min -- una regla tipo "sin contactar hace 2h" pierde sentido si solo se revisa una vez al día
    run: async () => {
      const { runPollingRules } = require('../services/crmAutomationEngine');
      const result = await runPollingRules();
      return [result];
    },
  },
  {
    name: 'stock-alerts',
    schedule: '0 * * * *', // cada hora en punto (no depende de timezone)
    run: async () => {
      const { checkAllStockAlerts } = require('../middleware/autoCheckAlerts.middleware');
      return checkAllStockAlerts();
    },
  },
  {
    name: 'ncf-sync',
    schedule: '0 7 * * *', // 7:00am hora Colombia
    run: async () => {
      const { sincronizarTodosLosTenants, revisarSuspensiones } = require('../services/ncf/ncfSyncService');
      const sync = await sincronizarTodosLosTenants();
      const suspendidos = await revisarSuspensiones();
      return [...sync, ...suspendidos];
    },
  },
  {
    name: 'tenant-auto-purge',
    schedule: '0 3 * * *', // 3:00am hora Colombia
    run: async () => {
      // Política: a los 30 días de cancelado un contrato se borran los
      // datos y la empresa. Es IRREVERSIBLE (dropea el schema del tenant),
      // así que queda apagado por defecto hasta activarlo a propósito con
      // ENABLE_TENANT_AUTOPURGE=true una vez validado en un ambiente de
      // pruebas. El borrado manual desde el superadmin (DELETE /tenants/:id)
      // no depende de esta bandera.
      if (process.env.ENABLE_TENANT_AUTOPURGE !== 'true') {
        logger.log('⏸️  [tenant-auto-purge] Desactivado (activar con ENABLE_TENANT_AUTOPURGE=true)');
        return [];
      }
      const { purgeExpiredCancelledTenants } = require('../services/tenantPurgeService');
      return purgeExpiredCancelledTenants({ graceDays: 30 });
    },
  },
];

function iniciarScheduler() {
  if (process.env.ENABLE_CRON_SCHEDULER === 'false') {
    logger.log('⏸️  [Scheduler] Desactivado por ENABLE_CRON_SCHEDULER=false -- los jobs solo corren si algo externo pega a /api/cron/*');
    return [];
  }

  const tasks = JOBS.map(({ name, schedule, run }) => {
    if (!cron.validate(schedule)) {
      logger.error(`❌ [Scheduler] Expresión cron inválida para "${name}": ${schedule}`);
      return null;
    }

    return cron.schedule(schedule, async () => {
      const startedAt = new Date();
      logger.log(`🔔 [Scheduler] Iniciando "${name}"...`);
      try {
        const result = await run();
        logger.log(`✅ [Scheduler] "${name}" terminó en ${Date.now() - startedAt.getTime()}ms`, result?.length !== undefined ? `(${result.length} elementos)` : '');
      } catch (error) {
        logger.error(`❌ [Scheduler] Error en "${name}":`, error.message);
      }
    }, { timezone: 'America/Bogota', name, noOverlap: true });
  }).filter(Boolean);

  logger.log(`⏰ [Scheduler] ${tasks.length} jobs programados: ${JOBS.map((j) => `${j.name} (${j.schedule})`).join(', ')}`);
  return tasks;
}

module.exports = { iniciarScheduler, JOBS };