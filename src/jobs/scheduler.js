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
const { withLeaseTry } = require('../utils/advisoryLock');
const logger = console; // este proyecto usa console.log/error directo en los jobs existentes

// Neon suspende el compute tras ~5 min sin consultas, y cada consulta lo
// despierta (y se paga). Reglas para que los jobs no lo mantengan despierto
// 24/7:
//  - Un job desactivado por variable de entorno ni se programa (`enabled`).
//  - Un job frecuente pregunta primero si hay trabajo, sin tocar la BD
//    (`shouldRun`), antes de tomar el lease.
//  - Los jobs periódicos que solo tienen sentido con gente trabajando corren
//    en horario hábil.
//  - Horarios escalonados (minutos distintos): a la hora en punto arrancaban
//    4 jobs a la vez y se repartían el mismo pool que los requests HTTP.
//
// Opciones por job: enabled() (por defecto sí), shouldRun() (por defecto
// sí) y leaseTtlMs (cuánto puede durar como máximo; ver withLeaseTry).
const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000;

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
    name: 'radian-deadlines',
    // Dos veces al día -- el plazo de 3 días hábiles se cuenta desde el
    // 032, así que una sola corrida diaria a las 8am podía dejar hasta 20
    // horas sin aviso de "por vencer" (ventana de 24h, ver
    // radianDeadlinesJob.js) si el 032 se aceptó ya entrada la tarde.
    schedule: '0 8,16 * * *',
    run: async () => {
      const { runRadianDeadlinesJob } = require('../services/radian/radianDeadlinesJob');
      return runRadianDeadlinesJob();
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
    name: 'crm-rewards',
    // 6:00am, media hora después de crm-lifecycle: para entonces el
    // progreso del período ya cerrado está consolidado. Corre a diario
    // (no solo el día 1) porque las metas semanales, mensuales y de
    // campaña cierran en fechas distintas, y porque también reintenta
    // las recompensas que esperaban un período de nómina abierto.
    schedule: '0 6 * * *',
    run: async () => {
      const { runCrmRewardsJob } = require('../services/crmRewardService');
      const result = await runCrmRewardsJob();
      return [result];
    },
  },
  {
    name: 'crm-automation-rules',
    // Cada 30 min en horario hábil (6:07 a 21:37) -- una regla tipo "sin
    // contactar hace 2h" pierde sentido si solo se revisa una vez al día,
    // pero de noche no hay nadie que atienda: lo de la noche lo dispara la
    // primera corrida de la mañana. Minutos 7/37 para no coincidir con la
    // hora en punto.
    schedule: '7,37 6-21 * * *',
    run: async () => {
      const { runPollingRules } = require('../services/crmAutomationEngine');
      const result = await runPollingRules();
      return [result];
    },
  },
  {
    name: 'wa-reminders',
    // Antes cada minuto: junto con `wa-campaigns`, era el job más frecuente
    // del scheduler -- corriendo 24/7 en las 5 réplicas, cada disparo abre
    // al menos 1 conexión/query a Neon (Tenant.findAll + advisory lock) sin
    // ninguna condición de "no hay nada pendiente, no toco la BD". Eso le
    // quitaba a Neon cualquier ventana de más de 60s para poder
    // autosuspender el compute en horas sin tráfico real (ver también
    // pool.min en config/database.js). 5 min sigue siendo puntual para un
    // recordatorio de WhatsApp -- nadie nota la diferencia frente a 1 min.
    // Solo consulta la BD si hay un recordatorio por vencer (aviso en
    // memoria, ver waCampaigns.service.js): sin esto despertaba a Neon cada
    // 5 min, 24/7, aunque no hubiera nada que enviar.
    schedule: '*/5 * * * *',
    shouldRun: () => require('../services/waCampaigns.service').hasDueReminders(),
    leaseTtlMs: 30 * 60 * 1000,
    run: async () => {
      const { processDueReminders } = require('../services/waCampaigns.service');
      const { processed } = await processDueReminders();
      return processed; // número real de recordatorios enviados en esta corrida
    },
  },
  {
    name: 'wa-campaigns',
    // Mismo motivo que wa-reminders arriba. El rate-limit interno de
    // ~15/min por tenant sigue aplicando dentro de cada corrida (no depende
    // de la frecuencia del cron, sino del sleep interno en
    // waCampaigns.service.js), así que espaciar el disparador a 5 min no
    // cambia el throughput real de envío, solo la latencia entre corridas.
    // Desfasado 2 min de wa-reminders, y igual que él solo consulta la BD si
    // hay una campaña en cola.
    schedule: '2-59/5 * * * *',
    shouldRun: () => require('../services/waCampaigns.service').hasPendingCampaigns(),
    leaseTtlMs: 30 * 60 * 1000,
    run: async () => {
      const { processQueuedCampaigns } = require('../services/waCampaigns.service');
      const { sent } = await processQueuedCampaigns();
      return sent; // número real de mensajes de campaña enviados en esta corrida
    },
  },
  {
    name: 'stock-alerts',
    // Red de seguridad: las alertas ya se recalculan en el momento en que
    // cambia el stock (markForAlertCheck). Antes cada hora, 24/7; ahora tres
    // veces en el día hábil.
    schedule: '15 6,12,18 * * *',
    run: async () => {
      const { checkAllStockAlerts } = require('../middleware/autoCheckAlerts.middleware');
      return checkAllStockAlerts();
    },
  },
  {
    name: 'customer-advance-alerts',
    schedule: '10 6 * * *', // 6:10am hora Colombia (después de crm-rewards) -- basta con una vez al día, el disparador es antigüedad en días, no una hora exacta
    run: async () => {
      const { checkAllAdvanceAlerts } = require('../middleware/autoCheckAdvanceAlerts.middleware');
      const result = await checkAllAdvanceAlerts();
      return [result]; // envuelto en array para que el log de "elementos" del scheduler tenga sentido
    },
  },
  {
    name: 'fixed-asset-depreciation',
    // Día 1 de cada mes, 4:00am hora Colombia -- corre DESPUÉS de que el mes
    // anterior ya cerró por completo, así se deprecia en firme (ver
    // fixedAssetDepreciation.service.js: procesa lastClosedPeriod(), no el
    // mes en curso). Naturalmente hace catch-up si el job se saltó algún mes.
    schedule: '0 4 1 * *',
    run: async () => {
      const { runMonthlyDepreciationAllTenants } = require('../services/accounting/fixedAssetDepreciation.service');
      return runMonthlyDepreciationAllTenants();
    },
  },
  {
    name: 'loan-installments-overdue-check',
    // Diario, 5:00am hora Colombia -- marca 'vencida' cualquier cuota
    // 'pendiente' cuyo due_date ya pasó. Solo actualiza el status; no
    // genera ningún asiento (el asiento del pago solo se genera cuando de
    // verdad se paga, vía registerPayment).
    schedule: '0 5 * * *',
    run: async () => {
      const { flagOverdueInstallments } = require('../services/accounting/loanAmortization.service');
      return flagOverdueInstallments();
    },
  },
  {
    name: 'ncf-sync',
    schedule: '0 7 * * *', // 7:00am hora Colombia
    // Desactivado: ni se programa (antes tomaba el lock en la BD solo para
    // decir que estaba desactivado). Cambiar la variable requiere reiniciar.
    enabled: () => process.env.ENABLE_NCF_AUTOSYNC === 'true',
    run: async () => {
      // Genera prefacturas reales en el Núcleo y le manda al cliente un
      // email con link de pago apenas se crean (ver
      // emailService.enviarPrefacturaGenerada) -- mientras se está probando
      // el módulo (ciudad/monto/fecha de cobro por tenant, reintentos de
      // rechazados, etc.) queda apagado por defecto para no facturarle a
      // clientes reales por accidente. Activar a propósito con
      // ENABLE_NCF_AUTOSYNC=true una vez validado. El botón "Sincronizar
      // tenants ahora" del panel sigue funcionando igual -- es una acción
      // explícita del usuario, no depende de esta bandera.
      const { sincronizarTodosLosTenants, revisarSuspensiones } = require('../services/ncf/ncfSyncService');
      const sync = await sincronizarTodosLosTenants();
      const suspendidos = await revisarSuspensiones();
      return [...sync, ...suspendidos];
    },
  },
  {
    name: 'tenant-auto-purge',
    schedule: '0 3 * * *', // 3:00am hora Colombia
    enabled: () => process.env.ENABLE_TENANT_AUTOPURGE === 'true',
    run: async () => {
      // Política: a los 30 días de cancelado un contrato se borran los
      // datos y la empresa. Es IRREVERSIBLE (dropea el schema del tenant),
      // así que queda apagado por defecto hasta activarlo a propósito con
      // ENABLE_TENANT_AUTOPURGE=true una vez validado en un ambiente de
      // pruebas. El borrado manual desde el superadmin (DELETE /tenants/:id)
      // no depende de esta bandera.
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

  const disabled = JOBS.filter((j) => j.enabled && !j.enabled()).map((j) => j.name);
  if (disabled.length) {
    logger.log(`⏸️  [Scheduler] Jobs desactivados (no se programan): ${disabled.join(', ')} -- ver ENABLE_NCF_AUTOSYNC / ENABLE_TENANT_AUTOPURGE`);
  }

  const tasks = JOBS.filter((j) => !j.enabled || j.enabled()).map(({ name, schedule, run, shouldRun, leaseTtlMs }) => {
    if (!cron.validate(schedule)) {
      logger.error(`❌ [Scheduler] Expresión cron inválida para "${name}": ${schedule}`);
      return null;
    }

    return cron.schedule(schedule, async () => {
      const startedAt = new Date();
      // Sin trabajo pendiente: ni log ni BD (cada 5 min llenaba el log).
      if (shouldRun && !shouldRun()) return;
      logger.log(`🔔 [Scheduler] "${name}" disparado, intentando tomar el lock...`);
      try {
        // noOverlap:true de node-cron solo evita que ESTE proceso solape una
        // corrida con la siguiente -- con varias réplicas, cada una dispara
        // el cron a la misma hora igual. El lease (public.cron_locks,
        // compartido entre réplicas) asegura que solo una de ellas realmente
        // ejecute el job en cada disparo; las demás lo saltan. A diferencia
        // del advisory lock que se usaba antes, no deja una transacción
        // abierta mientras corre el job.
        const { acquired, result } = await withLeaseTry(`pitbox:cron:${name}`, leaseTtlMs || DEFAULT_LEASE_TTL_MS, run);
        if (!acquired) {
          logger.log(`⏭️  [Scheduler] "${name}" ya se está ejecutando en otra réplica, se omite esta corrida`);
          return;
        }
        // `result` puede venir como array (longitud = elementos procesados,
        // ej. vehicle-reminders) o como número directo (ej. wa-reminders/
        // wa-campaigns, que reportan cuántos mensajes salieron de verdad en
        // esta corrida en vez de envolver un resumen en un array de 1 solo
        // elemento -- eso hacía que el log dijera "(1 elementos)" en CADA
        // corrida sin importar si había 0 o 5 pendientes, dando a entender
        // que siempre se enviaba algo cuando casi nunca era el caso).
        const count = typeof result === 'number' ? result : result?.length;
        logger.log(`✅ [Scheduler] "${name}" terminó en ${Date.now() - startedAt.getTime()}ms`, count !== undefined ? `(${count} elementos)` : '');
      } catch (error) {
        logger.error(`❌ [Scheduler] Error en "${name}":`, error.message);
      }
    }, { timezone: 'America/Bogota', name, noOverlap: true });
  }).filter(Boolean);

  logger.log(`⏰ [Scheduler] ${tasks.length} jobs programados: ${JOBS.filter((j) => !j.enabled || j.enabled()).map((j) => `${j.name} (${j.schedule})`).join(', ')}`);
  return tasks;
}

module.exports = { iniciarScheduler, JOBS };