// backend/src/controllers/crm/dashboard.controller.js
//
// CRM Fase 3 — "no solo para vender". Métricas que hoy nadie calculaba en
// Pitbox: conversión, tiempo de cierre, motivos de pérdida, clientes en
// riesgo y disparadores de recompra. Todo scoped por §5-bis (capa A):
// un seller ve sus propios números, manager/admin ven el consolidado.
const logger = require('../../config/logger');
const { Op, fn, col } = require('sequelize');
const { Opportunity, Customer, FollowUpTask, User, CustomerInteraction } = require('../../models');
const { applyOwnershipScope } = require('../../utils/crmScope');
const { loadStageMap, keysByType, resolveEntryStageKey } = require('../../utils/crmPipelineStages');

const customerLabel = c => {
  if (!c) return 'Cliente eliminado';
  return c.business_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Cliente';
};
const advisorLabel = u => u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() : null;

const getDashboard = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 86400000);

    const oppWhere = await applyOwnershipScope(req, { tenant_id }, 'owner_user_id');
    const taskWhere = await applyOwnershipScope(req, { tenant_id }, 'assigned_to_user_id');

    // Fase B.4 — 'ganado'/'perdido' ya no son strings fijos: se resuelven
    // contra las CrmPipelineStage configuradas por el tenant.
    const stageMap = await loadStageMap(tenant_id);
    const wonKeys = keysByType(stageMap, 'won');
    const lostKeys = keysByType(stageMap, 'lost');
    const openKeys = keysByType(stageMap, 'open');

    // Período anterior de igual duración, para el delta que se ve en las
    // StatsCard del dashboard (Fase A — "vs. período anterior").
    const prevSince = new Date(since.getTime() - days * 86400000);

    const [
      createdRows,
      wonInPeriod,
      lostRows,
      lostReasonsRaw,
      atRiskCustomers,
      upcomingRepurchase,
      followUpCounts,
      createdPrev,
      wonPrev,
      lostPrev,
      openOpportunities,
    ] = await Promise.all([
      Opportunity.findAll({
        where: { ...oppWhere, created_at: { [Op.gte]: since } },
        attributes: ['id', 'created_at', 'source', 'stage'],
      }),
      Opportunity.findAll({
        where: { ...oppWhere, stage: { [Op.in]: wonKeys }, stage_changed_at: { [Op.gte]: since } },
        attributes: ['id', 'created_at', 'stage_changed_at'],
      }),
      Opportunity.findAll({
        where: { ...oppWhere, stage: { [Op.in]: lostKeys }, stage_changed_at: { [Op.gte]: since } },
        attributes: ['id', 'stage_changed_at'],
      }),
      Opportunity.findAll({
        where: { ...oppWhere, stage: { [Op.in]: lostKeys }, stage_changed_at: { [Op.gte]: since } },
        attributes: ['lost_reason', [fn('COUNT', col('id')), 'count']],
        group: ['lost_reason'],
        raw: true,
      }),
      Customer.findAll({
        where: {
          tenant_id,
          lifecycle_stage: 'en_riesgo',
          ...(['admin', 'manager', 'super_admin'].includes(req.user.role) ? {} : { owner_user_id: req.user.id }),
        },
        attributes: ['id', 'first_name', 'last_name', 'business_name', 'last_interaction_at', 'owner_user_id'],
        order: [['last_interaction_at', 'ASC']],
        limit: 20,
      }),
      Customer.findAll({
        where: {
          tenant_id,
          next_vehicle_service_due: { [Op.between]: [new Date(), new Date(Date.now() + 14 * 86400000)] },
          ...(['admin', 'manager', 'super_admin'].includes(req.user.role) ? {} : { owner_user_id: req.user.id }),
        },
        attributes: ['id', 'first_name', 'last_name', 'business_name', 'next_vehicle_service_due', 'owner_user_id'],
        order: [['next_vehicle_service_due', 'ASC']],
        limit: 20,
      }),
      FollowUpTask.findAll({
        where: taskWhere,
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),
      Opportunity.count({ where: { ...oppWhere, created_at: { [Op.gte]: prevSince, [Op.lt]: since } } }),
      Opportunity.count({ where: { ...oppWhere, stage: { [Op.in]: wonKeys }, stage_changed_at: { [Op.gte]: prevSince, [Op.lt]: since } } }),
      Opportunity.count({ where: { ...oppWhere, stage: { [Op.in]: lostKeys }, stage_changed_at: { [Op.gte]: prevSince, [Op.lt]: since } } }),
      // Fase B.1 — pipeline abierto completo (sin filtro de fecha: el forecast
      // mira hacia adelante, no hacia el período consultado).
      Opportunity.findAll({
        where: { ...oppWhere, stage: { [Op.in]: openKeys } },
        attributes: ['id', 'stage', 'expected_value', 'probability', 'expected_close_date'],
      }),
    ]);

    const createdInPeriod = createdRows.length;
    const lostInPeriod = lostRows.length;

    const avgTimeToCloseDays = wonInPeriod.length
      ? wonInPeriod.reduce((sum, o) => sum + (new Date(o.stage_changed_at) - new Date(o.created_at)) / 86400000, 0) / wonInPeriod.length
      : null;

    const closedInPeriod = wonInPeriod.length + lostInPeriod;
    const conversionRate = closedInPeriod ? wonInPeriod.length / closedInPeriod : null;

    const closedPrev = wonPrev + lostPrev;
    const conversionRatePrev = closedPrev ? wonPrev / closedPrev : null;

    // Serie de tendencia para el mini-gráfico del dashboard: semanal si el
    // período es de 14+ días, diaria si es de una semana o menos.
    const bucketSizeDays = days > 14 ? 7 : 1;
    const trendBuckets = [];
    for (let cursor = new Date(since); cursor < new Date(); cursor.setDate(cursor.getDate() + bucketSizeDays)) {
      const bucketStart = new Date(cursor);
      const bucketEnd = new Date(Math.min(cursor.getTime() + bucketSizeDays * 86400000, Date.now()));
      trendBuckets.push({ start: bucketStart, end: bucketEnd, created: 0, won: 0, lost: 0 });
    }
    const placeInBucket = (rows, dateField, key) => {
      rows.forEach(row => {
        const d = new Date(row[dateField]);
        const bucket = trendBuckets.find(b => d >= b.start && d < b.end) || trendBuckets[trendBuckets.length - 1];
        if (bucket) bucket[key] += 1;
      });
    };
    placeInBucket(createdRows, 'created_at', 'created');
    placeInBucket(wonInPeriod, 'stage_changed_at', 'won');
    placeInBucket(lostRows, 'stage_changed_at', 'lost');

    // Fase B.1 — forecast de cierre. `expected_value` y `probability` ya
    // existían en el modelo Opportunity y no se estaban usando en ningún
    // lado del CRM; acá se convierten en la proyección ponderada del
    // pipeline abierto, y en el "cierre proyectado este mes" cruzando con
    // expected_close_date.
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    let totalOpenValue = 0;
    let totalOpenWeighted = 0;
    let forecastThisMonth = 0;

    openOpportunities.forEach(o => {
      const value = parseFloat(o.expected_value || 0);
      if (!value) return;
      const probability = (o.probability != null ? o.probability : stageMap[o.stage]?.default_probability ?? 10) / 100;
      const weighted = value * probability;

      totalOpenValue += value;
      totalOpenWeighted += weighted;

      if (o.expected_close_date) {
        const closeDate = new Date(o.expected_close_date);
        if (closeDate >= monthStart && closeDate < monthEnd) {
          forecastThisMonth += weighted;
        }
      }
    });

    // C.5 — "retorno de campañas": de los leads que entraron en el período
    // por cada canal (source), cuántos ya se ganaron. No es "won en el
    // período" (eso ya lo cubre `conversion`) sino "de lo que entró en el
    // período, qué le pasó hasta hoy" — la pregunta real detrás de "¿vale
    // la pena seguir pautando en Meta?". `meta_ads` va aparte y primero en
    // la respuesta porque es el único canal pago hoy; el resto queda en
    // `other_sources` para no tener que tocar esto si mañana se suma otro.
    const bySource = {};
    createdRows.forEach(o => {
      const s = bySource[o.source] || (bySource[o.source] = { source: o.source, created: 0, won: 0, lost: 0, open: 0 });
      s.created += 1;
      if (wonKeys.includes(o.stage)) s.won += 1;
      else if (lostKeys.includes(o.stage)) s.lost += 1;
      else s.open += 1;
    });
    const sourceBreakdown = Object.values(bySource)
      .map(s => ({ ...s, conversion_rate: s.created ? s.won / s.created : null }))
      .sort((a, b) => b.created - a.created);
    const metaAds = sourceBreakdown.find(s => s.source === 'meta_ads') || null;
    const otherSources = sourceBreakdown.filter(s => s.source !== 'meta_ads');

    res.json({
      success: true,
      data: {
        period_days: days,
        conversion: {
          created: createdInPeriod,
          won: wonInPeriod.length,
          lost: lostInPeriod,
          conversion_rate: conversionRate, // 0-1, null si no hubo cierres en el período
        },
        previous: {
          created: createdPrev,
          won: wonPrev,
          lost: lostPrev,
          conversion_rate: conversionRatePrev,
        },
        trend: trendBuckets.map(b => ({
          label: b.start.toISOString().slice(5, 10), // "MM-DD"
          created: b.created,
          won: b.won,
          lost: b.lost,
        })),
        avg_time_to_close_days: avgTimeToCloseDays,
        lost_reasons: lostReasonsRaw.map(r => ({ reason: r.lost_reason, count: parseInt(r.count, 10) })),
        at_risk_customers: atRiskCustomers,
        upcoming_repurchase: upcomingRepurchase,
        follow_up_load: followUpCounts.reduce((acc, r) => ({ ...acc, [r.status]: parseInt(r.count, 10) }), {}),
        forecast: {
          open_count: openOpportunities.length,
          total_open_value: totalOpenValue,       // suma bruta del pipeline abierto, sin ponderar
          total_open_weighted: totalOpenWeighted, // ponderado por probabilidad (manual o default por etapa)
          this_month: forecastThisMonth,          // ponderado, solo lo que tiene cierre esperado este mes
        },
        campaign_return: {
          meta_ads: metaAds,           // null si no entró ningún lead de Meta en el período
          other_sources: otherSources,
        },
      },
    });
  } catch (error) {
    logger.error('Error generando dashboard CRM:', error);
    res.status(500).json({ success: false, message: 'Error al generar el dashboard' });
  }
};

// ── B.5 — Feed de actividad de equipo ───────────────────────────────────────
// "Qué movió el equipo hoy": últimos 20 eventos combinando las cuatro cosas
// que el CRM ya registra con actor y fecha (no se crea tabla de auditoría
// nueva, se reutilizan los eventos existentes, tal como pide la propuesta):
//   - oportunidad creada        (Opportunity.created_at,      dueño = owner)
//   - oportunidad movida        (Opportunity.stage_changed_at, dueño = owner)
//   - tarea de seguimiento hecha (FollowUpTask.completed_at,   asesor = assigned_to)
//   - interacción registrada    (CustomerInteraction.created_at, user_id)
//
// Nota de honestidad (misma que la propuesta pide para el tracking de
// WhatsApp): Opportunity no guarda quién ejecutó el cambio de etapa, solo
// quién es el dueño actual — así que el feed atribuye el movimiento al
// asesor dueño de la oportunidad, no necesariamente a quien arrastró la
// tarjeta (ej. un manager moviendo la oportunidad de un vendedor). Es una
// aproximación razonable, no una bitácora de auditoría.
const getActivityFeed = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const since = new Date(Date.now() - 14 * 86400000); // ventana de 14 días

    const stageMap = await loadStageMap(tenant_id);
    const entryStage = resolveEntryStageKey(stageMap);

    const oppWhere = await applyOwnershipScope(req, { tenant_id }, 'owner_user_id');
    const taskWhere = await applyOwnershipScope(req, { tenant_id }, 'assigned_to_user_id');
    const interactionWhere = await applyOwnershipScope(req, { tenant_id }, 'user_id');

    const [createdOpps, movedOpps, completedTasks, interactions] = await Promise.all([
      Opportunity.findAll({
        where: { ...oppWhere, created_at: { [Op.gte]: since } },
        include: [
          { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] },
          { model: User, as: 'owner', attributes: ['id', 'first_name', 'last_name'] },
        ],
        order: [['created_at', 'DESC']],
        limit,
      }),
      Opportunity.findAll({
        where: { ...oppWhere, stage: { [Op.ne]: entryStage }, stage_changed_at: { [Op.gte]: since } },
        include: [
          { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] },
          { model: User, as: 'owner', attributes: ['id', 'first_name', 'last_name'] },
        ],
        order: [['stage_changed_at', 'DESC']],
        limit,
      }),
      FollowUpTask.findAll({
        where: { ...taskWhere, status: 'hecha', completed_at: { [Op.gte]: since } },
        include: [
          { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] },
          { model: User, as: 'assigned_to', attributes: ['id', 'first_name', 'last_name'] },
        ],
        order: [['completed_at', 'DESC']],
        limit,
      }),
      CustomerInteraction.findAll({
        where: { ...interactionWhere, created_at: { [Op.gte]: since } },
        include: [
          { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] },
          { model: User, as: 'user', attributes: ['id', 'first_name', 'last_name'] },
        ],
        order: [['created_at', 'DESC']],
        limit,
      }),
    ]);

    // Evita el evento redundante "se movió" para una oportunidad que ya
    // aparece como "se creó" dentro de la misma ventana de 14 días.
    const createdIds = new Set(createdOpps.map(o => o.id));

    const items = [
      ...createdOpps.map(o => ({
        type: 'opportunity_created',
        at: o.created_at,
        customer: customerLabel(o.customer),
        customer_id: o.customer_id,
        actor: advisorLabel(o.owner),
        opportunity_id: o.id,
      })),
      ...movedOpps
        .filter(o => !createdIds.has(o.id))
        .map(o => ({
          type: 'opportunity_stage_changed',
          at: o.stage_changed_at,
          customer: customerLabel(o.customer),
          customer_id: o.customer_id,
          actor: advisorLabel(o.owner),
          opportunity_id: o.id,
          stage_label: stageMap[o.stage]?.label || o.stage,
          stage_type: stageMap[o.stage]?.stage_type || null,
        })),
      ...completedTasks.map(t => ({
        type: 'followup_completed',
        at: t.completed_at,
        customer: customerLabel(t.customer),
        customer_id: t.customer_id,
        actor: advisorLabel(t.assigned_to),
        title: t.title,
      })),
      ...interactions.map(i => ({
        type: 'interaction_logged',
        at: i.created_at,
        customer: customerLabel(i.customer),
        customer_id: i.customer_id,
        actor: advisorLabel(i.user) || 'Sistema',
        interaction_type: i.type,
      })),
    ]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, limit);

    res.json({ success: true, data: items });
  } catch (error) {
    logger.error('Error generando feed de actividad CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la actividad del equipo' });
  }
};

// ── B.6 — Notificaciones dentro de la app ───────────────────────────────────
// Endpoint de conteo simple para el badge de la campana (ver
// components/common/CrmNotifications.jsx): seguimientos vencidos + leads
// nuevos sin contactar, con foco aparte en Meta Ads por ser el único canal
// pago hoy. Se apoya en los mismos datos que ya calcula el Kanban
// (crmLeadScore.js) y el job nocturno — no se crea tabla de alertas nueva
// como StockAlert/PayableAlert; es un conteo en vivo, no un histórico
// persistido con estado resuelto/ignorado.
const getNotificationsSummary = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;

    const stageMap = await loadStageMap(tenant_id);
    const entryStage = resolveEntryStageKey(stageMap);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);

    const taskWhere = await applyOwnershipScope(
      req,
      { tenant_id, status: 'pendiente', due_at: { [Op.lt]: new Date() } },
      'assigned_to_user_id'
    );
    const oppWhere = await applyOwnershipScope(req, { tenant_id }, 'owner_user_id');

    const [overdueFollowups, unattendedOpps] = await Promise.all([
      FollowUpTask.count({ where: taskWhere }),
      Opportunity.findAll({
        where: { ...oppWhere, stage: entryStage, stage_changed_at: { [Op.lte]: twoHoursAgo } },
        attributes: ['id', 'source'],
      }),
    ]);

    const unattendedMetaLeads = unattendedOpps.filter(o => o.source === 'meta_ads').length;

    res.json({
      success: true,
      data: {
        overdue_followups: overdueFollowups,
        unattended_leads: unattendedOpps.length,
        unattended_meta_leads: unattendedMetaLeads,
        total: overdueFollowups + unattendedOpps.length,
      },
    });
  } catch (error) {
    logger.error('Error obteniendo notificaciones CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener notificaciones' });
  }
};

module.exports = { getDashboard, getActivityFeed, getNotificationsSummary };