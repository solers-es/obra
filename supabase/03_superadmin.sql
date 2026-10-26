-- =============================================================================
-- BRIGADA · 03 · Superadmin de Solers (cuenta maestra admin@solers.es)
-- =============================================================================
-- Se ejecuta DESPUÉS de esquema.sql y 02_sync.sql. Es ADITIVO: no borra ni cambia
-- datos de clientes, y para cualquier usuario que no sea el superadmin todo se
-- comporta igual que antes.
--
-- Qué añade:
--   1. app.es_admin_solers()   → true solo para admin@solers.es con la marca de
--                                superadmin. Es el ÚNICO superadmin (lo fuerza un
--                                disparador: nadie más puede tener la marca).
--   2. Entrar dentro de un cliente (impersonar) SIN tocar sus cuentas ni su
--      equipo: el superadmin no se mete en `membresias`; las funciones de la
--      sincronización (mi_rol, subir_docs, siguiente_numero, brigada_docs_leer)
--      lo tratan como administrador de cualquier empresa.
--   3. public.solers_clientes() / solers_usuarios() / solers_entrar(): lista de
--      clientes con sus datos, usuarios de cada uno y entrada auditada.
--   4. public.solers_registro     → bitácora de todo lo que hace el superadmin.
--   5. public.soy_solers()        → la app lo pregunta para saber si enseña el panel.
-- Alta de cliente y cambio de contraseña NO están aquí: necesitan la API de
-- administración de Auth (service_role) y viven en api/superadmin.js.
-- =============================================================================
set check_function_bodies = off;

-- 1. El superadmin: único y conocido -------------------------------------------
create or replace function app.es_admin_solers()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select u.es_superadmin and lower(u.email) = 'admin@solers.es'
       from public.usuarios u where u.id = auth.uid()),
    false);
$$;
grant execute on function app.es_admin_solers() to authenticated;

-- Nadie más que admin@solers.es puede tener es_superadmin = true (ni por error ni a mano).
create or replace function app.solo_un_superadmin()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.es_superadmin and lower(coalesce(new.email,'')) <> 'admin@solers.es' then
    raise exception 'El único superadmin es admin@solers.es' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists solo_un_superadmin on public.usuarios;
create trigger solo_un_superadmin
  before insert or update on public.usuarios
  for each row execute function app.solo_un_superadmin();

-- 2. Impersonar: el superadmin cuenta como administrador de cualquier empresa -----
-- (misma firma y mismo resultado que antes para el resto de usuarios)
create or replace function app.mi_rol(p_tenant uuid)
returns app.rol_tenant
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select m.rol from public.membresias m
      where m.tenant_id = p_tenant and m.usuario_id = auth.uid() and m.estado = 'activa'),
    case when app.es_admin_solers() then 'admin'::app.rol_tenant end);
$$;
grant execute on function app.mi_rol(uuid) to authenticated;

drop policy if exists brigada_docs_leer on public.brigada_docs;
create policy brigada_docs_leer on public.brigada_docs for select to authenticated
  using ((tenant_id in (select app.tenants_visibles())
          and (app.mi_rol(tenant_id) <> 'operario' or coleccion in ('partes','obras_lite')))
         or app.es_admin_solers());

create or replace function public.subir_docs(p_tenant uuid, p_docs jsonb)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_rol app.rol_tenant; d jsonb; v_max bigint;
begin
  v_rol := app.mi_rol(p_tenant);       -- miembro de la empresa, o admin si es el superadmin
  if v_rol is null then raise exception 'Sin acceso a esta empresa' using errcode = '42501'; end if;
  if v_rol = 'solo_lectura' then raise exception 'Solo lectura' using errcode = '42501'; end if;
  if jsonb_typeof(p_docs) <> 'array' or jsonb_array_length(p_docs) > 500 then raise exception 'Lote no válido'; end if;
  for d in select * from jsonb_array_elements(p_docs) loop
    if v_rol = 'operario' and (d->>'coleccion') <> 'partes' then
      raise exception 'Un operario solo puede guardar partes' using errcode = '42501';
    end if;
    insert into public.brigada_docs as t (tenant_id, coleccion, doc_id, datos, mod_ms, borrado)
    values (p_tenant, d->>'coleccion', d->>'doc_id', coalesce(d->'datos','{}'::jsonb), (d->>'mod_ms')::bigint, coalesce((d->>'borrado')::boolean,false))
    on conflict (tenant_id, coleccion, doc_id) do update
      set datos = excluded.datos, mod_ms = excluded.mod_ms, borrado = excluded.borrado,
          seq = nextval('public.brigada_docs_seq'), actualizado_por = auth.uid()
      where excluded.mod_ms >= t.mod_ms;       -- gana el más reciente
  end loop;
  select coalesce(max(seq),0) into v_max from public.brigada_docs where tenant_id = p_tenant;
  return v_max;
end $$;
revoke all on function public.subir_docs(uuid,jsonb) from public, anon;
grant execute on function public.subir_docs(uuid,jsonb) to authenticated;

create or replace function public.siguiente_numero(p_tenant uuid, p_serie text, p_desde bigint default 0)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_rol app.rol_tenant; v_n bigint;
begin
  v_rol := app.mi_rol(p_tenant);
  if v_rol is null or v_rol in ('solo_lectura','operario') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  insert into public.brigada_contadores as c (tenant_id, serie, ultimo) values (p_tenant, p_serie, greatest(p_desde,0) + 1)
  on conflict (tenant_id, serie) do update set ultimo = greatest(c.ultimo, p_desde) + 1
  returning ultimo into v_n;
  return v_n;
end $$;
revoke all on function public.siguiente_numero(uuid,text,bigint) from public, anon;
grant execute on function public.siguiente_numero(uuid,text,bigint) to authenticated;

-- 3. Bitácora del superadmin -----------------------------------------------------
create table if not exists public.solers_registro (
  id         bigint generated always as identity primary key,
  cuando     timestamptz not null default now(),
  quien      text not null,                 -- alex / stalin / admin
  accion     text not null,                 -- puerta, alta_cliente, entrar, clave…
  tenant_id  uuid,
  objetivo   text,                          -- correo o empresa afectada (nunca contraseñas)
  detalle    jsonb not null default '{}'
);
alter table public.solers_registro enable row level security;
revoke all on public.solers_registro from anon, authenticated;
grant select on public.solers_registro to authenticated;
create policy solers_registro_leer on public.solers_registro for select to authenticated
  using (app.es_admin_solers());
-- Sin policies de escritura: se escribe con solers_registrar() o con la service_role de la API.

create or replace function public.solers_registrar(p_accion text, p_tenant uuid default null, p_objetivo text default null, p_detalle jsonb default '{}')
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not app.es_admin_solers() then raise exception 'Solo el superadmin' using errcode = '42501'; end if;
  insert into public.solers_registro (quien, accion, tenant_id, objetivo, detalle)
  values ('admin', left(p_accion, 40), p_tenant, left(p_objetivo, 200), coalesce(p_detalle, '{}'));
end $$;
revoke all on function public.solers_registrar(text,uuid,text,jsonb) from public, anon;
grant execute on function public.solers_registrar(text,uuid,text,jsonb) to authenticated;

-- 4. Lectura para el panel -------------------------------------------------------
create or replace function public.soy_solers()
returns boolean
language sql stable security definer set search_path = ''
as $$ select app.es_admin_solers(); $$;
revoke all on function public.soy_solers() from public, anon;
grant execute on function public.soy_solers() to authenticated;

-- Lista de clientes (empresas) con sus datos. Solo lectura.
create or replace function public.solers_clientes()
returns table (
  tenant_id uuid, razon_social text, nombre_comercial text, nif text, email_contacto text, telefono text,
  municipio text, provincia text, estado text, plan text, prueba_hasta date, creado_en timestamptz,
  usuarios bigint, admin_email text, obras bigint, presupuestos bigint, partes bigint, ultimo_movimiento timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not app.es_admin_solers() then raise exception 'Solo el superadmin' using errcode = '42501'; end if;
  return query
  select t.id, t.razon_social, t.nombre_comercial, t.nif, t.email_contacto, t.telefono,
         t.municipio, t.provincia, t.estado::text, t.plan, t.prueba_hasta, t.creado_en,
         (select count(*) from public.membresias m where m.tenant_id = t.id and m.estado = 'activa'),
         (select u.email from public.membresias m join public.usuarios u on u.id = m.usuario_id
           where m.tenant_id = t.id and m.estado = 'activa' and m.rol = 'admin' order by m.creado_en limit 1),
         (select count(*) from public.brigada_docs d where d.tenant_id = t.id and d.coleccion = 'obras' and not d.borrado),
         (select count(*) from public.brigada_docs d where d.tenant_id = t.id and d.coleccion = 'presupuestos' and not d.borrado),
         (select count(*) from public.brigada_docs d where d.tenant_id = t.id and d.coleccion = 'partes' and not d.borrado),
         (select to_timestamp(max(d.mod_ms) / 1000.0) from public.brigada_docs d where d.tenant_id = t.id and d.coleccion <> 'ajustes')
  from public.tenants t
  order by t.creado_en desc;
end $$;
revoke all on function public.solers_clientes() from public, anon;
grant execute on function public.solers_clientes() to authenticated;

-- Personas con acceso a un cliente (para elegir a quién resetear la contraseña).
create or replace function public.solers_usuarios(p_tenant uuid)
returns table (usuario_id uuid, email text, nombre text, rol text, estado text, ultimo_acceso timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not app.es_admin_solers() then raise exception 'Solo el superadmin' using errcode = '42501'; end if;
  return query
  select m.usuario_id, u.email, u.nombre, m.rol::text, m.estado::text,
         (select a.last_sign_in_at from auth.users a where a.id = m.usuario_id)
    from public.membresias m join public.usuarios u on u.id = m.usuario_id
   where m.tenant_id = p_tenant
   order by m.creado_en;
end $$;
revoke all on function public.solers_usuarios(uuid) from public, anon;
grant execute on function public.solers_usuarios(uuid) to authenticated;

-- Entrar dentro de un cliente: deja constancia y devuelve lo mínimo para pintar la cabecera.
create or replace function public.solers_entrar(p_tenant uuid)
returns table (tenant_id uuid, razon_social text)
language plpgsql security definer set search_path = ''
as $$
declare v_nombre text;
begin
  if not app.es_admin_solers() then raise exception 'Solo el superadmin' using errcode = '42501'; end if;
  select t.razon_social into v_nombre from public.tenants t where t.id = p_tenant;
  if v_nombre is null then raise exception 'Ese cliente no existe'; end if;
  insert into public.solers_registro (quien, accion, tenant_id, objetivo) values ('admin', 'entrar', p_tenant, v_nombre);
  return query select p_tenant, v_nombre;
end $$;
revoke all on function public.solers_entrar(uuid) from public, anon;
grant execute on function public.solers_entrar(uuid) to authenticated;
