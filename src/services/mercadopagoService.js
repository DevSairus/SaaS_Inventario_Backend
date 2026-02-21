// backend/src/services/mercadopagoService.js
const axios = require('axios');
const {
  MercadoPagoTransaction,
  TenantMercadoPagoConfig,
  Invoice,
  User,
  Payment,
  Tenant,
} = require('../models/associations');

class MercadoPagoService {
  constructor() {
    this.apiBaseUrl = 'https://api.mercadopago.com';
  }

  /**
   * Obtener configuración de MercadoPago del tenant
   */
  async getTenantConfig(tenantId) {
    const config = await TenantMercadoPagoConfig.findOne({
      where: {
        tenant_id: tenantId,
        is_active: true,
      },
    });

    if (!config) {
      throw new Error('MercadoPago no está configurado para este tenant');
    }

    return config;
  }

  /**
   * Crear preferencia de pago en MercadoPago
   */
  async createPreference({
    tenant_id,
    client_id,
    invoice_id,
    amount,
    description,
    payer_data,
  }) {
    try {
      console.log('📝 [MERCADOPAGO SERVICE] Creating preference:', {
        tenant_id,
        client_id,
        invoice_id,
        amount,
      });

      // 1. Obtener configuración del tenant
      const tenantConfig = await this.getTenantConfig(tenant_id);
      console.log('✅ [MERCADOPAGO SERVICE] Tenant config loaded:', {
        test_mode: tenantConfig.test_mode,
      });

      // 2. Validar factura
      const invoice = await Invoice.findByPk(invoice_id);

      if (!invoice) {
        console.error(
          '❌ [MERCADOPAGO SERVICE] Invoice not found:',
          invoice_id
        );
        throw new Error('Factura no encontrada');
      }

      if (invoice.status === 'paid') {
        console.error('❌ [MERCADOPAGO SERVICE] Invoice already paid');
        throw new Error('La factura ya está pagada');
      }

      console.log('✅ [MERCADOPAGO SERVICE] Invoice validated');

      // 3. Obtener datos del cliente
      const client = await User.findByPk(client_id);

      if (!client) {
        console.error('❌ [MERCADOPAGO SERVICE] Client not found:', client_id);
        throw new Error('Cliente no encontrado');
      }

      console.log('✅ [MERCADOPAGO SERVICE] Client found:', client.email);

      // 4. Obtener datos del tenant
      const tenant = await Tenant.findByPk(tenant_id);

      // 5. Generar referencia externa única
      const timestamp = Date.now();
      const random = Math.random().toString(36).substr(2, 9);
      const externalReference = `MP-${timestamp}-${random}`;

      console.log(
        '🔑 [MERCADOPAGO SERVICE] Generated reference:',
        externalReference
      );

      // 6. Preparar URLs
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const apiUrl = process.env.API_URL || 'http://localhost:5000';

      const successUrl =
        tenantConfig.custom_success_url ||
        `${frontendUrl}/payments/mercadopago/success`;
      const failureUrl =
        tenantConfig.custom_failure_url ||
        `${frontendUrl}/payments/mercadopago/failure`;
      const pendingUrl =
        tenantConfig.custom_pending_url ||
        `${frontendUrl}/payments/mercadopago/pending`;
      const notificationUrl =
        tenantConfig.custom_notification_url ||
        `${apiUrl}/api/v1/mercadopago/webhook`;

      // 7. Crear preferencia en MercadoPago
      const preferenceData = {
        items: [
          {
            title: description || `Factura ${invoice.invoice_number}`,
            quantity: 1,
            unit_price: parseFloat(amount),
            currency_id: 'COP',
          },
        ],
        payer: {
          name: payer_data?.first_name || client.first_name,
          surname: payer_data?.last_name || client.last_name || '',
          email: payer_data?.email || client.email,
          identification: {
            type: payer_data?.identification_type || 'CC',
            number:
              payer_data?.identification_number || client.identification_number,
          },
        },
        back_urls: {
          success: successUrl,
          failure: failureUrl,
          pending: pendingUrl,
        },
        // ⭐ QUITAR auto_return COMPLETAMENTE
        // auto_return: 'all',  // ❌ ESTO CAUSA EL ERROR
        external_reference: externalReference,
        notification_url: notificationUrl,
        statement_descriptor:
          tenantConfig.statement_descriptor ||
          tenant?.company_name?.substring(0, 50),
        binary_mode: tenantConfig.binary_mode || false,
        metadata: {
          tenant_id,
          invoice_id,
          client_id,
        },
      };

      console.log('📤 [MERCADOPAGO SERVICE] Calling MercadoPago API...');
      console.log('   - Mode:', tenantConfig.test_mode ? 'TEST' : 'PRODUCTION');
      console.log(
        '   - Access Token starts with:',
        tenantConfig.access_token.substring(0, 15) + '...'
      );
      console.log(
        '   - Preference data:',
        JSON.stringify(preferenceData, null, 2)
      );

      // ⭐ SIEMPRE llamar a MercadoPago API (test o producción)
      const response = await axios.post(
        `${this.apiBaseUrl}/checkout/preferences`,
        preferenceData,
        {
          headers: {
            Authorization: `Bearer ${tenantConfig.access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const preference = response.data;

      console.log(
        '✅ [MERCADOPAGO SERVICE] Preference created:',
        preference.id
      );
      console.log('   - Init Point:', preference.init_point);
      console.log('   - Sandbox Init Point:', preference.sandbox_init_point);

      // 8. Crear transacción en BD
      const transaction = await MercadoPagoTransaction.create({
        tenant_id,
        client_id,
        invoice_id,
        preference_id: preference.id,
        amount,
        status: 'pending',
        description: description || `Factura ${invoice.invoice_number}`,
        external_reference: externalReference,
        init_point: preference.init_point,
        sandbox_init_point: preference.sandbox_init_point,
        currency_id: 'COP',
        payer_email: payer_data?.email || client.email,
        payer_identification_type: payer_data?.identification_type || 'CC',
        payer_identification_number:
          payer_data?.identification_number || client.identification_number,
        payer_first_name: payer_data?.first_name || client.first_name,
        payer_last_name: payer_data?.last_name || client.last_name,
        ip_address: '127.0.0.1',
      });

      console.log(
        '✅ [MERCADOPAGO SERVICE] Transaction created in DB:',
        transaction.id
      );

      // 9. Retornar datos para el frontend
      return {
        id: transaction.id,
        preference_id: preference.id,
        init_point: preference.init_point,
        sandbox_init_point: preference.sandbox_init_point,
        amount: transaction.amount,
        status: transaction.status,
        external_reference: externalReference,
      };
    } catch (error) {
      console.error(
        '❌ [MERCADOPAGO SERVICE] Error creating preference:',
        error.response?.data || error.message || error
      );
      throw error;
    }
  }

  /**
   * Consultar estado de un pago en MercadoPago
   */
  async checkPaymentStatus(paymentIdMP, tenantId) {
    try {
      console.log(
        '🔍 [MERCADOPAGO SERVICE] Checking payment status:',
        paymentIdMP
      );

      const tenantConfig = await this.getTenantConfig(tenantId);

      // Consultar API de MercadoPago
      const response = await axios.get(
        `${this.apiBaseUrl}/v1/payments/${paymentIdMP}`,
        {
          headers: {
            Authorization: `Bearer ${tenantConfig.access_token}`,
          },
        }
      );

      return response.data;
    } catch (error) {
      console.error('❌ [MERCADOPAGO SERVICE] Error checking payment:', error);
      throw error;
    }
  }

  /**
   * Procesar notificación de webhook de MercadoPago
   */
  async processWebhook(data, query) {
    try {
      console.log('🔔 [MERCADOPAGO SERVICE] Processing webhook:', {
        data,
        query,
      });

      const { type } = query;
      const { id: notificationId } = data;

      if (type === 'payment') {
        const paymentIdMP = query.data_id || data.data?.id;

        if (!paymentIdMP) {
          console.error('❌ [MERCADOPAGO SERVICE] No payment ID in webhook');
          return;
        }

        // Buscar transacción por payment_id_mp
        const transaction = await MercadoPagoTransaction.findOne({
          where: { payment_id_mp: paymentIdMP },
        });

        if (!transaction) {
          console.error(
            '❌ [MERCADOPAGO SERVICE] Transaction not found for payment:',
            paymentIdMP
          );
          return;
        }

        // Obtener información del pago
        const paymentInfo = await this.checkPaymentStatus(
          paymentIdMP,
          transaction.tenant_id
        );

        // Actualizar transacción
        transaction.status = paymentInfo.status;
        transaction.status_detail = paymentInfo.status_detail;
        transaction.payment_type = paymentInfo.payment_type_id;
        transaction.payment_method_id = paymentInfo.payment_method_id;
        transaction.mp_response_code = paymentInfo.status;
        transaction.mp_response_message = paymentInfo.status_detail;
        transaction.date_approved = paymentInfo.date_approved;
        transaction.date_last_updated = new Date();
        await transaction.save();

        console.log(
          '✅ [MERCADOPAGO SERVICE] Transaction updated:',
          transaction.status
        );

        // Si fue aprobado, crear pago automáticamente
        if (transaction.status === 'approved') {
          await this.createPaymentFromTransaction(transaction);
        }
      }
    } catch (error) {
      console.error(
        '❌ [MERCADOPAGO SERVICE] Error processing webhook:',
        error
      );
    }
  }

  /**
   * Crear registro de pago cuando transacción es aprobada
   */
  async createPaymentFromTransaction(transaction) {
    try {
      console.log(
        '💰 [MERCADOPAGO SERVICE] Creating payment from transaction:',
        transaction.id
      );

      // Verificar si ya existe un pago
      if (transaction.payment_id) {
        console.log('⚠️ [MERCADOPAGO SERVICE] Payment already exists');
        return;
      }

      // Crear pago
      const payment = await Payment.create({
        tenant_id: transaction.tenant_id,
        user_id: transaction.client_id,
        invoice_id: transaction.invoice_id,
        amount: transaction.amount,
        payment_method: 'online',
        payment_date: new Date(),
        status: 'confirmed',
        reference_number: transaction.external_reference,
        transaction_id: transaction.payment_id_mp,
        notes: `Pago MercadoPago - ${transaction.payment_method_id || 'Online'}`,
      });

      // Vincular pago con transacción
      transaction.payment_id = payment.id;
      await transaction.save();

      // Actualizar factura
      const invoice = await Invoice.findByPk(transaction.invoice_id);
      if (invoice) {
        const currentPaid = parseFloat(invoice.paid_amount || 0);
        const newPaid = currentPaid + parseFloat(transaction.amount);
        const total = parseFloat(invoice.total_amount);

        invoice.paid_amount = newPaid;
        invoice.status = newPaid >= total ? 'paid' : 'partially_paid';
        invoice.paid_date = newPaid >= total ? new Date() : null;
        await invoice.save();

        console.log(
          '✅ [MERCADOPAGO SERVICE] Invoice updated:',
          invoice.status
        );
      }

      console.log('✅ [MERCADOPAGO SERVICE] Payment created:', payment.id);

      return payment;
    } catch (error) {
      console.error('❌ [MERCADOPAGO SERVICE] Error creating payment:', error);
      throw error;
    }
  }

  /**
   * Listar transacciones con filtros
   */
  async listTransactions({
    tenant_id,
    status,
    invoice_id,
    page = 1,
    limit = 20,
  }) {
    try {
      const { Op } = require('sequelize');
      const where = { tenant_id };

      if (status) {
        where.status = status;
      }
      if (invoice_id) {
        where.invoice_id = invoice_id;
      }

      const offset = (page - 1) * limit;

      const { count, rows } = await MercadoPagoTransaction.findAndCountAll({
        where,
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset),
      });

      // Cargar datos relacionados
      const transactionsWithRelations = await Promise.all(
        rows.map(async (transaction) => {
          const txData = transaction.toJSON();

          if (transaction.invoice_id) {
            const invoice = await Invoice.findByPk(transaction.invoice_id, {
              attributes: ['id', 'invoice_number', 'total_amount'],
            });
            txData.invoice = invoice ? invoice.toJSON() : null;
          }

          return txData;
        })
      );

      return {
        data: transactionsWithRelations,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          total_pages: Math.ceil(count / limit),
        },
      };
    } catch (error) {
      console.error(
        '❌ [MERCADOPAGO SERVICE] Error listing transactions:',
        error
      );
      throw error;
    }
  }

  /**
   * Obtener estadísticas de transacciones
   */
  async getStats(tenantId) {
    try {
      const transactions = await MercadoPagoTransaction.findAll({
        where: { tenant_id: tenantId },
      });

      return {
        total: transactions.length,
        approved: transactions.filter((t) => t.status === 'approved').length,
        pending: transactions.filter((t) => t.status === 'pending').length,
        rejected: transactions.filter((t) => t.status === 'rejected').length,
        total_amount: transactions.reduce(
          (sum, t) => sum + parseFloat(t.amount || 0),
          0
        ),
        approved_amount: transactions
          .filter((t) => t.status === 'approved')
          .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0),
      };
    } catch (error) {
      console.error('❌ [MERCADOPAGO SERVICE] Error getting stats:', error);
      throw error;
    }
  }
}

module.exports = new MercadoPagoService();
