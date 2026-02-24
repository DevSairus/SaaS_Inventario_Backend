// backend/src/controllers/workshop/vehicles.controller.js
const logger = require('../../config/logger');
const { Vehicle, Customer, WorkOrder, WorkOrderItem, User, Sale } = require('../../models');
const { Op } = require('sequelize');

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { search, customer_id, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const where = { tenant_id, is_active: true };
    if (customer_id) where.customer_id = customer_id;
    if (search) {
      where[Op.or] = [
        { plate: { [Op.iLike]: `%${search}%` } },
        { brand: { [Op.iLike]: `%${search}%` } },
        { model: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows } = await Vehicle.findAndCountAll({
      where,
      include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'phone'] }],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({ success: true, data: rows, total: count, page: parseInt(page), pages: Math.ceil(count / limit) });
  } catch (error) {
    logger.error('Error listando vehículos:', error);
    res.status(500).json({ success: false, message: 'Error al obtener vehículos' });
  }
};

const getById = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      include: [
        { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'phone', 'email'] },
        {
          model: WorkOrder,
          as: 'work_orders',
          attributes: ['id', 'order_number', 'status', 'received_at', 'total_amount', 'problem_description'],
          order: [['received_at', 'DESC']],
          limit: 10,
        }
      ]
    });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });
    res.json({ success: true, data: vehicle });
  } catch (error) {
    logger.error('Error obteniendo vehículo:', error);
    res.status(500).json({ success: false, message: 'Error al obtener vehículo' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { plate, brand, model, year, color, vin, engine, engine_number, ownership_card,
            soat_number, soat_expiry, tecnomecanica_number, tecnomecanica_expiry,
            fuel_type, current_mileage, customer_id, notes } = req.body;

    if (!plate) return res.status(400).json({ success: false, message: 'La placa es requerida' });

    const vehicle = await Vehicle.create({
      tenant_id, plate: plate.toUpperCase().trim(),
      brand, model, year, color, vin, engine, engine_number, ownership_card,
      soat_number, soat_expiry: soat_expiry || null,
      tecnomecanica_number, tecnomecanica_expiry: tecnomecanica_expiry || null,
      fuel_type, current_mileage, customer_id, notes
    });

    const full = await Vehicle.findByPk(vehicle.id, {
      include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] }]
    });

    res.status(201).json({ success: true, message: 'Vehículo registrado', data: full });
  } catch (error) {
    logger.error('Error creando vehículo:', error);
    res.status(500).json({ success: false, message: 'Error al crear vehículo' });
  }
};

const update = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });

    const { plate, brand, model, year, color, vin, engine, engine_number, ownership_card,
            soat_number, soat_expiry, tecnomecanica_number, tecnomecanica_expiry,
            fuel_type, current_mileage, customer_id, notes, is_active } = req.body;
    await vehicle.update({ plate: plate?.toUpperCase().trim() || vehicle.plate, brand, model, year, color, vin,
      engine, engine_number, ownership_card, soat_number, soat_expiry,
      tecnomecanica_number, tecnomecanica_expiry, fuel_type, current_mileage, customer_id, notes, is_active });

    // Reload con customer incluido para que el frontend tenga el objeto completo
    await vehicle.reload({
      include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'phone'] }]
    });

    res.json({ success: true, message: 'Vehículo actualizado', data: vehicle });
  } catch (error) {
    logger.error('Error actualizando vehículo:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar vehículo' });
  }
};

const getHistory = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'phone'] }],
    });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });

    const orders = await WorkOrder.findAll({
      where: { vehicle_id: req.params.id, tenant_id: req.user.tenant_id },
      order: [['received_at', 'DESC']],
      include: [
        {
          model: WorkOrderItem, as: 'items',
          attributes: ['id', 'product_name', 'quantity', 'unit_price', 'total', 'item_type'],
        },
        {
          model: User, as: 'technician',
          attributes: ['id', 'first_name', 'last_name'],
        },
        {
          model: Sale, as: 'sale',
          attributes: ['id', 'sale_number', 'status', 'payment_status', 'total_amount', 'paid_amount'],
        },
        {
          model: Customer, as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'business_name', 'phone'],
        },
      ],
    });

    res.json({ success: true, data: { vehicle, history: orders } });
  } catch (error) {
    logger.error('Error obteniendo historial:', error);
    res.status(500).json({ success: false, message: 'Error al obtener historial' });
  }
};

module.exports = { list, getById, create, update, getHistory };