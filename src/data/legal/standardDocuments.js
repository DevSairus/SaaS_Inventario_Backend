// backend/src/data/legal/standardDocuments.js
//
// Formatos estándar de Pitbox para:
//   - Autorización de tratamiento de datos personales (Habeas Data,
//     Ley 1581 de 2012). Base: 00 - Documentación/Autorización_Tratamiento_Datos.md
//   - Condiciones de ingreso del vehículo al taller.
//
// Ambos son Markdown con variables {{nombre}} que se llenan con los datos del
// tenant (ver buildDocumentVars en services/legal/consent.service.js). Un
// documento propio del tenant (business_config.habeas_data.custom_content)
// puede usar las mismas variables.
//
// Diferencias con el .md original: las casillas de "SÍ/NO AUTORIZO"
// publicidad (8.1) y la "Constancia del titular" (9) no van en el texto --
// la página pública las pide como controles, y la constancia la genera el
// sistema con la evidencia de aceptación (PDF). La sección 2.2 (taller) o
// 2.3 (comercio) se incluye según business_kind.

const VARIABLES = [
  { key: 'razon_social', label: 'Razón social o nombre del negocio' },
  { key: 'nit', label: 'NIT o identificación' },
  { key: 'ciudad', label: 'Ciudad / departamento' },
  { key: 'direccion', label: 'Dirección' },
  { key: 'correo', label: 'Correo de contacto' },
  { key: 'telefono', label: 'Teléfono' },
  { key: 'correo_datos', label: 'Correo para protección de datos' },
  { key: 'actividad', label: 'Descripción de la actividad comercial' },
  { key: 'url_politica', label: 'Enlace a la política de tratamiento' },
  { key: 'fecha_actualizacion', label: 'Fecha de actualización del documento' },
  { key: 'dias_bodegaje', label: 'Días antes de cobrar bodegaje (ingreso)' },
  { key: 'tarifa_bodegaje', label: 'Tarifa de bodegaje (ingreso)' },
  { key: 'tope_sin_aprobacion', label: 'Tope de gasto sin nueva aprobación (ingreso)' },
];

const WORKSHOP_PURPOSES = `### 2.2. Finalidades adicionales para servicios de taller

Cuando EL RESPONSABLE desarrolle actividades de mantenimiento, reparación o servicios técnicos para vehículos o motocicletas, podrá tratar los datos personales y la información asociada a los vehículos para:

a. Registrar los vehículos o motocicletas vinculados al cliente, incluyendo placa, marca, línea, modelo y demás características necesarias para prestar el servicio.

b. Elaborar cotizaciones, órdenes de trabajo, diagnósticos, presupuestos y registros de los servicios solicitados.

c. Gestionar mantenimientos preventivos, reparaciones, revisiones, instalaciones de repuestos y demás servicios contratados.

d. Registrar los trabajos efectuados, los repuestos utilizados, los insumos, las observaciones técnicas y el historial de servicios del vehículo.

e. Gestionar autorizaciones del cliente para la ejecución de trabajos, adquisición o instalación de repuestos y modificaciones del presupuesto.

f. Realizar seguimiento a los servicios prestados, informar sobre el estado de las reparaciones y comunicar novedades relacionadas con el vehículo.

g. Gestionar garantías, revisiones posteriores, reclamaciones y solicitudes relacionadas con los servicios efectuados.

h. Contactar al cliente para recordarle mantenimientos, revisiones o servicios que puedan resultar pertinentes para el vehículo, conforme a las autorizaciones otorgadas y las disposiciones aplicables.

Estas finalidades adicionales únicamente se aplicarán cuando correspondan a los servicios efectivamente prestados por EL RESPONSABLE.`;

const STORE_PURPOSES = `### 2.3. Finalidades adicionales para la comercialización de productos

Cuando EL RESPONSABLE desarrolle actividades comerciales de compra, venta, distribución o comercialización de productos, repuestos, accesorios u otros bienes, podrá tratar los datos personales para:

a. Administrar el registro de clientes y su información de contacto.

b. Elaborar cotizaciones, pedidos, comprobantes y documentos relacionados con las ventas.

c. Gestionar la disponibilidad de productos, la preparación y entrega de pedidos, las devoluciones y las garantías.

d. Administrar las transacciones comerciales, los pagos, las obligaciones pendientes y la cartera, cuando corresponda.

e. Informar al cliente sobre el estado de sus pedidos, novedades de entrega, cambios relacionados con sus compras y demás asuntos propios de la operación comercial.

f. Gestionar solicitudes de servicio posventa, reclamaciones y garantías de los productos adquiridos.`;

const STORE_ONLY_NOTE = `

Estas finalidades no autorizan por sí mismas el tratamiento de información sobre reparaciones, diagnósticos o historial de mantenimiento de vehículos cuando el establecimiento no presta dichos servicios.`;

/**
 * @param {'workshop'|'store'|'both'} businessKind
 */
function habeasDataStandard(businessKind = 'both') {
  const purposes = [];
  if (businessKind === 'workshop' || businessKind === 'both') purposes.push(WORKSHOP_PURPOSES);
  if (businessKind === 'store' || businessKind === 'both') {
    purposes.push(STORE_PURPOSES + (businessKind === 'store' ? STORE_ONLY_NOTE : ''));
  }

  return `# AUTORIZACIÓN PARA EL TRATAMIENTO DE DATOS PERSONALES

**Fecha de actualización:** {{fecha_actualizacion}}
**Responsable del tratamiento:** {{razon_social}}
**NIT o identificación:** {{nit}}

## 1. IDENTIFICACIÓN DEL RESPONSABLE

{{razon_social}}, identificado(a) con NIT o documento de identificación número {{nit}}, con domicilio en {{ciudad}}, dirección {{direccion}}, correo electrónico {{correo}} y teléfono {{telefono}}, en adelante EL RESPONSABLE, informa que realizará el tratamiento de datos personales conforme a la Ley 1581 de 2012, sus decretos reglamentarios y las demás disposiciones colombianas aplicables.

EL RESPONSABLE desarrolla actividades relacionadas con {{actividad}} y utiliza herramientas tecnológicas para administrar sus relaciones comerciales, clientes, productos, ventas y demás operaciones propias de su actividad.

## 2. FINALIDADES DEL TRATAMIENTO

Los datos personales serán recolectados, almacenados, organizados, utilizados, actualizados, consultados y, cuando corresponda legalmente, transmitidos a terceros o suprimidos, de acuerdo con las finalidades que se describen a continuación.

### 2.1. Finalidades generales

EL RESPONSABLE podrá tratar los datos personales para:

a. Identificar y registrar a sus clientes, proveedores, representantes y demás personas con las que mantenga relaciones comerciales.

b. Gestionar solicitudes de información, cotizaciones, pedidos, compras, ventas y demás operaciones comerciales.

c. Elaborar y administrar documentos comerciales, soportes de transacciones, facturas, cuentas de cobro y demás documentos que correspondan a la actividad del negocio.

d. Gestionar pagos, cartera, obligaciones pendientes, devoluciones, garantías y reclamaciones, según corresponda.

e. Mantener actualizada la información de contacto y el historial de las operaciones comerciales realizadas con el titular.

f. Atender solicitudes, peticiones, consultas, quejas y reclamos relacionados con los productos o servicios ofrecidos.

g. Cumplir las obligaciones legales, contables, tributarias, contractuales y administrativas que resulten aplicables.

h. Mantener la seguridad, integridad, trazabilidad y disponibilidad de la información relacionada con las operaciones comerciales.

i. Prevenir, detectar y gestionar posibles fraudes, suplantaciones, inconsistencias o usos no autorizados de los servicios.

j. Conservar la información durante los períodos exigidos por la legislación aplicable o mientras resulte necesario para las finalidades autorizadas, respetando las reglas de supresión y conservación legal.

${purposes.join('\n\n')}

### 2.4. Comunicaciones comerciales y publicidad

EL RESPONSABLE podrá utilizar los datos de contacto del titular para enviar información sobre promociones, descuentos, campañas publicitarias, nuevos productos, nuevos servicios y demás ofertas comerciales relacionadas con su actividad, **siempre que el titular haya otorgado la autorización correspondiente**.

Esta finalidad es independiente de las actividades necesarias para gestionar una compra, prestar un servicio, atender una garantía o cumplir obligaciones legales.

La negativa a recibir comunicaciones comerciales no impedirá el tratamiento de los datos que resulte necesario para ejecutar una relación contractual o cumplir obligaciones legales.

## 3. DATOS PERSONALES OBJETO DE TRATAMIENTO

Dependiendo de la relación comercial y de los servicios utilizados, EL RESPONSABLE podrá tratar las siguientes categorías de información:

- Datos de identificación: nombre, apellidos y tipo y número de documento, cuando sean necesarios.
- Datos de contacto: teléfono, correo electrónico, dirección y ciudad.
- Datos comerciales: cotizaciones, pedidos, compras, ventas, productos adquiridos, garantías y reclamaciones.
- Datos transaccionales: información relacionada con facturas, pagos, cartera y demás operaciones comerciales, según corresponda.
- Datos asociados a vehículos: placa, marca, línea, modelo y características del vehículo, cuando sean pertinentes para el servicio.
- Datos técnicos del servicio: órdenes de trabajo, mantenimientos, reparaciones, repuestos utilizados y observaciones técnicas, cuando correspondan.
- Datos de comunicaciones: solicitudes, consultas, quejas, reclamos y registros de atención.

EL RESPONSABLE deberá limitar la recolección a los datos pertinentes y necesarios para las finalidades informadas.

No se solicitarán datos sensibles salvo que exista una finalidad legítima que haga necesario su tratamiento y se cumplan los requisitos legales aplicables, incluida la autorización explícita cuando corresponda.

## 4. DERECHOS DEL TITULAR

De conformidad con la Ley 1581 de 2012, el titular de los datos personales tiene derecho a:

a. Conocer, actualizar y rectificar sus datos personales.

b. Solicitar prueba de la autorización otorgada, salvo las excepciones legales.

c. Ser informado, previa solicitud, sobre el uso que se ha dado a sus datos personales.

d. Presentar consultas y reclamos relacionados con el tratamiento de sus datos.

e. Solicitar la revocación de la autorización o la supresión de sus datos cuando proceda legalmente.

f. Acceder gratuitamente a sus datos personales objeto de tratamiento, en los términos legales.

g. Presentar quejas ante la Superintendencia de Industria y Comercio una vez agotado el trámite de consulta o reclamo ante EL RESPONSABLE, cuando así corresponda.

h. Abstenerse de responder preguntas sobre datos sensibles o sobre datos de niñas, niños y adolescentes, en los términos establecidos por la ley.

La revocación o supresión no procederá cuando exista un deber legal o contractual que obligue a conservar la información, o cuando concurra otra excepción legal aplicable.

## 5. CANALES PARA EL EJERCICIO DE LOS DERECHOS

El titular podrá presentar consultas, solicitudes o reclamos mediante los siguientes canales:

**Responsable:** {{razon_social}}

**Correo electrónico:** {{correo_datos}}

**Dirección física:** {{direccion}}

**Teléfono:** {{telefono}}

Las solicitudes serán atendidas conforme a los procedimientos y términos establecidos en la legislación colombiana vigente.

## 6. POLÍTICA DE TRATAMIENTO DE DATOS PERSONALES

EL RESPONSABLE informa que dispone de una Política de Tratamiento de Datos Personales en la que se describen las condiciones aplicables al tratamiento de la información, los procedimientos para ejercer los derechos del titular y los canales de atención correspondientes.

**Consulta de la política:** {{url_politica}}

El titular podrá consultar la política antes de otorgar su autorización.

## 7. USO DE PROVEEDORES TECNOLÓGICOS

Para administrar sus operaciones, EL RESPONSABLE podrá utilizar plataformas tecnológicas y proveedores que presten servicios de alojamiento, almacenamiento, procesamiento, mantenimiento, soporte y administración de sistemas de información.

Cuando resulte necesario, estos proveedores podrán acceder a los datos personales por cuenta de EL RESPONSABLE y conforme a las instrucciones, finalidades, medidas de seguridad y obligaciones contractuales y legales aplicables.

EL RESPONSABLE deberá procurar que dichos proveedores mantengan la confidencialidad de la información, implementen medidas de seguridad adecuadas y no utilicen los datos para finalidades propias no autorizadas.

Cuando el tratamiento involucre transmisiones o transferencias internacionales de datos personales, deberán cumplirse las condiciones y requisitos establecidos en la legislación colombiana.

## 8. DECLARACIÓN DE AUTORIZACIÓN

Declaro que he sido informado(a) de la identidad de EL RESPONSABLE, las finalidades del tratamiento de mis datos personales, mis derechos como titular y los canales disponibles para ejercerlos.

En consecuencia, autorizo de manera previa, expresa e informada a EL RESPONSABLE para recolectar, almacenar, organizar, utilizar, actualizar, consultar y realizar las demás operaciones de tratamiento que resulten necesarias para las finalidades descritas en este documento, dentro de los límites establecidos por la legislación aplicable.

Declaro que he tenido la oportunidad de consultar la Política de Tratamiento de Datos Personales de EL RESPONSABLE.

Entiendo que esta autorización se refiere exclusivamente a los tratamientos y finalidades que me han sido informados y no habilita el uso de mis datos para finalidades incompatibles o no autorizadas.

### 8.1. Autorización para comunicaciones comerciales

La autorización para recibir promociones, descuentos, ofertas, publicidad e información comercial (sección 2.4) es opcional y separada de la autorización para gestionar la relación comercial. Mi decisión sobre las comunicaciones comerciales no condiciona la prestación de los servicios ni la realización de las operaciones que sean necesarias para atender mi solicitud o cumplir las obligaciones legales correspondientes.
`;
}

const VEHICLE_INTAKE_STANDARD = `# CONDICIONES DE INGRESO DEL VEHÍCULO

{{razon_social}} (NIT {{nit}}), en adelante EL TALLER, recibe el vehículo descrito en esta acta en las condiciones registradas en el inventario de ingreso, y el cliente acepta las siguientes condiciones:

## 1. Estado del vehículo al ingreso

El cliente declara que el inventario de ingreso (kilometraje, nivel de combustible, estado de los elementos, observaciones y fotografías) refleja el estado en que entrega el vehículo. Los daños o faltantes no registrados en esta acta y que no sean atribuibles al servicio prestado no serán responsabilidad de EL TALLER.

## 2. Diagnóstico y pruebas

El cliente autoriza a EL TALLER a realizar la inspección y el diagnóstico necesarios sobre el problema reportado, incluyendo el desmontaje de piezas que se requiera para ello y las pruebas de ruta que el personal técnico considere necesarias, conducidas por personal autorizado de EL TALLER.

## 3. Trabajos y presupuesto

EL TALLER informará al cliente el diagnóstico y el presupuesto antes de ejecutar trabajos o instalar repuestos. Ningún trabajo adicional que supere {{tope_sin_aprobacion}} se realizará sin la aprobación previa del cliente, la cual podrá otorgarse por los medios electrónicos que EL TALLER disponga.

## 4. Objetos personales

EL TALLER no se hace responsable por dinero, documentos, objetos de valor u otros elementos personales dejados dentro del vehículo que no hayan sido registrados en el inventario de ingreso.

## 5. Repuestos reemplazados

Los repuestos reemplazados quedarán a disposición del cliente al momento de la entrega, salvo aquellos que deban entregarse al proveedor por garantía o disposición ambiental.

## 6. Retiro del vehículo y bodegaje

El cliente se compromete a retirar el vehículo una vez EL TALLER le informe que está listo. Transcurridos {{dias_bodegaje}} días calendario desde dicho aviso sin que el vehículo haya sido retirado, EL TALLER podrá cobrar bodegaje de {{tarifa_bodegaje}}.

## 7. Entrega

El vehículo se entregará al titular de esta orden o a quien presente autorización escrita de este, previo pago de los servicios prestados.

## 8. Aceptación

Al aceptar esta acta, el cliente declara que la información del inventario de ingreso es correcta y que conoce y acepta estas condiciones del servicio.
`;

module.exports = {
  VARIABLES,
  habeasDataStandard,
  VEHICLE_INTAKE_STANDARD,
};
