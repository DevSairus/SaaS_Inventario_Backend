// backend/src/routes/projects/projects.routes.js
//
// Módulo Proyectos. Base: /api/projects (requireModule('projects') en server.js)
//   Leer: cualquier usuario del tenant (los montos solo con 'projects.pnl', ver
//     el controller).
//   Crear/editar proyecto, presupuesto y lista de materiales: gerencia.
//   Reservar, pedir faltantes y despachar a la obra: gerencia y bodega.
//   Estado de resultados: gerencia y contabilidad.

const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/projects/projects.controller');
const { requirePermission } = require('../../middleware/requirePermission');

// Permisos por empresa (config/permissions.catalog.js).
const manage = requirePermission('projects.manage');
const stock = requirePermission('projects.stock');
const pnl = requirePermission('projects.pnl');

router.get('/', ctrl.list);
router.get('/options', ctrl.options);
// Mano de obra: empleados para registrar horas y reparto de nómina por periodo
router.get('/labor/employees', requirePermission('projects.time.write'), ctrl.employeeOptions);
router.get('/labor/periods', manage, ctrl.laborPeriods);
router.post('/labor/periods/:periodId/allocate', manage, ctrl.allocatePeriod);
// Horarios de obra (Fase 4, req. 1.1): turnos y distribución de horas por empleado y proyecto.
const hoursCtrl = require('../../controllers/projects/projectWorkHours.controller');
router.get('/labor/shifts', hoursCtrl.listShifts);
router.post('/labor/shifts', manage, hoursCtrl.createShift);
router.put('/labor/shifts/:shiftId', manage, hoursCtrl.updateShift);
router.get('/labor/distribution', hoursCtrl.distribution);
// Mantenimientos recurrentes (Fase 4, req. 1.3): agenda, planes y visitas.
const mntCtrl = require('../../controllers/projects/maintenance.controller');
const mntManage = requirePermission('projects.maintenance.manage');
const mntVisit = requirePermission('projects.maintenance.visit');
router.get('/maintenance/agenda', mntCtrl.agenda);
router.get('/maintenance/installations', mntCtrl.listInstallations);
router.post('/maintenance/installations', mntManage, mntCtrl.createInstallation);
router.post('/maintenance/installations/import', mntManage, mntCtrl.importInstallations);
router.get('/maintenance/installations/:installationId', mntCtrl.installationDetail);
router.put('/maintenance/installations/:installationId', mntManage, mntCtrl.updateInstallation);
router.post('/maintenance/installations/:installationId/equipment', mntManage, mntCtrl.createEquipment);
router.put('/maintenance/installations/:installationId/equipment/:equipmentId', mntManage, mntCtrl.updateEquipment);
router.post('/maintenance/installations/:installationId/plans', mntManage, mntCtrl.createPlan);
router.put('/maintenance/plans/:planId', mntManage, mntCtrl.updatePlan);
router.put('/maintenance/visits/:visitId', mntManage, mntCtrl.rescheduleVisit);
router.post('/maintenance/visits/:visitId/complete', mntVisit, mntCtrl.completeVisit);
router.post('/maintenance/visits/:visitId/cancel', mntManage, mntCtrl.cancelVisit);
router.get('/maintenance/visits/:visitId/pdf', mntCtrl.visitPdf);
router.post('/', manage, ctrl.create);

router.get('/:id', ctrl.getById);
router.put('/:id', manage, ctrl.update);
router.patch('/:id/status', manage, ctrl.changeStatus);
router.post('/:id/warehouse', manage, ctrl.createWarehouse);
router.get('/:id/pnl', pnl, ctrl.getPnl);

// Cortes de obra y facturación parcial ('projects.billing'; ver la facturación: 'projects.pnl')
const cuts = require('../../controllers/projects/projectCuts.controller');
const billing = requirePermission('projects.billing');
router.get('/:id/billing', pnl, cuts.billing);
router.post('/:id/cuts/preview', billing, cuts.preview);
router.post('/:id/cuts', billing, cuts.create);
router.put('/:id/cuts/:cutId', billing, cuts.update);
router.delete('/:id/cuts/:cutId', billing, cuts.remove);
router.post('/:id/cuts/:cutId/approve', billing, cuts.approve);
router.get('/:id/cuts/:cutId/invoice-payload', billing, cuts.invoicePayload);
router.post('/:id/cuts/:cutId/link-draft', billing, cuts.linkDraft);
router.post('/:id/cuts/:cutId/finalize', billing, cuts.finalize);
router.get('/:id/cuts/:cutId/acta', pnl, cuts.acta);
router.post('/:id/retention/release', billing, cuts.releaseRetention);
router.post('/:id/contract/close', billing, cuts.closeContract);
router.get('/:id/documents', ctrl.getDocuments);

// Etapas de obra y actas de despacho (Fase 4, req. 1.2). Etapas: gerencia; firmar/consultar actas: bodega.
const stagesCtrl = require('../../controllers/projects/projectStages.controller');
router.get('/:id/stages', stagesCtrl.listStages);
router.post('/:id/stages', manage, stagesCtrl.createStage);
router.put('/:id/stages/:stageId', manage, stagesCtrl.updateStage);
router.delete('/:id/stages/:stageId', manage, stagesCtrl.deleteStage);
router.get('/:id/dispatches', stagesCtrl.listDispatches);
router.get('/:id/dispatches/:dispatchId/acta', stagesCtrl.acta);
router.post('/:id/dispatches/:dispatchId/sign', stock, stagesCtrl.signDispatch);

router.post('/:id/budget', manage, ctrl.addBudgetLine);
router.put('/:id/budget/:lineId', manage, ctrl.updateBudgetLine);
router.delete('/:id/budget/:lineId', manage, ctrl.deleteBudgetLine);

router.get('/:id/bom', ctrl.getBom);
router.post('/:id/bom/preview', manage, ctrl.previewBom);
router.post('/:id/bom', manage, ctrl.saveBom);
router.patch('/:id/bom/items/:itemId', manage, ctrl.updateBomItem);
router.delete('/:id/bom/items/:itemId', manage, ctrl.deleteBomItem);
router.post('/:id/bom/reserve', stock, ctrl.reserveBom);
router.post('/:id/bom/release', stock, ctrl.releaseBom);
router.post('/:id/bom/order-lists', stock, ctrl.orderShortages);
router.post('/:id/bom/dispatch', stock, ctrl.dispatchBom);

router.get('/:id/site-stock', ctrl.getSiteStock);
router.post('/:id/return', stock, ctrl.returnSurplus);

router.get('/:id/time-entries', ctrl.getTimeEntries);
router.post('/:id/time-entries', requirePermission('projects.time.write'), ctrl.addTimeEntry);
router.post('/:id/time-sheet', requirePermission('projects.time.write'), hoursCtrl.saveSheet);
router.get('/:id/hours-distribution', hoursCtrl.projectDistribution);
router.get('/:id/maintenance', mntCtrl.projectInstallation);
router.post('/:id/maintenance', mntManage, mntCtrl.activateProject);
router.delete('/:id/time-entries/:entryId', requirePermission('projects.time.write'), ctrl.deleteTimeEntry);

module.exports = router;
