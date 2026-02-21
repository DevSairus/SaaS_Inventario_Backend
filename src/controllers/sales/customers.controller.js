// backend/src/controllers/sales/customers.controller.js
const { Customer, Sale, SaleItem } = require('../../models');
const { Op } = require('sequelize');

// Utilidad: el frontend envía full_name, la DB tiene first_name + last_name
function splitFullName(fullName) {
  if (!fullName) return { first_name: '', last_name: '' };
  const parts = fullName.trim().split(/\s+/);
  const first_name = parts[0] || '';
  const last_name = parts.slice(1).join(' ') || '';
  return { first_name, last_name };
}

// Utilidad: preparar datos del body para la DB
function prepareCustomerData(body) {
  const { full_name, ...rest } = body;
  const data = { ...rest };
  if (full_name !== undefined) {
    const { first_name, last_name } = splitFullName(full_name);
    data.first_name = first_name;
    data.last_name = last_name;
  }
  // Eliminar campos que no existen en la tabla
  delete data.discount_percentage;
  delete data.sales_representative_id;
  return data;
}

// Obtener todos los clientes
const getAll = async (req, res) => {
  try {
    const { search, type, status, limit = 50, offset = 0 } = req.query;
    const tenantId = req.tenant_id;

    const where = { tenant_id: tenantId };

    if (search) {
      where[Op.or] = [
        { first_name: { [Op.iLike]: `%${search}%` } },
        { last_name: { [Op.iLike]: `%${search}%` } },
        { tax_id: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (type) where.customer_type = type;
    if (status === 'active') where.is_active = true;
    else if (status === 'inactive') where.is_active = false;

    const customers = await Customer.findAll({
      where,
      order: [['first_name', 'ASC'], ['last_name', 'ASC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    const total = await Customer.count({ where });

    res.json({
      success: true,
      data: customers,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: total > (parseInt(offset) + parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error al obtener clientes:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener clientes',
      error: error.message
    });
  }
};

// Obtener un cliente por ID
const getById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;

    const customer = await Customer.findOne({
      where: { id, tenant_id: tenantId },
      include: [
        {
          model: Sale,
          as: 'sales',
          include: [
            {
              model: SaleItem,
              as: 'items'
            }
          ],
          limit: 10,
          order: [['sale_date', 'DESC']]
        }
      ]
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado'
      });
    }

    res.json({
      success: true,
      data: customer
    });
  } catch (error) {
    console.error('Error al obtener cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener cliente',
      error: error.message
    });
  }
};

// Crear nuevo cliente
const create = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const customerData = {
      ...prepareCustomerData(req.body),
      tenant_id: tenantId
    };

    if (customerData.tax_id) {
      const existingCustomer = await Customer.findOne({
        where: {
          tax_id: customerData.tax_id,
          tenant_id: tenantId
        }
      });

      if (existingCustomer) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe un cliente con este NIT/CC'
        });
      }
    }

    const customer = await Customer.create(customerData);

    res.status(201).json({
      success: true,
      message: 'Cliente creado exitosamente',
      data: customer
    });
  } catch (error) {
    console.error('Error al crear cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear cliente',
      error: error.message
    });
  }
};

// Actualizar cliente
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;

    const customer = await Customer.findOne({
      where: { id, tenant_id: tenantId }
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado'
      });
    }

    if (req.body.tax_id && req.body.tax_id !== customer.tax_id) {
      const existingCustomer = await Customer.findOne({
        where: {
          tax_id: req.body.tax_id,
          tenant_id: tenantId,
          id: { [Op.ne]: id }
        }
      });

      if (existingCustomer) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe otro cliente con este NIT/CC'
        });
      }
    }

    await customer.update(prepareCustomerData(req.body));

    res.json({
      success: true,
      message: 'Cliente actualizado exitosamente',
      data: customer
    });
  } catch (error) {
    console.error('Error al actualizar cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar cliente',
      error: error.message
    });
  }
};

// Eliminar cliente
const deleteById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;

    const customer = await Customer.findOne({
      where: { id, tenant_id: tenantId }
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado'
      });
    }

    const salesCount = await Sale.count({
      where: { customer_id: id }
    });

    if (salesCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'No se puede eliminar el cliente porque tiene ventas asociadas'
      });
    }

    await customer.destroy();

    res.json({
      success: true,
      message: 'Cliente eliminado exitosamente'
    });
  } catch (error) {
    console.error('Error al eliminar cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar cliente',
      error: error.message
    });
  }
};


// Buscar clientes por nombre, tax_id, email
const search = async (req, res) => {
  try {
    const { q } = req.query;
    const tenantId = req.tenant_id;

    if (!q || q.length < 2) {
      return res.json({ success: true, data: [] });
    }

    const customers = await Customer.findAll({
      where: {
        tenant_id: tenantId,
        [Op.or]: [
          { first_name: { [Op.iLike]: `%${q}%` } },
          { last_name: { [Op.iLike]: `%${q}%` } },
          { tax_id: { [Op.iLike]: `%${q}%` } },
          { email: { [Op.iLike]: `%${q}%` } },
        ]
      },
      order: [['first_name', 'ASC']],
      limit: 20
    });

    res.json({ success: true, data: customers });
  } catch (error) {
    console.error('Error buscando clientes:', error);
    res.status(500).json({
      success: false,
      message: 'Error buscando clientes',
      error: error.message
    });
  }
};

module.exports = {
  getAll,
  search,
  getById,
  create,
  update,
  delete: deleteById
};