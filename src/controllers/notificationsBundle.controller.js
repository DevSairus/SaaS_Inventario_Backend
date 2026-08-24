// backend/src/controllers/notificationsBundle.controller.js
//
// Antes: 6 componentes en Layout.jsx pedían cada uno lo suyo con su propio
// setInterval (2min/90s) — 6 round-trips independientes a Postgres por
// usuario logueado, todo el día (ver analisis-consumo-neon.md). Ahora el
// frontend consulta este único endpoint cada 30 min y este controlador hace
// el trabajo de los 6 en paralelo, dentro del mismo proceso.
//
// A propósito NO se duplica la lógica de cada query: se reutilizan los
// controladores existentes (getStockAlerts, getPayableAlerts, etc.) tal
// cual, invocándolos con un req/res "de mentira" que captura el JSON que
// habrían mandado por HTTP. Así los endpoints individuales (que siguen
// existiendo — las páginas de gestión y el refresh-al-abrir cada campana
// los siguen usando) y este bundle jamás pueden desincronizarse en el
// criterio de qué es o no una alerta activa.
const stockAlertsController = require('./stockAlerts.controller');
const payableAlertsController = require('./payableAlerts.controller');
const advanceAlertsController = require('./finance/customerAdvanceAlerts.controller');
const crmDashboardController = require('./crm/dashboard.controller');
const workOrdersController = require('./workshop/workOrders.controller');
const appointmentsController = require('./workshop/workshopAppointments.controller');
const { getEffectiveModulesForTenantId } = require('../services/moduleAccess');
const logger = require('../config/logger');

// Ejecuta un controlador Express normal sin pasar por HTTP: le da un req
// con el query que necesite y un res falso que resuelve la promesa en vez
// de escribir en el socket. Si el controlador lanza o responde con
// success:false, se resuelve igual (nunca rechaza) para que Promise.all no
// tumbe el resto del bundle por un solo módulo caído.
function invoke(controllerFn, baseReq, queryOverrides = {}) {
  return new Promise((resolve) => {
    const fakeReq = { ...baseReq, query: { ...baseReq.query, ...queryOverrides } };
    const fakeRes = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ statusCode: this.statusCode, body: payload }); },
    };
    try {
      Promise.resolve(controllerFn(fakeReq, fakeRes)).catch((err) => {
        resolve({ statusCode: 500, body: { success: false, message: err.message } });
      });
    } catch (err) {
      resolve({ statusCode: 500, body: { success: false, message: err.message } });
    }
  });
}

const getNotificationsBundle = async (req, res) => {
  try {
    const tenant_id = req.tenant_id || req.user?.tenant_id;
    const modules = req.is_super_admin || !tenant_id
      ? []
      : await getEffectiveModulesForTenantId(tenant_id);
    const hasCrm = modules.includes('crm');
    const hasWorkshop = modules.includes('workshop');

    // Stock/cuentas por pagar/anticipos: igual que hoy, sin gate de módulo
    // acá (las campanas ya se auto-ocultan si vienen 0 resultados).
    const tasks = {
      stock: invoke(stockAlertsController.getStockAlerts, req, { status: 'active', limit: 500 }),
      payable: invoke(payableAlertsController.getPayableAlerts, req, {
        status: 'active', limit: 500, sort_by: 'days_to_due', sort_order: 'ASC',
      }),
      advance: invoke(advanceAlertsController.getAdvanceAlerts, req, {
        status: 'active', limit: 500, sort_by: 'days_since_received', sort_order: 'DESC',
      }),
    };
    if (hasCrm) {
      tasks.crm = invoke(crmDashboardController.getNotificationsSummary, req);
    }
    if (hasWorkshop) {
      tasks.quotes = invoke(workOrdersController.getPendingQuoteNotifications, req);
      tasks.appointments = invoke(appointmentsController.getPending, req);
    }

    const keys = Object.keys(tasks);
    const results = await Promise.all(Object.values(tasks));

    const data = {};
    keys.forEach((key, i) => {
      const r = results[i];
      if (r.statusCode === 200 && r.body?.success) {
        data[key] = r.body.data;
      } else {
        data[key] = null;
        logger.warn(`[notifications-bundle] sección "${key}" falló (tenant ${tenant_id}): ${r.body?.message || 'sin detalle'}`);
      }
    });

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error obteniendo bundle de notificaciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener notificaciones' });
  }
};

module.exports = { getNotificationsBundle };
