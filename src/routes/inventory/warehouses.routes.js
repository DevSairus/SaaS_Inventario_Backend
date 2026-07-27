// backend/src/routes/inventory/warehouses.routes.js
const express = require('express');
const router = express.Router();

// Obtener todas las bodegas del tenant (opcionalmente filtradas por sede)
router.get('/', async (req, res) => {
  try {
    const { Warehouse } = require('../../models/inventory');
    const { Branch } = require('../../models');
    const tenantId = req.tenant_id;
    const { branch_id } = req.query;

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant ID no encontrado'
      });
    }

    const where = {
      tenant_id: tenantId,
      is_active: true
    };
    if (branch_id) where.branch_id = branch_id;

    const warehouses = await Warehouse.findAll({
      where,
      include: [{ model: Branch, as: 'branch', attributes: ['id', 'name'] }],
      order: [['is_main', 'DESC'], ['name', 'ASC']]
    });

    res.json({
      success: true,
      data: warehouses
    });
  } catch (error) {
    console.error('Error al obtener bodegas:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener bodegas',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
});

// Obtener bodega por ID
router.get('/:id', async (req, res) => {
  try {
    const { Warehouse } = require('../../models/inventory');
    const { id } = req.params;
    const tenantId = req.tenant_id;

    const warehouse = await Warehouse.findOne({
      where: { 
        id,
        tenant_id: tenantId 
      }
    });

    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Bodega no encontrada'
      });
    }

    res.json({
      success: true,
      data: warehouse
    });
  } catch (error) {
    console.error('Error al obtener bodega:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener bodega',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
});

// Crear nueva bodega
router.post('/', async (req, res) => {
  try {
    const { Warehouse } = require('../../models/inventory');
    const { sequelize } = require('../../config/database');
    const tenantId = req.tenant_id;
    const { name, code, address, city, phone, manager_id, is_main, branch_id, is_default } = req.body;

    const transaction = await sequelize.transaction();
    try {
      // Si se marca como principal (tenant-wide), desmarcar las demás
      if (is_main) {
        await Warehouse.update(
          { is_main: false },
          { where: { tenant_id: tenantId }, transaction }
        );
      }

      // Si se marca como default de su sede, desmarcar cualquier otra
      // bodega default de esa misma sede (solo puede haber una)
      if (branch_id && is_default) {
        await Warehouse.update(
          { is_default: false },
          { where: { tenant_id: tenantId, branch_id }, transaction }
        );
      }

      const warehouse = await Warehouse.create({
        tenant_id: tenantId,
        branch_id: branch_id || null,
        name,
        code,
        address,
        city,
        phone,
        manager_id: manager_id || null,
        is_main: is_main || false,
        is_default: branch_id ? Boolean(is_default) : false,
        is_active: true
      }, { transaction });

      await transaction.commit();

      res.status(201).json({
        success: true,
        message: 'Bodega creada exitosamente',
        data: warehouse
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (error) {
    console.error('Error al crear bodega:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear bodega',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
});

// Actualizar bodega
router.put('/:id', async (req, res) => {
  try {
    const { Warehouse } = require('../../models/inventory');
    const { sequelize } = require('../../config/database');
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const { name, code, address, city, phone, manager_id, is_main, is_active, branch_id, is_default } = req.body;

    const warehouse = await Warehouse.findOne({
      where: { 
        id,
        tenant_id: tenantId 
      }
    });

    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Bodega no encontrada'
      });
    }

    const effectiveBranchId = branch_id !== undefined ? branch_id : warehouse.branch_id;
    const effectiveIsDefault = is_default !== undefined ? Boolean(is_default) : warehouse.is_default;

    const transaction = await sequelize.transaction();
    try {
      // Si se marca como principal (tenant-wide), desmarcar las demás
      if (is_main && !warehouse.is_main) {
        await Warehouse.update(
          { is_main: false },
          { where: { tenant_id: tenantId }, transaction }
        );
      }

      // Si queda como default de su sede, desmarcar cualquier otra bodega
      // default de esa misma sede (solo puede haber una)
      if (effectiveBranchId && effectiveIsDefault) {
        await Warehouse.update(
          { is_default: false },
          { where: { tenant_id: tenantId, branch_id: effectiveBranchId, id: { [require('sequelize').Op.ne]: id } }, transaction }
        );
      }

      await warehouse.update({
        name: name !== undefined ? name : warehouse.name,
        code: code !== undefined ? code : warehouse.code,
        address: address !== undefined ? address : warehouse.address,
        city: city !== undefined ? city : warehouse.city,
        phone: phone !== undefined ? phone : warehouse.phone,
        manager_id: manager_id !== undefined ? manager_id : warehouse.manager_id,
        is_main: is_main !== undefined ? is_main : warehouse.is_main,
        is_active: is_active !== undefined ? is_active : warehouse.is_active,
        branch_id: effectiveBranchId,
        is_default: effectiveBranchId ? effectiveIsDefault : false,
      }, { transaction });

      await transaction.commit();

      res.json({
        success: true,
        message: 'Bodega actualizada exitosamente',
        data: warehouse
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (error) {
    console.error('Error al actualizar bodega:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar bodega',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
});

// Eliminar bodega (solo si no tiene stock)
router.delete('/:id', async (req, res) => {
  try {
    const { Warehouse } = require('../../models/inventory');
    const { ProductWarehouseStock } = require('../../models/inventory');
    const { id } = req.params;
    const tenantId = req.tenant_id;

    const warehouse = await Warehouse.findOne({
      where: { 
        id,
        tenant_id: tenantId 
      }
    });

    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Bodega no encontrada'
      });
    }

    // Verificar si tiene stock
    const hasStock = await ProductWarehouseStock.count({
      where: { 
        warehouse_id: id,
        current_stock: { [require('sequelize').Op.gt]: 0 }
      }
    });

    if (hasStock > 0) {
      return res.status(400).json({
        success: false,
        message: 'No se puede eliminar la bodega porque tiene productos en stock'
      });
    }

    await warehouse.destroy();

    res.json({
      success: true,
      message: 'Bodega eliminada exitosamente'
    });
  } catch (error) {
    console.error('Error al eliminar bodega:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar bodega',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
});

module.exports = router;