/* ==========================================================
   Sistema de Control de Alumnos y Selección de Béisbol
   Lógica de la aplicación (datos y autenticación en Supabase)
   ----------------------------------------------------------
   Secciones:
   1. Configuración
   2. Utilidades
   3. Capa de datos (Supabase)
   4. Reglas de negocio (semáforo, promedios)
   5. Autenticación del Manager (Supabase Auth)
   6. Router y navegación
   7. Vista: Registro de aspirante
   8. Vista: Perfil del alumno (consulta con n.º de control + comentarios)
   9. Vista: Panel del Manager (alumnos, modal, selección)
   10. Datos: exportar / importar / demo
   11. Eventos globales e inicialización
   ========================================================== */
(() => {
  'use strict';

  /* ========================================================
     1. CONFIGURACIÓN
     ======================================================== */
  const CONFIG = {
    // Proyecto de Supabase: Project Settings → API.
    // La clave "anon" (o "publishable") es pública por diseño; la seguridad real
    // la dan las políticas RLS de supabase/schema.sql.
    SUPABASE_URL: 'https://psolmpdigawyqfkbjzdx.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzb2xtcGRpZ2F3eXFma2JqemR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNzIyMDMsImV4cCI6MjEwNzk0ODIwM30.kfOFwryJwyKlm8vlT6S3ECOKmVc2JxY9ICHpISESc6k',

    MAX_UNIDADES: 8,       // unidades por materia (si lo cambias, cambia también el check en supabase/schema.sql)

    LEGACY_STORAGE_KEY: 'beisbol_alumnos_v1', // datos de la versión anterior (localStorage)

    MAX_INTENTOS: 5,       // intentos fallidos de login del manager antes de bloquear
    BLOQUEO_MS: 30000      // duración del bloqueo (ms)
  };

  const POSICIONES = ['Pitcher', 'Catcher', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
  const NIVELES = ['Sin asignar', 'Principiante', 'Intermedio', 'Avanzado', 'Titular'];
  const NIVEL_CLASE = { 'Sin asignar': 'na', 'Principiante': 'p', 'Intermedio': 'i', 'Avanzado': 'a', 'Titular': 't' };

  // Umbrales del semáforo
  const UMBRAL_VERDE = 80;
  const UMBRAL_AMARILLO = 70;

  /* ========================================================
     2. UTILIDADES
     ======================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  // UUID v4 (las materias se guardan en Supabase con id uuid)
  const uid = () => (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  const clamp = (n) => Math.min(100, Math.max(0, Math.round(n * 10) / 10));
  /** Promedio de una lista [{calificacion}] (null si está vacía) */
  const avgUnidades = (list) => list.length
    ? Math.round((list.reduce((a, u) => a + u.calificacion, 0) / list.length) * 10) / 10
    : null;

  // Escapa HTML para evitar inyección (XSS) al pintar datos capturados
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const ID_REGEX = /^[A-Za-z0-9-]{4,20}$/;
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Notificación tipo toast */
  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${type} border-0`;
    el.setAttribute('role', 'alert');
    el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(msg)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Cerrar"></button></div>`;
    $('#toastContainer').appendChild(el);
    const t = new bootstrap.Toast(el, { delay: 3500 });
    el.addEventListener('hidden.bs.toast', () => el.remove());
    t.show();
  }

  /** Diálogo de confirmación basado en promesa */
  function confirmDialog(title, message, okLabel = 'Confirmar', okClass = 'btn-danger') {
    return new Promise((resolve) => {
      const modalEl = $('#confirmModal');
      const ok = $('#confirmOk');
      $('#confirmTitle').textContent = title;
      $('#confirmMessage').textContent = message;
      ok.textContent = okLabel;
      ok.className = 'btn ' + okClass;

      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      let result = false;
      const onOk = () => { result = true; modal.hide(); };
      const onHidden = () => {
        ok.removeEventListener('click', onOk);
        modalEl.removeEventListener('hidden.bs.modal', onHidden);
        resolve(result);
      };
      ok.addEventListener('click', onOk);
      modalEl.addEventListener('hidden.bs.modal', onHidden);
      modal.show();
    });
  }

  /* ========================================================
     3. CAPA DE DATOS (LocalStorage)
     ======================================================== */
  /*
   * Modelo de alumno:
   * {
   *   id: 'A2026001',            // número de control (único)
   *   nombre, carrera,
   *   materias: [{ id, nombre, calificacion: number|null, comentario }],
   *   posiciones: ['SS','2B'],
   *   nivel: 'Intermedio',
   *   seleccionado: false,
   *   creadoEn: ISOString
   * }
   */
  let db = [];

  /* ---------- Cliente de Supabase ---------- */
  const configOk = () => !/TU-PROYECTO|TU-ANON-KEY/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_ANON_KEY);
  const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const auth = { role: null, user: null }; // role: 'manager' | null (el alumno no inicia sesión)
  const PERFIL_KEY = 'beisbol_perfil_actual'; // n.º de control abierto por el alumno (sessionStorage)
  let perfil = null;                          // perfil del alumno abierto (viene de consultar_perfil)

  function dbError(ctx, error) {
    console.error(ctx, error);
    toast(`${ctx}: ${error && error.message ? error.message : 'error desconocido'}`, 'danger');
  }

  /** Normaliza y valida un alumno (también se usa al importar JSON) */
  function sanitizeStudent(s) {
    if (!s || typeof s !== 'object') return null;
    const id = String(s.id ?? '').trim();
    const nombre = String(s.nombre ?? '').trim();
    if (!id || !nombre) return null;

    const materias = (Array.isArray(s.materias) ? s.materias : [])
      .filter((m) => m && typeof m === 'object')
      .map((m) => {
        const raw = m.calificacion;
        const hasGrade = raw !== null && raw !== undefined && raw !== '' && !isNaN(Number(raw));

        // Calificaciones por unidad (1..MAX_UNIDADES, sin repetir)
        const vistas = new Set();
        let unidades = (Array.isArray(m.unidades) ? m.unidades : [])
          .map((u) => ({ n: Math.round(Number(u && u.n)), g: u ? u.calificacion : null }))
          .filter((u) => Number.isInteger(u.n) && u.n >= 1 && u.n <= CONFIG.MAX_UNIDADES
            && u.g !== null && u.g !== undefined && u.g !== '' && !isNaN(Number(u.g)))
          .map((u) => ({ n: u.n, calificacion: clamp(Number(u.g)) }))
          .filter((u) => !vistas.has(u.n) && vistas.add(u.n))
          .sort((a, b) => a.n - b.n);
        // Respaldos antiguos con una sola calificación por materia → Unidad 1
        if (!unidades.length && hasGrade) unidades = [{ n: 1, calificacion: clamp(Number(raw)) }];

        return {
          id: UUID_REGEX.test(String(m.id ?? '')) ? m.id : uid(),
          nombre: String(m.nombre ?? '').trim(),
          unidades,
          calificacion: avgUnidades(unidades), // promedio de la materia (calculado)
          comentario: String(m.comentario ?? '').trim(),
          // Comentarios escritos por el alumno (solo lectura para el manager)
          comentarios: (Array.isArray(m.comentarios) ? m.comentarios : [])
            .map((c) => ({ id: c && c.id, texto: String((c && c.texto) ?? '').trim(), creadoEn: (c && c.creadoEn) || '' }))
            .filter((c) => c.texto)
        };
      })
      .filter((m) => m.nombre);

    return {
      id,
      uuid: UUID_REGEX.test(String(s.uuid ?? '')) ? s.uuid : null, // id interno en Supabase
      nombre,
      carrera: String(s.carrera ?? '').trim(),
      materias,
      posiciones: (Array.isArray(s.posiciones) ? s.posiciones : []).filter((p) => POSICIONES.includes(p)),
      nivel: NIVELES.includes(s.nivel) ? s.nivel : 'Sin asignar',
      seleccionado: !!s.seleccionado,
      creadoEn: s.creadoEn || new Date().toISOString()
    };
  }

  /** Fila de Supabase (alumnos + materias + comentarios) → objeto de la app */
  function fromRow(r) {
    const byDate = (a, b) => String(a.created_at).localeCompare(String(b.created_at));
    return sanitizeStudent({
      id: r.numero_control,
      uuid: r.id,
      nombre: r.nombre,
      carrera: r.carrera,
      nivel: r.nivel,
      posiciones: r.posiciones,
      seleccionado: r.seleccionado,
      creadoEn: r.created_at,
      materias: (r.materias || []).slice().sort(byDate).map((m) => ({
        id: m.id,
        nombre: m.nombre,
        comentario: m.comentario,
        unidades: (m.unidades || []).map((u) => ({ n: u.numero, calificacion: u.calificacion })),
        comentarios: (m.comentarios || []).slice().sort(byDate)
          .map((c) => ({ id: c.id, texto: c.texto, creadoEn: c.created_at }))
      }))
    });
  }

  /** JSON de la función consultar_perfil → objeto de la app */
  function fromPerfil(p) {
    if (!p) return null;
    return sanitizeStudent({
      id: p.numero_control,
      nombre: p.nombre,
      carrera: p.carrera,
      nivel: p.nivel,
      posiciones: p.posiciones,
      seleccionado: p.seleccionado,
      creadoEn: p.created_at,
      materias: (p.materias || []).map((m) => ({
        id: m.id, nombre: m.nombre, comentario: m.comentario,
        unidades: (m.unidades || []).map((u) => ({ n: u.numero, calificacion: u.calificacion })),
        comentarios: (m.comentarios || []).map((c) => ({ id: c.id, texto: c.texto, creadoEn: c.created_at }))
      }))
    });
  }

  /** Carga desde Supabase lo que la sesión puede ver (solo el manager; las tablas están protegidas por RLS) */
  async function loadDB() {
    const { data, error } = await sb
      .from('alumnos')
      .select('*, materias(*, comentarios(*), unidades(*))')
      .order('nombre');
    if (error) {
      db = [];
      dbError('No se pudieron cargar los datos', error);
      return false;
    }
    db = data.map(fromRow).filter(Boolean);
    return true;
  }

  /** Guarda (crea o actualiza) un alumno y sincroniza sus materias. Solo manager. Lanza error si falla. */
  async function persistStudent(s) {
    const row = {
      numero_control: s.id,
      nombre: s.nombre,
      carrera: s.carrera,
      nivel: s.nivel,
      posiciones: s.posiciones,
      seleccionado: s.seleccionado
    };
    if (s.uuid) {
      const { error } = await sb.from('alumnos').update(row).eq('id', s.uuid);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from('alumnos').insert(row).select('id').single();
      if (error) throw error;
      s.uuid = data.id;
    }

    // Materias: borra las que ya no están y hace upsert del resto
    const { data: existentes, error: e2 } = await sb.from('materias').select('id').eq('alumno_id', s.uuid);
    if (e2) throw e2;
    const keep = new Set(s.materias.map((m) => m.id));
    const borrar = existentes.map((x) => x.id).filter((id) => !keep.has(id));
    if (borrar.length) {
      const { error } = await sb.from('materias').delete().in('id', borrar);
      if (error) throw error;
    }
    if (s.materias.length) {
      const rows = s.materias.map((m) => ({
        id: m.id,
        alumno_id: s.uuid,
        nombre: m.nombre,
        comentario: m.comentario
      }));
      const { error } = await sb.from('materias').upsert(rows);
      if (error) throw error;

      // Calificaciones por unidad: upsert de las capturadas y borrado de las que se quitaron
      const unidadRows = s.materias.flatMap((m) =>
        m.unidades.map((u) => ({ materia_id: m.id, numero: u.n, calificacion: u.calificacion })));
      if (unidadRows.length) {
        const { error: e3 } = await sb.from('unidades').upsert(unidadRows, { onConflict: 'materia_id,numero' });
        if (e3) throw e3;
      }
      const { data: actuales, error: e4 } = await sb.from('unidades').select('id, materia_id, numero').in('materia_id', s.materias.map((m) => m.id));
      if (e4) throw e4;
      const vigentes = new Set(unidadRows.map((r) => `${r.materia_id}:${r.numero}`));
      const sobran = actuales.filter((x) => !vigentes.has(`${x.materia_id}:${x.numero}`)).map((x) => x.id);
      if (sobran.length) {
        const { error: e5 } = await sb.from('unidades').delete().in('id', sobran);
        if (e5) throw e5;
      }
    }
    return s;
  }

  /** Al importar un alumno que ya existe, reutiliza sus ids (así no se pierden los comentarios del alumno) */
  function reconcileIds(s, prev) {
    if (!prev) return;
    s.uuid = prev.uuid;
    const byName = new Map(prev.materias.map((m) => [norm(m.nombre), m.id]));
    s.materias.forEach((m) => { if (byName.has(norm(m.nombre))) m.id = byName.get(norm(m.nombre)); });
  }

  const findStudent = (id) => db.find((s) => norm(s.id) === norm(id));

  /* ========================================================
     4. REGLAS DE NEGOCIO
     ======================================================== */
  /** Semáforo de una calificación */
  function semaforo(n) {
    if (n === null || n === undefined) return { key: 'gris', label: 'Sin calificar', icon: 'bi-dash-circle' };
    if (n >= UMBRAL_VERDE) return { key: 'verde', label: 'Excelente', icon: 'bi-check-circle-fill' };
    if (n >= UMBRAL_AMARILLO) return { key: 'amarillo', label: 'Regular', icon: 'bi-exclamation-triangle-fill' };
    return { key: 'rojo', label: 'En riesgo', icon: 'bi-x-octagon-fill' };
  }

  /** Promedio de las materias ya calificadas (null si ninguna) */
  function promedio(s) {
    const graded = s.materias.filter((m) => m.calificacion !== null);
    if (!graded.length) return null;
    return Math.round((graded.reduce((a, m) => a + m.calificacion, 0) / graded.length) * 10) / 10;
  }

  const materiasEnRiesgo = (s) => s.materias.filter((m) => m.calificacion !== null && m.calificacion < UMBRAL_AMARILLO).length;

  /** Prioritario: promedio >= 80 y ninguna materia en rojo */
  function esPrioritario(s) {
    const p = promedio(s);
    return p !== null && p >= UMBRAL_VERDE && materiasEnRiesgo(s) === 0;
  }

  /* ---------- Helpers de HTML ---------- */
  function gradeBadge(n, showLabel = false) {
    const sm = semaforo(n);
    const val = n === null || n === undefined ? 'Sin calificar' : n;
    const label = showLabel && n !== null && n !== undefined ? ` · ${sm.label}` : '';
    return `<span class="badge-sem sem-${sm.key}"><i class="bi ${sm.icon}"></i>${esc(val)}${label}</span>`;
  }

  const nivelBadge = (nivel) => `<span class="nivel nivel-${NIVEL_CLASE[nivel] || 'na'}">${esc(nivel)}</span>`;

  const posChips = (arr) => arr.length
    ? arr.map((p) => `<span class="pos-chip">${esc(p)}</span>`).join('')
    : '<span class="text-muted small">Sin posiciones</span>';

  const selBadge = (s) => s.seleccionado
    ? '<span class="badge-sem sem-verde"><i class="bi bi-trophy-fill"></i>Seleccionado</span>'
    : '<span class="badge-sem sem-gris"><i class="bi bi-dash-circle"></i>No seleccionado</span>';

  function materiasResumen(s) {
    const n = s.materias.length;
    const r = materiasEnRiesgo(s);
    return `${n} materia${n === 1 ? '' : 's'}` + (r ? ` <span class="text-danger small fw-semibold">· ${r} en riesgo</span>` : '');
  }

  /* ========================================================
     5. AUTENTICACIÓN DEL MANAGER (simulada)
     ======================================================== */
  const isManager = () => auth.role === 'manager';
  let intentosFallidos = 0;
  let bloqueadoHasta = 0;

  function requireManager() {
    if (!isManager()) {
      toast('Acción solo para Managers. Inicia sesión.', 'danger');
      location.hash = '#/manager';
      return false;
    }
    return true;
  }

  /** Determina el rol de la sesión (manager si su usuario está en la tabla "managers") */
  async function resolveRole(session) {
    auth.user = session ? session.user : null;
    auth.role = null;
    if (!session) { db = []; return; }
    const { data, error } = await sb.rpc('es_manager');
    if (!error && data === true) auth.role = 'manager';
  }

  function updateAuthUI() {
    const on = isManager();
    $('#navLogoutItem').classList.toggle('d-none', !auth.role);
    $('#navManagerLabel').textContent = on ? 'Panel Manager' : 'Manager';
    $('#managerLogin').classList.toggle('d-none', on);
    $('#managerPanel').classList.toggle('d-none', !on);
  }

  /** Login del manager (correo + contraseña de Supabase Auth) */
  async function handleLogin(e) {
    e.preventDefault();
    const form = e.target;
    const err = $('#loginError');
    err.classList.add('d-none');
    const showErr = (msg) => { err.textContent = msg; err.classList.remove('d-none'); };

    if (Date.now() < bloqueadoHasta) {
      const s = Math.ceil((bloqueadoHasta - Date.now()) / 1000);
      return showErr(`Demasiados intentos. Espera ${s} s e inténtalo de nuevo.`);
    }

    const email = $('#loginUser').value.trim();
    const password = $('#loginPass').value;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });

    if (!error) {
      await resolveRole(data.session);
      if (isManager()) {
        intentosFallidos = 0;
        form.reset();
        await loadDB();
        updateAuthUI();
        renderManager();
        toast('Bienvenido, Manager.');
        return;
      }
      // Cuenta válida pero sin rol de manager
      await sb.auth.signOut();
      await resolveRole(null);
      $('#loginPass').value = '';
      return showErr('Esta cuenta no tiene permisos de manager.');
    }

    intentosFallidos++;
    if (intentosFallidos >= CONFIG.MAX_INTENTOS) {
      bloqueadoHasta = Date.now() + CONFIG.BLOQUEO_MS;
      intentosFallidos = 0;
      showErr(`Demasiados intentos. Acceso bloqueado ${CONFIG.BLOQUEO_MS / 1000} s.`);
    } else {
      showErr('Correo o contraseña incorrectos.');
    }
    $('#loginPass').value = '';
  }

  /** Búsqueda del perfil del alumno por número de control */
  async function handleSearchProfile(e) {
    e.preventDefault();
    const err = $('#perfilError');
    err.classList.add('d-none');
    const id = $('#perfilId').value.trim();
    if (!id) return;
    const ok = await abrirPerfil(id);
    if (!ok) {
      err.textContent = 'No encontramos ese número de control. Verifica o regístrate primero.';
      err.classList.remove('d-none');
      return;
    }
    $('#perfilId').value = '';
    renderProfileView();
  }

  /** Pide a Supabase el perfil de un número de control (devuelve true si existe) */
  async function abrirPerfil(id) {
    const { data, error } = await sb.rpc('consultar_perfil', { p_numero_control: id });
    if (error) { dbError('No se pudo consultar el perfil', error); return false; }
    perfil = fromPerfil(data);
    if (perfil) sessionStorage.setItem(PERFIL_KEY, perfil.id); else sessionStorage.removeItem(PERFIL_KEY);
    return !!perfil;
  }

  async function logout() {
    await sb.auth.signOut();
    await resolveRole(null);
    updateAuthUI();
    location.hash = '#/inicio';
    toast('Sesión cerrada.', 'secondary');
  }

  /* ========================================================
     6. ROUTER Y NAVEGACIÓN (hash)
     ======================================================== */
  const VIEWS = ['inicio', 'registro', 'perfil', 'manager'];

  function route() {
    const h = location.hash.replace(/^#\/?/, '') || 'inicio';
    const view = VIEWS.includes(h) ? h : 'inicio';

    $$('[data-view]').forEach((sec) => sec.classList.toggle('d-none', sec.dataset.view !== view));
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));

    if (view === 'perfil') renderProfileView();
    if (view === 'manager') {
      updateAuthUI();
      if (isManager()) renderManager();
    }
    if (view === 'registro' && !$('#regMaterias').children.length) addRegRow();

    // Cierra el menú móvil si estaba abierto
    const menu = $('#navMenu');
    if (menu.classList.contains('show')) bootstrap.Collapse.getOrCreateInstance(menu).hide();
    window.scrollTo(0, 0);
  }

  /* ========================================================
     7. VISTA: REGISTRO DE ASPIRANTE
     ======================================================== */
  function addRegRow(value = '') {
    const row = document.createElement('div');
    row.className = 'reg-materia card card-body bg-light border mb-3';
    const unidades = Array.from({ length: CONFIG.MAX_UNIDADES }, (_, i) => `
      <label class="unidad-input"><span>U${i + 1}</span>
        <input type="number" class="form-control form-control-sm" data-unidad="${i + 1}" min="0" max="100" step="0.1" inputmode="decimal" placeholder="—" aria-label="Calificación de la unidad ${i + 1}">
      </label>`).join('');
    row.innerHTML = `
      <div class="input-group mb-3">
        <span class="input-group-text"><i class="bi bi-book"></i></span>
        <input type="text" class="form-control" data-field="nombre" placeholder="Materia. Ej. Cálculo Diferencial" maxlength="60" value="${esc(value)}" aria-label="Nombre de la materia">
        <button type="button" class="btn btn-outline-danger" data-action="rm-reg-row" aria-label="Quitar materia"><i class="bi bi-trash"></i></button>
      </div>
      <div class="unidades-grid">${unidades}</div>
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-3">
        <span class="small text-muted">Captura solo las unidades que ya tengas.</span>
        <span class="small">Promedio de la materia: <span data-role="prom">${gradeBadge(null)}</span></span>
      </div>`;
    $('#regMaterias').appendChild(row);
  }

  /** Recalcula el promedio que se ve en una tarjeta de materia del registro */
  function updateRegProm(row) {
    const vals = $$('[data-unidad]', row).map((i) => i.value.trim())
      .filter((v) => v !== '' && !isNaN(Number(v)))
      .map((v) => ({ calificacion: clamp(Number(v)) }));
    $('[data-role="prom"]', row).innerHTML = gradeBadge(avgUnidades(vals), true);
  }

  function showRegError(msg) {
    const el = $('#regError');
    el.textContent = msg;
    el.classList.remove('d-none');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function handleRegister(e) {
    e.preventDefault();
    $('#regError').classList.add('d-none');
    const form = e.target;

    const nombre = $('#regNombre').value.trim();
    const id = $('#regId').value.trim();
    const carrera = $('#regCarrera').value.trim();

    if (!nombre || !carrera) return showRegError('Completa tu nombre y tu carrera.');
    if (!ID_REGEX.test(id)) return showRegError('El número de control debe tener 4–20 caracteres (letras, números o guion).');

    // Materias con sus unidades: sin vacías ni duplicadas
    const vistos = new Set();
    const materias = [];
    for (const row of $$('#regMaterias .reg-materia')) {
      const n = $('[data-field="nombre"]', row).value.trim();
      if (!n) continue;
      if (vistos.has(norm(n))) return showRegError(`La materia "${n}" está repetida.`);
      vistos.add(norm(n));
      const unidades = [];
      for (const inp of $$('[data-unidad]', row)) {
        const raw = inp.value.trim();
        if (raw === '') continue;
        if (isNaN(Number(raw)) || Number(raw) < 0 || Number(raw) > 100) {
          return showRegError(`La calificación de la unidad ${inp.dataset.unidad} de "${n}" debe estar entre 0 y 100.`);
        }
        unidades.push({ n: Number(inp.dataset.unidad), calificacion: clamp(Number(raw)) });
      }
      materias.push({ nombre: n, unidades });
    }
    if (!materias.length) return showRegError('Agrega al menos una materia que cursas.');

    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try {
      const { error } = await sb.rpc('registrar_alumno', {
        p_numero_control: id, p_nombre: nombre, p_carrera: carrera, p_materias: materias
      });
      if (error) {
        const m = error.message || '';
        if (/duplicado/.test(m) || error.code === '23505') {
          return showRegError('Ese número de control ya está registrado. Consúltalo en "Mi perfil".');
        }
        return showRegError(`No se pudo registrar: ${m}`);
      }
      form.reset();
      $('#regMaterias').innerHTML = '';
      addRegRow();
      await abrirPerfil(id);
      toast('¡Registro exitoso! Este es tu perfil.');
      location.hash = '#/perfil';
    } finally {
      btn.disabled = false;
    }
  }

  /* ========================================================
     8. VISTA: PERFIL DEL ALUMNO (solo lectura de resultados)
     ======================================================== */
  function renderProfileView() {
    $('#formBuscarPerfil').classList.toggle('d-none', !!perfil);
    $('#perfilResultado').innerHTML = perfil ? profileHTML(perfil) : '';
  }

  const fechaCorta = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  function profileHTML(s) {
    const p = promedio(s);

    const materias = s.materias.length
      ? s.materias.map((m) => {
        const k = semaforo(m.calificacion);
        const unidades = m.unidades.length
          ? `<div class="unidades-chips mt-3">${m.unidades.map((u) => {
            const ku = semaforo(u.calificacion);
            return `<span class="unit-chip sem-${ku.key}" title="Unidad ${u.n}: ${esc(ku.label)}"><small>U${u.n}</small><strong>${esc(u.calificacion)}</strong></span>`;
          }).join('')}</div>`
          : '';
        const comentarios = m.comentarios.length
          ? `<div class="mt-3"><div class="small text-muted mb-1"><i class="bi bi-chat-dots me-1"></i>Mis comentarios</div>
              ${m.comentarios.map((c) => `
                <div class="comentario comentario-alumno mb-1">${esc(c.texto)}<div class="small text-muted mt-1">${esc(fechaCorta(c.creadoEn))}</div></div>`).join('')}
            </div>`
          : '';
        return `
          <div class="card materia-card ${k.key} mb-2 shadow-sm">
            <div class="card-body py-3">
              <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
                <h3 class="h6 mb-0">${esc(m.nombre)}</h3>
                ${gradeBadge(m.calificacion, true)}
              </div>
              ${unidades || '<p class="small text-muted mb-0 mt-2">Aún no hay calificaciones por unidad.</p>'}
              ${m.comentario ? `<div class="comentario mt-2"><i class="bi bi-chat-left-text me-1"></i><strong>Manager:</strong> ${esc(m.comentario)}</div>` : ''}
              ${comentarios}
              <form class="mt-3" data-form="add-comentario" data-mid="${esc(m.id)}" novalidate>
                <label class="form-label small mb-1" for="com-${esc(m.id)}">Comentario sobre esta materia</label>
                <div class="input-group">
                  <textarea id="com-${esc(m.id)}" class="form-control form-control-sm" rows="2" maxlength="500" placeholder="Ej. Con este maestro tengo muchas faltas"></textarea>
                  <button class="btn btn-outline-success" type="submit" aria-label="Enviar comentario"><i class="bi bi-send"></i></button>
                </div>
              </form>
            </div>
          </div>`;
      }).join('')
      : '<p class="text-muted">Aún no tienes materias registradas.</p>';

    return `
      <div class="card shadow-sm mb-3">
        <div class="card-body p-4">
          <div class="d-flex flex-wrap justify-content-between align-items-start gap-2">
            <div>
              <h2 class="h4 mb-1">${esc(s.nombre)}</h2>
              <div class="text-muted">N.º de control: <strong>${esc(s.id)}</strong></div>
              <div class="text-muted">${esc(s.carrera)}</div>
            </div>
            <button class="btn btn-sm btn-outline-secondary" data-action="close-profile"><i class="bi bi-x-lg me-1"></i>Cerrar perfil</button>
          </div>
          <hr>
          <div class="row g-3 text-center text-md-start">
            <div class="col-6 col-md-3"><div class="small text-muted text-uppercase">Promedio</div><div class="mt-1">${gradeBadge(p, true)}</div></div>
            <div class="col-6 col-md-3"><div class="small text-muted text-uppercase">Estatus</div><div class="mt-1">${selBadge(s)}</div></div>
            <div class="col-6 col-md-3"><div class="small text-muted text-uppercase">Nivel deportivo</div><div class="mt-1">${nivelBadge(s.nivel)}</div></div>
            <div class="col-6 col-md-3"><div class="small text-muted text-uppercase">Posiciones</div><div class="mt-1">${posChips(s.posiciones)}</div></div>
          </div>
        </div>
      </div>

      <div class="d-flex justify-content-between align-items-center mb-2">
        <h2 class="h5 mb-0"><i class="bi bi-journal-bookmark me-1"></i>Mis materias</h2>
        <span class="text-muted small">${s.materias.length} registrada${s.materias.length === 1 ? '' : 's'}</span>
      </div>
      <p class="small text-muted">Aquí puedes dejar comentarios sobre cada materia (por ejemplo, si un maestro no te permite presentar examen o tienes muchas faltas). Los demás datos solo los modifica el manager.</p>
      ${materias}`;
  }

  /** El alumno agrega un comentario a una de sus materias (única escritura que permite RLS) */
  async function handleAddComentario(form) {
    const s = perfil;
    if (!s) return;
    const m = s.materias.find((x) => x.id === form.dataset.mid);
    if (!m) return;

    const texto = $('textarea', form).value.trim();
    if (!texto) return toast('Escribe un comentario antes de enviarlo.', 'warning');
    if (texto.length > 500) return toast('El comentario no puede pasar de 500 caracteres.', 'warning');

    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    const { data, error } = await sb.rpc('agregar_comentario', {
      p_numero_control: s.id, p_materia_id: m.id, p_texto: texto
    });
    if (error) {
      btn.disabled = false;
      return dbError('No se pudo guardar el comentario', error);
    }
    m.comentarios.push({ id: data.id, texto: data.texto, creadoEn: data.created_at });
    renderProfileView();
    toast('Comentario agregado.');
  }

  /* ========================================================
     9. VISTA: PANEL DEL MANAGER
     ======================================================== */
  const filters = { q: '', carrera: '', nivel: '', sem: '', estatus: '', pos: '' };

  function renderManager() {
    if (!isManager()) return;
    renderStats();
    renderCarreraOptions();
    renderAlumnos();
    renderSeleccion();
  }

  /* ---------- Estadísticas ---------- */
  function renderStats() {
    const total = db.length;
    const sel = db.filter((s) => s.seleccionado).length;
    const prio = db.filter(esPrioritario).length;
    const riesgo = db.filter((s) => { const p = promedio(s); return p !== null && p < UMBRAL_AMARILLO; }).length;
    const proms = db.map(promedio).filter((p) => p !== null);
    const general = proms.length ? (proms.reduce((a, b) => a + b, 0) / proms.length).toFixed(1) : '—';

    const card = (cls, icon, value, label) => `
      <div class="col-6 col-lg">
        <div class="card stat-card ${cls} shadow-sm h-100"><div class="card-body py-3">
          <div class="d-flex justify-content-between align-items-center">
            <div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>
            <i class="bi ${icon} fs-2 text-muted opacity-50"></i>
          </div>
        </div></div>
      </div>`;

    $('#statsRow').innerHTML =
      card('navy', 'bi-people-fill', total, 'Alumnos') +
      card('verde', 'bi-trophy-fill', sel, 'Seleccionados') +
      card('verde', 'bi-check-circle-fill', prio, 'Prioritarios') +
      card('rojo', 'bi-x-octagon-fill', riesgo, 'En riesgo') +
      card('gold', 'bi-graph-up', general, 'Promedio general');
  }

  /** Mantiene actualizado el filtro de carreras y el autocompletado */
  function renderCarreraOptions() {
    const carreras = [...new Set(db.map((s) => s.carrera).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const sel = $('#fCarrera');
    const current = filters.carrera;
    sel.innerHTML = '<option value="">Todas las carreras</option>' +
      carreras.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    sel.value = carreras.includes(current) ? current : '';
    filters.carrera = sel.value;
    $('#listaCarreras').innerHTML = carreras.map((c) => `<option value="${esc(c)}"></option>`).join('');
  }

  function filteredStudents() {
    const q = norm(filters.q);
    return db.filter((s) => {
      if (q && !(norm(s.nombre).includes(q) || norm(s.id).includes(q) || s.materias.some((m) => norm(m.nombre).includes(q)))) return false;
      if (filters.carrera && s.carrera !== filters.carrera) return false;
      if (filters.nivel && s.nivel !== filters.nivel) return false;
      if (filters.pos && !s.posiciones.includes(filters.pos)) return false;
      if (filters.estatus === 'sel' && !s.seleccionado) return false;
      if (filters.estatus === 'nosel' && s.seleccionado) return false;
      if (filters.sem && semaforo(promedio(s)).key !== filters.sem) return false;
      return true;
    }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  /* ---------- Lista de alumnos (tabla + tarjetas) ---------- */
  function renderAlumnos() {
    const list = filteredStudents();
    $('#contadorResultados').textContent = `Mostrando ${list.length} de ${db.length} alumno${db.length === 1 ? '' : 's'}`;
    $('#sinResultados').classList.toggle('d-none', list.length > 0);

    // Tabla (escritorio)
    $('#tablaAlumnos').innerHTML = list.map((s) => {
      const p = promedio(s);
      return `
        <tr>
          <td><div class="fw-semibold">${esc(s.nombre)}</div><div class="small text-muted">${esc(s.id)}</div></td>
          <td>${esc(s.carrera)}</td>
          <td>${materiasResumen(s)}</td>
          <td>${gradeBadge(p)}</td>
          <td>${nivelBadge(s.nivel)}</td>
          <td>${posChips(s.posiciones)}</td>
          <td>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" role="switch" data-action="toggle-sel" data-id="${esc(s.id)}" ${s.seleccionado ? 'checked' : ''} aria-label="Seleccionado">
            </div>
          </td>
          <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-outline-primary" data-action="edit-student" data-id="${esc(s.id)}" title="Editar / calificar"><i class="bi bi-pencil-square"></i></button>
            <button class="btn btn-sm btn-outline-danger" data-action="delete-student" data-id="${esc(s.id)}" title="Eliminar"><i class="bi bi-trash"></i></button>
          </td>
        </tr>`;
    }).join('');

    // Tarjetas (móvil / tablet)
    $('#cardsAlumnos').innerHTML = list.map((s) => {
      const p = promedio(s);
      const mats = s.materias.length
        ? s.materias.map((m) => `<div class="mini-materia"><span>${esc(m.nombre)}</span>${gradeBadge(m.calificacion)}</div>`).join('')
        : '<div class="text-muted small">Sin materias</div>';
      return `
        <div class="col-12 col-md-6">
          <div class="card student-card ${semaforo(p).key} ${s.seleccionado ? 'seleccionado' : ''} shadow-sm h-100">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-start gap-2">
                <div>
                  <div class="fw-semibold">${esc(s.nombre)}</div>
                  <div class="small text-muted">${esc(s.id)} · ${esc(s.carrera)}</div>
                </div>
                ${gradeBadge(p)}
              </div>
              <div class="my-2 d-flex flex-wrap gap-2 align-items-center">${nivelBadge(s.nivel)}${selBadge(s)}</div>
              <div class="mb-2">${posChips(s.posiciones)}</div>
              <div class="border-top pt-2">${mats}</div>
            </div>
            <div class="card-footer bg-transparent d-flex justify-content-between align-items-center">
              <div class="form-check form-switch mb-0">
                <input class="form-check-input" type="checkbox" role="switch" id="sw-${esc(s.id)}" data-action="toggle-sel" data-id="${esc(s.id)}" ${s.seleccionado ? 'checked' : ''}>
                <label class="form-check-label small" for="sw-${esc(s.id)}">Seleccionado</label>
              </div>
              <div>
                <button class="btn btn-sm btn-outline-primary" data-action="edit-student" data-id="${esc(s.id)}"><i class="bi bi-pencil-square"></i></button>
                <button class="btn btn-sm btn-outline-danger" data-action="delete-student" data-id="${esc(s.id)}"><i class="bi bi-trash"></i></button>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  async function deleteStudent(id) {
    if (!requireManager()) return;
    const s = findStudent(id);
    if (!s) return;
    const ok = await confirmDialog('Eliminar alumno', `¿Eliminar a ${s.nombre} (${s.id}) con todas sus materias, calificaciones y comentarios? Esta acción no se puede deshacer.`, 'Eliminar');
    if (!ok) return;
    const { error } = await sb.from('alumnos').delete().eq('id', s.uuid);
    if (error) return dbError('No se pudo eliminar', error);
    await loadDB();
    renderManager();
    toast('Alumno eliminado.', 'secondary');
  }

  /* ---------- Modal de alta / edición ---------- */
  let editing = null; // { originalId, materias: [], posiciones: [], creadoEn }

  function openStudentModal(id) {
    if (!requireManager()) return;
    const s = id ? findStudent(id) : null;
    editing = {
      originalId: s ? s.id : null,
      materias: s ? s.materias.map((m) => ({ ...m, unidades: m.unidades.map((u) => ({ ...u })) })) : [],
      posiciones: s ? [...s.posiciones] : [],
      creadoEn: s ? s.creadoEn : new Date().toISOString()
    };

    $('#mTitle').textContent = s ? `Editar: ${s.nombre}` : 'Nuevo alumno';
    $('#mError').classList.add('d-none');
    $('#mNombre').value = s ? s.nombre : '';
    $('#mId').value = s ? s.id : '';
    $('#mCarrera').value = s ? s.carrera : '';
    $('#mNivel').value = s ? s.nivel : 'Sin asignar';
    $('#mEstatus').value = s && s.seleccionado ? 'si' : 'no';

    $('#mPosiciones').innerHTML = POSICIONES.map((p) => `
      <div>
        <input type="checkbox" class="btn-check pos-toggle" id="pos-${p}" value="${p}" ${editing.posiciones.includes(p) ? 'checked' : ''}>
        <label class="btn btn-outline-secondary btn-sm" for="pos-${p}">${p}</label>
      </div>`).join('');

    renderModalMaterias();
    bootstrap.Modal.getOrCreateInstance($('#studentModal')).show();
  }

  function renderModalMaterias() {
    const box = $('#mMaterias');
    if (!editing.materias.length) {
      box.innerHTML = '<p class="text-muted small mb-0">Sin materias. Usa el botón "Materia" para agregar una.</p>';
    } else {
      box.innerHTML = editing.materias.map((m) => `
        <div class="card card-body mb-2 bg-light border" data-mid="${esc(m.id)}">
          <div class="row g-2 align-items-end">
            <div class="col-12 col-md-5">
              <label class="form-label small mb-1">Materia</label>
              <input class="form-control form-control-sm" data-field="nombre" maxlength="60" value="${esc(m.nombre)}">
            </div>
            <div class="col-7 col-md-4">
              <label class="form-label small mb-1 d-block">Promedio de la materia</label>
              <span data-role="badge">${gradeBadge(m.calificacion, true)}</span>
            </div>
            <div class="col-5 col-md-3 text-end">
              <button type="button" class="btn btn-sm btn-outline-danger" data-action="rm-modal-materia" data-mid="${esc(m.id)}"><i class="bi bi-trash me-1"></i>Quitar</button>
            </div>
            <div class="col-12">
              <label class="form-label small mb-1">Calificación por unidad (0–100)</label>
              <div class="unidades-grid">
                ${Array.from({ length: CONFIG.MAX_UNIDADES }, (_, i) => {
                  const u = (m.unidades || []).find((x) => x.n === i + 1);
                  return `<label class="unidad-input"><span>U${i + 1}</span><input type="number" class="form-control form-control-sm" data-unidad="${i + 1}" min="0" max="100" step="0.1" inputmode="decimal" value="${u ? u.calificacion : ''}" placeholder="—"></label>`;
                }).join('')}
              </div>
            </div>
            <div class="col-12">
              <label class="form-label small mb-1">Comentarios / problemas</label>
              <textarea class="form-control form-control-sm" rows="2" data-field="comentario" maxlength="500" placeholder="Observaciones o incidencias académicas">${esc(m.comentario)}</textarea>
            </div>
            ${(m.comentarios || []).length ? `
            <div class="col-12">
              <div class="small text-muted mb-1"><i class="bi bi-chat-dots me-1"></i>Comentarios del alumno (solo lectura)</div>
              ${m.comentarios.map((c) => `<div class="comentario comentario-alumno mb-1">${esc(c.texto)}<div class="small text-muted mt-1">${esc(fechaCorta(c.creadoEn))}</div></div>`).join('')}
            </div>` : ''}
          </div>
        </div>`).join('');
    }
    updateModalPromedio();
  }

  function updateModalPromedio() {
    const tmp = { materias: editing.materias };
    $('#mPromedio').innerHTML = gradeBadge(promedio(tmp), true);
  }

  /** Actualiza el borrador mientras se escribe (sin re-render para no perder el foco) */
  function onModalMateriaInput(e) {
    const card = e.target.closest('[data-mid]');
    if (!card) return;
    const m = editing.materias.find((x) => x.id === card.dataset.mid);
    if (!m) return;

    // Calificación de una unidad
    if (e.target.dataset.unidad) {
      const n = Number(e.target.dataset.unidad);
      const v = e.target.value.trim();
      m.unidades = (m.unidades || []).filter((u) => u.n !== n);
      // Sin clamp aquí: al guardar se valida que esté entre 0 y 100
      if (v !== '' && !isNaN(Number(v))) m.unidades.push({ n, calificacion: Number(v) });
      m.unidades.sort((a, b) => a.n - b.n);
      m.calificacion = avgUnidades(m.unidades.map((u) => ({ calificacion: clamp(u.calificacion) })));
      $('[data-role="badge"]', card).innerHTML = gradeBadge(m.calificacion, true);
      updateModalPromedio();
      return;
    }

    const field = e.target.dataset.field;
    if (field) m[field] = e.target.value;
  }

  async function saveStudentFromModal(e) {
    e.preventDefault();
    if (!requireManager()) return;
    const err = $('#mError');
    const fail = (msg) => { err.textContent = msg; err.classList.remove('d-none'); err.scrollIntoView({ block: 'nearest' }); };

    const nombre = $('#mNombre').value.trim();
    const id = $('#mId').value.trim();
    const carrera = $('#mCarrera').value.trim();

    if (!nombre || !carrera) return fail('Nombre y carrera son obligatorios.');
    if (!ID_REGEX.test(id)) return fail('El número de control debe tener 4–20 caracteres (letras, números o guion).');
    const dup = findStudent(id);
    if (dup && dup.id !== editing.originalId) return fail('Ya existe otro alumno con ese número de control.');

    // Validación de materias y calificaciones
    const vistos = new Set();
    for (const m of editing.materias) {
      const n = String(m.nombre || '').trim();
      if (!n) return fail('Hay una materia sin nombre. Complétala o quítala.');
      if (vistos.has(norm(n))) return fail(`La materia "${n}" está repetida.`);
      vistos.add(norm(n));
      if ((m.unidades || []).some((u) => u.calificacion < 0 || u.calificacion > 100)) {
        return fail(`Las calificaciones por unidad de "${n}" deben estar entre 0 y 100.`);
      }
    }

    const prev = editing.originalId ? findStudent(editing.originalId) : null;
    const student = sanitizeStudent({
      id, nombre, carrera,
      uuid: prev ? prev.uuid : null,
      materias: editing.materias,
      posiciones: $$('#mPosiciones input:checked').map((i) => i.value),
      nivel: $('#mNivel').value,
      seleccionado: $('#mEstatus').value === 'si',
      creadoEn: editing.creadoEn
    });

    const btn = $('button[type="submit"]', $('#formAlumno'));
    btn.disabled = true;
    try {
      err.classList.add('d-none');
      await persistStudent(student);
      await loadDB();
      bootstrap.Modal.getOrCreateInstance($('#studentModal')).hide();
      renderManager();
      toast(editing.originalId ? 'Alumno actualizado.' : 'Alumno creado.');
    } catch (error) {
      fail(error && error.code === '23505'
        ? 'Ya existe otro alumno con ese número de control, o hay una materia repetida.'
        : `No se pudo guardar: ${error && error.message ? error.message : error}`);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- Control de selección ---------- */
  async function setSeleccion(id, value) {
    if (!requireManager()) return;
    const s = findStudent(id);
    if (!s) return;
    if (value) {
      const p = promedio(s);
      if (p !== null && p < UMBRAL_AMARILLO) {
        const ok = await confirmDialog('Alumno en riesgo académico',
          `${s.nombre} tiene promedio ${p} (rojo). ¿Seleccionarlo de todas formas?`, 'Seleccionar', 'btn-warning');
        if (!ok) { renderManager(); return; }
      }
    }
    const { error } = await sb.from('alumnos').update({ seleccionado: value }).eq('id', s.uuid);
    if (error) { dbError('No se pudo actualizar la selección', error); renderManager(); return; }
    s.seleccionado = value;
    renderManager();
    toast(value ? `${s.nombre} fue seleccionado.` : `${s.nombre} ya no está en la selección.`, value ? 'success' : 'secondary');
  }

  async function seleccionarPrioritarios() {
    if (!requireManager()) return;
    const pendientes = db.filter((s) => esPrioritario(s) && !s.seleccionado);
    if (!pendientes.length) return toast('No hay prioritarios pendientes por seleccionar.', 'info');
    const ok = await confirmDialog('Seleccionar prioritarios',
      `Se seleccionarán ${pendientes.length} alumno(s) con promedio ≥ 80 y sin materias en rojo.`, 'Seleccionar', 'btn-success');
    if (!ok) return;
    const { error } = await sb.from('alumnos').update({ seleccionado: true }).in('id', pendientes.map((s) => s.uuid));
    if (error) return dbError('No se pudo actualizar la selección', error);
    pendientes.forEach((s) => { s.seleccionado = true; });
    renderManager();
    toast(`${pendientes.length} alumno(s) seleccionados.`);
  }

  async function limpiarSeleccion() {
    if (!requireManager()) return;
    const sel = db.filter((s) => s.seleccionado);
    if (!sel.length) return toast('No hay alumnos seleccionados.', 'info');
    const ok = await confirmDialog('Limpiar selección', 'Se quitará a todos los alumnos del equipo. Los datos académicos no se modifican.', 'Limpiar');
    if (!ok) return;
    const { error } = await sb.from('alumnos').update({ seleccionado: false }).in('id', sel.map((s) => s.uuid));
    if (error) return dbError('No se pudo limpiar la selección', error);
    sel.forEach((s) => { s.seleccionado = false; });
    renderManager();
    toast('Selección reiniciada.', 'secondary');
  }

  function renderSeleccion() {
    const pos = $('#selPosicion').value;
    const soloElegibles = $('#selSoloElegibles').checked;
    const byProm = (a, b) => (promedio(b) ?? -1) - (promedio(a) ?? -1);

    const equipo = db.filter((s) => s.seleccionado).sort(byProm);
    let cand = db.filter((s) => !s.seleccionado);
    if (pos) cand = cand.filter((s) => s.posiciones.includes(pos));
    if (soloElegibles) cand = cand.filter(esPrioritario);
    cand.sort(byProm);

    $('#selCandCount').textContent = cand.length;
    $('#selEquipoCount').textContent = equipo.length;

    const card = (s, btn) => {
      const p = promedio(s);
      const r = materiasEnRiesgo(s);
      return `
        <div class="card student-card ${semaforo(p).key} ${s.seleccionado ? 'seleccionado' : ''} shadow-sm">
          <div class="card-body py-2">
            <div class="d-flex justify-content-between align-items-start gap-2">
              <div class="min-w-0">
                <div class="fw-semibold">${esc(s.nombre)} ${esc(s.id) ? `<span class="small text-muted fw-normal">· ${esc(s.id)}</span>` : ''}</div>
                <div class="small text-muted">${esc(s.carrera)}</div>
              </div>
              ${gradeBadge(p)}
            </div>
            <div class="d-flex flex-wrap align-items-center gap-2 mt-2">
              ${nivelBadge(s.nivel)} ${posChips(s.posiciones)}
              ${esPrioritario(s) ? '<span class="badge text-bg-success">Prioritario</span>' : ''}
              ${r ? `<span class="badge text-bg-danger">${r} materia${r === 1 ? '' : 's'} en riesgo</span>` : ''}
              <div class="ms-auto">${btn}</div>
            </div>
          </div>
        </div>`;
    };

    $('#selCandidatos').innerHTML = cand.length
      ? cand.map((s) => card(s, `<button class="btn btn-sm btn-success" data-action="sel-add" data-id="${esc(s.id)}"><i class="bi bi-plus-lg me-1"></i>Seleccionar</button>`)).join('')
      : '<div class="text-muted small p-3 text-center border rounded-3 bg-white">Sin candidatos con estos filtros.</div>';

    $('#selEquipo').innerHTML = equipo.length
      ? equipo.map((s) => card(s, `<button class="btn btn-sm btn-outline-danger" data-action="sel-remove" data-id="${esc(s.id)}"><i class="bi bi-x-lg me-1"></i>Quitar</button>`)).join('')
      : '<div class="text-muted small p-3 text-center border rounded-3 bg-white">Aún no hay jugadores seleccionados.</div>';

    // Cobertura por posición
    $('#selCobertura').innerHTML = POSICIONES.map((p) => {
      const jugadores = equipo.filter((s) => s.posiciones.includes(p));
      return `
        <div class="col-6 col-md-4 col-xl-3">
          <div class="cobertura-item ${jugadores.length ? 'cubierta' : ''}">
            <div class="d-flex justify-content-between"><span class="pos">${p}</span><span class="badge ${jugadores.length ? 'text-bg-success' : 'text-bg-secondary'}">${jugadores.length}</span></div>
            <div class="small text-muted text-truncate">${jugadores.length ? jugadores.map((j) => esc(j.nombre.split(' ')[0])).join(', ') : 'Sin cubrir'}</div>
          </div>
        </div>`;
    }).join('');
  }

  /* ========================================================
     10. DATOS: EXPORTAR / IMPORTAR / DEMO / BORRAR
     ======================================================== */
  function exportData() {
    const payload = { version: 1, exportado: new Date().toISOString(), alumnos: db };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `alumnos-beisbol-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Respaldo exportado.');
  }

  /** Importa una lista de alumnos a Supabase (sobrescribe por número de control) */
  async function importStudents(arr, titulo) {
    const valid = arr.map(sanitizeStudent).filter(Boolean);
    if (!valid.length) throw new Error('Sin alumnos válidos');

    const ok = await confirmDialog(titulo,
      `Se importarán ${valid.length} alumno(s). Si un número de control ya existe, se sobrescribirá con los datos recibidos.`, 'Importar', 'btn-primary');
    if (!ok) return;

    let hechos = 0;
    try {
      for (const s of valid) {
        s.uuid = null; // el uuid de un respaldo no sirve en otra base
        reconcileIds(s, findStudent(s.id));
        await persistStudent(s);
        hechos++;
      }
    } catch (error) {
      dbError(`Importación detenida tras ${hechos} alumno(s)`, error);
    }
    await loadDB();
    renderManager();
    if (hechos) toast(`${hechos} alumno(s) importados.`);
  }

  function importData(file) {
    if (!file || !requireManager()) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        const arr = Array.isArray(data) ? data : data.alumnos;
        if (!Array.isArray(arr)) throw new Error('Formato inválido');
        await importStudents(arr, 'Importar respaldo');
      } catch (err) {
        toast('El archivo no es un respaldo válido.', 'danger');
      }
    };
    reader.readAsText(file);
  }

  /** Pasa a Supabase los datos que la versión anterior guardó en el localStorage de este navegador */
  async function migrarLocal() {
    if (!requireManager()) return;
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(CONFIG.LEGACY_STORAGE_KEY) || '[]'); } catch (e) { arr = []; }
    if (!Array.isArray(arr) || !arr.length) return toast('No hay datos locales anteriores en este navegador.', 'info');
    try {
      await importStudents(arr, 'Migrar datos locales a Supabase');
    } catch (err) {
      toast('Los datos locales no son válidos.', 'danger');
    }
  }

  async function loadDemo() {
    if (!requireManager()) return;
    // M(nombre, promedio, comentario): genera 4 unidades que promedian ese valor
    const M = (nombre, base, comentario = '') => ({
      id: uid(), nombre, comentario,
      unidades: base === null ? [] : [-2, 2, -1, 1].map((d, i) => ({ n: i + 1, calificacion: clamp(base + d) }))
    });
    const demo = [
      { id: 'A2026001', nombre: 'Carlos Hernández Ruiz', carrera: 'Ingeniería en Sistemas', nivel: 'Titular', posiciones: ['Pitcher'], seleccionado: true,
        materias: [M('Cálculo Diferencial', 92), M('Programación', 95, 'Excelente participación.'), M('Física', 88)] },
      { id: 'A2026002', nombre: 'Miguel Ángel Torres', carrera: 'Ingeniería Industrial', nivel: 'Avanzado', posiciones: ['SS', '2B'], seleccionado: false,
        materias: [M('Estadística', 85), M('Ergonomía', 81), M('Dibujo', 83)] },
      { id: 'A2026003', nombre: 'Luis Fernando Gómez', carrera: 'Contaduría', nivel: 'Intermedio', posiciones: ['CF', 'LF'], seleccionado: false,
        materias: [M('Contabilidad I', 76, 'Entrega tareas tarde.'), M('Derecho Fiscal', 72), M('Matemáticas Financieras', 78)] },
      { id: 'A2026004', nombre: 'Jorge Ramírez Soto', carrera: 'Ingeniería en Sistemas', nivel: 'Intermedio', posiciones: ['Catcher'], seleccionado: false,
        materias: [M('Bases de Datos', 68, 'Faltas frecuentes por entrenamientos.'), M('Redes', 74), M('Álgebra Lineal', 62, 'Necesita asesoría.')] },
      { id: 'A2026005', nombre: 'Diego Martínez Peña', carrera: 'Administración', nivel: 'Principiante', posiciones: ['1B'], seleccionado: false,
        materias: [M('Mercadotecnia', 90), M('Economía', 86), M('Administración I', 84)] },
      { id: 'A2026006', nombre: 'Andrés Castillo Vega', carrera: 'Ingeniería Industrial', nivel: 'Sin asignar', posiciones: [], seleccionado: false,
        materias: [M('Química', 55, 'Reprobó primer parcial.'), M('Estadística', 64), M('Cálculo Integral', 58)] },
      { id: 'A2026007', nombre: 'Rafael Ortiz Luna', carrera: 'Contaduría', nivel: 'Avanzado', posiciones: ['3B', 'RF'], seleccionado: true,
        materias: [M('Auditoría', 89), M('Costos', 93), M('Ética Profesional', 97)] },
      { id: 'A2026008', nombre: 'Sebastián Flores Mora', carrera: 'Administración', nivel: 'Principiante', posiciones: ['DH'], seleccionado: false,
        materias: [M('Contabilidad', null), M('Informática', null)] }
    ];
    let added = 0;
    try {
      for (const s of demo.map(sanitizeStudent)) {
        if (findStudent(s.id)) continue;
        await persistStudent(s);
        added++;
      }
    } catch (error) {
      dbError('No se pudieron cargar los datos de ejemplo', error);
    }
    await loadDB();
    renderManager();
    toast(added ? `${added} alumnos de ejemplo cargados.` : 'Los datos de ejemplo ya estaban cargados.', added ? 'success' : 'info');
  }

  async function wipeAll() {
    if (!requireManager()) return;
    const ok = await confirmDialog('Borrar todos los datos', 'Se eliminarán TODOS los alumnos, materias, calificaciones y comentarios de Supabase. Considera exportar un respaldo antes.', 'Borrar todo');
    if (!ok) return;
    const { error } = await sb.from('alumnos').delete().not('id', 'is', null);
    if (error) return dbError('No se pudo borrar', error);
    await loadDB();
    renderManager();
    toast('Datos eliminados.', 'secondary');
  }

  /* ========================================================
     11. EVENTOS GLOBALES E INICIALIZACIÓN
     ======================================================== */
  function bindEvents() {
    // Formularios estáticos
    $('#formRegistro').addEventListener('submit', handleRegister);
    $('#formBuscarPerfil').addEventListener('submit', handleSearchProfile);
    $('#formLogin').addEventListener('submit', handleLogin);
    $('#formAlumno').addEventListener('submit', saveStudentFromModal);
    $('#btnLogout').addEventListener('click', logout);
    $('#fileImport').addEventListener('change', (e) => { importData(e.target.files[0]); e.target.value = ''; });

    // Formularios generados dinámicamente (comentarios del alumno en su perfil)
    document.addEventListener('submit', (e) => {
      const form = e.target.closest('[data-form="add-comentario"]');
      if (form) { e.preventDefault(); handleAddComentario(form); }
    });

    // Filtros del panel
    const bindFilter = (sel, key, evt = 'change') => $(sel).addEventListener(evt, (e) => { filters[key] = e.target.value; renderAlumnos(); });
    bindFilter('#fBuscar', 'q', 'input');
    bindFilter('#fCarrera', 'carrera');
    bindFilter('#fNivel', 'nivel');
    bindFilter('#fPosicion', 'pos');
    bindFilter('#fSemaforo', 'sem');
    bindFilter('#fEstatus', 'estatus');
    $('#btnLimpiarFiltros').addEventListener('click', () => {
      Object.keys(filters).forEach((k) => { filters[k] = ''; });
      ['#fBuscar', '#fCarrera', '#fNivel', '#fPosicion', '#fSemaforo', '#fEstatus'].forEach((s) => { $(s).value = ''; });
      renderAlumnos();
    });
    $('#selPosicion').addEventListener('change', renderSeleccion);
    $('#selSoloElegibles').addEventListener('change', renderSeleccion);

    // Promedio en vivo en las tarjetas de materia del registro
    $('#regMaterias').addEventListener('input', (e) => {
      const row = e.target.closest('.reg-materia');
      if (row && e.target.dataset.unidad) updateRegProm(row);
    });

    // Edición de materias dentro del modal
    $('#mMaterias').addEventListener('input', onModalMateriaInput);

    // Switch de selección en tabla / tarjetas
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-action="toggle-sel"]')) setSeleccion(t.dataset.id, t.checked);
    });

    // Delegación de clics para todos los botones con data-action
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, id, mid } = btn.dataset;

      switch (action) {
        // Registro
        case 'add-reg-row': addRegRow(); break;
        case 'rm-reg-row': {
          const row = btn.closest('.reg-materia');
          if ($$('#regMaterias .reg-materia').length > 1) row.remove();
          else { $$('input', row).forEach((i) => { i.value = ''; }); updateRegProm(row); }
          break;
        }
        // Perfil
        case 'close-profile':
          perfil = null;
          sessionStorage.removeItem(PERFIL_KEY);
          renderProfileView();
          break;
        // Manager
        case 'new-student': openStudentModal(null); break;
        case 'edit-student': openStudentModal(id); break;
        case 'delete-student': deleteStudent(id); break;
        case 'add-modal-materia':
          editing.materias.push({ id: uid(), nombre: '', calificacion: null, comentario: '', unidades: [], comentarios: [] });
          renderModalMaterias();
          break;
        case 'rm-modal-materia':
          editing.materias = editing.materias.filter((m) => m.id !== mid);
          renderModalMaterias();
          break;
        case 'sel-add': setSeleccion(id, true); break;
        case 'sel-remove': setSeleccion(id, false); break;
        case 'sel-priority': seleccionarPrioritarios(); break;
        case 'sel-clear': limpiarSeleccion(); break;
        case 'export': if (requireManager()) exportData(); break;
        case 'demo': loadDemo(); break;
        case 'migrate-local': migrarLocal(); break;
        case 'wipe': wipeAll(); break;
        default: break;
      }
    });

    window.addEventListener('hashchange', route);
  }

  function fillStaticOptions() {
    const posOpts = POSICIONES.map((p) => `<option value="${p}">${p}</option>`).join('');
    $('#fPosicion').insertAdjacentHTML('beforeend', posOpts);
    $('#selPosicion').insertAdjacentHTML('beforeend', posOpts);
    $('#fNivel').insertAdjacentHTML('beforeend', NIVELES.map((n) => `<option value="${n}">${n}</option>`).join(''));
    $('#mNivel').innerHTML = NIVELES.map((n) => `<option value="${n}">${n}</option>`).join('');
  }

  async function init() {
    fillStaticOptions();
    bindEvents();

    if (!configOk()) {
      $('#configWarning').classList.remove('d-none');
    } else {
      const { data } = await sb.auth.getSession();
      await resolveRole(data.session);
      if (isManager()) await loadDB();
      // Reabre el perfil que el alumno tenía abierto en esta pestaña
      const guardado = sessionStorage.getItem(PERFIL_KEY);
      if (guardado) await abrirPerfil(guardado);
    }
    updateAuthUI();
    route();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
