-- =============================================================================
-- BRIGADA · 02 · Alta de empresa y sincronización de la app
-- =============================================================================
-- Se ejecuta DESPUÉS de esquema.sql. Añade:
--   1. public.crear_empresa(...)  → crea la empresa y hace admin a quien la crea
--      (la tabla tenants no admite INSERT directo: así nadie se auto-asigna empresas).
--   2. public.brigada_docs        → un documento JSON por entidad (obra, parte,
--      presupuesto, cliente…) con RLS por empresa. La app trabaja sin conexión y
--      sincroniza con public.subir_docs / lectura incremental por `seq`.
--   3. public.siguiente_numero()  → numeración atómica (facturas, presupuestos)
--      para que dos móviles no emitan el mismo número.
-- Conflictos: gana el cambio con `mod_ms` más reciente (último en editar).
-- Roles: admin/jefe_obra/administrativo escriben todo; operario SOLO 'partes';
--        solo_lectura no escribe.
-- =============================================================================
set check_function_bodies = off;

-- 1. Alta de empresa ----------------------------------------------------------
create or replace function public.crear_empresa(
  p_nif text, p_razon_social text, p_direccion text default null,
  p_email text default null, p_telefono text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_tenant uuid;
begin
  if v_uid is null then raise exception 'Hay que iniciar sesión' using errcode = '28000'; end if;
  if coalesce(trim(p_razon_social),'') = '' then raise exception 'Falta el nombre de la empresa'; end if;
  if p_nif is null or not app.es_nif_valido(p_nif) then raise exception 'El NIF/CIF no es válido'; end if;
  -- Un usuario puede crear como mucho 3 empresas (evita abusos del alta abierta)
  if (select count(*) from public.membresias where usuario_id = v_uid and rol = 'admin') >= 3 then
    raise exception 'Límite de empresas alcanzado';
  end if;
  insert into public.tenants (nif, razon_social, direccion, email_contacto, telefono, prueba_hasta)
  values (upper(regexp_replace(p_nif,'[\s.-]','','g')), trim(p_razon_social), p_direccion, p_email, p_telefono, current_date + 30)
  returning id into v_tenant;
  insert into public.membresias (tenant_id, usuario_id, rol) values (v_tenant, v_uid, 'admin');
  return v_tenant;
end $$;
revoke all on function public.crear_empresa(text,text,text,text,text) from public, anon;
grant execute on function public.crear_empresa(text,text,text,text,text) to authenticated;

-- 2. Documentos sincronizados ------------------------------------------------
create sequence if not exists public.brigada_docs_seq;
create table if not exists public.brigada_docs (
  tenant_id  uuid   not null references public.tenants(id) on delete cascade,
  coleccion  text   not null check (coleccion ~ '^[a-z_]{1,40}$'),
  doc_id     text   not null check (length(doc_id) between 1 and 80),
  datos      jsonb  not null default '{}',
  mod_ms     bigint not null,                              -- reloj del cliente (desempate)
  seq        bigint not null default nextval('public.brigada_docs_seq'),  -- cursor de lectura
  borrado    boolean not null default false,
  actualizado_por uuid default auth.uid(),
  primary key (tenant_id, coleccion, doc_id)
);
create index if not exists brigada_docs_seq_idx on public.brigada_docs (tenant_id, seq);

alter table public.brigada_docs enable row level security;

create or replace function app.mi_rol(p_tenant uuid)
returns app.rol_tenant
language sql stable security definer set search_path = ''
as $$ select m.rol from public.membresias m
       where m.tenant_id = p_tenant and m.usuario_id = auth.uid() and m.estado = 'activa' $$;
grant execute on function app.mi_rol(uuid) to authenticated;

-- Lectura: toda la empresa ve todo, EXCEPTO el operario, que solo ve sus partes
-- y la lista de obras (nombre) para poder imputar horas. Nunca precios ni facturas.
create policy brigada_docs_leer on public.brigada_docs for select to authenticated
  using (tenant_id in (select app.tenants_visibles())
         and (app.mi_rol(tenant_id) <> 'operario' or coleccion in ('partes','obras_lite')));
-- Sin policies de escritura: se escribe SOLO con subir_docs (security definer).

create or replace function public.subir_docs(p_tenant uuid, p_docs jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_rol app.rol_tenant; d jsonb; v_max bigint;
begin
  select m.rol into v_rol from public.membresias m
   where m.tenant_id = p_tenant and m.usuario_id = auth.uid() and m.estado = 'activa';
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

-- 3. Numeración atómica -------------------------------------------------------
create table if not exists public.brigada_contadores (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  serie text not null check (serie ~ '^[A-Za-z0-9_-]{1,20}$'),
  ultimo bigint not null default 0,
  primary key (tenant_id, serie)
);
alter table public.brigada_contadores enable row level security;  -- sin policies: solo por la función

create or replace function public.siguiente_numero(p_tenant uuid, p_serie text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_rol app.rol_tenant; v_n bigint;
begin
  select m.rol into v_rol from public.membresias m
   where m.tenant_id = p_tenant and m.usuario_id = auth.uid() and m.estado = 'activa';
  if v_rol is null or v_rol in ('solo_lectura','operario') then raise exception 'Sin permiso' using errcode = '42501'; end if;
  insert into public.brigada_contadores as c (tenant_id, serie, ultimo) values (p_tenant, p_serie, 1)
  on conflict (tenant_id, serie) do update set ultimo = c.ultimo + 1
  returning ultimo into v_n;
  return v_n;
end $$;
revoke all on function public.siguiente_numero(uuid,text) from public, anon;
grant execute on function public.siguiente_numero(uuid,text) to authenticated;

grant select on public.brigada_docs to authenticated;

-- 4. Invitar a alguien a la empresa -------------------------------------------
-- Solo el admin. La persona debe haberse registrado antes con ese email.
create or replace function public.invitar_usuario(p_tenant uuid, p_email text, p_rol app.rol_tenant)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_usuario uuid;
begin
  if app.mi_rol(p_tenant) is distinct from 'admin' then raise exception 'Solo el administrador puede invitar' using errcode = '42501'; end if;
  select u.id into v_usuario from public.usuarios u where lower(u.email) = lower(trim(p_email));
  if v_usuario is null then raise exception 'Esa persona aún no tiene cuenta: que se registre primero con ese email'; end if;
  insert into public.membresias (tenant_id, usuario_id, rol, invitado_por) values (p_tenant, v_usuario, p_rol, auth.uid())
  on conflict (tenant_id, usuario_id) do update set rol = excluded.rol, estado = 'activa';
end $$;
revoke all on function public.invitar_usuario(uuid,text,app.rol_tenant) from public, anon;
grant execute on function public.invitar_usuario(uuid,text,app.rol_tenant) to authenticated;
