# Módulo Ensambladora en Pitbox — Fase 8 (panel de monitoreo de sincronización)

Todos los archivos ya existían de fases anteriores -- ningún archivo
nuevo esta vez, ni cambios en `server.js` (las rutas cuelgan del router
que ya estaba montado en `/api/ensambladora/sync` desde Fase 0).

- `src/controllers/ensambladora/sync.controller.js` → `listEvents` ahora
  acepta filtros (`estado`, `tipo_evento`, `direccion`, `revisado`); se
  agregan `reintentarEvento` y `marcarRevisado`
- `src/routes/ensambladora/events.routes.js` → agrega
  `POST /events/:id/reintentar` y `POST /events/:id/marcar-revisado`
- `src/services/ensambladora/syncOutboundClient.js` → agrega
  `reenviarEventoExistente` (usada por `reintentarEvento`)

**No hizo falta ninguna migración** -- los campos `revisado`,
`revisado_por`, `revisado_en`, `intentos` ya existían en
`ensambladora_eventos_sync` desde Fase 0.

## ⚠️ Importante: el "reintentar" funciona distinto en cada lado

Hay DOS lugares donde un evento puede fallar, y el reintento correcto
depende de cuál fue:

**1. El evento nunca llegó al Core** (caída de red, timeout, Core abajo).
Acá el reintento tiene que hacerse **desde Pitbox** --
`POST /api/ensambladora/sync/events/:id/reintentar` reenvía el mismo
`event_id` y el mismo payload. Como el Core nunca lo procesó, esta vez sí
lo procesa de verdad.

**2. El evento SÍ llegó al Core, pero falló una validación de negocio**
(ej. un código de pieza que no existía, una línea sin tarifa configurada).
En este caso el Core YA tiene una fila para ese `event_id` -- si Pitbox
reintentara reenviando el mismo id, el Core detectaría que ya existe
(idempotencia) y devolvería el estado viejo **sin volver a correr nada**.
El reintento real tiene que hacerse **desde el panel del Core**
(`POST /api/sync/eventos-sync/:id/reintentar`, ver `backendESM/LEEME`),
una vez que alguien del equipo de la Ensambladora corrigió la causa (ej.
creó la pieza que faltaba en el catálogo).

En la práctica: si un evento salió en error, primero fijate en el Core si
ya quedó registrado ahí (`GET /api/sync/eventos-sync?estado=error`). Si
está ahí, reintentalo desde el Core. Si no aparece, reintentalo desde
Pitbox.

## Qué trae

```bash
# Listar con filtros
curl "http://localhost:5000/api/ensambladora/sync/events?estado=error" -H "Authorization: Bearer <JWT>"

# Reintentar (solo eventos salientes en error, y solo sirve si nunca llegaron al Core -- ver arriba)
curl -X POST http://localhost:5000/api/ensambladora/sync/events/<id>/reintentar -H "Authorization: Bearer <JWT>"

# Marcar revisado
curl -X POST http://localhost:5000/api/ensambladora/sync/events/<id>/marcar-revisado \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"revisado_por":"Nombre de quien lo revisó"}'
```

## Probado contra Postgres real + Core real

El caso más representativo que hay: una garantía radicada con un
`pieza_codigo` que no existía en el catálogo (quedó en error, del lado del
Core). Se creó la pieza faltante en el catálogo, se reintentó el evento
desde `POST /api/sync/eventos-sync/:id/reintentar` del Core, y **el
reintento efectivamente creó la orden de garantía que había fallado la
primera vez** -- confirmado en la base. También se probó marcar-revisado
(guarda quién y cuándo) y el filtro por `estado` en ambos lados.
