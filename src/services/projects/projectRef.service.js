// backend/src/services/projects/projectRef.service.js
//
// project_id en documentos existentes (compras, gastos, ventas): se valida
// aquí para que los controllers solo lo propaguen. Con project_id vacío el
// documento funciona igual que antes del módulo Proyectos.

const { Project } = require('../../models');
const { INACTIVE_STATUSES } = require('./projectStock.service');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/**
 * Normaliza y valida el proyecto de un documento.
 *  - undefined → undefined (el campo no vino: no tocarlo en un update)
 *  - '' / null → null (documento general)
 *  - id → el proyecto, que debe ser del tenant y no estar cerrado/cancelado
 *    (salvo que el documento ya lo tuviera: editar un documento viejo de un
 *    proyecto cerrado no obliga a cambiarle el proyecto).
 * @returns {Promise<undefined|null|Project>}
 */
async function resolveDocumentProject(tenantId, projectId, { currentProjectId = null, transaction } = {}) {
  if (projectId === undefined) return undefined;
  if (projectId === null || projectId === '') return null;
  const project = await Project.findOne({
    where: { id: projectId, tenant_id: tenantId },
    attributes: ['id', 'code', 'name', 'status', 'warehouse_id'],
    transaction,
  });
  if (!project) throw httpError(400, 'Proyecto no encontrado');
  if (INACTIVE_STATUSES.includes(project.status) && project.id !== currentProjectId) {
    throw httpError(400, `El proyecto ${project.code} está ${project.status === 'closed' ? 'cerrado' : 'cancelado'}: no admite documentos nuevos`);
  }
  return project;
}

module.exports = { resolveDocumentProject };
