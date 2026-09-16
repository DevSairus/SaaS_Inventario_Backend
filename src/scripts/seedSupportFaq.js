#!/usr/bin/env node
// Seed de Preguntas Frecuentes (Centro de Soporte) para Pitbox.
// Tablas públicas (sin tenant_id): support_faq_categories / support_faq_articles.
// Idempotente: no duplica categorías (por name) ni artículos (por category_id + question);
// si ya existen, actualiza answer/order/is_active para que se pueda re-correr tras editar
// este archivo sin generar copias.
//
// Uso:
//   DATABASE_URL_DIRECT="postgresql://..." node src/scripts/seedSupportFaq.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { sequelize } = require('../config/database');
const { SupportFaqCategory, SupportFaqArticle } = require('../models');

// ─────────────────────────────────────────────────────────────────────────
// Contenido. Ajusta libremente y vuelve a correr el script para actualizar.
// ─────────────────────────────────────────────────────────────────────────
const FAQ_CATALOG = [
  {
    name: 'Primeros pasos y cuenta',
    order: 10,
    articles: [
      {
        question: '¿Cómo ingreso a Pitbox por primera vez?',
        answer:
          'Usa el correo y la contraseña que te compartió el administrador de tu empresa al crear tu usuario. Si es tu primer ingreso, te recomendamos cambiar la contraseña desde tu perfil apenas inicies sesión. Si tu empresa tiene varias sucursales, selecciona la sucursal con la que vas a trabajar antes de continuar.',
      },
      {
        question: 'Olvidé mi contraseña, ¿cómo la recupero?',
        answer:
          'En la pantalla de inicio de sesión usa la opción "¿Olvidaste tu contraseña?" e ingresa tu correo registrado; te llegará un enlace para crear una nueva. Si no te llega el correo, revisa spam o pídele a tu administrador que te la restablezca manualmente desde el módulo de usuarios.',
      },
      {
        question: '¿Cómo agrego un nuevo usuario o cambio su rol?',
        answer:
          'Un usuario con rol admin puede crear usuarios desde Configuración → Usuarios, asignando un rol (por ejemplo operario, asesor de facturación, contador, etc.). El rol define qué módulos y acciones puede ver o ejecutar esa persona; los permisos finos por rol se ajustan desde Configuración → Permisos.',
      },
      {
        question: '¿Puedo trabajar con varias sucursales o bodegas desde una sola cuenta?',
        answer:
          'Sí. Pitbox soporta múltiples sucursales y bodegas dentro de la misma empresa, según el plan contratado. Puedes cambiar de sucursal activa desde el selector superior, y cada sucursal puede tener su propio inventario, caja y usuarios asignados.',
      },
      {
        question: 'Mi sesión se cierra sola o me pide iniciar sesión de nuevo muy seguido',
        answer:
          'Por seguridad, la sesión expira tras un periodo de inactividad. Si trabajas con formularios largos (por ejemplo una orden de trabajo extensa), guarda avances parciales cuando sea posible. Si el cierre de sesión ocurre de forma inesperada y muy frecuente, repórtalo como ticket de soporte adjuntando la hora aproximada en que ocurrió.',
      },
    ],
  },
  {
    name: 'Planes, módulos y límites',
    order: 20,
    articles: [
      {
        question: '¿Cómo sé qué plan tiene mi empresa y qué incluye?',
        answer:
          'Desde Configuración → Suscripción puedes ver el plan activo y sus límites (usuarios, clientes, productos, bodegas, sucursales y facturas por mes). Si tu empresa necesita ampliar alguno de esos límites, comunícate con soporte o con tu administrador para gestionar un cambio de plan.',
      },
      {
        question: '¿Qué pasa si alcanzo el límite de usuarios, productos o facturas de mi plan?',
        answer:
          'Cuando se alcanza un límite del plan, Pitbox bloquea la creación de nuevos registros de ese tipo (por ejemplo, no dejará crear un nuevo usuario si ya llegaste al máximo) hasta que se libere espacio o se actualice el plan. El sistema te avisa en el momento con un mensaje indicando cuál límite se superó.',
      },
      {
        question: '¿Cómo activo un módulo adicional (Taller, CRM, Nómina, Ensambladora, etc.)?',
        answer:
          'Los módulos se activan a nivel de empresa y algunos dependen de otros (por ejemplo, Taller requiere Ventas e Inventario, y Nómina requiere Contabilidad y Tesorería). La activación la gestiona el equipo de Pitbox o tu administrador con permisos de superadmin; contacta a soporte indicando qué módulo necesitas.',
      },
      {
        question: '¿Los módulos que no uso afectan el costo de mi plan?',
        answer:
          'No, cada empresa solo paga por los módulos que tiene activos. Puedes revisar el detalle de módulos habilitados y sus dependencias desde Configuración → Módulos (visible según tu rol).',
      },
      {
        question: '¿Qué es NEXA y necesito un plan especial para usarlo?',
        answer:
          'NEXA es el asistente de inteligencia artificial de Pitbox, disponible como módulo independiente. Solo los roles con permiso (típicamente administrador, gerente o contador) pueden conversar con él y aprobar las acciones que proponga.',
      },
    ],
  },
  {
    name: 'Ventas y Facturación',
    order: 30,
    articles: [
      {
        question: '¿Cómo registro una venta o una cotización?',
        answer:
          'Desde el módulo de Ventas puedes crear una cotización y, una vez el cliente la aprueba, convertirla en venta sin volver a digitar los productos. Si tu empresa tiene el módulo Taller activo, una cotización también se puede convertir directamente en una orden de trabajo.',
      },
      {
        question: '¿Qué medios de pago puedo registrar en una venta?',
        answer:
          'Puedes registrar pagos en efectivo, con tarjeta, transferencia o los medios que tu empresa haya configurado, incluyendo pagos parciales o mixtos. Cada pago queda asociado a la sesión de caja abierta en ese momento.',
      },
      {
        question: '¿Puedo anular o corregir una venta ya facturada?',
        answer:
          'Una venta con factura electrónica emitida a la DIAN no se elimina; para corregirla se generan los documentos correspondientes (nota crédito o nota débito) desde el módulo de Facturación Electrónica, manteniendo la trazabilidad exigida por la norma.',
      },
      {
        question: '¿Cómo hago una devolución de un cliente?',
        answer:
          'Las devoluciones de clientes se gestionan desde el módulo de Ventas → Devoluciones, donde se indica el producto y el motivo; el sistema ajusta el inventario y, si aplica, genera la nota crédito electrónica asociada.',
      },
      {
        question: '¿Cómo se manejan los anticipos o abonos de clientes?',
        answer:
          'Los abonos anticipados de un cliente se registran en Cartera → Anticipos y quedan disponibles para aplicarse a una venta futura de ese mismo cliente, evitando manejar el dinero por fuera del sistema.',
      },
    ],
  },
  {
    name: 'Inventario y Productos',
    order: 40,
    articles: [
      {
        question: '¿Cómo creo un producto o repuesto nuevo?',
        answer:
          'Desde Inventario → Productos puedes crear un producto manualmente o importar varios a la vez desde una plantilla de Excel. Cada producto se asocia a una categoría, unidad de medida y, si aplica, a las equivalencias con referencias de otros proveedores.',
      },
      {
        question: '¿Cómo transfiero mercancía entre bodegas o sucursales?',
        answer:
          'Usa Inventario → Transferencias para mover stock entre bodegas o sucursales. La transferencia descuenta del origen y suma al destino una vez se confirma la recepción, dejando registro de quién la generó y quién la recibió.',
      },
      {
        question: '¿Cómo corrijo un error de stock (sobrante o faltante)?',
        answer:
          'Los ajustes de inventario (por conteo físico, avería o pérdida) se hacen desde Inventario → Ajustes, indicando el motivo. Estos movimientos quedan auditados y, según la configuración contable de tu empresa, pueden generar el asiento correspondiente.',
      },
      {
        question: '¿Pitbox me avisa cuando un producto está por agotarse?',
        answer:
          'Sí, el módulo de alertas de stock notifica cuando un producto llega al mínimo configurado, para que puedas generar la orden de compra a tiempo.',
      },
      {
        question: '¿Puedo tener el mismo repuesto con referencias distintas por marca o proveedor?',
        answer:
          'Sí, el módulo de Equivalencias te permite vincular un mismo producto interno con las referencias equivalentes de distintos fabricantes o proveedores, para encontrarlo sin importar con qué código lo busque el cliente o el técnico.',
      },
    ],
  },
  {
    name: 'Cartera y Cuentas por Cobrar',
    order: 50,
    articles: [
      {
        question: '¿Cómo veo cuánto me debe un cliente?',
        answer:
          'En Cartera → Cuentas por Cobrar puedes consultar el saldo pendiente por cliente, con el detalle de facturas vencidas y por vencer.',
      },
      {
        question: '¿Pitbox me avisa cuando una cartera está próxima a vencer?',
        answer:
          'Sí, el sistema genera alertas automáticas de cartera por vencer y vencida, visibles en el módulo de Cartera y, según la configuración, también por correo.',
      },
      {
        question: '¿Cómo registro el pago de una factura a crédito?',
        answer:
          'Desde Cartera → Cuentas por Cobrar selecciona la factura y registra el abono, total o parcial; el saldo del cliente se actualiza automáticamente y el pago queda reflejado en la sesión de caja o el medio de recaudo usado.',
      },
    ],
  },
  {
    name: 'Tesorería y Caja',
    order: 60,
    articles: [
      {
        question: '¿Cómo abro y cierro la caja del día?',
        answer:
          'Desde el módulo de Caja abre una sesión indicando el monto base con el que empiezas el turno. Al finalizar, ciérrala registrando el conteo real; Pitbox compara lo esperado (ventas y pagos del turno) contra lo contado y muestra si hay una diferencia.',
      },
      {
        question: '¿Puedo tener más de una caja abierta al mismo tiempo?',
        answer:
          'Sí, cada sucursal puede manejar sus propias sesiones de caja de forma independiente, según cómo esté configurada tu empresa.',
      },
      {
        question: '¿Dónde veo el flujo de caja o los egresos e ingresos del negocio?',
        answer:
          'El módulo de Tesorería → Flujo de Caja consolida los movimientos de ingreso y egreso (ventas, pagos a proveedores, gastos) para que tengas una vista completa del efectivo del negocio, más allá de una sola sesión de caja.',
      },
    ],
  },
  {
    name: 'Contabilidad',
    order: 70,
    articles: [
      {
        question: '¿Las ventas y compras generan asientos contables automáticamente?',
        answer:
          'Sí, cuando el módulo de Contabilidad está activo, las operaciones de Ventas, Inventario y Tesorería generan sus asientos automáticamente según el plan de cuentas configurado, para que no tengas que digitarlos manualmente.',
      },
      {
        question: '¿Puedo personalizar el plan de cuentas de mi empresa?',
        answer:
          'Sí, el plan de cuentas se configura por empresa desde el módulo de Contabilidad, y puedes ajustar a qué cuenta se contabiliza cada tipo de movimiento.',
      },
      {
        question: '¿Cómo genero reportes contables o financieros?',
        answer:
          'Desde Contabilidad → Reportes puedes generar los informes financieros disponibles según tu plan (por ejemplo balance y estado de resultados) para un rango de fechas determinado.',
      },
    ],
  },
  {
    name: 'Facturación Electrónica (DIAN)',
    order: 80,
    articles: [
      {
        question: '¿Cómo configuro la facturación electrónica DIAN por primera vez?',
        answer:
          'En Facturación Electrónica → Configuración cargas tu certificado digital y los datos de habilitación ante la DIAN, y en Resoluciones registras el rango de numeración autorizado. Puedes usar "Probar conexión" para validar que la configuración quedó correcta antes de facturar en producción.',
      },
      {
        question: 'Una factura quedó "rechazada" o "pendiente" ante la DIAN, ¿qué hago?',
        answer:
          'Revisa el detalle del evento en Facturación Electrónica → Eventos DIAN, donde aparece el motivo del rechazo. Corrige el dato señalado (por ejemplo un valor tributario o el documento del cliente) y reenvía la factura desde la misma venta.',
      },
      {
        question: '¿Cómo emito una nota crédito o nota débito?',
        answer:
          'Desde la venta ya facturada electrónicamente, usa la opción de crear nota crédito o nota débito, indicando el motivo. El documento se envía a la DIAN referenciando la factura original, tal como lo exige la norma.',
      },
      {
        question: '¿Qué es el "documento soporte" y cuándo debo usarlo?',
        answer:
          'El documento soporte se genera cuando compras a un proveedor que no está obligado a facturar electrónicamente. Se crea desde el módulo de Facturación Electrónica → Documento Soporte, y también admite notas de ajuste si hay que corregirlo después.',
      },
      {
        question: 'Mi certificado digital está por vencer, ¿cómo lo actualizo?',
        answer:
          'Usa "Diagnosticar certificado" en Facturación Electrónica → Configuración para ver la fecha de vencimiento. Cuando tengas el nuevo certificado emitido por tu entidad certificadora, cárgalo en el mismo módulo antes de que venza el actual para no interrumpir la facturación.',
      },
    ],
  },
  {
    name: 'CRM',
    order: 90,
    articles: [
      {
        question: '¿Para qué sirve el módulo de CRM en Pitbox?',
        answer:
          'El CRM te da una vista 360° del cliente (historial de compras, interacciones y oportunidades) y un pipeline para hacer seguimiento comercial, además de clasificar automáticamente a cada cliente como prospecto, activo, en riesgo o inactivo según su comportamiento reciente.',
      },
      {
        question: '¿Pitbox puede avisarme cuándo un cliente probablemente necesite volver a comprar o a mantenimiento?',
        answer:
          'Sí, si tu empresa tiene el módulo Taller activo junto con CRM, el sistema estima cuándo un cliente tendría su próximo servicio y, cuando se acerca esa ventana, puede generar automáticamente una oportunidad de recompra en el pipeline.',
      },
      {
        question: '¿Puedo recibir leads de Facebook o Instagram directamente en el CRM?',
        answer:
          'Sí, con el módulo de integración con Meta activo, los leads de Facebook e Instagram Lead Ads llegan directamente al pipeline del CRM sin captura manual.',
      },
      {
        question: '¿Cómo convierto una cotización o una oportunidad en una venta?',
        answer:
          'Desde la oportunidad o la cotización asociada usa la opción de convertir a venta (o a orden de trabajo, si tu empresa tiene Taller activo); no es necesario volver a digitar los datos del cliente ni los productos.',
      },
    ],
  },
  {
    name: 'Taller (Órdenes de trabajo)',
    order: 100,
    articles: [
      {
        question: '¿Cómo creo una orden de trabajo?',
        answer:
          'Puedes crear una orden de trabajo directamente o convertirla desde una cotización aprobada. En ella registras el vehículo, el diagnóstico, los repuestos y la mano de obra a facturar al cliente.',
      },
      {
        question: '¿Cómo agendo una cita de taller?',
        answer:
          'Desde el módulo de Citas puedes programar la cita del cliente indicando fecha, hora y servicio; el sistema envía recordatorios según la configuración de notificaciones de tu empresa.',
      },
      {
        question: '¿Puedo llevar el control del taller sin conexión a internet?',
        answer:
          'Pitbox incluye soporte limitado sin conexión (PWA) para ciertas pantallas de taller; los cambios se sincronizan automáticamente apenas se recupera la conexión.',
      },
      {
        question: '¿Cómo veo el historial de servicios de un vehículo o cliente?',
        answer:
          'El historial completo de órdenes de trabajo de un vehículo o cliente queda disponible desde su ficha, útil tanto para diagnóstico como para argumentar garantías.',
      },
    ],
  },
  {
    name: 'Ensambladora (CSA / PDV)',
    order: 110,
    articles: [
      {
        question: '¿Qué es el módulo Ensambladora dentro de Pitbox?',
        answer:
          'Es el módulo que usa un centro autorizado (CSA/PDV) para su operación diaria de alistamiento, entrega, revisión y garantía de vehículos, sincronizada con el sistema central (Core) de la ensambladora.',
      },
      {
        question: '¿Qué pasa si pierdo la conexión con el Core de la ensambladora?',
        answer:
          'Las operaciones locales del CSA/PDV se siguen registrando en Pitbox y se sincronizan con el Core automáticamente cuando la conexión se restablece.',
      },
      {
        question: '¿El módulo Ensambladora reemplaza al módulo Taller?',
        answer:
          'No, lo complementa: Ensambladora extiende el mismo patrón de órdenes de trabajo de Taller para los procesos específicos de alistamiento, entrega y garantía del centro autorizado.',
      },
    ],
  },
  {
    name: 'Nómina Electrónica',
    order: 120,
    articles: [
      {
        question: '¿Qué necesito tener activo para usar Nómina Electrónica?',
        answer:
          'El módulo de Nómina depende de Contabilidad y Tesorería, ya que cada comprobante de nómina genera su asiento contable automático y el pago al empleado se concilia como egreso de tesorería.',
      },
      {
        question: '¿Cómo genero un comprobante de nómina electrónica?',
        answer:
          'Desde Nómina → Periodos creas el periodo de pago, defines los devengos y deducciones de cada empleado según los conceptos configurados, y generas el comprobante electrónico correspondiente.',
      },
      {
        question: '¿Puedo hacer un ajuste o eliminar un comprobante ya emitido?',
        answer:
          'Sí, la nómina electrónica soporta notas de ajuste sobre un comprobante ya emitido, siguiendo el mismo tratamiento que exige la norma para nómina electrónica en Colombia.',
      },
      {
        question: '¿Puedo generar el certificado de ingresos y retenciones de un empleado?',
        answer:
          'Sí, desde Nómina → Certificados puedes generar el certificado anual de ingresos y retenciones en PDF para cada empleado, con el detalle de devengos y deducciones del periodo.',
      },
    ],
  },
  {
    name: 'NEXA (Asistente de IA)',
    order: 130,
    articles: [
      {
        question: '¿Qué puede hacer NEXA por mí?',
        answer:
          'NEXA es un asistente conversacional que entiende el contexto de tu empresa en Pitbox y puede ayudarte a consultar información o preparar acciones dentro del sistema (por ejemplo, un movimiento o un registro), pero siempre te muestra la propuesta antes de ejecutarla.',
      },
      {
        question: '¿Cualquier usuario puede usar NEXA?',
        answer:
          'No, por ahora solo los roles administrador, gerente y contador pueden conversar con NEXA y aprobar o rechazar sus propuestas.',
      },
      {
        question: '¿NEXA ejecuta cambios en mi empresa sin que yo lo confirme?',
        answer:
          'No. Cuando NEXA propone una acción concreta (como registrar algo en el sistema), la deja pendiente de tu aprobación explícita; nada se ejecuta hasta que la apruebes.',
      },
    ],
  },
  {
    name: 'Seguridad y permisos',
    order: 140,
    articles: [
      {
        question: '¿Cómo controlo qué puede ver o hacer cada empleado?',
        answer:
          'Desde Configuración → Permisos puedes ajustar, por rol, qué módulos y acciones tiene disponibles cada tipo de usuario (por ejemplo, un operario no verá lo mismo que un contador o un administrador).',
      },
      {
        question: '¿Un usuario puede tener acceso a datos de otra empresa (otro tenant)?',
        answer:
          'No. Pitbox aísla completamente la información de cada empresa (arquitectura multi-tenant); un usuario solo puede ver y operar sobre los datos de la empresa a la que pertenece su cuenta.',
      },
      {
        question: '¿Qué debo hacer si sospecho que mi cuenta fue accedida por alguien más?',
        answer:
          'Cambia tu contraseña de inmediato desde tu perfil y avisa a tu administrador para que revise el registro de accesos y, si es necesario, restablezca tus credenciales o revise los permisos de tu cuenta.',
      },
    ],
  },
  {
    name: 'Soporte y tickets',
    order: 150,
    articles: [
      {
        question: '¿Cómo contacto a soporte si no encuentro la respuesta aquí?',
        answer:
          'Desde el Centro de Soporte usa el botón "Crear ticket", describe tu problema con el mayor detalle posible (qué intentabas hacer, qué pasó y, si puedes, una captura de pantalla) y nuestro equipo te responderá según la prioridad asignada.',
      },
      {
        question: '¿Cómo hago seguimiento a un ticket que ya creé?',
        answer:
          'En "Mis Tickets" puedes ver el estado de cada solicitud (abierto, en progreso, esperando tu respuesta, resuelto o cerrado) y continuar la conversación con el agente asignado desde ahí mismo.',
      },
      {
        question: '¿Puedo calificar la atención que recibí?',
        answer:
          'Sí, cuando un ticket se marca como resuelto puedes calificar la atención recibida; esa calificación nos ayuda a mejorar el servicio de soporte.',
      },
    ],
  },
];

async function main() {
  await sequelize.authenticate();
  console.log('→ Conectado a la base de datos. Poblando FAQ del Centro de Soporte...\n');

  let catsCreated = 0;
  let catsUpdated = 0;
  let artsCreated = 0;
  let artsUpdated = 0;

  for (const cat of FAQ_CATALOG) {
    const [category, catWasCreated] = await SupportFaqCategory.findOrCreate({
      where: { name: cat.name },
      defaults: { name: cat.name, order: cat.order, is_active: true },
    });

    if (!catWasCreated) {
      await category.update({ order: cat.order, is_active: true });
      catsUpdated++;
    } else {
      catsCreated++;
    }

    console.log(`  ${catWasCreated ? '+ creada' : '~ actualizada'} categoría: ${cat.name}`);

    for (let i = 0; i < cat.articles.length; i++) {
      const art = cat.articles[i];
      const [article, artWasCreated] = await SupportFaqArticle.findOrCreate({
        where: { category_id: category.id, question: art.question },
        defaults: {
          category_id: category.id,
          question: art.question,
          answer: art.answer,
          order: i * 10,
          is_active: true,
        },
      });

      if (!artWasCreated) {
        await article.update({ answer: art.answer, order: i * 10, is_active: true });
        artsUpdated++;
      } else {
        artsCreated++;
      }
    }
  }

  console.log('\n✔ Listo.');
  console.log(`  Categorías → creadas: ${catsCreated}, actualizadas: ${catsUpdated}`);
  console.log(`  Artículos  → creados: ${artsCreated}, actualizados: ${artsUpdated}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('✖ Error poblando FAQ:', err);
  process.exit(1);
});
