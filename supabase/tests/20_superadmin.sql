-- Pruebas del superadmin de Solers (se ejecuta tras 10_rls_sync.sql sobre la misma base).
\set ON_ERROR_STOP off
\echo '#### SUPERADMIN'
-- usuarios: el superadmin (admin@solers.es), un impostor con el mismo nombre en otro dominio y un cliente nuevo
insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000ad','admin@solers.es'),('00000000-0000-0000-0000-0000000000ee','admin@solers.es.falso.com'),('00000000-0000-0000-0000-0000000000dd','dueno@c.es');
\echo '== Marcar superadmin a otro correo (debe fallar: el unico es admin@solers.es)'
update public.usuarios set es_superadmin = true where email = 'ana@a.es';
update public.usuarios set es_superadmin = true where email = 'admin@solers.es.falso.com';
\echo '== Marcar a admin@solers.es (debe ir bien)'
update public.usuarios set es_superadmin = true where email = 'admin@solers.es';
select email, es_superadmin from public.usuarios where es_superadmin;
\echo '== Insertar un superadmin con otro correo (debe fallar)'
insert into public.usuarios(id,email,es_superadmin) values (gen_random_uuid(),'otro@x.es',true);

grant usage on schema public, app to authenticated;
grant execute on all functions in schema app to authenticated;
select id as ta from public.tenants where razon_social = 'Reformas A SL' \gset
-- empresa C propia de esta prueba: un dueño y un operario, para la regresión
insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000f1','op@c.es');
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000dd',false);
select public.crear_empresa('A58818501','Constructora C SL') as tc \gset
select public.subir_docs(:'tc'::uuid,'[{"coleccion":"obras","doc_id":"c1","datos":{"nombre":"Obra C"},"mod_ms":10},{"coleccion":"partes","doc_id":"cp1","datos":{"h":4},"mod_ms":10}]') > 0;
reset role;
insert into public.membresias(tenant_id,usuario_id,rol) values (:'tc','00000000-0000-0000-0000-0000000000f1','operario');

-- ---- Ana (cliente normal)
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
\echo '== Ana: soy_solers = false'
select public.soy_solers();
\echo '== Ana no puede listar clientes (debe fallar)'
select * from public.solers_clientes();
\echo '== Ana no puede entrar en otro cliente (debe fallar)'
select * from public.solers_entrar(:'ta'::uuid);
\echo '== Ana no puede marcarse superadmin (permission denied)'
update public.usuarios set es_superadmin = true where id = '00000000-0000-0000-0000-00000000000a';
\echo '== Ana no lee la bitacora (0 filas)'
select count(*) from public.solers_registro;
\echo '== Ana: su equipo no incluye al superadmin (sin admin@solers.es)'
select email from public.equipo_empresa(:'ta'::uuid) order by 1;

-- ---- Impostor (otro dominio) con la marca forzada por la service_role
reset role;
alter table public.usuarios disable trigger solo_un_superadmin;
update public.usuarios set es_superadmin = true where email = 'admin@solers.es.falso.com';
alter table public.usuarios enable trigger solo_un_superadmin;
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ee',false);
\echo '== Impostor con marca pero otro correo: soy_solers = false y no lista'
select public.soy_solers();
select * from public.solers_clientes();
reset role; update public.usuarios set es_superadmin = false where email = 'admin@solers.es.falso.com';

-- ---- El superadmin
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ad',false);
\echo '== Admin: soy_solers = true'
select public.soy_solers();
\echo '== Admin: lista de clientes (A con 1 admin ana y su equipo)'
select razon_social, usuarios, admin_email, obras, partes from public.solers_clientes() order by razon_social;
\echo '== Admin: usuarios de A'
select email, rol, estado from public.solers_usuarios(:'ta'::uuid) order by email;
\echo '== Admin entra en A (deja constancia)'
select razon_social from public.solers_entrar(:'ta'::uuid);
\echo '== Admin entra en un cliente que no existe (debe fallar)'
select * from public.solers_entrar('00000000-0000-0000-0000-000000000999'::uuid);
\echo '== Admin lee TODOS los documentos de A (obras y partes)'
select coleccion, count(*) from public.brigada_docs where tenant_id = :'ta' group by 1 order by 1;
\echo '== Admin escribe en A y numera'
select public.subir_docs(:'ta'::uuid,'[{"coleccion":"obras","doc_id":"o2","datos":{"nombre":"Desde Solers"},"mod_ms":300}]') > 0;
select public.siguiente_numero(:'ta'::uuid,'A-2026');
\echo '== Admin NO esta en el equipo de A (membresias de A sin admin@solers.es)'
select count(*) from public.membresias m join public.usuarios u on u.id = m.usuario_id where m.tenant_id = :'ta' and u.email = 'admin@solers.es';
\echo '== Admin escribe en la bitacora y la lee'
select public.solers_registrar('prueba', :'ta'::uuid, 'x', '{"k":1}');
select accion, objetivo from public.solers_registro order by id;
\echo '== Admin no puede borrar la bitacora (debe fallar)'
delete from public.solers_registro;
reset role;

-- ---- Regresion: lo de siempre sigue igual (empresa C)
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f1',false);
\echo '== Operario sigue sin poder subir obras (debe fallar)'
select public.subir_docs(:'tc'::uuid,'[{"coleccion":"obras","doc_id":"c1","datos":{"nombre":"HACK"},"mod_ms":999}]');
\echo '== Operario sigue viendo solo partes (esperado 1 parte, 0 obras)'
select count(*) from public.brigada_docs where tenant_id = :'tc' and coleccion = 'partes';
select count(*) from public.brigada_docs where tenant_id = :'tc' and coleccion = 'obras';
\echo '== Operario no es superadmin ni puede listar (debe fallar)'
select public.soy_solers();
select * from public.solers_clientes();
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
\echo '== Beto sigue sin ver C (0)'
select count(*) from public.brigada_docs where tenant_id = :'tc';
reset role;
\echo '#### FIN SUPERADMIN'
