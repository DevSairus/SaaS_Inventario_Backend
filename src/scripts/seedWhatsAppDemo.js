#!/usr/bin/env node
// Seed WhatsApp demo (modo local sin Meta) para Empresa de Pruebas.
// Uso:
//   DATABASE_URL_DIRECT="postgresql://..." node src/scripts/seedWhatsAppDemo.js [slug]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { sequelize } = require('../config/database');
const { runWithTenantSchema } = require('../config/tenantContext');
const {
  User,
  Customer,
  WaConversation,
  WaMessage,
  TenantMetaConfig,
} = require('../models');

async function main() {
  const slug = process.argv[2] || 'empresa-de-pruebas';
  await sequelize.authenticate();

  const [[tenant]] = await sequelize.query(
    `SELECT id, schema_name, company_name FROM public.tenants WHERE slug = :slug`,
    { replacements: { slug } }
  );
  if (!tenant) {
    console.error(`Tenant slug=${slug} no encontrado`);
    process.exit(1);
  }

  const tenantId = tenant.id;
  const schemaName = tenant.schema_name;
  console.log(`→ WhatsApp demo en ${tenant.company_name} (${schemaName})`);

  // Activar modo demo en public.tenant_meta_configs
  const [meta] = await TenantMetaConfig.findOrCreate({
    where: { tenant_id: tenantId },
    defaults: {
      tenant_id: tenantId,
      is_active: true,
      wa_demo_mode: true,
      own_display_phone: 'Demo Pitbox · Empresa de Pruebas',
      wa_coexistence: true,
    },
  });
  const displayPhone =
    slug === 'motos-estrada'
      ? 'Demo Pitbox · Motos Estrada'
      : meta.own_display_phone || 'Demo Pitbox · Empresa de Pruebas';

  await meta.update({
    is_active: true,
    wa_demo_mode: true,
    own_display_phone: displayPhone,
    wa_coexistence: true,
    last_error: null,
  });
  console.log('✓ Modo demo WA activado');

  const sellers = await User.findAll({
    where: { tenant_id: tenantId, is_active: true },
    order: [['role', 'ASC']],
    limit: 10,
  });
  const admin = sellers.find((u) => ['admin', 'manager', 'super_admin'].includes(u.role)) || sellers[0];
  const advisorA = sellers.find((u) => u.role === 'seller') || sellers[1] || admin;
  const advisorB = sellers.filter((u) => u.role === 'seller')[1] || advisorA;

  await runWithTenantSchema(schemaName, async () => {
    const customers = await Customer.findAll({
      where: { tenant_id: tenantId },
      limit: 8,
      order: [['created_at', 'ASC']],
    });

    const autoScenarios = [
      {
        phone: '573001112233',
        name: 'Laura Gómez',
        customer: customers[0],
        assignee: advisorA?.id,
        priority: 'high',
        marks: ['hot_lead', 'waiting_customer'],
        is_pinned: true,
        follow_up_hours: 2,
        note: 'Pidió cotización de kit de frenos. Seguir hoy.',
        messages: [
          { direction: 'in', body: 'Hola, buenas tardes. Necesito cotización de pastillas para un Spark GT 2020', hoursAgo: 5 },
          { direction: 'out', body: '¡Hola Laura! Claro, ¿me confirmas si es delantero o trasero?', hoursAgo: 4.8, user: advisorA },
          { direction: 'in', body: 'Delanteras. También me interesa el aceite 5W30', hoursAgo: 4.5 },
          { direction: 'out', body: 'Perfecto. Te preparo la cotización con instalación en taller. ¿Prefieres recoger o domicilio?', hoursAgo: 4.2, user: advisorA },
          { direction: 'in', body: 'Domicilio en Envigado por favor', hoursAgo: 0.3 },
        ],
      },
      {
        phone: '573104445566',
        name: 'Carlos Restrepo',
        customer: customers[1],
        assignee: advisorB?.id,
        priority: 'normal',
        marks: ['quote_sent'],
        is_pinned: false,
        follow_up_hours: 26,
        note: 'Cotización enviada ayer. Ventana 24h probablemente cerrada — usar plantilla.',
        messages: [
          { direction: 'in', body: 'Buenas, ¿cuánto sale el cambio de clutch de una Duster?', hoursAgo: 30 },
          { direction: 'out', body: 'Hola Carlos, te paso valores aproximados según kilometraje. ¿Cuántos km tiene?', hoursAgo: 29, user: advisorB },
          { direction: 'in', body: '120.000 km', hoursAgo: 28 },
          { direction: 'out', body: 'Te envié la cotización formal. Cuando quieras agendamos diagnóstico.', hoursAgo: 27, user: advisorB },
        ],
      },
      {
        phone: '573207778899',
        name: 'Ana Patricia Mejía',
        customer: customers[2],
        assignee: null,
        priority: 'urgent',
        marks: ['payment_pending'],
        is_pinned: false,
        follow_up_hours: 1,
        note: 'Sin asignar — cola admin. Cliente pregunta por factura.',
        messages: [
          { direction: 'in', body: 'Hola, compré ayer y no me llegó la factura al WhatsApp', hoursAgo: 1.2 },
          { direction: 'in', body: '¿Me pueden ayudar? Pedido con placa ABC123', hoursAgo: 0.9 },
        ],
      },
      {
        phone: '573159990011',
        name: 'Taller Hermanos Díaz',
        customer: customers[3],
        assignee: advisorA?.id,
        priority: 'normal',
        marks: ['appointment'],
        is_pinned: true,
        follow_up_hours: 48,
        note: 'Cuenta B2B. Cita para mañana 9am.',
        messages: [
          { direction: 'in', body: 'Necesitamos 4 amortiguadores KYB para un Captiva. ¿Tienen stock?', hoursAgo: 8 },
          { direction: 'out', body: 'Sí hay stock en sede principal. ¿Los enviamos o pasan?', hoursAgo: 7.5, user: advisorA },
          { direction: 'in', body: 'Pasamos mañana a las 9', hoursAgo: 7 },
          { direction: 'out', body: 'Queda agendado. Los dejamos separados a nombre de Taller Hermanos Díaz.', hoursAgo: 6.8, user: advisorA },
        ],
      },
      {
        phone: '573001234567',
        name: 'Demo Cliente Foto',
        customer: null,
        assignee: advisorA?.id,
        priority: 'normal',
        marks: [],
        is_pinned: false,
        follow_up_hours: null,
        note: null,
        messages: [
          { direction: 'in', body: 'Les mando foto de la referencia que necesito', hoursAgo: 2, type: 'text' },
          {
            direction: 'in',
            body: '[imagen]',
            type: 'image',
            media_url: 'https://placehold.co/400x300/png?text=Ref+Repuesto',
            hoursAgo: 1.9,
          },
          { direction: 'out', body: 'Recibido. Es un filtro de aceite MANN W712. Te confirmo precio en un momento.', hoursAgo: 1.7, user: advisorA },
        ],
      },
    ];

    // Escenarios de concesionario / taller de motos (App Review + demo comercial)
    const motosScenarios = [
      {
        phone: '573001112233',
        name: 'Andrés López',
        customer: customers[0] || null,
        assignee: advisorA?.id,
        priority: 'high',
        marks: ['hot_lead', 'waiting_customer'],
        is_pinned: true,
        follow_up_hours: 2,
        note: 'Interesado en XR 190 nueva. Seguir hoy con disponibilidad y financiación.',
        messages: [
          { direction: 'in', body: 'Buenas, ¿tienen Honda XR 190 disponibles en Yarumal?', hoursAgo: 5 },
          { direction: 'out', body: '¡Hola Andrés! Sí, tenemos Motocicleta nueva XR 190 en Bodega Yarumal. ¿La quieres de contado o financiación?', hoursAgo: 4.8, user: advisorA },
          { direction: 'in', body: 'Financiación. ¿Qué papeles necesito?', hoursAgo: 4.5 },
          { direction: 'out', body: 'Cédula, recibo de servicio público y referencias. Te armo la cotización formal ahora.', hoursAgo: 4.2, user: advisorA },
          { direction: 'in', body: 'Perfecto, estoy por la zona esta tarde', hoursAgo: 0.3 },
        ],
      },
      {
        phone: '573104445566',
        name: 'Juliana Restrepo',
        customer: customers[1] || null,
        assignee: advisorB?.id,
        priority: 'normal',
        marks: ['quote_sent'],
        is_pinned: false,
        follow_up_hours: 26,
        note: 'Cotización de servicio enviada. Ventana 24h cerrada — responder con plantilla.',
        messages: [
          { direction: 'in', body: 'Hola, ¿cuánto vale el mantenimiento de una CB190R?', hoursAgo: 30 },
          { direction: 'out', body: 'Hola Juliana. Incluye aceite, filtro y revisión. ¿Cuántos km tiene la moto?', hoursAgo: 29, user: advisorB },
          { direction: 'in', body: '8.500 km', hoursAgo: 28 },
          { direction: 'out', body: 'Te envié la cotización por WhatsApp. Cuando quieras agendamos en taller.', hoursAgo: 27, user: advisorB },
        ],
      },
      {
        phone: '573207778899',
        name: 'Santiago Mejía',
        customer: customers[2] || null,
        assignee: null,
        priority: 'urgent',
        marks: ['payment_pending'],
        is_pinned: false,
        follow_up_hours: 1,
        note: 'Cola sin asignar. Cliente pide factura de compra.',
        messages: [
          { direction: 'in', body: 'Hola, ayer compré un casco y no me llegó la factura', hoursAgo: 1.2 },
          { direction: 'in', body: '¿Me ayudan? Mi cédula es la de la factura de ayer en Yarumal', hoursAgo: 0.9 },
        ],
      },
      {
        phone: '573159990011',
        name: 'Taller Rutas del Norte',
        customer: customers[3] || null,
        assignee: advisorA?.id,
        priority: 'normal',
        marks: ['appointment'],
        is_pinned: true,
        follow_up_hours: 48,
        note: 'Cliente B2B. Retiro de repuestos mañana 9am.',
        messages: [
          { direction: 'in', body: 'Necesitamos kit de arrastre para XR 150. ¿Hay stock?', hoursAgo: 8 },
          { direction: 'out', body: 'Sí hay en Bodega Yarumal. ¿Lo enviamos o pasan?', hoursAgo: 7.5, user: advisorA },
          { direction: 'in', body: 'Pasamos mañana a las 9', hoursAgo: 7 },
          { direction: 'out', body: 'Queda separado a nombre de Taller Rutas del Norte. ¡Los esperamos!', hoursAgo: 6.8, user: advisorA },
        ],
      },
      {
        phone: '573001234567',
        name: 'Demo Cliente Foto',
        customer: null,
        assignee: advisorA?.id,
        priority: 'normal',
        marks: [],
        is_pinned: false,
        follow_up_hours: null,
        note: null,
        messages: [
          { direction: 'in', body: 'Les mando foto de la pastilla de freno que necesito', hoursAgo: 2, type: 'text' },
          {
            direction: 'in',
            body: '[imagen]',
            type: 'image',
            media_url: 'https://placehold.co/400x300/png?text=Pastilla+Freno+Moto',
            hoursAgo: 1.9,
          },
          { direction: 'out', body: 'Recibido. Es pastilla delantera para XR. Te confirmo precio y stock en un momento.', hoursAgo: 1.7, user: advisorA },
        ],
      },
    ];

    const scenarios = slug === 'motos-estrada' ? motosScenarios : autoScenarios;

    let created = 0;
    for (const sc of scenarios) {
      const phone = sc.phone.replace(/\D/g, '');
      let [conv] = await WaConversation.findOrCreate({
        where: { tenant_id: tenantId, wa_contact_phone: phone },
        defaults: {
          tenant_id: tenantId,
          wa_contact_phone: phone,
          wa_contact_name: sc.name,
          customer_id: sc.customer?.id || null,
          assigned_user_id: sc.assignee || null,
          status: 'open',
          unread_count: 0,
          priority: sc.priority,
          marks: sc.marks,
          is_pinned: sc.is_pinned,
          internal_note: sc.note,
        },
      });

      await conv.update({
        wa_contact_name: sc.name,
        customer_id: sc.customer?.id || conv.customer_id,
        assigned_user_id: sc.assignee,
        priority: sc.priority,
        marks: sc.marks,
        is_pinned: sc.is_pinned,
        internal_note: sc.note,
        follow_up_at: sc.follow_up_hours != null
          ? new Date(Date.now() + sc.follow_up_hours * 3600 * 1000)
          : null,
      });

      // Limpiar mensajes demo previos de esta conversación
      await WaMessage.destroy({ where: { conversation_id: conv.id, source: 'demo' } });

      let lastInbound = null;
      let lastAt = null;
      let unread = 0;
      for (const m of sc.messages) {
        const createdAt = new Date(Date.now() - m.hoursAgo * 3600 * 1000);
        lastAt = createdAt;
        if (m.direction === 'in') {
          lastInbound = createdAt;
          unread += 1;
        }
        await WaMessage.create({
          tenant_id: tenantId,
          conversation_id: conv.id,
          direction: m.direction,
          type: m.type || 'text',
          body: m.body,
          media_url: m.media_url || null,
          meta_message_id: `demo_seed_${phone}_${createdAt.getTime()}`,
          status: m.direction === 'out' ? 'read' : 'received',
          sent_by_user_id: m.user?.id || null,
          source: 'demo',
          created_at: createdAt,
          updated_at: createdAt,
        });
      }

      // Si el último mensaje es outbound, unread = 0 para esa conversación "atendida"
      const lastMsg = sc.messages[sc.messages.length - 1];
      if (lastMsg?.direction === 'out') unread = 0;

      await conv.update({
        last_message_at: lastAt,
        last_inbound_at: lastInbound,
        unread_count: unread,
      });
      created += 1;
    }

    console.log(`✓ ${created} conversaciones demo listas`);
    console.log('  Asesores de ejemplo:', advisorA?.email, advisorB?.email);
    console.log('  Admin ve todas; cada seller solo las suyas + cola.');
  });

  console.log(`\nDemo listo. Entra a /crm/whatsapp en ${tenant.company_name}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
