const Permission = require('../models/auth/Permission');
const RolePermission = require('../models/auth/RolePermission');
const { Op } = require('sequelize');

/**
 * Obtener todos los permisos agrupados por módulo
 */
const getAllPermissions = async (req, res) => {
  try {
    const permissions = await Permission.findAll({
      where: { is_active: true },
      order: [
        ['module', 'ASC'],
        ['name', 'ASC'],
      ],
    });

    // Agrupar por módulo
    const groupedPermissions = permissions.reduce((acc, perm) => {
      if (!acc[perm.module]) {
        acc[perm.module] = [];
      }
      acc[perm.module].push(perm);
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: {
        permissions,
        grouped: groupedPermissions,
      },
    });
  } catch (error) {
    console.error('Error obteniendo permisos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener permisos',
      error: error.message,
    });
  }
};

/**
 * Obtener permisos de un rol específico
 */
const getRolePermissions = async (req, res) => {
  try {
    const { role } = req.params;

    // Validar que el rol existe
    const validRoles = [
      'super_admin',
      'admin',
      'operario',
      'cliente',
      'asesor_facturacion',
      'asesor_servicio_cliente',
    ];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Rol inválido',
      });
    }

    // Obtener todos los permisos
    const allPermissions = await Permission.findAll({
      where: { is_active: true },
      order: [
        ['module', 'ASC'],
        ['name', 'ASC'],
      ],
    });

    // Obtener permisos del rol
    const rolePermissions = await RolePermission.findAll({
      where: { role },
      include: [
        {
          model: Permission,
          as: 'permission',
          where: { is_active: true },
        },
      ],
    });

    // IDs de permisos que tiene el rol
    const rolePermissionIds = rolePermissions.map((rp) => rp.permission_id);

    // Marcar cuáles tiene y cuáles no
    const permissionsWithStatus = allPermissions.map((perm) => ({
      ...perm.toJSON(),
      has_permission: rolePermissionIds.includes(perm.id),
    }));

    // Agrupar por módulo
    const groupedPermissions = permissionsWithStatus.reduce((acc, perm) => {
      if (!acc[perm.module]) {
        acc[perm.module] = [];
      }
      acc[perm.module].push(perm);
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: {
        role,
        permissions: permissionsWithStatus,
        grouped: groupedPermissions,
      },
    });
  } catch (error) {
    console.error('Error obteniendo permisos del rol:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener permisos del rol',
      error: error.message,
    });
  }
};

/**
 * Actualizar permisos de un rol
 */
const updateRolePermissions = async (req, res) => {
  try {
    const { role } = req.params;
    const { permission_ids } = req.body; // Array de IDs de permisos

    // Validar rol
    const validRoles = [
      'admin',
      'operario',
      'cliente',
      'asesor_facturacion',
      'asesor_servicio_cliente',
    ]; // Super admin no se modifica
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Rol inválido o no modificable',
      });
    }

    // Validar que permission_ids sea un array
    if (!Array.isArray(permission_ids)) {
      return res.status(400).json({
        success: false,
        message: 'permission_ids debe ser un array',
      });
    }

    // Eliminar permisos actuales del rol
    await RolePermission.destroy({
      where: { role },
    });

    // Crear nuevos permisos
    const newPermissions = permission_ids.map((permissionId) => ({
      role,
      permission_id: permissionId,
    }));

    if (newPermissions.length > 0) {
      await RolePermission.bulkCreate(newPermissions);
    }

    res.status(200).json({
      success: true,
      message: 'Permisos actualizados exitosamente',
      data: {
        role,
        permissions_count: newPermissions.length,
      },
    });
  } catch (error) {
    console.error('Error actualizando permisos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar permisos',
      error: error.message,
    });
  }
};

/**
 * Agregar un permiso a un rol
 */
const addPermissionToRole = async (req, res) => {
  try {
    const { role } = req.params;
    const { permission_id } = req.body;

    // Validar rol
    const validRoles = [
      'admin',
      'operario',
      'cliente',
      'asesor_facturacion',
      'asesor_servicio_cliente',
    ];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Rol inválido o no modificable',
      });
    }

    // Verificar que el permiso existe
    const permission = await Permission.findByPk(permission_id);
    if (!permission) {
      return res.status(404).json({
        success: false,
        message: 'Permiso no encontrado',
      });
    }

    // Verificar si ya existe
    const existing = await RolePermission.findOne({
      where: { role, permission_id },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'El rol ya tiene este permiso',
      });
    }

    // Crear relación
    await RolePermission.create({
      role,
      permission_id,
    });

    res.status(201).json({
      success: true,
      message: 'Permiso agregado exitosamente',
    });
  } catch (error) {
    console.error('Error agregando permiso:', error);
    res.status(500).json({
      success: false,
      message: 'Error al agregar permiso',
      error: error.message,
    });
  }
};

/**
 * Remover un permiso de un rol
 */
const removePermissionFromRole = async (req, res) => {
  try {
    const { role, permissionId } = req.params;

    // Validar rol
    const validRoles = [
      'admin',
      'operario',
      'cliente',
      'asesor_facturacion',
      'asesor_servicio_cliente',
    ];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Rol inválido o no modificable',
      });
    }

    // Eliminar relación
    const deleted = await RolePermission.destroy({
      where: {
        role,
        permission_id: permissionId,
      },
    });

    if (deleted === 0) {
      return res.status(404).json({
        success: false,
        message: 'Permiso no encontrado para este rol',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Permiso removido exitosamente',
    });
  } catch (error) {
    console.error('Error removiendo permiso:', error);
    res.status(500).json({
      success: false,
      message: 'Error al remover permiso',
      error: error.message,
    });
  }
};

/**
 * Obtener permisos del usuario actual
 */
const getMyPermissions = async (req, res) => {
  try {
    const userRole = req.user.role;

    // Super admin tiene todos los permisos
    if (userRole === 'super_admin') {
      const allPermissions = await Permission.findAll({
        where: { is_active: true },
      });

      return res.status(200).json({
        success: true,
        data: {
          role: userRole,
          permissions: allPermissions.map((p) => p.name),
          all_permissions: allPermissions,
        },
      });
    }

    // Obtener permisos del rol
    const rolePermissions = await RolePermission.findAll({
      where: { role: userRole },
      include: [
        {
          model: Permission,
          as: 'permission',
          where: { is_active: true },
        },
      ],
    });

    const permissions = rolePermissions.map((rp) => rp.permission.name);
    const allPermissions = rolePermissions.map((rp) => rp.permission);

    res.status(200).json({
      success: true,
      data: {
        role: userRole,
        permissions, // Array de strings ['invoices.view', 'invoices.create']
        all_permissions: allPermissions, // Objetos completos
      },
    });
  } catch (error) {
    console.error('Error obteniendo mis permisos:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener permisos',
      error: error.message,
    });
  }
};

module.exports = {
  getAllPermissions,
  getRolePermissions,
  updateRolePermissions,
  addPermissionToRole,
  removePermissionFromRole,
  getMyPermissions,
};