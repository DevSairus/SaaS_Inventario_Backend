// backend/src/controllers/branches/branches.controller.js
const { Branch, Warehouse, User, UserBranch, sequelize } = require('../../models');

// Listar sedes del tenant
// Admin (y super_admin) ven todas las sedes, igual que branchMiddleware las
// deja operar cualquier sede sin estar en user_branches. Cualquier otro rol
// solo debe ver/seleccionar las sedes que tiene asignadas — de lo contrario
// el selector de sede deja "elegir" sedes que luego el middleware rechaza.
const list = async (req, res) => {
  try {
    const isTenantAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';

    if (isTenantAdmin) {
      const branches = await Branch.findAll({
        where: { tenant_id: req.tenant_id },
        include: [
          { model: Warehouse, as: 'warehouse', attributes: ['id', 'name', 'code'] },
        ],
        order: [['is_main', 'DESC'], ['name', 'ASC']],
      });
      return res.json({ success: true, data: branches });
    }

    const branches = await Branch.findAll({
      where: { tenant_id: req.tenant_id, is_active: true },
      include: [
        { model: Warehouse, as: 'warehouse', attributes: ['id', 'name', 'code'] },
        {
          model: User,
          as: 'users',
          attributes: [],
          where: { id: req.user.id },
          required: true,
        },
      ],
      order: [['is_main', 'DESC'], ['name', 'ASC']],
    });
    res.json({ success: true, data: branches });
  } catch (error) {
    console.error('Error al listar sedes:', error);
    res.status(500).json({ success: false, message: 'Error al listar sedes', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// Obtener sede por ID
const getById = async (req, res) => {
  try {
    const branch = await Branch.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
      include: [
        { model: Warehouse, as: 'warehouse' },
        { model: Warehouse, as: 'warehouses' },
        { model: User, as: 'users', attributes: ['id', 'first_name', 'last_name', 'email', 'role'], through: { attributes: ['is_default'] } },
      ],
    });
    if (!branch) return res.status(404).json({ success: false, message: 'Sede no encontrada' });
    res.json({ success: true, data: branch });
  } catch (error) {
    console.error('Error al obtener sede:', error);
    res.status(500).json({ success: false, message: 'Error al obtener sede', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// Crear sede (opcionalmente con su bodega en el mismo request)
const create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { code, name, address, city, phone, email, manager_id, is_main, create_warehouse = true, warehouse_code, warehouse_name } = req.body;

    if (!code || !name) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'code y name son obligatorios' });
    }

    if (is_main) {
      await Branch.update({ is_main: false }, { where: { tenant_id: req.tenant_id }, transaction });
    }

    const branch = await Branch.create({
      tenant_id: req.tenant_id,
      code,
      name,
      address,
      city,
      phone,
      email,
      manager_id: manager_id || null,
      is_main: is_main || false,
      is_active: true,
    }, { transaction });

    let warehouse = null;
    if (create_warehouse) {
      warehouse = await Warehouse.create({
        tenant_id: req.tenant_id,
        branch_id: branch.id,
        code: warehouse_code || `BOD-${code}`,
        name: warehouse_name || `Bodega ${name}`,
        address,
        city,
        phone,
        manager_id: manager_id || null,
        is_main: is_main || false,
        is_default: true,
        is_active: true,
      }, { transaction });
    }

    await transaction.commit();
    res.status(201).json({ success: true, message: 'Sede creada exitosamente', data: { ...branch.toJSON(), warehouse } });
  } catch (error) {
    await transaction.rollback();
    console.error('Error al crear sede:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe una sede con ese código' });
    }
    res.status(500).json({ success: false, message: 'Error al crear sede', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// Actualizar sede
const update = async (req, res) => {
  try {
    const branch = await Branch.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!branch) return res.status(404).json({ success: false, message: 'Sede no encontrada' });

    const { code, name, address, city, phone, email, manager_id, is_main, is_active } = req.body;

    if (is_main && !branch.is_main) {
      await Branch.update({ is_main: false }, { where: { tenant_id: req.tenant_id } });
    }

    await branch.update({
      code: code !== undefined ? code : branch.code,
      name: name !== undefined ? name : branch.name,
      address: address !== undefined ? address : branch.address,
      city: city !== undefined ? city : branch.city,
      phone: phone !== undefined ? phone : branch.phone,
      email: email !== undefined ? email : branch.email,
      manager_id: manager_id !== undefined ? manager_id : branch.manager_id,
      is_main: is_main !== undefined ? is_main : branch.is_main,
      is_active: is_active !== undefined ? is_active : branch.is_active,
    });

    res.json({ success: true, message: 'Sede actualizada exitosamente', data: branch });
  } catch (error) {
    console.error('Error al actualizar sede:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar sede', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// Desactivar sede (no se elimina físicamente: tiene historial asociado)
const deactivate = async (req, res) => {
  try {
    const branch = await Branch.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!branch) return res.status(404).json({ success: false, message: 'Sede no encontrada' });

    if (branch.is_main) {
      return res.status(400).json({ success: false, message: 'No se puede desactivar la sede principal' });
    }

    await branch.update({ is_active: false });
    res.json({ success: true, message: 'Sede desactivada exitosamente' });
  } catch (error) {
    console.error('Error al desactivar sede:', error);
    res.status(500).json({ success: false, message: 'Error al desactivar sede', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// ── Asignación de usuarios a sedes ──────────────────────────────────────────

// Listar usuarios asignados a una sede
const listUsers = async (req, res) => {
  try {
    const branch = await Branch.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!branch) return res.status(404).json({ success: false, message: 'Sede no encontrada' });

    const assignments = await UserBranch.findAll({
      where: { branch_id: branch.id },
      include: [{ model: User, as: 'user', attributes: ['id', 'first_name', 'last_name', 'email', 'role'] }],
    });

    res.json({ success: true, data: assignments });
  } catch (error) {
    console.error('Error al listar usuarios de la sede:', error);
    res.status(500).json({ success: false, message: 'Error al listar usuarios de la sede', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// Asignar un usuario a una sede
const assignUser = async (req, res) => {
  try {
    const branch = await Branch.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!branch) return res.status(404).json({ success: false, message: 'Sede no encontrada' });

    const { user_id, is_default = false } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'user_id es obligatorio' });

    const user = await User.findOne({ where: { id: user_id, tenant_id: req.tenant_id } });
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });

    const [assignment, created] = await UserBranch.findOrCreate({
      where: { user_id, branch_id: branch.id },
      defaults: { is_default },
    });

    if (is_default) {
      // Solo puede haber una sede por defecto por usuario
      await UserBranch.update(
        { is_default: false },
        { where: { user_id, branch_id: { [require('sequelize').Op.ne]: branch.id } } }
      );
      if (!created && !assignment.is_default) await assignment.update({ is_default: true });
    }

    res.status(created ? 201 : 200).json({
      success: true,
      message: created ? 'Usuario asignado a la sede' : 'La asignación ya existía',
      data: assignment,
    });
  } catch (error) {
    console.error('Error al asignar usuario a sede:', error);
    res.status(500).json({ success: false, message: 'Error al asignar usuario a sede', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// Quitar un usuario de una sede
const removeUser = async (req, res) => {
  try {
    const branch = await Branch.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!branch) return res.status(404).json({ success: false, message: 'Sede no encontrada' });

    const deleted = await UserBranch.destroy({
      where: { branch_id: branch.id, user_id: req.params.userId },
    });

    if (!deleted) return res.status(404).json({ success: false, message: 'El usuario no estaba asignado a esta sede' });

    res.json({ success: true, message: 'Usuario removido de la sede' });
  } catch (error) {
    console.error('Error al remover usuario de sede:', error);
    res.status(500).json({ success: false, message: 'Error al remover usuario de sede', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

module.exports = {
  list,
  getById,
  create,
  update,
  deactivate,
  listUsers,
  assignUser,
  removeUser,
};