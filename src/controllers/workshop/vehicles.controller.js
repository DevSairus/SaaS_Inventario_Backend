// backend/src/controllers/workshop/vehicles.controller.js
const crypto = require('crypto');
const logger = require('../../config/logger');
const { Vehicle, Customer, WorkOrder, WorkOrderItem, User, Sale, Tenant } = require('../../models');
const { Op } = require('sequelize');
const { runWithTenantSchema } = require('../../config/tenantContext');
const { resolveRecordSchemaByToken } = require('../../utils/publicTokenResolver');
const { resolveVehicleMaintenance } = require('../../services/workshop/maintenance.service');
const QRCode = require('qrcode');
const { getCustomerWhatsappNumber } = require('../../utils/customerWhatsappPhone');
const whatsappService = require('../../services/whatsappService');

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
            fuel_type, current_mileage, customer_id, notes, vehicle_type } = req.body;

    if (!plate) return res.status(400).json({ success: false, message: 'La placa es requerida' });

    const vehicle = await Vehicle.create({
      tenant_id, plate: plate.toUpperCase().trim(),
      brand, model,
      vehicle_type: vehicle_type || 'automovil',
      year: year ? parseInt(year) || null : null,
      color, vin, engine, engine_number, ownership_card,
      soat_number, soat_expiry: soat_expiry || null,
      tecnomecanica_number, tecnomecanica_expiry: tecnomecanica_expiry || null,
      fuel_type,
      current_mileage: current_mileage ? parseInt(current_mileage) || null : null,
      customer_id: customer_id || null,
      notes
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
            fuel_type, current_mileage, customer_id, notes, is_active, vehicle_type } = req.body;
    await vehicle.update({
      plate: plate?.toUpperCase().trim() || vehicle.plate,
      brand, model,
      vehicle_type: vehicle_type || vehicle.vehicle_type,
      year: year ? parseInt(year) || null : null,
      color, vin, engine, engine_number, ownership_card,
      soat_number, soat_expiry, tecnomecanica_number, tecnomecanica_expiry,
      fuel_type,
      current_mileage: current_mileage ? parseInt(current_mileage) || null : null,
      customer_id: customer_id || null,
      notes, is_active
    });

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

const remove = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });

    // Soft-delete: marcar inactivo en lugar de borrar
    await vehicle.update({ is_active: false });
    res.json({ success: true, message: 'Vehículo eliminado' });
  } catch (error) {
    logger.error('Error eliminando vehículo:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar vehículo' });
  }
};

// ── PORTAL DEL VEHÍCULO / MANTENIMIENTOS ────────────────────────────────────
// Ver 00 - Documentación/plan-portal-mantenimiento-vehiculo.md secciones 5 y 8.

const portalUrlFor = (token) =>
  `${process.env.FRONTEND_URL || 'https://tu-app.vercel.app'}/portal/vehiculo/${token}`;

/**
 * Devuelve el portal_token del vehículo, generándolo la primera vez. El token
 * va impreso en el sticker QR y NUNCA se regenera -- por eso el UPDATE es
 * condicional (portal_token IS NULL): si dos requests llegan a la vez, solo
 * uno lo fija y el otro relee ese mismo valor, en vez de pisarlo y dejar
 * inservible un sticker que ya se imprimió con el primero.
 */
async function ensurePortalToken(vehicle) {
  if (vehicle.portal_token) return vehicle.portal_token;
  await Vehicle.update(
    { portal_token: crypto.randomUUID() },
    { where: { id: vehicle.id, tenant_id: vehicle.tenant_id, portal_token: null } }
  );
  const fresh = await Vehicle.findOne({
    where: { id: vehicle.id, tenant_id: vehicle.tenant_id },
    attributes: ['id', 'portal_token'],
  });
  vehicle.portal_token = fresh.portal_token;
  return fresh.portal_token;
}

// GET /workshop/vehicles/:id/maintenance
const getMaintenance = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });

    const data = await resolveVehicleMaintenance(vehicle);
    res.json({
      success: true,
      data: { ...data, portal_url: vehicle.portal_token ? portalUrlFor(vehicle.portal_token) : null },
    });
  } catch (error) {
    logger.error('Error obteniendo mantenimientos del vehículo:', error);
    res.status(500).json({ success: false, message: 'Error al obtener mantenimientos' });
  }
};

const CUSTOMER_PHONE_ATTRS = ['first_name', 'phone', 'mobile', 'mobile_country_code'];

// POST /workshop/vehicles/:id/portal-token
// Genera (o devuelve el existente) link permanente del portal + enlace wa.me.
const getPortalLink = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      include: [{ model: Customer, as: 'customer', attributes: CUSTOMER_PHONE_ATTRS }],
    });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });

    const token = await ensurePortalToken(vehicle);
    const portalUrl = portalUrlFor(token);
    const text = encodeURIComponent(
      `Hola! Aquí puedes consultar la hoja de vida y el próximo mantenimiento de tu vehículo ${vehicle.plate}:\n${portalUrl}`
    );
    const phone = getCustomerWhatsappNumber(vehicle.customer);
    res.json({
      success: true,
      data: {
        token,
        portal_url: portalUrl,
        whatsapp_url: phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`,
      },
    });
  } catch (error) {
    logger.error('Error generando link de portal del vehículo:', error);
    res.status(500).json({ success: false, message: 'Error al generar el enlace del portal' });
  }
};

// POST /workshop/vehicles/:id/portal-whatsapp
// Mismo camino que sendWhatsApp de la OT: WhatsApp Cloud API si el tenant lo
// tiene operativo, si no enlace wa.me para que el usuario lo envíe.
const sendPortalWhatsApp = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const vehicle = await Vehicle.findOne({
      where: { id: req.params.id, tenant_id },
      include: [{ model: Customer, as: 'customer', attributes: CUSTOMER_PHONE_ATTRS }],
    });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });

    const phone = getCustomerWhatsappNumber(vehicle.customer);
    if (!phone) {
      return res.status(400).json({ success: false, message: 'El vehículo no tiene propietario con teléfono registrado.' });
    }

    const portalUrl = portalUrlFor(await ensurePortalToken(vehicle));
    const greeting = vehicle.customer?.first_name ? `Hola ${vehicle.customer.first_name}!` : 'Hola!';
    const message = `${greeting} Te compartimos la hoja de vida de tu vehículo *${vehicle.plate}*: historial de servicios y próximo mantenimiento.\n${portalUrl}`;

    try {
      const waCloud = require('../../services/whatsappCloud.service');
      const status = await waCloud.getWhatsAppStatus(tenant_id);
      if (status.operational) {
        const sent = await waCloud.sendTextFromTenant({
          tenantId: tenant_id,
          to: phone,
          body: message,
          userId: req.user?.id || null,
          source: 'api',
        });
        return res.json({
          success: true,
          channel: 'cloud_api',
          portal_url: portalUrl,
          conversation_id: sent.conversation_id,
          message: `Portal enviado por WhatsApp Cloud API a ${phone}.`,
        });
      }
    } catch (cloudErr) {
      logger.warn('[WhatsApp] Cloud fallback a wa.me portal vehículo:', cloudErr.message);
    }

    const result = await whatsappService.sendText(phone, message);
    res.json({
      success: true,
      channel: 'wa_me',
      waLink: result.waLink,
      portal_url: portalUrl,
      message: `Enlace listo para enviar a ${phone}.`,
    });
  } catch (error) {
    logger.error('[WhatsApp] Error enviando portal del vehículo:', error);
    res.status(500).json({ success: false, message: error.message || 'Error al enviar el portal por WhatsApp' });
  }
};

// GET /workshop/vehicles/:id/label
// Datos del sticker QR permanente del vehículo. La etiqueta se arma e
// imprime en el navegador (VehicleLabelPrintModal.jsx), igual que las de
// código de barras de productos, para que cada taller elija el tamaño de su
// impresora/rollo. El próximo servicio NO va impreso (quedaría desactualizado
// en el siguiente cambio): se consulta al escanear el QR.
const getLabel = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, tenant_id } });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });

    const portalUrl = portalUrlFor(await ensurePortalToken(vehicle));
    const tenant = await Tenant.findByPk(tenant_id, {
      attributes: ['company_name', 'phone', 'logo_url', 'primary_color'],
    });

    // QR generado acá (qrcode ya es dependencia del backend) en vez de sumar
    // una librería más al frontend. Negro puro y corrección 'M': aguanta
    // bien la impresión térmica a 203 dpi y algo de desgaste del sticker.
    const qr_data_url = await QRCode.toDataURL(portalUrl, {
      errorCorrectionLevel: 'M', margin: 1, width: 600,
      color: { dark: '#000000', light: '#ffffff' },
    });

    res.json({
      success: true,
      data: {
        portal_url: portalUrl,
        qr_data_url,
        vehicle: { plate: vehicle.plate, brand: vehicle.brand, model: vehicle.model, year: vehicle.year },
        workshop: {
          name: tenant?.company_name || '',
          phone: tenant?.phone || '',
          logo_url: tenant?.logo_url || null,
          primary_color: tenant?.primary_color || '#1e40af',
        },
      },
    });
  } catch (error) {
    logger.error('Error generando sticker del vehículo:', error);
    res.status(500).json({ success: false, message: 'Error generando el sticker' });
  }
};

// ── PÚBLICO (sin auth) ──────────────────────────────────────────────────────

// El link va en un sticker pegado en el vehículo: cualquiera que lo vea
// puede escanearlo. Por eso el portal NO expone datos del propietario
// (nombre, teléfono, documento), ni precios, ni notas internas, ni VIN /
// número de motor -- solo lo necesario para la hoja de vida.
const VEHICLE_PUBLIC_ATTRS = [
  'plate', 'brand', 'model', 'year', 'color', 'vehicle_type', 'fuel_type',
  'current_mileage', 'soat_expiry', 'tecnomecanica_expiry',
];

// GET /public/vehicles/:token
const getPublicVehiclePortal = async (req, res) => {
  try {
    let resolved;
    try {
      resolved = await resolveRecordSchemaByToken({ table: 'vehicles', column: 'portal_token', token: req.params.token });
    } catch {
      return res.status(503).json({ success: false, message: 'Función no disponible aún' });
    }
    if (!resolved) return res.status(404).json({ success: false, message: 'Vehículo no encontrado o enlace inválido' });

    return runWithTenantSchema(resolved.schemaName, () => getPublicVehiclePortalBody(resolved.id, res));
  } catch (error) {
    logger.error('Error en getPublicVehiclePortal:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el vehículo' });
  }
};

async function getPublicVehiclePortalBody(vehicleId, res) {
  try {
    const vehicle = await Vehicle.findByPk(vehicleId, {
      attributes: ['id', 'tenant_id', 'is_active', ...VEHICLE_PUBLIC_ATTRS],
    });
    if (!vehicle || !vehicle.is_active) {
      return res.status(404).json({ success: false, message: 'Vehículo no encontrado o enlace inválido' });
    }

    const [maintenance, orders, tenant] = await Promise.all([
      resolveVehicleMaintenance(vehicle),
      WorkOrder.findAll({
        where: { vehicle_id: vehicle.id, tenant_id: vehicle.tenant_id, status: 'entregado' },
        attributes: ['id', 'order_number', 'received_at', 'delivered_at', 'mileage_in', 'mileage_out', 'work_performed'],
        include: [
          { model: WorkOrderItem, as: 'items', attributes: ['item_type', 'product_name', 'quantity', 'approval_status'] },
          { model: User, as: 'technician', attributes: ['first_name'] },
        ],
        order: [['delivered_at', 'DESC']],
        limit: 50,
      }),
      Tenant.findByPk(vehicle.tenant_id, {
        attributes: ['company_name', 'phone', 'email', 'address', 'logo_url', 'primary_color', 'slug'],
      }),
    ]);

    const vehicleData = {};
    for (const k of VEHICLE_PUBLIC_ATTRS) vehicleData[k] = vehicle[k];

    res.json({
      success: true,
      data: {
        vehicle: vehicleData,
        // Ritmo de uso estimado a partir de sus visitas (null si aún no hay
        // lecturas suficientes) -- ver estimateUsage en maintenance.service.js.
        usage: maintenance.usage ? {
          km_per_day: maintenance.usage.km_per_day,
          estimated_km: maintenance.usage.estimated_km,
          last_reading: maintenance.usage.last_reading,
        } : null,
        // Sin ids internos (OT, tipo) -- solo lo que pinta la tarjeta.
        upcoming: maintenance.upcoming.map(u => ({
          name: u.name,
          status: u.status,
          interval_km: u.interval_km,
          interval_months: u.interval_months,
          next_due_mileage: u.next_due_mileage ?? null,
          next_due_date: u.next_due_date ?? null,
          km_remaining: u.km_remaining ?? null,
          days_remaining: u.days_remaining ?? null,
          km_estimated: !!u.km_estimated,
          estimated_km_due_date: u.estimated_km_due_date ?? null,
          last: u.last ? { performed_at: u.last.performed_at, mileage_at_service: u.last.mileage_at_service } : null,
        })),
        history: orders.map(o => ({
          order_number: o.order_number,
          date: o.delivered_at || o.received_at,
          mileage: o.mileage_out || o.mileage_in || null,
          work_performed: o.work_performed,
          technician: o.technician?.first_name || null,
          items: (o.items || [])
            .filter(i => (i.approval_status || 'aprobado') === 'aprobado')
            .map(i => ({ item_type: i.item_type, product_name: i.product_name, quantity: parseFloat(i.quantity) })),
          maintenance: maintenance.records.filter(r => r.work_order_id === o.id).map(r => r.name),
        })),
        workshop: tenant ? {
          name: tenant.company_name,
          phone: tenant.phone,
          email: tenant.email,
          address: tenant.address,
          logo_url: tenant.logo_url,
          primary_color: tenant.primary_color || '#2563eb',
          slug: tenant.slug,
        } : null,
      },
    });
  } catch (error) {
    logger.error('Error en getPublicVehiclePortalBody:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el vehículo' });
  }
}

module.exports = {
  list, getById, create, update, getHistory, remove,
  getMaintenance, getPortalLink, sendPortalWhatsApp, getLabel, getPublicVehiclePortal,
};