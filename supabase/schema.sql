-- =====================================================================
--  Control de Alumnos y Selección de Béisbol · Esquema de Supabase
--  Ejecuta TODO este archivo en: Supabase → SQL Editor → New query → Run
-- =====================================================================

-- ---------- 1. TABLAS ------------------------------------------------

-- Cuentas con rol de manager (se llena a mano, ver paso final)
create table if not exists public.managers (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table if not exists public.alumnos (
  id              uuid primary key default gen_random_uuid(),
  numero_control  text not null check (numero_control ~ '^[A-Za-z0-9-]{4,20}$'),
  nombre          text not null check (char_length(nombre) between 1 and 80),
  carrera         text not null default '' check (char_length(carrera) <= 80),
  nivel           text not null default 'Sin asignar'
                  check (nivel in ('Sin asignar','Principiante','Intermedio','Avanzado','Titular')),
  posiciones      text[] not null default '{}',
  seleccionado    boolean not null default false,
  created_at      timestamptz not null default now()
);
create unique index if not exists alumnos_numero_control_uq on public.alumnos (lower(numero_control));

create table if not exists public.materias (
  id           uuid primary key default gen_random_uuid(),
  alumno_id    uuid not null references public.alumnos (id) on delete cascade,
  nombre       text not null check (char_length(nombre) between 1 and 60),
  comentario   text not null default '' check (char_length(comentario) <= 500), -- observaciones del manager
  created_at   timestamptz not null default now()
);
create unique index if not exists materias_alumno_nombre_uq on public.materias (alumno_id, lower(nombre));

-- Calificación de cada unidad de una materia (máx. 8). El promedio de la
-- materia se calcula en la app a partir de estas filas.
create table if not exists public.unidades (
  id           uuid primary key default gen_random_uuid(),
  materia_id   uuid not null references public.materias (id) on delete cascade,
  numero       smallint not null check (numero between 1 and 8),
  calificacion numeric(4,1) not null check (calificacion between 0 and 100),
  unique (materia_id, numero)
);

-- Comentarios que escribe el alumno sobre sus materias
create table if not exists public.comentarios (
  id         uuid primary key default gen_random_uuid(),
  materia_id uuid not null references public.materias (id) on delete cascade,
  alumno_id  uuid not null references public.alumnos (id) on delete cascade,
  texto      text not null check (char_length(btrim(texto)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists comentarios_materia_idx on public.comentarios (materia_id);

-- ---------- 2. SEGURIDAD (RLS) --------------------------------------
-- Las tablas solo son accesibles para el manager. El alumno (sin cuenta)
-- trabaja únicamente a través de las 3 funciones de la sección 3.

create or replace function public.es_manager()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.managers where user_id = auth.uid());
$$;
revoke execute on function public.es_manager() from public, anon;
grant  execute on function public.es_manager() to authenticated;

alter table public.managers    enable row level security;  -- sin políticas: no se lee desde la app
alter table public.alumnos     enable row level security;
alter table public.materias    enable row level security;
alter table public.comentarios enable row level security;
alter table public.unidades    enable row level security;

revoke all on public.managers, public.alumnos, public.materias, public.unidades, public.comentarios from anon;

drop policy if exists manager_alumnos     on public.alumnos;
drop policy if exists manager_materias    on public.materias;
drop policy if exists manager_comentarios on public.comentarios;
drop policy if exists manager_unidades    on public.unidades;
create policy manager_alumnos     on public.alumnos     for all to authenticated using (public.es_manager()) with check (public.es_manager());
create policy manager_materias    on public.materias    for all to authenticated using (public.es_manager()) with check (public.es_manager());
create policy manager_comentarios on public.comentarios for all to authenticated using (public.es_manager()) with check (public.es_manager());
create policy manager_unidades    on public.unidades    for all to authenticated using (public.es_manager()) with check (public.es_manager());

-- ---------- 3. FUNCIONES PARA EL ALUMNO (sin cuenta) ----------------
-- Se identifica solo con su número de control. Cada función devuelve o
-- modifica ÚNICAMENTE los datos de ese número de control.

-- 3.1 Registro: alumno + materias con sus calificaciones por unidad
--     p_materias = [{"nombre":"Cálculo","unidades":[{"n":1,"calificacion":90},{"n":2,"calificacion":85}]}]
create or replace function public.registrar_alumno(
  p_numero_control text, p_nombre text, p_carrera text, p_materias jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  m    jsonb;
  v_nombre text;
  v_mat    uuid;
  u        jsonb;
  v_num    int;
  v_cal    numeric;
begin
  if btrim(coalesce(p_numero_control,'')) !~ '^[A-Za-z0-9-]{4,20}$' then
    raise exception 'numero_control_invalido';
  end if;
  if btrim(coalesce(p_nombre,'')) = '' or btrim(coalesce(p_carrera,'')) = '' then
    raise exception 'datos_incompletos';
  end if;
  if jsonb_typeof(p_materias) <> 'array' or jsonb_array_length(p_materias) = 0 then
    raise exception 'sin_materias';
  end if;

  if exists (select 1 from alumnos where lower(numero_control) = lower(btrim(p_numero_control))) then
    raise exception 'duplicado';
  end if;

  insert into alumnos (numero_control, nombre, carrera)
  values (btrim(p_numero_control), left(btrim(p_nombre), 80), left(btrim(p_carrera), 80))
  returning id into v_id;

  for m in select * from jsonb_array_elements(p_materias) limit 30 loop
    v_nombre := left(btrim(coalesce(m->>'nombre','')), 60);
    if v_nombre = '' then continue; end if;
    insert into materias (alumno_id, nombre)
    values (v_id, v_nombre)
    on conflict do nothing
    returning id into v_mat;
    if v_mat is null then continue; end if;  -- materia repetida

    if jsonb_typeof(m->'unidades') = 'array' then
      for u in select * from jsonb_array_elements(m->'unidades') limit 8 loop
        v_num := (u->>'n')::int;
        v_cal := (u->>'calificacion')::numeric;
        if v_num not between 1 and 8 or v_cal not between 0 and 100 then
          raise exception 'calificacion_invalida';
        end if;
        insert into unidades (materia_id, numero, calificacion)
        values (v_mat, v_num, v_cal)
        on conflict (materia_id, numero) do update set calificacion = excluded.calificacion;
      end loop;
    end if;
  end loop;
end;
$$;

-- 3.2 Consulta del perfil con el número de control
create or replace function public.consultar_perfil(p_numero_control text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'numero_control', a.numero_control,
    'nombre', a.nombre,
    'carrera', a.carrera,
    'nivel', a.nivel,
    'posiciones', a.posiciones,
    'seleccionado', a.seleccionado,
    'created_at', a.created_at,
    'materias', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'nombre', m.nombre,
        'comentario', m.comentario,
        'unidades', coalesce((
          select jsonb_agg(jsonb_build_object('numero', u.numero, 'calificacion', u.calificacion)
                           order by u.numero)
          from unidades u where u.materia_id = m.id
        ), '[]'::jsonb),
        'comentarios', coalesce((
          select jsonb_agg(jsonb_build_object('id', c.id, 'texto', c.texto, 'created_at', c.created_at)
                           order by c.created_at)
          from comentarios c where c.materia_id = m.id
        ), '[]'::jsonb)
      ) order by m.created_at)
      from materias m where m.alumno_id = a.id
    ), '[]'::jsonb)
  )
  from alumnos a
  where lower(a.numero_control) = lower(btrim(p_numero_control));
$$;

-- 3.3 Agregar un comentario a una materia propia
create or replace function public.agregar_comentario(
  p_numero_control text, p_materia_id uuid, p_texto text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_alumno uuid;
  v_row    comentarios;
begin
  select a.id into v_alumno
  from alumnos a
  join materias m on m.alumno_id = a.id
  where lower(a.numero_control) = lower(btrim(p_numero_control)) and m.id = p_materia_id;

  if v_alumno is null then raise exception 'materia_no_encontrada'; end if;
  if btrim(coalesce(p_texto,'')) = '' or char_length(btrim(p_texto)) > 500 then
    raise exception 'comentario_invalido';
  end if;

  insert into comentarios (materia_id, alumno_id, texto)
  values (p_materia_id, v_alumno, btrim(p_texto))
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'texto', v_row.texto, 'created_at', v_row.created_at);
end;
$$;

revoke execute on function public.registrar_alumno(text,text,text,jsonb)  from public;
revoke execute on function public.consultar_perfil(text)                  from public;
revoke execute on function public.agregar_comentario(text,uuid,text)      from public;
grant  execute on function public.registrar_alumno(text,text,text,jsonb)  to anon, authenticated;
grant  execute on function public.consultar_perfil(text)                  to anon, authenticated;
grant  execute on function public.agregar_comentario(text,uuid,text)      to anon, authenticated;

-- ---------- 4. LIMPIEZA (solo si ejecutaste una versión anterior) ---
drop trigger  if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.mi_alumno_id() cascade;
alter table public.alumnos drop column if exists user_id;
-- La calificación ahora vive por unidad (tabla unidades). Si ejecutaste una
-- versión anterior con una sola calificación por materia, esto la elimina:
alter table public.materias drop column if exists calificacion;

-- ---------- 5. CREAR TU CUENTA DE MANAGER ---------------------------
-- 1) Supabase → Authentication → Users → Add user (correo + contraseña,
--    marca "Auto Confirm User").
-- 2) Ejecuta esto con TU correo:
--
--    insert into public.managers (user_id)
--    select id from auth.users where email = 'tu-correo@ejemplo.com';
