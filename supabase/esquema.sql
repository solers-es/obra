-- =============================================================================
-- BRIGADA · Esquema de datos del MVP (gestión de OBRA / construcción)
-- =============================================================================
-- Base de datos NUEVA e independiente (PostgreSQL / Supabase). No comparte nada
-- con GestorOS: solo hereda su ESTILO (multiempresa con tenant_id, RLS en todas
-- las tablas, importes calculados por la base, todo en español).
--
-- Flujo que cubre el MVP:
--
--   OBRA  ─presupuesto→  CAPÍTULOS → PARTIDAS (medición × precio_unidad)
--     │
--     ├─ CERTIFICACIONES por avance (líneas que miden cada partida este período)
--     │        └→ FACTURA (con sus líneas) ──→ REGISTRO VERIFACTU
--     │
--     └─ COSTES imputados a la obra:
--            · MATERIAL  → albaranes de proveedor (líneas de albarán)
--            · MANO DE OBRA → partes de trabajo (horas × coste/hora vigente)
--            todo se vuelca en IMPUTACION_COSTES (libro de costes de la obra)
--
--   MARGEN de la obra = producción certificada/facturada − costes imputados
--   (se calcula con la vista `obra_margen` al final del fichero).
--
-- Ejecútese de principio a fin sobre una base Supabase vacía (necesita el
-- esquema `auth`, que Supabase ya trae).
-- =============================================================================


-- =============================================================================
-- BLOQUE 0 · Base: extensiones, esquema privado, tipos y seguridad
-- =============================================================================
-- Las funciones auxiliares viven en el esquema `app`, que NO se publica por la
-- API de PostgREST. Son SECURITY DEFINER a propósito: leen las tablas de
-- pertenencia saltándose RLS y así se evita la recursión infinita que habría si
-- una policy de `membresias` tuviera que volver a consultar `membresias`.
-- =============================================================================

create extension if not exists "pgcrypto" with schema extensions;

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Tipos enumerados
-- -----------------------------------------------------------------------------

-- Rol de un usuario dentro de una empresa (tenant)
create type app.rol_tenant as enum (
  'admin',        -- control total de la empresa: usuarios, ajustes, todo
  'jefe_obra',    -- gestiona obras, presupuestos, certificaciones y partes
  'administrativo',-- factura, registra albaranes, imputa costes
  'operario',     -- solo imputa sus propias horas (parte de trabajo)
  'solo_lectura'  -- consulta y descarga, sin escritura
);

create type app.estado_membresia as enum ('activa', 'suspendida', 'revocada');

create type app.estado_tenant as enum ('prueba', 'activo', 'suspendido', 'cancelado');

-- Ciclo de vida de una obra
create type app.estado_obra as enum (
  'presupuesto',  -- en estudio, aún no adjudicada
  'adjudicada',   -- ganada, pendiente de arrancar
  'en_ejecucion', -- obra viva
  'parada',       -- suspendida temporalmente
  'finalizada',   -- terminada, pendiente de liquidación
  'liquidada',    -- cerrada por completo
  'cancelada'
);

create type app.estado_certificacion as enum ('borrador', 'aprobada', 'facturada', 'anulada');

create type app.estado_factura as enum ('borrador', 'emitida', 'anulada');

-- Origen y naturaleza de un coste imputado a la obra
create type app.tipo_coste as enum ('material', 'mano_obra', 'maquinaria', 'subcontrata', 'otros');
create type app.origen_coste as enum ('albaran', 'parte_trabajo', 'factura_recibida', 'manual');

-- -----------------------------------------------------------------------------
-- Funciones de seguridad (autocontenidas: no dependen de GestorOS)
-- -----------------------------------------------------------------------------

-- Superadmin = nosotros. Se marca en `usuarios`, nunca desde el JWT del cliente.
create or replace function app.es_superadmin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select u.es_superadmin from public.usuarios u where u.id = auth.uid()),
    false
  );
$$;

comment on function app.es_superadmin() is
  'True si el usuario autenticado tiene la marca de superadmin en public.usuarios.';

-- Tenants que el usuario autenticado puede LEER (membresía activa).
create or replace function app.tenants_visibles()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
    from public.membresias m
   where m.usuario_id = auth.uid()
     and m.estado = 'activa'::app.estado_membresia;
$$;

comment on function app.tenants_visibles() is
  'Tenants legibles por el usuario autenticado (membresía directa y activa).';

-- Tenants sobre los que el usuario puede ESCRIBIR. `solo_lectura` queda fuera.
create or replace function app.tenants_editables()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
    from public.membresias m
   where m.usuario_id = auth.uid()
     and m.estado = 'activa'::app.estado_membresia
     and m.rol in (
       'admin'::app.rol_tenant,
       'jefe_obra'::app.rol_tenant,
       'administrativo'::app.rol_tenant,
       'operario'::app.rol_tenant
     );
$$;

comment on function app.tenants_editables() is
  'Tenants sobre los que el usuario puede insertar/actualizar/borrar.';

-- Tenants donde el usuario es administrador de la empresa (ajustes, usuarios).
create or replace function app.tenants_administrables()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
    from public.membresias m
   where m.usuario_id = auth.uid()
     and m.estado = 'activa'::app.estado_membresia
     and m.rol = 'admin'::app.rol_tenant;
$$;

comment on function app.tenants_administrables() is
  'Tenants donde el usuario es admin de la empresa.';

grant execute on function
  app.es_superadmin(),
  app.tenants_visibles(),
  app.tenants_editables(),
  app.tenants_administrables()
to authenticated;

-- -----------------------------------------------------------------------------
-- Utilidades comunes
-- -----------------------------------------------------------------------------

-- Mantiene la columna actualizado_en al día en cada UPDATE.
create or replace function app.set_actualizado_en()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

-- Impide cambiar el tenant_id de una fila ya creada: sin esto, un usuario con
-- acceso a dos empresas podría "mover" datos de una a otra.
create or replace function app.bloquear_cambio_de_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'No se permite cambiar el tenant_id de un registro existente'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Validación de NIF/CIF/NIE español, usable como CHECK. NULL se considera válido
-- (la obligatoriedad se decide con NOT NULL, no aquí).
create or replace function app.es_nif_valido(nif text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text;
  letras_dni constant text := 'TRWAGMYFPDXBNJZSQVHLCKE';
  letras_cif constant text := 'JABCDEFGHI';
  num integer;
  cuerpo text;
  suma integer := 0;
  digito integer;
  i integer;
  control char;
begin
  if nif is null then
    return true;
  end if;

  v := upper(regexp_replace(nif, '[\s.-]', '', 'g'));

  -- DNI: 8 dígitos + letra de control
  if v ~ '^[0-9]{8}[A-Z]$' then
    return substr(letras_dni, (substr(v, 1, 8)::bigint % 23)::integer + 1, 1) = substr(v, 9, 1);
  end if;

  -- NIE: X/Y/Z + 7 dígitos + letra
  if v ~ '^[XYZ][0-9]{7}[A-Z]$' then
    num := ((translate(substr(v, 1, 1), 'XYZ', '012') || substr(v, 2, 7))::bigint % 23)::integer;
    return substr(letras_dni, num + 1, 1) = substr(v, 9, 1);
  end if;

  -- CIF: letra + 7 dígitos + dígito o letra de control
  if v ~ '^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$' then
    cuerpo := substr(v, 2, 7);
    for i in 1..7 loop
      digito := substr(cuerpo, i, 1)::integer;
      if i % 2 = 1 then
        digito := digito * 2;
        digito := (digito / 10) + (digito % 10);
      end if;
      suma := suma + digito;
    end loop;
    digito := (10 - (suma % 10)) % 10;
    control := substr(v, 9, 1);
    if control ~ '[0-9]' then
      return control::integer = digito;
    else
      return control = substr(letras_cif, digito + 1, 1);
    end if;
  end if;

  return false;
end;
$$;

comment on function app.es_nif_valido(text) is
  'Valida NIF/NIE/CIF españoles incluido el dígito de control. NULL se considera válido.';

-- Importe de una línea (cantidad × precio, con descuento opcional). IMMUTABLE
-- para poder usarla en columnas generadas. Redondeo a 2 decimales línea a línea.
create or replace function app.importe_linea(
  cantidad numeric,
  precio_unitario numeric,
  descuento_porcentaje numeric
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(
    coalesce(cantidad, 0) * coalesce(precio_unitario, 0)
      * (1 - coalesce(descuento_porcentaje, 0) / 100),
    2
  );
$$;


-- =============================================================================
-- BLOQUE 1 · IDENTIDAD: tenants (empresas constructoras), usuarios, membresías
-- =============================================================================

-- tenants · una fila por empresa constructora cliente de Brigada.
-- Es la unidad de aislamiento: todo lo demás cuelga de aquí por tenant_id.
create table public.tenants (
  id                 uuid primary key default gen_random_uuid(),
  nif                text not null,
  razon_social       text not null,
  nombre_comercial   text,

  direccion          text,
  codigo_postal      text,
  municipio          text,
  provincia          text,
  pais               text not null default 'ES',

  email_contacto     text,
  telefono           text,
  web                text,
  logo_url           text,

  -- Configuración por defecto para sus facturas
  retencion_irpf_por_defecto numeric(5,2) not null default 0
    check (retencion_irpf_por_defecto >= 0 and retencion_irpf_por_defecto <= 100),

  estado             app.estado_tenant not null default 'prueba',
  plan               text not null default 'prueba',
  prueba_hasta       date,

  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now(),

  constraint tenants_nif_valido check (app.es_nif_valido(nif)),
  constraint tenants_cp_formato check (codigo_postal is null or codigo_postal ~ '^[0-9]{5}$'),
  constraint tenants_pais_iso check (pais ~ '^[A-Z]{2}$')
);

-- El NIF identifica a la empresa de forma única en todo el sistema.
create unique index tenants_nif_unico
  on public.tenants (upper(replace(replace(nif, '-', ''), ' ', '')));

comment on table public.tenants is 'Empresas constructoras. Unidad de aislamiento del sistema (tenant).';

-- usuarios · perfil de aplicación, 1:1 con auth.users (Supabase Auth).
create table public.usuarios (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  nombre         text,
  apellidos      text,
  telefono       text,
  avatar_url     text,

  -- Marca de superadmin (nosotros). Solo la cambia el service_role.
  es_superadmin  boolean not null default false,

  ultimo_acceso  timestamptz,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

comment on table public.usuarios is 'Perfil de aplicación asociado 1:1 a auth.users. No lleva tenant_id: un usuario puede pertenecer a varias empresas vía membresias.';

-- Alta automática del perfil al registrarse en Supabase Auth.
create or replace function app.crear_perfil_usuario()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.usuarios (id, email, nombre, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger crear_perfil_al_registrarse
  after insert on auth.users
  for each row execute function app.crear_perfil_usuario();

-- membresias · relación usuario <-> empresa, con su rol.
create table public.membresias (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  usuario_id     uuid not null references public.usuarios(id) on delete cascade,
  rol            app.rol_tenant not null default 'operario',
  estado         app.estado_membresia not null default 'activa',
  invitado_por   uuid references public.usuarios(id) on delete set null,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  unique (tenant_id, usuario_id)
);

create index membresias_usuario_idx on public.membresias (usuario_id) where estado = 'activa';
create index membresias_tenant_idx on public.membresias (tenant_id);

comment on table public.membresias is 'Pertenencia de un usuario a una empresa, con su rol. Determina lo que ve y toca.';


-- =============================================================================
-- BLOQUE 2 · MAESTROS: clientes (promotores), proveedores, operarios
-- =============================================================================

-- clientes · los PROMOTORES para los que se ejecutan las obras.
create table public.clientes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  tipo           text not null default 'empresa' check (tipo in ('empresa', 'particular', 'administracion_publica')),
  razon_social   text not null,
  nombre_comercial text,
  nif            text,

  direccion      text,
  codigo_postal  text,
  municipio      text,
  provincia      text,
  pais           text not null default 'ES',

  email          text,
  telefono       text,
  persona_contacto text,

  -- Datos de facturación a administración pública (FACe / DIR3), opcionales
  es_administracion_publica boolean not null default false,
  dir3_oficina_contable     text,
  dir3_organo_gestor        text,
  dir3_unidad_tramitadora   text,

  dias_vencimiento integer not null default 30 check (dias_vencimiento >= 0),
  forma_pago     text,
  notas          text,
  activo         boolean not null default true,

  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  constraint clientes_nif_valido check (pais <> 'ES' or app.es_nif_valido(nif)),
  constraint clientes_cp_formato check (codigo_postal is null or codigo_postal ~ '^[0-9]{5}$')
);

create index clientes_tenant_idx on public.clientes (tenant_id) where activo;

comment on table public.clientes is 'Promotores / clientes de la constructora. Son el destinatario de las obras y de las facturas.';

-- proveedores · de quienes llegan los materiales (albaranes) y subcontratas.
create table public.proveedores (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  razon_social   text not null,
  nombre_comercial text,
  nif            text,

  direccion      text,
  codigo_postal  text,
  municipio      text,
  provincia      text,
  pais           text not null default 'ES',

  email          text,
  telefono       text,
  persona_contacto text,

  tipo           text not null default 'material'
    check (tipo in ('material', 'subcontrata', 'maquinaria', 'servicios', 'otros')),
  notas          text,
  activo         boolean not null default true,

  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  constraint proveedores_nif_valido check (pais <> 'ES' or app.es_nif_valido(nif)),
  constraint proveedores_cp_formato check (codigo_postal is null or codigo_postal ~ '^[0-9]{5}$')
);

create index proveedores_tenant_idx on public.proveedores (tenant_id) where activo;

comment on table public.proveedores is 'Proveedores de material, maquinaria y subcontratas.';

-- operarios · el personal que imputa horas a la obra. Puede estar (o no)
-- vinculado a un usuario de la aplicación.
create table public.operarios (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  -- Si el operario entra en la app para fichar sus horas, se enlaza aquí.
  usuario_id     uuid references public.usuarios(id) on delete set null,

  nombre         text not null,
  apellidos      text,
  nif            text,
  categoria      text,          -- oficial 1ª, peón, encargado, etc.
  telefono       text,
  email          text,
  fecha_alta     date,
  fecha_baja     date,
  activo         boolean not null default true,

  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  constraint operarios_nif_valido check (app.es_nif_valido(nif))
);

create index operarios_tenant_idx on public.operarios (tenant_id) where activo;

comment on table public.operarios is 'Personal de obra que imputa horas. El coste/hora va en costes_hora, con vigencia.';

-- costes_hora · coste/hora REAL de cada operario, con vigencia temporal.
-- El coste cambia con el tiempo (convenio, antigüedad); guardamos un histórico
-- y se elige el vigente a la fecha del parte de trabajo.
create table public.costes_hora (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  operario_id    uuid not null references public.operarios(id) on delete cascade,

  coste_hora     numeric(10,4) not null check (coste_hora >= 0),
  vigente_desde  date not null,
  vigente_hasta  date,          -- NULL = vigente indefinidamente

  observaciones  text,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  constraint costes_hora_rango check (vigente_hasta is null or vigente_hasta >= vigente_desde)
);

create index costes_hora_operario_idx on public.costes_hora (operario_id, vigente_desde desc);

-- No puede haber dos costes del mismo operario que empiecen el mismo día.
create unique index costes_hora_operario_fecha_unico
  on public.costes_hora (operario_id, vigente_desde);

comment on table public.costes_hora is 'Coste/hora real por operario con vigencia (vigente_desde/hasta). Se consulta con app.coste_hora_vigente().';

-- Devuelve el coste/hora vigente de un operario en una fecha dada.
create or replace function app.coste_hora_vigente(p_operario_id uuid, p_fecha date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select ch.coste_hora
    from public.costes_hora ch
   where ch.operario_id = p_operario_id
     and ch.vigente_desde <= p_fecha
     and (ch.vigente_hasta is null or ch.vigente_hasta >= p_fecha)
   order by ch.vigente_desde desc
   limit 1;
$$;

grant execute on function app.coste_hora_vigente(uuid, date) to authenticated;

comment on function app.coste_hora_vigente(uuid, date) is
  'Coste/hora de un operario vigente en la fecha indicada, o NULL si no hay tramo.';


-- =============================================================================
-- BLOQUE 3 · OBRA y PRESUPUESTO: obras → capítulos → partidas
-- =============================================================================

-- obras · el proyecto que se ejecuta para un promotor.
create table public.obras (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  cliente_id     uuid references public.clientes(id) on delete restrict,

  codigo         text not null,          -- código interno de obra (p.ej. "24-012")
  nombre         text not null,
  descripcion    text,

  direccion      text,
  codigo_postal  text,
  municipio      text,
  provincia      text,

  estado         app.estado_obra not null default 'presupuesto',

  fecha_adjudicacion date,
  fecha_inicio   date,
  fecha_fin_prevista date,
  fecha_fin_real date,

  -- Importe contratado (lo que se acordó con el promotor). El presupuesto
  -- detallado se desglosa en capítulos y partidas; esto es el total de contrato.
  importe_contrato numeric(14,2) not null default 0,
  retencion_garantia_porcentaje numeric(5,2) not null default 0
    check (retencion_garantia_porcentaje >= 0 and retencion_garantia_porcentaje <= 100),

  notas          text,
  creado_por     uuid references public.usuarios(id) on delete set null,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- El código de obra es único dentro de cada empresa.
create unique index obras_codigo_unico on public.obras (tenant_id, upper(codigo));
create index obras_tenant_estado_idx on public.obras (tenant_id, estado);
create index obras_cliente_idx on public.obras (cliente_id);

comment on table public.obras is 'Obra ejecutada para un promotor. Raíz del presupuesto, las certificaciones y los costes.';

-- capitulos · primer nivel del presupuesto (cimentación, estructura, etc.).
create table public.capitulos (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  obra_id        uuid not null references public.obras(id) on delete cascade,

  codigo         text not null,          -- "01", "02"...
  nombre         text not null,
  orden          integer not null default 0,

  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  unique (obra_id, codigo)
);

create index capitulos_obra_idx on public.capitulos (obra_id, orden);
create index capitulos_tenant_idx on public.capitulos (tenant_id);

comment on table public.capitulos is 'Capítulos del presupuesto de una obra (primer nivel de agrupación de partidas).';

-- partidas · la unidad presupuestaria: medición × precio_unidad = importe.
create table public.partidas (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  obra_id        uuid not null references public.obras(id) on delete cascade,
  capitulo_id    uuid not null references public.capitulos(id) on delete cascade,

  codigo         text not null,          -- "01.03"
  descripcion    text not null,
  unidad         text not null default 'ud',  -- m2, m3, ml, ud, h, kg...
  orden          integer not null default 0,

  medicion       numeric(14,4) not null default 0 check (medicion >= 0),   -- cantidad presupuestada
  precio_unidad  numeric(14,4) not null default 0 check (precio_unidad >= 0),

  -- Importe presupuestado de la partida, calculado por la base (no por el cliente).
  importe        numeric(14,2)
    generated always as (round(coalesce(medicion, 0) * coalesce(precio_unidad, 0), 2)) stored,

  -- Coste unitario previsto (para comparar presupuesto vs coste objetivo). Opcional.
  coste_unidad_previsto numeric(14,4) check (coste_unidad_previsto is null or coste_unidad_previsto >= 0),

  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  unique (obra_id, codigo)
);

create index partidas_capitulo_idx on public.partidas (capitulo_id, orden);
create index partidas_obra_idx on public.partidas (obra_id);
create index partidas_tenant_idx on public.partidas (tenant_id);

comment on table public.partidas is 'Partida presupuestaria: medición × precio_unidad. El importe lo calcula la base.';
comment on column public.partidas.importe is 'Importe presupuestado = round(medicion * precio_unidad, 2). Columna generada.';

-- La partida debe pertenecer a la misma obra que su capítulo (coherencia de árbol).
create or replace function app.validar_partida_capitulo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obra uuid;
  v_tenant uuid;
begin
  select c.obra_id, c.tenant_id into v_obra, v_tenant
    from public.capitulos c where c.id = new.capitulo_id;

  if v_obra is null then
    raise exception 'El capítulo % no existe', new.capitulo_id using errcode = 'foreign_key_violation';
  end if;
  if v_obra <> new.obra_id then
    raise exception 'La partida y su capítulo pertenecen a obras distintas' using errcode = 'check_violation';
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'La partida pertenece a una empresa distinta que su capítulo' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger partidas_validar_capitulo
  before insert or update on public.partidas
  for each row execute function app.validar_partida_capitulo();


-- =============================================================================
-- BLOQUE 4 · CERTIFICACIONES por avance y sus líneas
-- =============================================================================
-- Una certificación mide, en un período, cuánto se ha ejecutado de cada partida.
-- Es el paso previo a facturar: se certifica el avance y luego se factura.
-- =============================================================================

create table public.certificaciones (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  obra_id        uuid not null references public.obras(id) on delete cascade,

  numero         integer not null,       -- 1, 2, 3... correlativo por obra
  descripcion    text,
  fecha          date not null default current_date,
  periodo_desde  date,
  periodo_hasta  date,

  estado         app.estado_certificacion not null default 'borrador',

  -- Totales de ESTA certificación (origen a mano de obra certificada en el período).
  -- Los calcula un trigger a partir de las líneas; no se aceptan desde el cliente.
  base_imponible numeric(14,2) not null default 0,

  -- Retención de garantía aplicada a esta certificación (se descuenta del cobro).
  retencion_garantia_porcentaje numeric(5,2) not null default 0
    check (retencion_garantia_porcentaje >= 0 and retencion_garantia_porcentaje <= 100),
  importe_retencion_garantia numeric(14,2) not null default 0,

  aprobada_en    timestamptz,
  observaciones  text,
  creado_por     uuid references public.usuarios(id) on delete set null,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  unique (obra_id, numero)
);

create index certificaciones_obra_idx on public.certificaciones (obra_id, numero);
create index certificaciones_tenant_idx on public.certificaciones (tenant_id);
create index certificaciones_estado_idx on public.certificaciones (tenant_id, estado);

comment on table public.certificaciones is 'Certificación de avance de obra en un período. Base de la factura. Correlativa por obra.';

-- lineas_certificacion · cuánto se certifica de cada partida en esta certificación.
create table public.lineas_certificacion (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  certificacion_id uuid not null references public.certificaciones(id) on delete cascade,
  partida_id     uuid not null references public.partidas(id) on delete restrict,

  orden          integer not null default 0,

  -- Precio congelado al certificar (copia del precio_unidad de la partida): una
  -- certificación aprobada no debe cambiar porque luego se retoque la partida.
  precio_unidad  numeric(14,4) not null default 0,

  -- Medición ejecutada ACUMULADA hasta esta certificación, y la del período.
  cantidad_acumulada numeric(14,4) not null default 0 check (cantidad_acumulada >= 0),
  cantidad_anterior  numeric(14,4) not null default 0 check (cantidad_anterior >= 0),

  -- Cantidad certificada en este período = acumulada − anterior.
  cantidad_periodo numeric(14,4)
    generated always as (coalesce(cantidad_acumulada, 0) - coalesce(cantidad_anterior, 0)) stored,

  -- Importe certificado en el período = cantidad_periodo × precio_unidad.
  importe numeric(14,2)
    generated always as (
      round((coalesce(cantidad_acumulada, 0) - coalesce(cantidad_anterior, 0)) * coalesce(precio_unidad, 0), 2)
    ) stored,

  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  unique (certificacion_id, partida_id)
);

create index lineas_cert_certificacion_idx on public.lineas_certificacion (certificacion_id, orden);
create index lineas_cert_partida_idx on public.lineas_certificacion (partida_id);
create index lineas_cert_tenant_idx on public.lineas_certificacion (tenant_id);

comment on table public.lineas_certificacion is 'Avance certificado por partida. cantidad_periodo e importe los calcula la base.';

-- La línea debe pertenecer a la misma empresa y obra que su certificación y su partida.
create or replace function app.validar_linea_certificacion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_cert uuid;
  v_obra_cert uuid;
  v_obra_part uuid;
begin
  select c.tenant_id, c.obra_id into v_tenant_cert, v_obra_cert
    from public.certificaciones c where c.id = new.certificacion_id;
  if v_tenant_cert is null then
    raise exception 'La certificación % no existe', new.certificacion_id using errcode = 'foreign_key_violation';
  end if;
  if v_tenant_cert <> new.tenant_id then
    raise exception 'La línea pertenece a una empresa distinta que su certificación' using errcode = 'check_violation';
  end if;

  select p.obra_id into v_obra_part from public.partidas p where p.id = new.partida_id;
  if v_obra_part <> v_obra_cert then
    raise exception 'La partida no pertenece a la obra de esta certificación' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger lineas_cert_validar
  before insert or update on public.lineas_certificacion
  for each row execute function app.validar_linea_certificacion();

-- Recalcula el total de la certificación cuando cambian sus líneas.
create or replace function app.recalcular_certificacion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cert uuid;
  v_base numeric(14,2);
  v_ret numeric(5,2);
begin
  v_cert := coalesce(new.certificacion_id, old.certificacion_id);

  select coalesce(sum(lc.importe), 0) into v_base
    from public.lineas_certificacion lc
   where lc.certificacion_id = v_cert;

  select retencion_garantia_porcentaje into v_ret
    from public.certificaciones where id = v_cert;

  update public.certificaciones
     set base_imponible = v_base,
         importe_retencion_garantia = round(v_base * coalesce(v_ret, 0) / 100, 2),
         actualizado_en = now()
   where id = v_cert;

  return null;
end;
$$;

create trigger lineas_cert_recalcular
  after insert or update or delete on public.lineas_certificacion
  for each row execute function app.recalcular_certificacion();


-- =============================================================================
-- BLOQUE 5 · FACTURAS y sus líneas (venta al promotor)
-- =============================================================================
-- Principio heredado de GestorOS: la base de datos es la fuente de verdad de los
-- importes. Los totales NO se aceptan desde el cliente; se calculan por trigger.
-- Una factura puede nacer de una certificación (lo normal en obra) o ser libre.
-- =============================================================================

create table public.facturas (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  obra_id        uuid references public.obras(id) on delete restrict,
  cliente_id     uuid references public.clientes(id) on delete restrict,
  -- Certificación de la que procede (si la factura certifica avance de obra).
  certificacion_id uuid references public.certificaciones(id) on delete set null,

  serie          text not null default 'A',
  numero         integer,                 -- se asigna al emitir, nunca en borrador
  numero_completo text,

  estado         app.estado_factura not null default 'borrador',

  fecha_expedicion date not null default current_date,
  fecha_operacion  date,

  -- Copia congelada de emisor y receptor al emitir (la ley exige los datos de
  -- aquel momento, aunque luego cambie la ficha del cliente).
  datos_emisor   jsonb,
  datos_cliente  jsonb,

  moneda         text not null default 'EUR' check (moneda ~ '^[A-Z]{3}$'),

  -- Totales calculados por trigger a partir de las líneas.
  base_imponible numeric(14,2) not null default 0,
  total_iva      numeric(14,2) not null default 0,
  total_irpf     numeric(14,2) not null default 0,
  total          numeric(14,2) not null default 0,
  desglose_iva   jsonb not null default '[]'::jsonb,

  estado_cobro   text not null default 'pendiente'
    check (estado_cobro in ('pendiente', 'parcial', 'cobrada', 'incobrable')),
  fecha_vencimiento date,
  forma_pago     text,

  observaciones  text,
  pdf_url        text,

  emitida_en     timestamptz,
  anulada_en     timestamptz,
  creado_por     uuid references public.usuarios(id) on delete set null,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  -- Una factura emitida siempre tiene número; un borrador nunca.
  constraint facturas_numero_segun_estado check (
    (estado = 'borrador' and numero is null and numero_completo is null)
    or (estado in ('emitida', 'anulada') and numero is not null and numero_completo is not null)
  )
);

-- Numeración correlativa sin huecos: única por serie y número dentro de cada empresa.
create unique index facturas_numero_unico_por_serie
  on public.facturas (tenant_id, serie, numero)
  where numero is not null;

create index facturas_tenant_fecha_idx on public.facturas (tenant_id, fecha_expedicion desc);
create index facturas_obra_idx on public.facturas (obra_id);
create index facturas_cliente_idx on public.facturas (cliente_id);
create index facturas_certificacion_idx on public.facturas (certificacion_id) where certificacion_id is not null;

comment on table public.facturas is 'Facturas de venta al promotor. Los totales los calcula la base, no el cliente.';

create table public.lineas_factura (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  factura_id     uuid not null references public.facturas(id) on delete cascade,

  orden          integer not null default 0,
  descripcion    text not null,
  cantidad       numeric(12,4) not null default 1 check (cantidad <> 0),
  unidad         text,
  precio_unitario numeric(14,4) not null default 0,
  descuento_porcentaje numeric(5,2) not null default 0
    check (descuento_porcentaje >= 0 and descuento_porcentaje <= 100),

  tipo_iva       numeric(5,2) not null default 21 check (tipo_iva >= 0 and tipo_iva <= 100),
  tipo_irpf      numeric(5,2) not null default 0 check (tipo_irpf >= 0 and tipo_irpf <= 100),

  exenta         boolean not null default false,
  causa_exencion text,

  -- Importes derivados, no escribibles desde la API.
  base_imponible numeric(14,2)
    generated always as (app.importe_linea(cantidad, precio_unitario, descuento_porcentaje)) stored,
  cuota_iva numeric(14,2)
    generated always as (
      round(app.importe_linea(cantidad, precio_unitario, descuento_porcentaje) * tipo_iva / 100, 2)
    ) stored,
  cuota_irpf numeric(14,2)
    generated always as (
      round(app.importe_linea(cantidad, precio_unitario, descuento_porcentaje) * tipo_irpf / 100, 2)
    ) stored,

  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  constraint lineas_factura_exenta_sin_iva check (not exenta or tipo_iva = 0),
  constraint lineas_factura_exenta_con_causa check (not exenta or causa_exencion is not null)
);

create index lineas_factura_idx on public.lineas_factura (factura_id, orden);
create index lineas_factura_tenant_idx on public.lineas_factura (tenant_id);

comment on table public.lineas_factura is 'Líneas de la factura de venta. base/cuotas son columnas generadas.';

-- La línea debe pertenecer a la misma empresa que su factura.
create or replace function app.validar_tenant_de_linea_factura()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select f.tenant_id into v_tenant from public.facturas f where f.id = new.factura_id;
  if v_tenant is null then
    raise exception 'La factura % no existe', new.factura_id using errcode = 'foreign_key_violation';
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'La línea pertenece a una empresa distinta que la factura' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger lineas_factura_validar_tenant
  before insert or update on public.lineas_factura
  for each row execute function app.validar_tenant_de_linea_factura();

-- Recalcula los totales de la factura cuando cambian sus líneas.
create or replace function app.recalcular_factura()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_factura uuid;
  v_base numeric(14,2);
  v_iva  numeric(14,2);
  v_irpf numeric(14,2);
  v_desglose jsonb;
begin
  v_factura := coalesce(new.factura_id, old.factura_id);

  -- Totales de la factura.
  select coalesce(sum(lf.base_imponible), 0),
         coalesce(sum(lf.cuota_iva), 0),
         coalesce(sum(lf.cuota_irpf), 0)
    into v_base, v_iva, v_irpf
    from public.lineas_factura lf
   where lf.factura_id = v_factura;

  -- Desglose por tipo de IVA (una entrada por tipo), para el libro registro.
  select coalesce(
           jsonb_agg(jsonb_build_object('tipo', g.tipo_iva, 'base', g.base, 'cuota', g.cuota)
                     order by g.tipo_iva),
           '[]'::jsonb)
    into v_desglose
    from (
      select lf.tipo_iva,
             sum(lf.base_imponible) as base,
             sum(lf.cuota_iva)      as cuota
        from public.lineas_factura lf
       where lf.factura_id = v_factura
       group by lf.tipo_iva
    ) g;

  update public.facturas
     set base_imponible = v_base,
         total_iva      = v_iva,
         total_irpf     = v_irpf,
         total          = v_base + v_iva - v_irpf,
         desglose_iva   = v_desglose,
         actualizado_en = now()
   where id = v_factura;

  return null;
end;
$$;

create trigger lineas_factura_recalcular
  after insert or update or delete on public.lineas_factura
  for each row execute function app.recalcular_factura();


-- =============================================================================
-- BLOQUE 6 · REGISTROS VERIFACTU (cadena de registros de facturación)
-- =============================================================================
--  ⚠️  Esta tabla define DÓNDE se guarda el registro, no CÓMO se calcula.
--  El algoritmo de huella, el orden de concatenación de campos, el QR y el XML
--  de remisión están fijados por la especificación oficial de la AEAT
--  (RD 1007/2023 y su orden de desarrollo). NO se implementa aquí nada de eso:
--  antes de calcular una huella hay que programar contra la especificación
--  vigente descargada de sede.agenciatributaria.gob.es. Los campos de abajo son
--  el contenedor y se ajustarán a los nombres oficiales al implementarlo.
-- =============================================================================

create table public.registros_verifactu (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete restrict,
  factura_id     uuid not null references public.facturas(id) on delete restrict,

  tipo_registro  text not null check (tipo_registro in ('alta', 'anulacion')),

  -- Posición en la cadena de la empresa. Correlativo y sin huecos.
  numero_orden   bigint not null,

  -- Huella (hash) de este registro y del anterior de la cadena.
  huella         text,
  huella_anterior text,
  algoritmo_huella text not null default 'SHA-256',

  fecha_hora_generacion timestamptz not null default now(),

  xml_registro   text,
  estado_envio   text not null default 'pendiente'
    check (estado_envio in ('pendiente', 'enviado', 'aceptado', 'aceptado_con_errores', 'rechazado', 'error')),
  entorno        text not null default 'pruebas' check (entorno in ('pruebas', 'produccion')),
  respuesta_aeat jsonb,
  csv_aeat       text,
  intentos_envio integer not null default 0,
  ultimo_error   text,
  enviado_en     timestamptz,

  creado_en      timestamptz not null default now(),

  unique (tenant_id, numero_orden),
  unique (factura_id, tipo_registro)
);

create index registros_verifactu_pendientes_idx
  on public.registros_verifactu (tenant_id, estado_envio)
  where estado_envio in ('pendiente', 'error');

comment on table public.registros_verifactu is
  'Cadena de registros de facturación VeriFactu. Append-only: nunca se borra ni se reescribe la huella.';

-- El registro es inalterable salvo el resultado del envío a la AEAT.
create or replace function app.proteger_registro_verifactu()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.factura_id is distinct from old.factura_id
     or new.tipo_registro is distinct from old.tipo_registro
     or new.numero_orden is distinct from old.numero_orden
     or new.huella is distinct from old.huella
     or new.huella_anterior is distinct from old.huella_anterior
     or new.algoritmo_huella is distinct from old.algoritmo_huella
     or new.fecha_hora_generacion is distinct from old.fecha_hora_generacion then
    raise exception 'El registro VeriFactu es inalterable; solo se puede actualizar el resultado del envío'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger registros_verifactu_proteger
  before update on public.registros_verifactu
  for each row execute function app.proteger_registro_verifactu();


-- =============================================================================
-- BLOQUE 7 · COSTES DE MATERIAL: albaranes de proveedor y sus líneas
-- =============================================================================

create table public.albaranes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  obra_id        uuid not null references public.obras(id) on delete restrict,
  proveedor_id   uuid not null references public.proveedores(id) on delete restrict,

  numero_albaran text,                     -- el número que trae el albarán del proveedor
  fecha          date not null default current_date,

  -- Total del albarán (suma de líneas), calculado por trigger.
  base_imponible numeric(14,2) not null default 0,

  -- Trazabilidad con la factura del proveedor cuando llegue (opcional en MVP).
  factura_proveedor_numero text,
  estado         text not null default 'recibido'
    check (estado in ('recibido', 'conformado', 'facturado')),

  observaciones  text,
  creado_por     uuid references public.usuarios(id) on delete set null,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index albaranes_obra_idx on public.albaranes (obra_id, fecha desc);
create index albaranes_proveedor_idx on public.albaranes (proveedor_id);
create index albaranes_tenant_idx on public.albaranes (tenant_id);

comment on table public.albaranes is 'Albarán de material recibido para una obra. El total es coste de MATERIAL de la obra.';

create table public.lineas_albaran (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  albaran_id     uuid not null references public.albaranes(id) on delete cascade,

  -- A qué partida/capítulo se imputa el material (opcional: puede ir a la obra sin más).
  partida_id     uuid references public.partidas(id) on delete set null,

  orden          integer not null default 0,
  descripcion    text not null,
  cantidad       numeric(14,4) not null default 0 check (cantidad >= 0),
  unidad         text,
  precio_unitario numeric(14,4) not null default 0 check (precio_unitario >= 0),

  importe numeric(14,2)
    generated always as (round(coalesce(cantidad, 0) * coalesce(precio_unitario, 0), 2)) stored,

  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index lineas_albaran_albaran_idx on public.lineas_albaran (albaran_id, orden);
create index lineas_albaran_partida_idx on public.lineas_albaran (partida_id);
create index lineas_albaran_tenant_idx on public.lineas_albaran (tenant_id);

comment on table public.lineas_albaran is 'Materiales de un albarán. importe = cantidad × precio_unitario (columna generada).';

-- La línea pertenece a la misma empresa que su albarán.
create or replace function app.validar_tenant_de_linea_albaran()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select a.tenant_id into v_tenant from public.albaranes a where a.id = new.albaran_id;
  if v_tenant is null then
    raise exception 'El albarán % no existe', new.albaran_id using errcode = 'foreign_key_violation';
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'La línea pertenece a una empresa distinta que el albarán' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger lineas_albaran_validar_tenant
  before insert or update on public.lineas_albaran
  for each row execute function app.validar_tenant_de_linea_albaran();

-- Recalcula el total del albarán cuando cambian sus líneas.
create or replace function app.recalcular_albaran()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_albaran uuid;
begin
  v_albaran := coalesce(new.albaran_id, old.albaran_id);
  update public.albaranes
     set base_imponible = (select coalesce(sum(importe), 0) from public.lineas_albaran where albaran_id = v_albaran),
         actualizado_en = now()
   where id = v_albaran;
  return null;
end;
$$;

create trigger lineas_albaran_recalcular
  after insert or update or delete on public.lineas_albaran
  for each row execute function app.recalcular_albaran();


-- =============================================================================
-- BLOQUE 8 · COSTES DE MANO DE OBRA: partes de trabajo y sus líneas
-- =============================================================================
-- El parte de trabajo recoge las horas de un operario en una fecha. Cada línea
-- imputa horas a una obra (y opcionalmente a una partida). El coste se calcula
-- con el coste/hora REAL vigente a esa fecha (app.coste_hora_vigente).
-- =============================================================================

create table public.partes_trabajo (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  operario_id    uuid not null references public.operarios(id) on delete restrict,

  fecha          date not null default current_date,

  -- Total de horas y coste del parte (suma de líneas), calculado por trigger.
  total_horas    numeric(10,2) not null default 0,
  total_coste    numeric(14,2) not null default 0,

  estado         text not null default 'borrador'
    check (estado in ('borrador', 'aprobado', 'imputado')),
  observaciones  text,
  creado_por     uuid references public.usuarios(id) on delete set null,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  unique (operario_id, fecha)
);

create index partes_operario_idx on public.partes_trabajo (operario_id, fecha desc);
create index partes_tenant_idx on public.partes_trabajo (tenant_id);

comment on table public.partes_trabajo is 'Parte diario de un operario. Sus líneas reparten horas entre obras.';

create table public.lineas_parte (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  parte_id       uuid not null references public.partes_trabajo(id) on delete cascade,
  obra_id        uuid not null references public.obras(id) on delete restrict,
  partida_id     uuid references public.partidas(id) on delete set null,

  orden          integer not null default 0,
  horas          numeric(8,2) not null check (horas > 0),

  -- Coste/hora aplicado, congelado al imputar (copia del vigente a la fecha del
  -- parte). Se guarda para que el coste no cambie si luego se edita costes_hora.
  coste_hora_aplicado numeric(10,4) not null default 0 check (coste_hora_aplicado >= 0),

  importe numeric(14,2)
    generated always as (round(coalesce(horas, 0) * coalesce(coste_hora_aplicado, 0), 2)) stored,

  descripcion    text,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index lineas_parte_parte_idx on public.lineas_parte (parte_id, orden);
create index lineas_parte_obra_idx on public.lineas_parte (obra_id);
create index lineas_parte_partida_idx on public.lineas_parte (partida_id);
create index lineas_parte_tenant_idx on public.lineas_parte (tenant_id);

comment on table public.lineas_parte is 'Horas imputadas a una obra. importe = horas × coste_hora_aplicado (columna generada).';

-- Valida empresa y, si no viene coste_hora_aplicado, lo rellena con el vigente.
create or replace function app.preparar_linea_parte()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_operario uuid;
  v_fecha date;
begin
  select pt.tenant_id, pt.operario_id, pt.fecha
    into v_tenant, v_operario, v_fecha
    from public.partes_trabajo pt where pt.id = new.parte_id;

  if v_tenant is null then
    raise exception 'El parte % no existe', new.parte_id using errcode = 'foreign_key_violation';
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'La línea pertenece a una empresa distinta que el parte' using errcode = 'check_violation';
  end if;

  -- Si no se indicó el coste/hora, se toma el vigente a la fecha del parte.
  if new.coste_hora_aplicado is null or new.coste_hora_aplicado = 0 then
    new.coste_hora_aplicado := coalesce(app.coste_hora_vigente(v_operario, v_fecha), 0);
  end if;

  return new;
end;
$$;

create trigger lineas_parte_preparar
  before insert or update on public.lineas_parte
  for each row execute function app.preparar_linea_parte();

-- Recalcula totales del parte cuando cambian sus líneas.
create or replace function app.recalcular_parte()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parte uuid;
begin
  v_parte := coalesce(new.parte_id, old.parte_id);
  update public.partes_trabajo
     set total_horas = (select coalesce(sum(horas), 0) from public.lineas_parte where parte_id = v_parte),
         total_coste = (select coalesce(sum(importe), 0) from public.lineas_parte where parte_id = v_parte),
         actualizado_en = now()
   where id = v_parte;
  return null;
end;
$$;

create trigger lineas_parte_recalcular
  after insert or update or delete on public.lineas_parte
  for each row execute function app.recalcular_parte();


-- =============================================================================
-- BLOQUE 9 · IMPUTACIÓN DE COSTES (libro único de costes de la obra)
-- =============================================================================
-- Tabla transversal donde confluyen TODOS los costes de una obra, vengan de
-- donde vengan (material por albarán, mano de obra por parte, o manual). Es la
-- base del cálculo de MARGEN: sumando aquí por obra se obtiene el coste total.
-- Cada fila puede apuntar a su origen (albarán/parte) para trazabilidad.
-- =============================================================================

create table public.imputacion_costes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  obra_id        uuid not null references public.obras(id) on delete cascade,
  capitulo_id    uuid references public.capitulos(id) on delete set null,
  partida_id     uuid references public.partidas(id) on delete set null,

  tipo           app.tipo_coste not null,
  origen         app.origen_coste not null default 'manual',

  -- Enlace al documento de origen (según `origen`). Todos opcionales.
  albaran_id       uuid references public.albaranes(id) on delete set null,
  linea_albaran_id uuid references public.lineas_albaran(id) on delete set null,
  parte_id         uuid references public.partes_trabajo(id) on delete set null,
  linea_parte_id   uuid references public.lineas_parte(id) on delete set null,
  proveedor_id     uuid references public.proveedores(id) on delete set null,
  operario_id      uuid references public.operarios(id) on delete set null,

  fecha          date not null default current_date,
  concepto       text not null,
  cantidad       numeric(14,4),
  unidad         text,
  importe        numeric(14,2) not null check (importe >= 0),

  observaciones  text,
  creado_por     uuid references public.usuarios(id) on delete set null,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index imputacion_obra_idx on public.imputacion_costes (obra_id, fecha);
create index imputacion_obra_tipo_idx on public.imputacion_costes (obra_id, tipo);
create index imputacion_partida_idx on public.imputacion_costes (partida_id);
create index imputacion_tenant_idx on public.imputacion_costes (tenant_id);

comment on table public.imputacion_costes is
  'Libro único de costes de la obra (material + mano de obra + otros). Base del cálculo de margen.';


-- =============================================================================
-- BLOQUE 10 · VISTAS DE MARGEN (producción certificada/facturada − costes)
-- =============================================================================
-- El margen de una obra se lee de aquí. No se almacena: se calcula en vivo para
-- que siempre refleje el estado real de certificaciones, facturas y costes.
-- Las vistas respetan la RLS de sus tablas base (security_invoker).
-- =============================================================================

create or replace view public.obra_margen
with (security_invoker = true) as
select
  o.id                              as obra_id,
  o.tenant_id,
  o.codigo,
  o.nombre,
  o.estado,
  o.importe_contrato,

  -- Producción certificada (suma de bases de certificaciones no anuladas).
  coalesce(c.certificado, 0)        as total_certificado,
  -- Producción facturada (suma de bases de facturas emitidas).
  coalesce(f.facturado, 0)          as total_facturado,

  -- Costes imputados, desglosados.
  coalesce(k.coste_material, 0)     as coste_material,
  coalesce(k.coste_mano_obra, 0)    as coste_mano_obra,
  coalesce(k.coste_otros, 0)        as coste_otros,
  coalesce(k.coste_total, 0)        as coste_total,

  -- Margen = producción certificada − coste total imputado.
  coalesce(c.certificado, 0) - coalesce(k.coste_total, 0) as margen,

  -- Margen en % sobre lo certificado (NULL si aún no se ha certificado nada).
  case when coalesce(c.certificado, 0) <> 0
       then round((coalesce(c.certificado, 0) - coalesce(k.coste_total, 0)) * 100 / c.certificado, 2)
       else null end               as margen_porcentaje
from public.obras o
left join (
  select obra_id, sum(base_imponible) as certificado
    from public.certificaciones
   where estado <> 'anulada'
   group by obra_id
) c on c.obra_id = o.id
left join (
  select obra_id, sum(base_imponible) as facturado
    from public.facturas
   where estado = 'emitida'
   group by obra_id
) f on f.obra_id = o.id
left join (
  select obra_id,
         sum(importe) filter (where tipo = 'material')  as coste_material,
         sum(importe) filter (where tipo = 'mano_obra') as coste_mano_obra,
         sum(importe) filter (where tipo not in ('material','mano_obra')) as coste_otros,
         sum(importe)                                   as coste_total
    from public.imputacion_costes
   group by obra_id
) k on k.obra_id = o.id;

comment on view public.obra_margen is
  'Margen por obra: producción certificada/facturada frente a costes imputados (material + mano de obra + otros).';


-- =============================================================================
-- BLOQUE 11 · Triggers de mantenimiento (actualizado_en + tenant inmutable)
-- =============================================================================

create trigger tenants_actualizado before update on public.tenants
  for each row execute function app.set_actualizado_en();
create trigger usuarios_actualizado before update on public.usuarios
  for each row execute function app.set_actualizado_en();
create trigger membresias_actualizado before update on public.membresias
  for each row execute function app.set_actualizado_en();
create trigger clientes_actualizado before update on public.clientes
  for each row execute function app.set_actualizado_en();
create trigger proveedores_actualizado before update on public.proveedores
  for each row execute function app.set_actualizado_en();
create trigger operarios_actualizado before update on public.operarios
  for each row execute function app.set_actualizado_en();
create trigger costes_hora_actualizado before update on public.costes_hora
  for each row execute function app.set_actualizado_en();
create trigger obras_actualizado before update on public.obras
  for each row execute function app.set_actualizado_en();
create trigger capitulos_actualizado before update on public.capitulos
  for each row execute function app.set_actualizado_en();
create trigger partidas_actualizado before update on public.partidas
  for each row execute function app.set_actualizado_en();
create trigger certificaciones_actualizado before update on public.certificaciones
  for each row execute function app.set_actualizado_en();
create trigger lineas_cert_actualizado before update on public.lineas_certificacion
  for each row execute function app.set_actualizado_en();
create trigger facturas_actualizado before update on public.facturas
  for each row execute function app.set_actualizado_en();
create trigger lineas_factura_actualizado before update on public.lineas_factura
  for each row execute function app.set_actualizado_en();
create trigger albaranes_actualizado before update on public.albaranes
  for each row execute function app.set_actualizado_en();
create trigger lineas_albaran_actualizado before update on public.lineas_albaran
  for each row execute function app.set_actualizado_en();
create trigger partes_actualizado before update on public.partes_trabajo
  for each row execute function app.set_actualizado_en();
create trigger lineas_parte_actualizado before update on public.lineas_parte
  for each row execute function app.set_actualizado_en();
create trigger imputacion_actualizado before update on public.imputacion_costes
  for each row execute function app.set_actualizado_en();

-- tenant_id inmutable en todas las tablas de negocio con tenant_id.
create trigger membresias_tenant_inmutable before update on public.membresias
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger clientes_tenant_inmutable before update on public.clientes
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger proveedores_tenant_inmutable before update on public.proveedores
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger operarios_tenant_inmutable before update on public.operarios
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger costes_hora_tenant_inmutable before update on public.costes_hora
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger obras_tenant_inmutable before update on public.obras
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger capitulos_tenant_inmutable before update on public.capitulos
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger partidas_tenant_inmutable before update on public.partidas
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger certificaciones_tenant_inmutable before update on public.certificaciones
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger lineas_cert_tenant_inmutable before update on public.lineas_certificacion
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger facturas_tenant_inmutable before update on public.facturas
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger lineas_factura_tenant_inmutable before update on public.lineas_factura
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger albaranes_tenant_inmutable before update on public.albaranes
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger lineas_albaran_tenant_inmutable before update on public.lineas_albaran
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger partes_tenant_inmutable before update on public.partes_trabajo
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger lineas_parte_tenant_inmutable before update on public.lineas_parte
  for each row execute function app.bloquear_cambio_de_tenant();
create trigger imputacion_tenant_inmutable before update on public.imputacion_costes
  for each row execute function app.bloquear_cambio_de_tenant();


-- =============================================================================
-- BLOQUE 12 · ROW LEVEL SECURITY
-- =============================================================================
-- Dos capas: RLS decide QUÉ FILAS ve/toca cada usuario (aislamiento por tenant);
-- los GRANT deciden a qué tablas llega. El rol `anon` no toca ninguna tabla de
-- negocio: todo exige sesión. El patrón por tenant es idéntico en casi todas:
--   SELECT  → tenant_id in tenants_visibles()
--   INSERT  → tenant_id in tenants_editables()   (WITH CHECK)
--   UPDATE  → tenant_id in tenants_editables()   (USING + WITH CHECK)
--   DELETE  → tenant_id in tenants_editables()
--   (y siempre el superadmin aparte).
-- =============================================================================

alter table public.tenants              enable row level security;
alter table public.usuarios             enable row level security;
alter table public.membresias           enable row level security;
alter table public.clientes             enable row level security;
alter table public.proveedores          enable row level security;
alter table public.operarios            enable row level security;
alter table public.costes_hora          enable row level security;
alter table public.obras                enable row level security;
alter table public.capitulos            enable row level security;
alter table public.partidas             enable row level security;
alter table public.certificaciones      enable row level security;
alter table public.lineas_certificacion enable row level security;
alter table public.facturas             enable row level security;
alter table public.lineas_factura       enable row level security;
alter table public.registros_verifactu  enable row level security;
alter table public.albaranes            enable row level security;
alter table public.lineas_albaran       enable row level security;
alter table public.partes_trabajo       enable row level security;
alter table public.lineas_parte         enable row level security;
alter table public.imputacion_costes    enable row level security;

-- Punto de partida: nadie toca nada. A partir de aquí concedemos lo justo.
revoke all on all tables in schema public from anon, authenticated;

-- -----------------------------------------------------------------------------
-- tenants · lectura para miembros; alta por RPC (no INSERT directo).
-- -----------------------------------------------------------------------------
grant select on public.tenants to authenticated;
grant update (
  razon_social, nombre_comercial, direccion, codigo_postal, municipio, provincia,
  pais, email_contacto, telefono, web, logo_url, retencion_irpf_por_defecto
) on public.tenants to authenticated;

create policy tenants_leer on public.tenants for select to authenticated
  using (id in (select app.tenants_visibles()) or app.es_superadmin());
create policy tenants_actualizar on public.tenants for update to authenticated
  using (id in (select app.tenants_administrables()) or app.es_superadmin())
  with check (id in (select app.tenants_administrables()) or app.es_superadmin());

-- -----------------------------------------------------------------------------
-- usuarios · cada uno se ve a sí mismo y a quien comparte empresa con él.
-- `es_superadmin` queda fuera del GRANT: solo la cambia el service_role.
-- -----------------------------------------------------------------------------
grant select on public.usuarios to authenticated;
grant update (nombre, apellidos, telefono, avatar_url) on public.usuarios to authenticated;

create policy usuarios_leer on public.usuarios for select to authenticated
  using (
    id = auth.uid()
    or app.es_superadmin()
    or exists (
      select 1 from public.membresias m
       where m.usuario_id = usuarios.id
         and m.tenant_id in (select app.tenants_visibles())
    )
  );
create policy usuarios_actualizar_propio on public.usuarios for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- -----------------------------------------------------------------------------
-- membresias · lectura por miembros; gestión por admin de la empresa.
-- -----------------------------------------------------------------------------
grant select, insert, delete on public.membresias to authenticated;
grant update (rol, estado) on public.membresias to authenticated;

create policy membresias_leer on public.membresias for select to authenticated
  using (
    usuario_id = auth.uid()
    or tenant_id in (select app.tenants_visibles())
    or app.es_superadmin()
  );
create policy membresias_crear on public.membresias for insert to authenticated
  with check (tenant_id in (select app.tenants_administrables()) or app.es_superadmin());
create policy membresias_actualizar on public.membresias for update to authenticated
  using (tenant_id in (select app.tenants_administrables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_administrables()) or app.es_superadmin());
create policy membresias_borrar on public.membresias for delete to authenticated
  using (tenant_id in (select app.tenants_administrables()) or app.es_superadmin());

-- -----------------------------------------------------------------------------
-- Patrón estándar por tenant para el resto de tablas de negocio.
-- -----------------------------------------------------------------------------

-- clientes --------------------------------------------------------------------
grant select, insert, delete on public.clientes to authenticated;
grant update (
  tipo, razon_social, nombre_comercial, nif, direccion, codigo_postal, municipio,
  provincia, pais, email, telefono, persona_contacto, es_administracion_publica,
  dir3_oficina_contable, dir3_organo_gestor, dir3_unidad_tramitadora,
  dias_vencimiento, forma_pago, notas, activo
) on public.clientes to authenticated;
create policy clientes_leer on public.clientes for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy clientes_crear on public.clientes for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy clientes_actualizar on public.clientes for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy clientes_borrar on public.clientes for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- proveedores -----------------------------------------------------------------
grant select, insert, delete on public.proveedores to authenticated;
grant update (
  razon_social, nombre_comercial, nif, direccion, codigo_postal, municipio,
  provincia, pais, email, telefono, persona_contacto, tipo, notas, activo
) on public.proveedores to authenticated;
create policy proveedores_leer on public.proveedores for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy proveedores_crear on public.proveedores for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy proveedores_actualizar on public.proveedores for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy proveedores_borrar on public.proveedores for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- operarios -------------------------------------------------------------------
grant select, insert, delete on public.operarios to authenticated;
grant update (
  usuario_id, nombre, apellidos, nif, categoria, telefono, email,
  fecha_alta, fecha_baja, activo
) on public.operarios to authenticated;
create policy operarios_leer on public.operarios for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy operarios_crear on public.operarios for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy operarios_actualizar on public.operarios for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy operarios_borrar on public.operarios for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- costes_hora -----------------------------------------------------------------
grant select, insert, delete on public.costes_hora to authenticated;
grant update (coste_hora, vigente_desde, vigente_hasta, observaciones)
  on public.costes_hora to authenticated;
create policy costes_hora_leer on public.costes_hora for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy costes_hora_crear on public.costes_hora for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy costes_hora_actualizar on public.costes_hora for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy costes_hora_borrar on public.costes_hora for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- obras -----------------------------------------------------------------------
grant select, insert, delete on public.obras to authenticated;
grant update (
  cliente_id, codigo, nombre, descripcion, direccion, codigo_postal, municipio,
  provincia, estado, fecha_adjudicacion, fecha_inicio, fecha_fin_prevista,
  fecha_fin_real, importe_contrato, retencion_garantia_porcentaje, notas
) on public.obras to authenticated;
create policy obras_leer on public.obras for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy obras_crear on public.obras for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy obras_actualizar on public.obras for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy obras_borrar on public.obras for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- capitulos -------------------------------------------------------------------
grant select, insert, delete on public.capitulos to authenticated;
grant update (codigo, nombre, orden) on public.capitulos to authenticated;
create policy capitulos_leer on public.capitulos for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy capitulos_crear on public.capitulos for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy capitulos_actualizar on public.capitulos for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy capitulos_borrar on public.capitulos for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- partidas --------------------------------------------------------------------
grant select, insert, delete on public.partidas to authenticated;
grant update (capitulo_id, codigo, descripcion, unidad, orden, medicion,
              precio_unidad, coste_unidad_previsto) on public.partidas to authenticated;
create policy partidas_leer on public.partidas for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy partidas_crear on public.partidas for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy partidas_actualizar on public.partidas for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy partidas_borrar on public.partidas for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- certificaciones -------------------------------------------------------------
-- Los totales (base_imponible, importe_retencion_garantia) NO se conceden: los
-- calcula el trigger a partir de las líneas.
grant select, insert, delete on public.certificaciones to authenticated;
grant update (numero, descripcion, fecha, periodo_desde, periodo_hasta, estado,
              retencion_garantia_porcentaje, aprobada_en, observaciones)
  on public.certificaciones to authenticated;
create policy certificaciones_leer on public.certificaciones for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy certificaciones_crear on public.certificaciones for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy certificaciones_actualizar on public.certificaciones for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy certificaciones_borrar on public.certificaciones for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- lineas_certificacion --------------------------------------------------------
-- cantidad_periodo e importe son columnas generadas (no se conceden).
grant select, insert, delete on public.lineas_certificacion to authenticated;
grant update (partida_id, orden, precio_unidad, cantidad_acumulada, cantidad_anterior)
  on public.lineas_certificacion to authenticated;
create policy lineas_cert_leer on public.lineas_certificacion for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy lineas_cert_crear on public.lineas_certificacion for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy lineas_cert_actualizar on public.lineas_certificacion for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy lineas_cert_borrar on public.lineas_certificacion for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- facturas --------------------------------------------------------------------
-- numero, numero_completo, estado y los totales NO se conceden: los asigna el
-- proceso de emisión y los triggers.
grant select, insert, delete on public.facturas to authenticated;
grant update (obra_id, cliente_id, certificacion_id, serie, fecha_expedicion,
              fecha_operacion, moneda, estado_cobro, fecha_vencimiento, forma_pago,
              observaciones, pdf_url) on public.facturas to authenticated;
create policy facturas_leer on public.facturas for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy facturas_crear on public.facturas for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy facturas_actualizar on public.facturas for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy facturas_borrar on public.facturas for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- lineas_factura --------------------------------------------------------------
grant select, insert, delete on public.lineas_factura to authenticated;
grant update (orden, descripcion, cantidad, unidad, precio_unitario,
              descuento_porcentaje, tipo_iva, tipo_irpf, exenta, causa_exencion)
  on public.lineas_factura to authenticated;
create policy lineas_factura_leer on public.lineas_factura for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy lineas_factura_crear on public.lineas_factura for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy lineas_factura_actualizar on public.lineas_factura for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy lineas_factura_borrar on public.lineas_factura for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- registros_verifactu ---------------------------------------------------------
-- Solo lectura desde la aplicación. Los escribe el proceso de emisión (service_role).
grant select on public.registros_verifactu to authenticated;
create policy verifactu_leer on public.registros_verifactu for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());

-- albaranes -------------------------------------------------------------------
grant select, insert, delete on public.albaranes to authenticated;
grant update (obra_id, proveedor_id, numero_albaran, fecha, factura_proveedor_numero,
              estado, observaciones) on public.albaranes to authenticated;
create policy albaranes_leer on public.albaranes for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy albaranes_crear on public.albaranes for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy albaranes_actualizar on public.albaranes for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy albaranes_borrar on public.albaranes for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- lineas_albaran --------------------------------------------------------------
grant select, insert, delete on public.lineas_albaran to authenticated;
grant update (partida_id, orden, descripcion, cantidad, unidad, precio_unitario)
  on public.lineas_albaran to authenticated;
create policy lineas_albaran_leer on public.lineas_albaran for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy lineas_albaran_crear on public.lineas_albaran for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy lineas_albaran_actualizar on public.lineas_albaran for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy lineas_albaran_borrar on public.lineas_albaran for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- partes_trabajo --------------------------------------------------------------
grant select, insert, delete on public.partes_trabajo to authenticated;
grant update (operario_id, fecha, estado, observaciones) on public.partes_trabajo to authenticated;
create policy partes_leer on public.partes_trabajo for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy partes_crear on public.partes_trabajo for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy partes_actualizar on public.partes_trabajo for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy partes_borrar on public.partes_trabajo for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- lineas_parte ----------------------------------------------------------------
-- importe es columna generada; coste_hora_aplicado lo rellena el trigger si falta.
grant select, insert, delete on public.lineas_parte to authenticated;
grant update (obra_id, partida_id, orden, horas, coste_hora_aplicado, descripcion)
  on public.lineas_parte to authenticated;
create policy lineas_parte_leer on public.lineas_parte for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy lineas_parte_crear on public.lineas_parte for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy lineas_parte_actualizar on public.lineas_parte for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy lineas_parte_borrar on public.lineas_parte for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- imputacion_costes -----------------------------------------------------------
grant select, insert, delete on public.imputacion_costes to authenticated;
grant update (obra_id, capitulo_id, partida_id, tipo, origen, albaran_id,
              linea_albaran_id, parte_id, linea_parte_id, proveedor_id, operario_id,
              fecha, concepto, cantidad, unidad, importe, observaciones)
  on public.imputacion_costes to authenticated;
create policy imputacion_leer on public.imputacion_costes for select to authenticated
  using (tenant_id in (select app.tenants_visibles()) or app.es_superadmin());
create policy imputacion_crear on public.imputacion_costes for insert to authenticated
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy imputacion_actualizar on public.imputacion_costes for update to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin())
  with check (tenant_id in (select app.tenants_editables()) or app.es_superadmin());
create policy imputacion_borrar on public.imputacion_costes for delete to authenticated
  using (tenant_id in (select app.tenants_editables()) or app.es_superadmin());

-- Vistas (la vista respeta la RLS de sus tablas base por security_invoker).
grant select on public.obra_margen to authenticated;

-- Secuencias e identidad
grant usage on all sequences in schema public to authenticated;

-- =============================================================================
-- FIN DEL ESQUEMA · Brigada MVP
-- 20 tablas, todas con RLS. Todas las de negocio llevan tenant_id (salvo
-- `usuarios`, perfil global 1:1 con auth.users, cuyo aislamiento se hace por
-- membresia). Importes calculados por la base; VeriFactu como contenedor
-- inalterable pendiente de implementar contra la especificación oficial.
-- =============================================================================
