const User = require('../models/User');
const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const {
  addTenantScope,
  addTenantData,
  validateTenantOwnership,
} = require('../utils/tenantScope');

// Obtener todos los usuarios (admin)
const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10, role, search, is_active } = req.query;

    const offset = (page - 1) * limit;
    let where = {
      role: { 
        [Op.in]: ['admin', 'manager', 'seller', 'warehouse_keeper', 'user', 'viewer'] 
      },
    };

    if (role) {
      where.role = role; // Permite filtrar por rol específico
    }

    if (is_active !== undefined) {
      where.is_active = is_active === 'true';
    }

    if (search) {
      where[Op.or] = [
        { first_name: { [Op.iLike]: `%${search}%` } },
        { last_name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    // Agregar tenant_id automáticamente
    where = addTenantScope(where, req);

    const { count, rows: users } = await User.findAndCountAll({
      where,
      attributes: { exclude: ['password_hash'] },
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']],
    });

    res.status(200).json({
      success: true,
      data: {
        users,
        currentPage: parseInt(page),
        totalPages: Math.ceil(count / limit),
        totalItems: count,
      },
    });
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener usuarios',
      error: error.message,
    });
  }
};
// Obtener usuario por ID
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    let where = { id };
    where = addTenantScope(where, req);

    const user = await User.findOne({
      where,
      attributes: { exclude: ['password_hash'] },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // Validar ownership
    if (!validateTenantOwnership(user, req)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permiso para ver este usuario',
      });
    }

    // Solo admin o el mismo usuario pueden ver detalles
    if (req.user.role !== 'admin' && req.user.id !== id) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para ver este usuario',
      });
    }

    res.status(200).json({
      success: true,
      data: { user },
    });
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener usuario',
      error: error.message,
    });
  }
};

// Obtener perfil del usuario actual
const getProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password_hash'] },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    res.status(200).json({
      success: true,
      data: { user },
    });
  } catch (error) {
    console.error('Error obteniendo perfil:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener perfil',
      error: error.message,
    });
  }
};

// Actualizar perfil del usuario actual
const updateProfile = async (req, res) => {
  try {
    const { first_name, last_name, phone, address } = req.body;

    const user = await User.findByPk(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    await user.update({
      first_name,
      last_name,
      phone,
      address,
    });

    const userResponse = user.toJSON();
    delete userResponse.password_hash;

    res.status(200).json({
      success: true,
      message: 'Perfil actualizado exitosamente',
      data: { user: userResponse },
    });
  } catch (error) {
    console.error('Error actualizando perfil:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar perfil',
      error: error.message,
    });
  }
};

// Cambiar contraseña
const changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    const user = await User.findByPk(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // Verificar contraseña actual
    const isValidPassword = await bcrypt.compare(
      current_password,
      user.password_hash
    );

    if (!isValidPassword) {
      return res.status(400).json({
        success: false,
        message: 'La contraseña actual es incorrecta',
      });
    }

    // Actualizar contraseña
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await user.update({ password_hash: hashedPassword });

    res.status(200).json({
      success: true,
      message: 'Contraseña actualizada exitosamente',
    });
  } catch (error) {
    console.error('Error cambiando contraseña:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cambiar contraseña',
      error: error.message,
    });
  }
};

// Crear usuario (admin)
const createUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array(),
      });
    }

    const {
      email,
      password,
      role,
      first_name,
      last_name,
      phone,
    } = req.body;

    // Validar rol (excluir super_admin que solo se crea desde backend)
    const validRoles = ['admin', 'manager', 'seller', 'warehouse_keeper', 'user', 'viewer'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Rol inválido. Los roles permitidos son: ${validRoles.join(', ')}`
      });
    }

    // Verificar si el email ya existe en el tenant
    let existingWhere = { email };
    existingWhere = addTenantScope(existingWhere, req);

    const existingUser = await User.findOne({ where: existingWhere });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'El email ya está registrado',
      });
    }

    // Hash de la contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // Crear usuario con tenant_id
    let userData = {
      email,
      password_hash: hashedPassword,
      role: role || 'user',
      first_name,
      last_name,
      phone,
      is_active: true,
    };

    userData = addTenantData(userData, req);

    const user = await User.create(userData);

    const userResponse = user.toJSON();
    delete userResponse.password_hash;

    res.status(201).json({
      success: true,
      message: 'Usuario creado exitosamente',
      data: { user: userResponse },
    });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear usuario',
      error: error.message,
    });
  }
};

// Crear cliente (simplificado)
const createClient = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array(),
      });
    }

    const {
      email,
      first_name,
      last_name,
      identification_type,
      identification_number,
      phone,
      address,
      stratum,
    } = req.body;

    // Verificar si el email ya existe
    let existingWhere = { email };
    existingWhere = addTenantScope(existingWhere, req);

    const existingUser = await User.findOne({ where: existingWhere });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'El email ya está registrado',
      });
    }

    // Generar contraseña temporal
    const tempPassword = Math.random().toString(36).slice(-8);

    // Crear cliente con tenant_id
    let userData = {
      email,
      password_hash: tempPassword,
      role: 'cliente',
      first_name,
      last_name,
      identification_type,
      identification_number,
      phone,
      address,
      stratum,
      is_active: true,
      created_by: req.user.id,
    };

    userData = addTenantData(userData, req);

    const user = await User.create(userData);

    const userResponse = user.toJSON();
    delete userResponse.password_hash;

    res.status(201).json({
      success: true,
      message: 'Cliente creado exitosamente',
      data: { user: userResponse, tempPassword },
    });
  } catch (error) {
    console.error('Error creando cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear cliente',
      error: error.message,
    });
  }
};

// Actualizar usuario
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, phone, address, stratum, is_active, role } =
      req.body;

    let where = { id };
    where = addTenantScope(where, req);

    const user = await User.findOne({ where });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // Validar ownership
    if (!validateTenantOwnership(user, req)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permiso para actualizar este usuario',
      });
    }

    const updateData = {
      first_name,
      last_name,
      phone,
      address,
      stratum,
    };

    if (req.user.role === 'admin') {
      if (is_active !== undefined) {
        updateData.is_active = is_active;
      }
      if (role) {
        updateData.role = role;
      }
    }

    await user.update(updateData);

    const userResponse = user.toJSON();
    delete userResponse.password_hash;

    res.status(200).json({
      success: true,
      message: 'Usuario actualizado exitosamente',
      data: { user: userResponse },
    });
  } catch (error) {
    console.error('Error actualizando usuario:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar usuario',
      error: error.message,
    });
  }
};

// Activar/desactivar usuario
const toggleUserStatus = async (req, res) => {
  try {
    const { id } = req.params;

    let where = { id };
    where = addTenantScope(where, req);

    const user = await User.findOne({ where });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // Validar ownership
    if (!validateTenantOwnership(user, req)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permiso para modificar este usuario',
      });
    }

    // No permitir desactivar el propio usuario
    if (req.user.id === id) {
      return res.status(400).json({
        success: false,
        message: 'No puedes desactivarte a ti mismo',
      });
    }

    await user.update({ is_active: !user.is_active });

    res.status(200).json({
      success: true,
      message: `Usuario ${user.is_active ? 'activado' : 'desactivado'} exitosamente`,
      data: { user: { id: user.id, is_active: user.is_active } },
    });
  } catch (error) {
    console.error('Error cambiando estado:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cambiar estado del usuario',
      error: error.message,
    });
  }
};

// Actualizar configuración de auto-generación de facturas
const updateAutoInvoiceConfig = async (req, res) => {
  try {
    const { id } = req.params;
    const { auto_generate_invoice } = req.body;

    let where = { id };
    where = addTenantScope(where, req);

    const user = await User.findOne({ where });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // Validar ownership
    if (!validateTenantOwnership(user, req)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permiso para modificar este usuario',
      });
    }

    await user.update({ auto_generate_invoice });

    res.status(200).json({
      success: true,
      message: 'Configuración actualizada exitosamente',
      data: {
        user_id: user.id,
        auto_generate_invoice: user.auto_generate_invoice,
      },
    });
  } catch (error) {
    console.error('Error actualizando configuración:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar configuración',
      error: error.message,
    });
  }
};

// Eliminar usuario (admin) - Soft delete
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    let where = { id };
    where = addTenantScope(where, req);

    const user = await User.findOne({ where });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado',
      });
    }

    // Validar ownership
    if (!validateTenantOwnership(user, req)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permiso para eliminar este usuario',
      });
    }

    // No permitir eliminar el propio usuario admin
    if (req.user.id === id) {
      return res.status(400).json({
        success: false,
        message: 'No puedes eliminarte a ti mismo',
      });
    }

    // Soft delete - desactivar usuario
    await user.update({ is_active: false });

    res.status(200).json({
      success: true,
      message: 'Usuario desactivado exitosamente',
    });
  } catch (error) {
    console.error('Error eliminando usuario:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar usuario',
      error: error.message,
    });
  }
};

// Obtener estado de límites del tenant actual
const getLimitsStatus = async (req, res) => {
  try {
    const tenantId = req.tenant_id;

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant ID no encontrado',
      });
    }

    // Obtener tenant
    const Tenant = require('../models/Tenant');
    const tenant = await Tenant.findByPk(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado',
      });
    }

    // Obtener configuración de planes
    const { PLANS } = require('../middleware/checkLimits');
    const plan = PLANS[tenant.plan];

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan no encontrado',
      });
    }

    // Contar usuarios (admin + manager + seller + warehouse_keeper + user + viewer) - usando addTenantScope
    let usersWhere = {
      role: { [Op.in]: ['admin', 'manager', 'seller', 'warehouse_keeper', 'user', 'viewer'] },
      is_active: true,
    };
    usersWhere = addTenantScope(usersWhere, req);

    const currentUsers = await User.count({ where: usersWhere });

    // Contar clientes - usando addTenantScope
    let clientsWhere = {
      role: 'cliente',
      is_active: true,
    };
    clientsWhere = addTenantScope(clientsWhere, req);

    const currentClients = await User.count({ where: clientsWhere });

    // Contar facturas del mes actual
    const Invoice = require('../models/Invoice');
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let invoicesWhere = {
      created_at: { [Op.gte]: startOfMonth },
    };
    invoicesWhere = addTenantScope(invoicesWhere, req);

    const currentInvoices = await Invoice.count({ where: invoicesWhere });

    // Calcular límites
    const limits = {
      users: {
        current: currentUsers,
        max: plan.max_users === -1 ? 'unlimited' : plan.max_users,
        percentage:
          plan.max_users === -1
            ? 0
            : Math.round((currentUsers / plan.max_users) * 100),
        exceeded: plan.max_users !== -1 && currentUsers >= plan.max_users,
        warning: plan.max_users !== -1 && currentUsers >= plan.max_users * 0.9,
      },
      clients: {
        current: currentClients,
        max: plan.max_clients === -1 ? 'unlimited' : plan.max_clients,
        percentage:
          plan.max_clients === -1
            ? 0
            : Math.round((currentClients / plan.max_clients) * 100),
        exceeded: plan.max_clients !== -1 && currentClients >= plan.max_clients,
        warning:
          plan.max_clients !== -1 && currentClients >= plan.max_clients * 0.9,
      },
      invoices: {
        current: currentInvoices,
        max:
          plan.max_invoices_per_month === -1
            ? 'unlimited'
            : plan.max_invoices_per_month,
        percentage:
          plan.max_invoices_per_month === -1
            ? 0
            : Math.round((currentInvoices / plan.max_invoices_per_month) * 100),
        exceeded:
          plan.max_invoices_per_month !== -1 &&
          currentInvoices >= plan.max_invoices_per_month,
        warning:
          plan.max_invoices_per_month !== -1 &&
          currentInvoices >= plan.max_invoices_per_month * 0.9,
      },
      plan: {
        name: plan.name,
        code: tenant.plan,
        price: plan.price,
      },
    };

    res.status(200).json({
      success: true,
      data: limits,
    });
  } catch (error) {
    console.error('❌ [LIMITS] Error obteniendo límites:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener límites',
      error: error.message,
    });
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  getProfile,
  updateProfile,
  changePassword,
  createUser,
  createClient,
  updateUser,
  toggleUserStatus,
  updateAutoInvoiceConfig,
  deleteUser,
  getLimitsStatus,
};