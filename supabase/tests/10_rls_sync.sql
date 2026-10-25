\set ON_ERROR_STOP off
-- usuarios de prueba
insert into auth.users(id,email) values ('00000000-0000-0000-0000-00000000000a','ana@a.es'),('00000000-0000-0000-0000-00000000000b','beto@b.es'),('00000000-0000-0000-0000-00000000000c','op@a.es');
grant usage on schema public, app to authenticated;
grant execute on all functions in schema app to authenticated;
-- Ana crea empresa A, Beto empresa B
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
\echo '== NIF invalido (debe fallar)'
select public.crear_empresa('B1234','Mala SL');
\echo '== Ana crea empresa A'
select public.crear_empresa('B12345674','Reformas A SL','C/ Sol 1') as ta \gset
\echo :ta
select public.subir_docs(:'ta'::uuid, '[{"coleccion":"obras","doc_id":"o1","datos":{"nombre":"Obra A"},"mod_ms":100},{"coleccion":"partes","doc_id":"p1","datos":{"h":8},"mod_ms":100}]');
reset role;
-- operario de A
insert into public.membresias(tenant_id,usuario_id,rol) values (:'ta','00000000-0000-0000-0000-00000000000c','operario');
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select public.crear_empresa('12345678Z','Otra SL') as tb \gset
\echo '== Beto NO ve docs de A (0 filas esperadas)'
select count(*) from public.brigada_docs where tenant_id=:'ta';
\echo '== Beto NO puede subir a A (debe fallar)'
select public.subir_docs(:'ta'::uuid,'[{"coleccion":"obras","doc_id":"x","mod_ms":1}]');
\echo '== Beto puede subir a B'
select public.subir_docs(:'tb'::uuid,'[{"coleccion":"obras","doc_id":"ob","datos":{"n":1},"mod_ms":5}]');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
\echo '== Operario: obras NO (debe fallar), partes SI'
select public.subir_docs(:'ta'::uuid,'[{"coleccion":"obras","doc_id":"o1","datos":{"nombre":"HACK"},"mod_ms":999}]');
select public.subir_docs(:'ta'::uuid,'[{"coleccion":"partes","doc_id":"p2","datos":{"h":6},"mod_ms":101}]');
\echo '== Operario lee SOLO partes y obras_lite (1 parte p1 + p2 = 2; la obra o1 NO)'
select count(*) from public.brigada_docs where tenant_id=:'ta';
\echo '== Operario no puede numerar facturas (debe fallar)'
select public.siguiente_numero(:'ta'::uuid,'A-2026');
\echo '== Escritura directa a la tabla (debe fallar)'
insert into public.brigada_docs(tenant_id,coleccion,doc_id,mod_ms) values (:'ta','obras','z',1);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
\echo '== LWW: cambio viejo no pisa (debe seguir "Obra A"), nuevo si'
select public.subir_docs(:'ta'::uuid,'[{"coleccion":"obras","doc_id":"o1","datos":{"nombre":"VIEJO"},"mod_ms":50}]');
select datos->>'nombre' from public.brigada_docs where doc_id='o1' and tenant_id=:'ta';
select public.subir_docs(:'ta'::uuid,'[{"coleccion":"obras","doc_id":"o1","datos":{"nombre":"NUEVO"},"mod_ms":200}]');
select datos->>'nombre' from public.brigada_docs where doc_id='o1' and tenant_id=:'ta';
\echo '== Numeracion atomica 1,2,3'
select public.siguiente_numero(:'ta'::uuid,'A-2026') union all select public.siguiente_numero(:'ta'::uuid,'A-2026') union all select public.siguiente_numero(:'ta'::uuid,'A-2026');

\echo '== Invitar: Beto (admin de B, no de A) NO puede invitar a A (debe fallar)'
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select public.invitar_usuario(:'ta'::uuid,'beto@b.es','jefe_obra');
\echo '== Ana (admin de A) invita a Beto como jefe_obra'
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select public.invitar_usuario(:'ta'::uuid,'beto@b.es','jefe_obra');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
\echo '== Beto ya ve los docs de A (>0)'
select count(*)>0 from public.brigada_docs where tenant_id=:'ta';

\echo '== Numero desde 10 (primera vez que se conecta una empresa que ya facturo 10) -> 11, luego 12; nunca retrocede'
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select public.siguiente_numero(:'ta'::uuid,'B-2026',10) union all select public.siguiente_numero(:'ta'::uuid,'B-2026',3);
