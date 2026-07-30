-- RENAME-sequelize-migrations-rows.sql
--
-- Acompaña el rename de:
--   0260202120100-create-supplier-returns.js   -> 20260202120100-create-supplier-returns.js
--   YYYYMMDDHHMMSS-create-customer-returns.js  -> 20260103000000-create-customer-returns.js
--
-- OBLIGATORIO correr esto ANTES de desplegar el código con los archivos ya
-- renombrados. `sequelize_migrations` guarda las migraciones YA EJECUTADAS
-- por su nombre de archivo -- si el archivo cambia de nombre sin actualizar
-- la fila correspondiente, el migrator (src/database/migrator.js, y
-- provisionTenantSchema.js para cada schema de tenant) va a pensar que esa
-- migración nunca corrió y va a intentar correrla de nuevo -> como las
-- tablas ya existen, revienta el arranque.
--
-- Correr en `public` (una vez) Y en cada schema de tenant ya provisionado
-- (uno por uno, reemplazando el nombre de schema).

-- 1) public
UPDATE public.sequelize_migrations
   SET name = '20260202120100-create-supplier-returns.js'
 WHERE name = '0260202120100-create-supplier-returns.js';

UPDATE public.sequelize_migrations
   SET name = '20260103000000-create-customer-returns.js'
 WHERE name = 'YYYYMMDDHHMMSS-create-customer-returns.js';

-- 2) cada schema de tenant -- repetir este bloque reemplazando <schema>
--    por cada valor de public.tenants.schema_name (SELECT schema_name FROM
--    public.tenants WHERE schema_name IS NOT NULL;)
--
-- UPDATE "<schema>".sequelize_migrations
--    SET name = '20260202120100-create-supplier-returns.js'
--  WHERE name = '0260202120100-create-supplier-returns.js';
--
-- UPDATE "<schema>".sequelize_migrations
--    SET name = '20260103000000-create-customer-returns.js'
--  WHERE name = 'YYYYMMDDHHMMSS-create-customer-returns.js';

-- Verificación rápida (debería devolver 0 filas en todos los schemas después de correr esto):
-- SELECT name FROM public.sequelize_migrations WHERE name IN ('0260202120100-create-supplier-returns.js', 'YYYYMMDDHHMMSS-create-customer-returns.js');
