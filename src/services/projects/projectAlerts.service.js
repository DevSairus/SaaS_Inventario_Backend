// backend/src/services/projects/projectAlerts.service.js
//
// Alertas de sobrecosto (Fase 2 del módulo Proyectos): compara lo ejecutado
// contra el presupuesto, por categoría y en total, con los umbrales del
// proyecto (alert_warning_pct, alert_critical_pct; por defecto 80 y 100 %).
//   - Se evalúa al abrir el proyecto y cada día con el job 'project-budget-alerts'.
//   - Una alerta abierta por proyecto, categoría y nivel; al abrirse se avisa
//     una vez por correo al responsable del proyecto y a administración.
//   - Si lo ejecutado vuelve a quedar por debajo del umbral, se resuelve sola.

const { Op } = require('sequelize');
const logger = require('../../config/logger');
const { Project, ProjectBudgetAlert, User, Tenant } = require('../../models');
const { getProjectPnl, BUDGET_CATEGORY_LABELS } = require('./projectPnl.service');

const num = (v) => Number(v) || 0;
const money = (n) => `$${Math.round(num(n)).toLocaleString('es-CO')}`;
const LABELS = { total: 'Total del proyecto', ...BUDGET_CATEGORY_LABELS };
// Proyectos que todavía gastan: los demás no se vigilan.
const WATCHED_STATUSES = ['approved', 'in_progress', 'on_hold', 'completed'];

/** Niveles que corresponden a cada categoría según el P&G (función pura). */
function evaluateLevels(pnl, { warningPct = 80, criticalPct = 100 } = {}) {
  const lines = [
    ...pnl.budget.lines.map((l) => ({ category: l.category, budget: l.budget, executed: l.executed })),
    { category: 'total', budget: pnl.budget.total, executed: pnl.budget.executed },
  ];
  const out = [];
  for (const l of lines) {
    if (!(l.budget > 0)) continue;
    const pct = Math.round((l.executed / l.budget) * 10000) / 100;
    const levels = [];
    if (pct >= warningPct) levels.push('warning');
    if (pct >= criticalPct) levels.push('critical');
    out.push({ ...l, executed_pct: pct, levels });
  }
  return out;
}

async function notify(tenantId, project, created) {
  try {
    const recipients = new Map();
    const users = await User.findAll({
      where: {
        tenant_id: tenantId,
        is_active: true,
        [Op.or]: [{ role: { [Op.in]: ['admin', 'manager'] } }, ...(project.manager_id ? [{ id: project.manager_id }] : [])],
      },
      attributes: ['id', 'first_name', 'email'],
    });
    for (const u of users) if (u.email) recipients.set(u.email, u);
    if (!recipients.size) return;
    const tenant = await Tenant.findByPk(tenantId, { attributes: ['company_name', 'business_name'] });
    const base = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');
    const critical = created.some((a) => a.level === 'critical');
    const rows = created.map((a) => `<li><strong>${LABELS[a.category] || a.category}</strong>: ejecutado ${money(a.executed)} de ${money(a.budget)} (${num(a.executed_pct)}%)${a.level === 'critical' ? ' — <strong>sobrecosto</strong>' : ''}</li>`).join('');
    await require('../emailService').sendEmail({
      to: [...recipients.keys()],
      subject: `${critical ? 'Sobrecosto' : 'Alerta de presupuesto'} en ${project.code} · ${project.name}`,
      html: `<p>El proyecto <strong>${project.code} · ${project.name}</strong>${tenant ? ` (${tenant.business_name || tenant.company_name})` : ''} superó sus umbrales de presupuesto:</p>
        <ul>${rows}</ul>
        ${base ? `<p><a href="${base}/projects/${project.id}?tab=pnl">Ver el estado de resultados</a></p>` : ''}`,
    });
    await ProjectBudgetAlert.update({ notified_at: new Date() }, { where: { id: created.map((a) => a.id) } });
  } catch (err) {
    logger.warn(`[project-alerts] No se pudo avisar el sobrecosto de ${project.code}: ${err.message}`);
  }
}

/**
 * Evalúa un proyecto: abre las alertas nuevas (y avisa), actualiza las
 * vigentes y resuelve las que ya no aplican. Devuelve las abiertas.
 */
async function evaluateProject(tenantId, project, pnl = null) {
  if (!WATCHED_STATUSES.includes(project.status)) return [];
  const result = pnl || await getProjectPnl(tenantId, project);
  const levels = evaluateLevels(result, { warningPct: num(project.alert_warning_pct) || 80, criticalPct: num(project.alert_critical_pct) || 100 });
  const open = await ProjectBudgetAlert.findAll({ where: { tenant_id: tenantId, project_id: project.id, status: 'open' } });
  const key = (c, l) => `${c}:${l}`;
  const openBy = new Map(open.map((a) => [key(a.category, a.level), a]));
  const wanted = new Set();
  const created = [];
  for (const l of levels) {
    for (const level of l.levels) {
      const k = key(l.category, level);
      wanted.add(k);
      const values = { budget: l.budget, executed: l.executed, executed_pct: l.executed_pct };
      const existing = openBy.get(k);
      if (existing) {
        await existing.update(values);
      } else {
        try {
          created.push(await ProjectBudgetAlert.create({ tenant_id: tenantId, project_id: project.id, category: l.category, level, ...values }));
        } catch (err) {
          // Dos evaluaciones simultáneas: la otra ya la abrió.
          if (err.name !== 'SequelizeUniqueConstraintError') throw err;
        }
      }
    }
  }
  const stale = open.filter((a) => !wanted.has(key(a.category, a.level)));
  if (stale.length) await ProjectBudgetAlert.update({ status: 'resolved', resolved_at: new Date() }, { where: { id: stale.map((a) => a.id) } });
  if (created.length) notify(tenantId, project, created);
  return ProjectBudgetAlert.findAll({ where: { tenant_id: tenantId, project_id: project.id, status: 'open' }, order: [['level', 'ASC'], ['category', 'ASC']] });
}

/** Job diario: todos los proyectos vigilados de todos los tenants con el módulo. */
async function checkAllProjects() {
  const { runWithTenantSchema } = require('../../config/tenantContext');
  const { getEffectiveModulesForTenantId } = require('../moduleAccess');
  const tenants = await Tenant.findAll({ where: { is_active: true }, attributes: ['id', 'schema_name'] });
  let evaluated = 0;
  for (const t of tenants) {
    try {
      if (!(await getEffectiveModulesForTenantId(t.id)).includes('projects')) continue;
      await runWithTenantSchema(t.schema_name || null, async () => {
        const projects = await Project.findAll({ where: { tenant_id: t.id, status: WATCHED_STATUSES } });
        for (const p of projects) {
          await evaluateProject(t.id, p);
          evaluated += 1;
        }
      });
    } catch (err) {
      logger.warn(`[project-alerts] Tenant ${t.id}: ${err.message}`);
    }
  }
  return [{ evaluated }];
}

module.exports = { evaluateLevels, evaluateProject, checkAllProjects, LABELS };
