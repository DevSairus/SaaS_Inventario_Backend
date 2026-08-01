// src/scripts/seedDemoTenant.js
//
// Uso: DATABASE_URL_DIRECT="postgresql://..." node src/scripts/seedDemoTenant.js <slug>
//
// Puebla un tenant ya provisionado (schema-per-tenant) con datos de muestra
// para demos: usuarios con distintos roles, clientes, vehículos, productos,
// cotizaciones, órdenes de trabajo y el pipeline completo del CRM (oportunidades
// en cada etapa, tareas de seguimiento en cada estado, interacciones y tags).
//
// Idempotente a nivel de "no duplicar toda la corrida": si el tenant ya tiene
// oportunidades de CRM, asume que ya se corrió antes y no hace nada.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const models = require('../models');
const { runWithTenantSchema } = require('../config/tenantContext');
const { sequelize } = require('../config/database');

const {
  User, Branch, Warehouse, Product, Customer, Vehicle, Sale, SaleItem, WorkOrder, WorkOrderItem,
  Opportunity, FollowUpTask, CustomerInteraction, CustomerTag, CustomerTagAssignment,
} = models;

const DEMO_PASSWORD = 'Demo2026!';

async function main() {
  const slug = process.argv[2] || 'empresa-de-pruebas';

  await sequelize.authenticate();

  const [[tenant]] = await sequelize.query(
    `SELECT id, schema_name FROM public.tenants WHERE slug = :slug`,
    { replacements: { slug } }
  );
  if (!tenant) throw new Error(`No existe un tenant con slug "${slug}"`);

  const tenantId = tenant.id;
  const schemaName = tenant.schema_name;
  if (!schemaName) throw new Error(`El tenant "${slug}" no está cortado a schema-per-tenant todavía`);

  console.log(`Tenant: ${slug} (${tenantId}) — schema: ${schemaName}`);

  await runWithTenantSchema(schemaName, async () => {
    const existingOpps = await Opportunity.count({ where: { tenant_id: tenantId } });
    if (existingOpps > 0) {
      console.log(`Ya hay ${existingOpps} oportunidades en este tenant — asumo que el seed ya corrió. Nada que hacer.`);
      return;
    }

    // findOrCreate en cada bloque hace que una corrida anterior interrumpida
    // a mitad de camino (ej. por un error más adelante) se pueda re-ejecutar
    // sin duplicar lo que ya se alcanzó a crear.
    const branch = await Branch.findOne({ where: { tenant_id: tenantId } });
    const warehouse = await Warehouse.findOne({ where: { tenant_id: tenantId } });
    if (!branch) throw new Error('El tenant no tiene ninguna sucursal — provisiónala antes de seedear');

    // ── Usuarios con distintos roles ──────────────────────────────────────
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const usersData = [
      { email: 'gerente@empresadepruebas.demo', first_name: 'Laura', last_name: 'Gómez', role: 'manager' },
      { email: 'vendedor1@empresadepruebas.demo', first_name: 'Carlos', last_name: 'Ramírez', role: 'seller' },
      { email: 'vendedor2@empresadepruebas.demo', first_name: 'Daniela', last_name: 'Torres', role: 'seller' },
      { email: 'tecnico1@empresadepruebas.demo', first_name: 'Andrés', last_name: 'Pérez', role: 'technician' },
      { email: 'tecnico2@empresadepruebas.demo', first_name: 'Julián', last_name: 'Rojas', role: 'technician' },
      { email: 'bodega@empresadepruebas.demo', first_name: 'Marcela', last_name: 'Ruiz', role: 'warehouse_keeper' },
      { email: 'contabilidad@empresadepruebas.demo', first_name: 'Felipe', last_name: 'Castro', role: 'accountant' },
    ];
    const users = {};
    for (const u of usersData) {
      const [row] = await User.findOrCreate({
        where: { email: u.email },
        defaults: { tenant_id: tenantId, password_hash: passwordHash, is_active: true, ...u },
      });
      users[u.role + (users[u.role] ? '2' : '')] = row;
      console.log(`Usuario: ${u.email} / ${DEMO_PASSWORD} (${u.role})`);
    }
    const manager = users.manager;
    const seller1 = users.seller;
    const seller2 = users.seller2;
    const tech1 = users.technician;
    const tech2 = users.technician2;

    // ── Clientes ───────────────────────────────────────────────────────────
    const customersData = [
      { customer_type: 'individual', first_name: 'Juan Pablo Martínez', phone: '3011234567', email: 'juanpablo@example.com', lifecycle_stage: 'activo' },
      { customer_type: 'company', first_name: 'Talleres', business_name: 'Talleres El Rápido S.A.S', phone: '3021234567', email: 'contacto@elrapido.com', lifecycle_stage: 'activo' },
      { customer_type: 'individual', first_name: 'María Fernanda López', phone: '3031234567', email: 'mafe@example.com', lifecycle_stage: 'prospecto' },
      { customer_type: 'individual', first_name: 'Ricardo Salazar', phone: '3041234567', email: 'ricardo@example.com', lifecycle_stage: 'en_riesgo' },
      { customer_type: 'company', first_name: 'Transportes', business_name: 'Transportes Andinos Ltda', phone: '3051234567', email: 'info@andinos.com', lifecycle_stage: 'inactivo' },
    ];
    const customers = [];
    for (const c of customersData) {
      const [row] = await Customer.findOrCreate({
        where: { tenant_id: tenantId, email: c.email },
        defaults: { tenant_id: tenantId, is_active: true, ...c },
      });
      customers.push(row);
    }
    const [custJuan, custTalleres, custMafe, custRicardo, custAndinos] = customers;
    const custSergio = await Customer.findOne({ where: { tenant_id: tenantId } });

    // ── Productos adicionales ────────────────────────────────────────────
    const productsData = [
      { product_type: 'simple', sku: 'FIL-001', name: 'Filtro de aceite', unit_of_measure: 'unit', sale_price: 25000, average_cost: 12000 },
      { product_type: 'service', sku: 'SRV-ACE', name: 'Cambio de aceite', unit_of_measure: 'unit', sale_price: 80000, average_cost: 30000 },
      { product_type: 'simple', sku: 'FRE-001', name: 'Pastillas de freno', unit_of_measure: 'unit', sale_price: 60000, average_cost: 28000 },
      { product_type: 'simple', sku: 'KIT-001', name: 'Kit de arrastre', unit_of_measure: 'unit', sale_price: 150000, average_cost: 90000 },
    ];
    for (const p of productsData) {
      await Product.findOrCreate({ where: { tenant_id: tenantId, sku: p.sku }, defaults: { tenant_id: tenantId, is_active: true, ...p } });
    }

    // ── Vehículos ────────────────────────────────────────────────────────
    const [vehJuan] = await Vehicle.findOrCreate({
      where: { tenant_id: tenantId, plate: 'ABC123' },
      defaults: { tenant_id: tenantId, customer_id: custJuan.id, plate: 'ABC123', vehicle_type: 'automovil', brand: 'Chevrolet', model: 'Spark', year: 2019, is_active: true },
    });
    const [vehRicardo] = await Vehicle.findOrCreate({
      where: { tenant_id: tenantId, plate: 'XYZ789' },
      defaults: { tenant_id: tenantId, customer_id: custRicardo.id, plate: 'XYZ789', vehicle_type: 'motocicleta', brand: 'Yamaha', model: 'FZ 2.0', year: 2021, is_active: true },
    });
    const vehSergio = await Vehicle.findOne({ where: { tenant_id: tenantId, customer_id: custSergio.id } });

    // ── Cotizaciones (Sale con document_type='cotizacion') ──────────────
    const quotesData = [
      { sale_number: 'COT-2026-0001', customer: custJuan, status: 'draft', total: 105000 },
      { sale_number: 'COT-2026-0002', customer: custMafe, status: 'pending', total: 240000 },
      { sale_number: 'COT-2026-0003', customer: custTalleres, status: 'completed', total: 480000 },
      { sale_number: 'COT-2026-0004', customer: custRicardo, status: 'cancelled', total: 60000 },
    ];
    const quotes = [];
    for (const q of quotesData) {
      const [row] = await Sale.findOrCreate({
        where: { tenant_id: tenantId, sale_number: q.sale_number },
        defaults: {
          tenant_id: tenantId, branch_id: branch.id, warehouse_id: warehouse?.id,
          sale_number: q.sale_number, document_type: 'cotizacion', status: q.status,
          customer_id: q.customer.id, customer_name: q.customer.business_name || q.customer.first_name,
          customer_phone: q.customer.phone, customer_email: q.customer.email,
          subtotal: q.total, tax_amount: 0, total_amount: q.total, created_by: seller1.id,
        },
      });
      quotes.push(row);
      const existingItem = await SaleItem.findOne({ where: { sale_id: row.id } });
      if (!existingItem) {
        await SaleItem.create({
          tenant_id: tenantId, sale_id: row.id, item_type: 'free_line',
          product_name: 'Mano de obra + repuestos (línea de demo)', quantity: 1,
          unit_price: q.total, subtotal: q.total, total: q.total,
        });
      }
    }

    // ── Órdenes de trabajo ───────────────────────────────────────────────
    const workOrdersData = [
      { order_number: 'OT-2026-0002', vehicle: vehSergio, customer: custSergio, technician: tech1, status: 'en_proceso', problem: 'Ruido en motor al acelerar' },
      { order_number: 'OT-2026-0003', vehicle: vehJuan, customer: custJuan, technician: tech2, status: 'listo', problem: 'Cambio de pastillas de freno' },
      { order_number: 'OT-2026-0004', vehicle: vehSergio, customer: custSergio, technician: tech1, status: 'entregado', problem: 'Mantenimiento preventivo 5,000 km' },
      { order_number: 'OT-2026-0005', vehicle: vehRicardo, customer: custRicardo, technician: tech2, status: 'cancelado', problem: 'Revisión de frenos traseros' },
    ];
    for (const wo of workOrdersData) {
      const now = new Date();
      const [row] = await WorkOrder.findOrCreate({
        where: { tenant_id: tenantId, order_number: wo.order_number },
        defaults: {
          tenant_id: tenantId, order_number: wo.order_number, vehicle_id: wo.vehicle.id,
          customer_id: wo.customer.id, technician_id: wo.technician.id, warehouse_id: warehouse?.id,
          status: wo.status, problem_description: wo.problem,
          completed_at: ['listo', 'entregado'].includes(wo.status) ? now : null,
          delivered_at: wo.status === 'entregado' ? now : null,
          subtotal: 80000, tax_amount: 15200, total_amount: 95200,
        },
      });
      const existingItem = await WorkOrderItem.findOne({ where: { work_order_id: row.id } });
      if (!existingItem) {
        await WorkOrderItem.create({
          tenant_id: tenantId, work_order_id: row.id, item_type: 'mano_obra',
          product_name: 'Mano de obra (línea de demo)', quantity: 1,
          unit_price: 80000, tax_percentage: 19, tax_amount: 15200, subtotal: 80000, total: 95200,
        });
      }
    }

    // ── CRM: Tags ────────────────────────────────────────────────────────
    const [tagVip] = await CustomerTag.findOrCreate({ where: { tenant_id: tenantId, name: 'VIP' }, defaults: { tenant_id: tenantId, name: 'VIP', color: '#F59E0B' } });
    const [tagRecurrente] = await CustomerTag.findOrCreate({ where: { tenant_id: tenantId, name: 'Recurrente' }, defaults: { tenant_id: tenantId, name: 'Recurrente', color: '#10B981' } });
    await CustomerTagAssignment.findOrCreate({ where: { customer_id: custSergio.id, customer_tag_id: tagVip.id }, defaults: { tenant_id: tenantId, customer_id: custSergio.id, customer_tag_id: tagVip.id } });
    await CustomerTagAssignment.findOrCreate({ where: { customer_id: custTalleres.id, customer_tag_id: tagRecurrente.id }, defaults: { tenant_id: tenantId, customer_id: custTalleres.id, customer_tag_id: tagRecurrente.id } });

    // ── CRM: Oportunidades (una por etapa del pipeline) ──────────────────
    const opportunitiesData = [
      { customer: custJuan, owner: seller1, source: 'walk_in', stage: 'nuevo', expected_value: 105000 },
      { customer: custMafe, owner: seller2, source: 'whatsapp', stage: 'contactado', expected_value: 240000 },
      { customer: custTalleres, owner: seller1, source: 'referido', stage: 'cotizado', expected_value: 480000, quote_sale_id: quotes[2].id },
      { customer: custRicardo, owner: seller2, source: 'llamada', stage: 'negociacion', expected_value: 60000 },
      { customer: custSergio, owner: seller1, source: 'recompra_recurrente', stage: 'ganado', expected_value: 350000 },
      { customer: custAndinos, owner: seller2, source: 'web', stage: 'perdido', expected_value: 200000, lost_reason: 'precio' },
    ];
    const opportunities = [];
    for (const o of opportunitiesData) {
      const row = await Opportunity.create({
        tenant_id: tenantId, branch_id: branch.id, customer_id: o.customer.id, owner_user_id: o.owner.id,
        source: o.source, stage: o.stage, expected_value: o.expected_value,
        quote_sale_id: o.quote_sale_id || null, lost_reason: o.lost_reason || null,
        stage_changed_at: new Date(),
      });
      opportunities.push(row);
    }

    // ── CRM: Tareas de seguimiento (una por estado) ──────────────────────
    const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
    const followUpsData = [
      { title: 'Llamar para confirmar interés', due_at: inDays(2), status: 'pendiente', opportunity: opportunities[0], customer: custJuan, assigned: seller1 },
      { title: 'Enviar cotización actualizada', due_at: inDays(-3), status: 'pendiente', opportunity: opportunities[1], customer: custMafe, assigned: seller2 },
      { title: 'Seguimiento post-venta', due_at: inDays(-1), status: 'vencida', opportunity: opportunities[2], customer: custTalleres, assigned: seller1 },
      { title: 'Confirmar fecha de entrega', due_at: inDays(-5), status: 'hecha', opportunity: opportunities[4], customer: custSergio, assigned: seller1, completed_at: new Date() },
      { title: 'Reintentar contacto', due_at: inDays(1), status: 'cancelada', opportunity: opportunities[5], customer: custAndinos, assigned: seller2 },
    ];
    for (const f of followUpsData) {
      await FollowUpTask.create({
        tenant_id: tenantId, branch_id: branch.id, customer_id: f.customer.id, opportunity_id: f.opportunity.id,
        assigned_to_user_id: f.assigned.id, created_by_user_id: manager.id,
        title: f.title, due_at: f.due_at, status: f.status, completed_at: f.completed_at || null,
      });
    }

    // ── CRM: Interacciones registradas ───────────────────────────────────
    const interactionsData = [
      { customer: custJuan, user: seller1, type: 'llamada', summary: 'Cliente pidió que lo llamen la próxima semana', outcome: 'neutral' },
      { customer: custMafe, user: seller2, type: 'whatsapp', summary: 'Envió fotos del vehículo por WhatsApp', outcome: 'positivo' },
      { customer: custTalleres, user: seller1, type: 'visita', summary: 'Visita al taller para revisar flota', outcome: 'positivo' },
      { customer: custRicardo, user: seller2, type: 'nota', summary: 'No contesta llamadas hace 2 semanas', outcome: 'negativo' },
    ];
    for (const i of interactionsData) {
      await CustomerInteraction.create({
        tenant_id: tenantId, branch_id: branch.id, customer_id: i.customer.id, user_id: i.user.id,
        type: i.type, summary: i.summary, outcome: i.outcome,
      });
    }

    console.log('\n✅ Seed de demo completado.');
    console.log('\nUsuarios de demo (todos con password: ' + DEMO_PASSWORD + '):');
    usersData.forEach((u) => console.log(`  - ${u.email} (${u.role})`));
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('❌', err); process.exit(1); });
