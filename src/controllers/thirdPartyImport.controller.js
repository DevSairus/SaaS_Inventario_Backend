// backend/src/controllers/thirdPartyImport.controller.js
//
// Plantilla e importación de clientes y proveedores desde Excel — ver
// services/importers/thirdPartyImport.service.js.
//   GET  /api/customers/import/template             · /api/inventory/suppliers/import/template
//   POST /api/customers/import?dry_run=true|false   · /api/inventory/suppliers/import?dry_run=…
//        (archivo en "archivo"; update_existing=true para actualizar los que ya existen)
const { Tenant } = require('../models');
const { buildTemplate, importThirdParties } = require('../services/importers/thirdPartyImport.service');

const FILE_NAMES = { customers: 'Plantilla_Clientes_Pitbox.xlsx', suppliers: 'Plantilla_Proveedores_Pitbox.xlsx' };

const template = (entity) => async (req, res) => {
  try {
    const buffer = await buildTemplate(entity);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${FILE_NAMES[entity]}"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error(`Error en plantilla de ${entity}:`, error);
    res.status(500).json({ success: false, message: 'No se pudo generar la plantilla' });
  }
};

const importFile = (entity) => async (req, res) => {
  try {
    const tenantId = req.tenant_id || req.user?.tenant_id;
    if (!tenantId) return res.status(400).json({ success: false, message: 'Usuario sin empresa asignada' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Adjunta el archivo Excel' });
    const flag = (name) => req.query[name] === 'true' || req.body?.[name] === 'true';
    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'dian_config'] });
    const cfg = tenant?.dian_config || {};
    const data = await importThirdParties({
      entity,
      tenantId,
      buffer: req.file.buffer,
      dryRun: flag('dry_run'),
      updateExisting: flag('update_existing'),
      defaultCity: cfg.city_code ? { city_code: cfg.city_code, city: cfg.city || null, state: cfg.dept || null } : null,
    });
    res.json({ success: true, data });
  } catch (error) {
    if (error.statusCode) {
      console.warn(`Importación de ${entity} rechazada (${error.statusCode}) archivo="${req.file?.originalname}": ${error.message}`);
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error(`Error importando ${entity}:`, error);
    res.status(500).json({ success: false, message: `Error al importar: ${error.message}` });
  }
};

module.exports = { template, importFile };
