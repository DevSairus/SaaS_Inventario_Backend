# WhatsApp Business (Cloud API + Coexistencia) en Pitbox

Este documento explica cómo funciona la integración de WhatsApp end-to-end:
arquitectura, modelo de datos, aislamiento multi-tenant, seguridad, y el
registro de las correcciones aplicadas el 2026-08-04. Está pensado para que
cualquiera del equipo (o un asistente de IA en una sesión futura) entienda el
sistema sin tener que releer todo el código.

> **Lineamiento de producto**: esto es **WhatsApp Business Platform (Cloud
> API) con coexistencia**, no un cliente no oficial de WhatsApp. El número del
> tenant se conecta vía **Embedded Signup** de Meta y sigue siendo usable
> simultáneamente desde la app WhatsApp Business del celular del negocio —
> Pitbox no reemplaza esa app, la complementa. No hay (ni debe haber) ninguna
> automatización tipo wppconnect/whatsapp-web.js que dependa de una sesión de
> WhatsApp Web — eso violaría los Términos de Servicio de WhatsApp y arriesga
> el número. La única pieza "wa.me" que existe (`whatsapp.controller.js` /
> `whatsappService.js`, rutas `/api/whatsapp/*`) es el método
> **oficialmente soportado** de click-to-chat (enlaces `https://wa.me/...`),
> usado como fallback simple para enviar facturas/documentos sin necesitar
> WhatsApp Cloud API conectado.

---

## 1. Dos integraciones, un mismo webhook

Pitbox tiene DOS integraciones distintas con Meta que comparten la misma App
de Meta for Developers y el mismo endpoint de webhook (`/api/webhooks/meta`):

1. **Lead Ads** (Facebook/Instagram) — leads de formularios de anuncios se
   convierten en `Customer` + `Opportunity` en el CRM.
2. **WhatsApp Cloud API** — mensajería con clientes desde un inbox dentro de
   Pitbox (`WhatsAppInboxPage.jsx`).

Ambas comparten:
- Una **App de Meta única** (`MetaConfig`, fila singleton en `public`) con
  `app_id`/`app_secret` — necesaria para los diálogos OAuth y para firmar
  webhooks.
- El **mismo endpoint HTTP** de webhook, que distingue el tipo de evento por
  `payload.object` (`"page"` → Lead Ads, `"whatsapp_business_account"` →
  WhatsApp).

Cada tenant se conecta de forma independiente en `TenantMetaConfig` (una fila
por tenant), en modo:
- `own` — el tenant conectó su propia cuenta de Meta Business (OAuth propio
  para Lead Ads, Embedded Signup propio para WhatsApp).
- `pitbox` — el tenant usa la página/WABA **compartida** de Pitbox (soporte
  hace el mapeo manual de qué leads/números pertenecen a qué tenant).

## 2. Modelo de datos

| Tabla | Schema | Qué guarda |
|---|---|---|
| `meta_config` | `public` (singleton) | App ID/Secret de Meta, verify token del webhook, credenciales del modo compartido "pitbox". **Secretos cifrados en reposo** (ver §4). |
| `tenant_meta_configs` | `public` (**no** por-tenant, a propósito — ver §3) | Conexión de cada tenant: `provider_mode`, `own_waba_id`, `own_phone_number_id`, `own_access_token` (cifrado), `wa_coexistence`, `wa_demo_mode`. |
| `wa_conversations` | por-tenant | Una fila por contacto de WhatsApp: `wa_contact_phone`, `assigned_user_id`, `unread_count`, `last_inbound_at` (clave para la ventana de 24h), `is_pinned`, `priority`, `marks`, `follow_up_at`. |
| `wa_messages` | por-tenant | Cada mensaje entrante/saliente, `meta_message_id` (dedupe), `status` (sent/delivered/read/failed), `direction`, `source` (`webhook`/`api`/`app_echo`/`automation`/`broadcast`/`demo`). |
| `wa_templates`, `wa_reminder_jobs`, `wa_campaigns`, `wa_campaign_recipients` | por-tenant | Plantillas sincronizadas desde Meta, recordatorios programados y campañas masivas. |

## 3. Aislamiento multi-tenant — por qué nunca se deben cruzar los datos

Esto es lo más sensible de todo el sistema: un cliente **jamás** debe poder
ver conversaciones/leads de otro. Las garantías, de abajo hacia arriba:

1. **Todas las tablas de negocio son *schema-per-tenant*** (`wa_conversations`,
   `wa_messages`, `Customer`, etc. viven en `tenant_<slug>`, no en `public`).
   El *search_path* de cada request se fija según el tenant autenticado
   (`tenantMiddleware` → `runWithTenantSchema`), y `registerTenantSchemaHooks.js`
   hace que **todas** las queries de esos modelos (incluidos los `include`)
   resuelvan dinámicamente contra el schema del tenant actual — no hay forma
   de que una query "se olvide" el filtro de tenant.

2. **`MetaConfig`/`TenantMetaConfig` viven a propósito en `public`** (no son
   *schema-per-tenant*) porque cuando llega un webhook de Meta, Pitbox
   todavía no sabe a qué tenant pertenece — necesita resolverlo primero por
   `page_id` / `waba_id` / `phone_number_id` / `form_id`, ANTES de poder fijar
   un *search_path*. Por eso están en la lista `PUBLIC_SCHEMA_MODELS` de
   `registerTenantSchemaHooks.js`: nunca heredan el schema dinámico del
   request, siempre se consultan contra `public`, venga o no de un contexto
   de tenant.

3. **Resolución de tenant por `phone_number_id` para mensajes entrantes**
   (`resolverTenantByPhoneNumberId` en `whatsappCloud.service.js`): busca en
   `public.tenant_meta_configs` la fila `is_active=true` cuyo
   `own_phone_number_id` coincide con el del webhook. **Esta es la pieza que
   más importa para que dos tenants no se crucen**, porque decide a qué
   inbox entra cada mensaje del cliente final.

4. **Corrección aplicada (2026-08-04): verificación de propiedad +
   constraint único.** Antes, `completeEmbeddedSignup` guardaba el
   `phone_number_id` que llegaba en el body del request sin verificar que
   realmente perteneciera al token recién obtenido, y no existía ningún
   constraint que impidiera a dos tenants activos compartir el mismo
   `phone_number_id`. Ahora:
   - `whatsappCloud.service.js::completeEmbeddedSignup` llama a
     `GET /{waba_id}/phone_numbers` con el access token recién canjeado y
     **rechaza** la conexión (`403`) si el `phone_number_id` del body no
     aparece en esa lista.
   - Si el número ya está activo en OTRO tenant, se rechaza con `409` antes
     de guardar nada.
   - Migración `2026080601-unique-active-wa-phone-number.js` agrega un
     **índice único parcial** en Postgres:
     `UNIQUE (own_phone_number_id) WHERE is_active AND own_phone_number_id IS NOT NULL`
     — la base de datos ahora rechaza físicamente cualquier intento de
     duplicar un número activo, sea cual sea el camino de código que lo
     intente.

5. **RBAC dentro del inbox** (`utils/waConversationScope.js`): dentro de un
   mismo tenant, un `seller` solo ve sus conversaciones asignadas + las sin
   asignar; `manager` ve las de su(s) sede(s); `admin`/`super_admin` ven todo.
   Se aplica en cada listado/lectura/escritura del inbox
   (`whatsappCloud.controller.js`).

## 4. Secretos — qué se cifra y cómo

| Secreto | Dónde vive | Cifrado |
|---|---|---|
| `TenantMetaConfig.own_access_token` | por tenant | AES-256-GCM (`utils/metaTokenCrypto.js`) desde siempre. |
| `MetaConfig.app_secret` | singleton | **Antes: texto plano. Corrección 2026-08-04: AES-256-GCM**, transparente vía getter/setter del modelo (`models/payments/MetaConfig.js`) — el resto del código sigue leyendo `config.app_secret` como string plano, el cifrado ocurre solo al leer/escribir de Postgres. |
| `MetaConfig.shared_system_user_token` | singleton | Igual que `app_secret`, mismo fix. |

Clave de cifrado: `META_TOKEN_ENCRYPTION_KEY` (32 bytes hex) si está definida;
si no, se deriva de `JWT_SECRET` (válido para dev, pero en producción se
recomienda una clave dedicada — si `JWT_SECRET` se filtra algún día, hoy
también expondría estos tokens).

La migración `2026080602-encrypt-meta-config-secrets.js` re-cifra en el
arranque cualquier valor que ya estuviera en texto plano en `meta_config`
(no-op si la fila está vacía, que es el caso actual en la base de pruebas).

## 5. Verificación del webhook (HMAC)

`services/meta/metaClient.js::verificarFirmaWebhook` calcula
`HMAC-SHA256(app_secret, rawBody)` y lo compara con el header
`X-Hub-Signature-256` usando `crypto.timingSafeEqual` (evita *timing
attacks*), tal como lo documenta Meta.

**Corrección 2026-08-04**: si `app_secret` no está configurado, antes se
aceptaba CUALQUIER webhook sin firma (`return true`, "inseguro, solo dev").
Ahora eso solo se tolera si `NODE_ENV !== 'production'`; en producción sin
`app_secret` configurado, el webhook se **rechaza** (nunca se procesa un
payload no verificado). El handshake GET (`hub.challenge`) sigue exigiendo
que `webhook_verify_token` coincida exactamente, sin excepción.

## 6. Flujo de mensajes salientes

### 6.1 Plantilla (`sendTemplateFromTenant`)
Las plantillas HSM aprobadas por Meta se pueden enviar **en cualquier
momento** (son justamente el mecanismo para iniciar/reabrir una
conversación). Usado por: envío manual desde el inbox, recordatorios
(`wa_reminder_jobs`) y campañas (`wa_campaigns`).

### 6.2 Texto libre (`sendTextFromTenant`)
Solo válido **dentro de la ventana de 24h** desde el último mensaje entrante
del cliente (Customer Service Window, documentado por Meta). **Corrección
2026-08-04**: antes esto no se validaba en el backend — el agente se enteraba
recién cuando Meta devolvía el error `131047` después de intentar enviar.
Ahora `sendTextFromTenant` calcula la ventana con el mismo helper que ya usa
el inbox para mostrarla (`utils/waWorkspacePrefs.js::windowStatus`,
`conversation.last_inbound_at + 24h`) y devuelve `409 WA_WINDOW_CLOSED` con
un mensaje claro ("usa una plantilla aprobada") si está cerrada, sin llamar a
Meta.

### 6.3 Modo demo (`wa_demo_mode`)
Un tenant puede activar un inbox 100% simulado (sin credenciales de Meta) —
pensado para demos comerciales. `sendTextFromTenant`/`simulateInboundDemo`
generan mensajes locales con `meta_message_id` sintético (`demo_out_...`,
`demo_in_...`) y estado `delivered`/`received` inmediato.

## 7. Flujo de mensajes entrantes (webhook)

`POST /api/webhooks/meta` → `handleWebhook` → verifica firma →
`procesarWhatsAppEntry(entry)` por cada `entry` del payload:

- `field === 'messages'` → `ingestInboundWhatsApp` por cada mensaje: resuelve
  tenant por `phone_number_id`, busca/crea `WaConversation`, intenta
  encontrar el `Customer` dueño de ese teléfono (match exacto o por los
  últimos 10 dígitos normalizados — ver corrección abajo), inserta
  `WaMessage`, emite el evento de socket `wa:new-message`.
- `field === 'statuses'` → `updateMessageStatus` actualiza `sent` / `delivered`
  / `read` / `failed` del mensaje saliente correspondiente
  (`meta_message_id`). **Corrección 2026-08-04**: antes se llamaba sin
  `tenantId`, así que el estado se guardaba en BD pero el evento de socket
  `wa:message-status` nunca se emitía — el inbox no mostraba los "check
  marks" en tiempo real, solo al recargar. Ahora `procesarWhatsAppEntry`
  resuelve el tenant una vez por `phone_number_id` y lo pasa, así el evento
  llega en vivo.
- `field === 'smb_message_echoes'` (coexistencia) → mensajes que el asesor
  mandó desde la app WhatsApp Business del celular se reflejan también en el
  inbox de Pitbox (`direction: 'out'`, `source: 'app_echo'`).

**Corrección 2026-08-04 (matching de cliente)**: el match por teléfono ahora
normaliza el valor guardado en `Customer.phone` con `regexp_replace(phone,
'\D', '', 'g')` antes de compararlo contra los últimos 10 dígitos del
remitente, en vez de comparar el string crudo con `ILIKE`. Esto corrige tanto
falsos negativos (un teléfono guardado como `"+57 300 123 4567"` antes nunca
hacía match) como el riesgo de comparar caracteres literales en vez de
dígitos.

**Idempotencia**: `appendMessage` deduplica por `meta_message_id` antes de
insertar — Meta puede reintentar la entrega de un mismo evento de webhook, y
esto evita mensajes duplicados en el inbox.

## 8. Rate limiting de envíos salientes

**Corrección 2026-08-04**: se agregó `waSendLimiter`
(`middleware/rateLimiter.js`) — 40 envíos/minuto **por tenant** (antes de
esto, `send-template`, `send-text`, respuestas del inbox y arranque de
campañas solo caían bajo el límite genérico de 500 req/15min por IP,
compartido con toda la API, que no frena nada específico de WhatsApp). Se
aplicó a:
- `POST /api/crm/whatsapp/send-template`
- `POST /api/crm/whatsapp/send-text`
- `POST /api/crm/whatsapp/conversations/:id/messages`
- `POST /api/crm/whatsapp/campaigns/:id/start`

Por qué importa puntualmente para WhatsApp (no es solo "costo de API"): Meta
mide la calidad del número (*quality rating*) y el volumen permitido en 24h
(*messaging tier*: 250 / 1K / 10K / 100K conversaciones) a nivel de
`phone_number_id`. Un pico de envíos mal dirigidos puede degradar la
calificación del número o, en casos extremos, hacer que Meta lo restrinja.

Las campañas/recordatorios en background (`waCampaigns.service.js`) ya
tenían su propio throttle interno (`sleep(60ms)` entre envíos ≈ 16
mensajes/segundo, lotes de 15-20 por tick del cron) — eso no cambió.

## 9. Jobs programados

Corren dentro del mismo proceso Node (`jobs/scheduler.js`, `node-cron`, zona
horaria Colombia), no como funciones serverless separadas:

| Job | Cadencia | Qué hace |
|---|---|---|
| `wa-reminders` | cada minuto | `processDueReminders()` — envía plantillas de `wa_reminder_jobs` cuyo `scheduled_at` ya pasó. |
| `wa-campaigns` | cada minuto | `processQueuedCampaigns()` — procesa lotes de campañas `queued`/`running`. |

Desactivable con `ENABLE_CRON_SCHEDULER=false`.

## 10. Endpoints expuestos

Todos bajo `authMiddleware + tenantMiddleware + branchMiddleware +
requireModule('crm')` salvo el webhook (público, autenticado por firma HMAC).

```
GET    /api/webhooks/meta                       — handshake de verificación (público)
POST   /api/webhooks/meta                       — eventos de Lead Ads + WhatsApp (público, firma HMAC)
GET    /api/webhooks/meta/oauth-callback         — callback OAuth "cuenta propia" (público, state firmado con JWT)

GET    /api/crm/whatsapp/status
POST   /api/crm/whatsapp/embedded-signup/complete
POST   /api/crm/whatsapp/disconnect
POST   /api/crm/whatsapp/demo-mode
POST   /api/crm/whatsapp/demo/simulate-inbound
POST   /api/crm/whatsapp/send-template           — [rate-limited: 40/min/tenant]
POST   /api/crm/whatsapp/send-text               — [rate-limited: 40/min/tenant]
GET    /api/crm/whatsapp/workspace-prefs
PUT    /api/crm/whatsapp/workspace-prefs
GET    /api/crm/whatsapp/conversations
GET    /api/crm/whatsapp/conversations/:id
PATCH  /api/crm/whatsapp/conversations/:id
GET    /api/crm/whatsapp/conversations/:id/messages
POST   /api/crm/whatsapp/conversations/:id/messages   — [rate-limited: 40/min/tenant]
POST   /api/crm/whatsapp/conversations/:id/read
POST   /api/crm/whatsapp/conversations/:id/assign
POST   /api/crm/whatsapp/conversations/:id/ai/suggest
POST   /api/crm/whatsapp/conversations/:id/ai/summarize
POST   /api/crm/whatsapp/templates/sync
GET    /api/crm/whatsapp/templates
GET    /api/crm/whatsapp/reminders
POST   /api/crm/whatsapp/reminders
GET    /api/crm/whatsapp/campaigns
POST   /api/crm/whatsapp/campaigns
POST   /api/crm/whatsapp/campaigns/:id/start     — [rate-limited: 40/min/tenant]

GET    /api/whatsapp/status | POST /connect | /disconnect   — modo wa.me (sin Cloud API), no-ops informativos
GET    /api/whatsapp/test-cloudinary             — solo admin/super_admin

GET    /api/v1/superadmin/meta-config            — nunca devuelve secretos, solo has_app_secret: boolean
POST   /api/v1/superadmin/meta-config
POST   /api/v1/superadmin/meta-config/probar-conexion
GET    /api/v1/superadmin/meta-config/tenants    — excluye own_access_token de la respuesta (corrección 2026-08-04)
PUT    /api/v1/superadmin/meta-config/tenants/:tenantId/lead-forms
```

## 11. Cambios aplicados — 2026-08-04

Auditoría de seguridad + corrección, ejecutada **solo contra la base de
pruebas** (tenant `DEMO PITBOX` / `empresa-de-pruebas`; verificado que los
tenants reales — Lemans Motos, Amortiguadores y Freno de Oriente — no tenían
ninguna fila en `tenant_meta_configs`/`meta_config` antes ni después, cero
impacto). Migraciones son aditivas (`CREATE INDEX`, re-cifrado in-place),
sin `DROP`/`DELETE` de datos existentes.

| # | Archivo(s) | Qué se corrigió |
|---|---|---|
| 1 | `services/whatsappCloud.service.js`, migración `2026080601` | Fuga cross-tenant en Embedded Signup: se verifica el `phone_number_id` contra la Graph API antes de guardarlo, se rechaza si ya pertenece a otro tenant activo, y se agrega constraint único parcial en BD. |
| 2 | `services/meta/metaClient.js` | Verificación de firma de webhook ya no acepta payloads sin firmar en producción. |
| 3 | `models/payments/MetaConfig.js`, migración `2026080602` | `app_secret` y `shared_system_user_token` cifrados en reposo (antes texto plano). |
| 4 | `middleware/rateLimiter.js`, `routes/crm/whatsappCloud.routes.js` | Rate limit dedicado (40/min/tenant) en los 4 endpoints que efectivamente disparan un envío a la Graph API. |
| 5 | `services/whatsappCloud.service.js` | Chequeo de ventana de 24h antes de enviar texto libre (antes solo lo validaba Meta después del intento). |
| 6 | `controllers/metaWebhook.controller.js` | Los estados de mensaje (`sent`/`delivered`/`read`) ahora llegan en vivo por socket al inbox (antes solo se guardaban en BD). |
| 7 | `routes/superadmin.routes.js` | `GET /meta-config/tenants` ya no incluye el blob cifrado `own_access_token` en la respuesta. |
| 8 | `services/whatsappCloud.service.js` | Matching de cliente por teléfono normalizado (evita falsos negativos/positivos por formato del número). |

## 12. Oportunidades de mejora — NO implementadas (a propósito)

Detectadas en la revisión, de menor severidad; no se tocaron para no
introducir riesgo adicional sin tu confirmación explícita:

- **`META_TOKEN_ENCRYPTION_KEY` no es obligatoria en `validateEnv.js`.** Hoy
  cae a derivar la clave desde `JWT_SECRET` si falta. Recomendado: exigirla
  explícitamente en producción (variable dedicada, no compartida con la
  firma de sesiones).
- **Sin backoff/circuit-breaker en campañas masivas.** `processQueuedCampaigns`
  sigue enviando el resto del lote aunque varios mensajes seguidos fallen
  (p. ej. número bloqueado, plantilla rechazada). Vale la pena pausar la
  campaña tras N fallos consecutivos y avisar al admin.
- **`GRAPH_VERSION` fija por variable de entorno** (`v21.0` por defecto), sin
  alerta cuando Meta deprecia una versión (~cada 2 años). Se podría chequear
  en `probarConexion()`.
- **Copias "fantasma" de `tenant_meta_configs`/`meta_config` dentro de cada
  schema de tenant.** El propagador de migraciones a schemas de tenant
  (`migrateAllTenantSchemas`) replica TODAS las migraciones, incluidas las
  que crean estas dos tablas — aunque nunca se usan ahí (`registerTenantSchemaHooks.js`
  las fuerza a resolver siempre contra `public`, ver §3). Es black cosmético/
  de limpieza, no un riesgo funcional; requeriría tocar el motor de
  propagación de migraciones, fuera del alcance de esta corrección para no
  afectar arquitectura.
- **Sin backoff/retry ante rate-limit de Meta (código 131056)** en el cliente
  HTTP (`metaClient.js`) — los envíos que chocan con el límite de Meta
  simplemente quedan `failed` y hay que reintentarlos a mano/otra corrida del
  cron.

## 13. Cómo probar de forma segura

Usar siempre el tenant `DEMO PITBOX` (`slug: empresa-de-pruebas`):

```bash
# Activar modo demo (sin credenciales de Meta reales)
POST /api/crm/whatsapp/demo-mode { "enabled": true }

# Simular un mensaje entrante del "cliente"
POST /api/crm/whatsapp/demo/simulate-inbound { "phone": "573001234567", "body": "Hola, quiero una cotización" }

# Responder desde el inbox — no llama a Meta, todo queda local
POST /api/crm/whatsapp/conversations/:id/messages { "body": "¡Claro! Dame un momento" }
```

Nunca probar Embedded Signup / envío real contra `lemans-motos` ni
`amortiguadores-y-freno-de-oriente` sin coordinarlo explícitamente — son
tenants con clientes reales.
