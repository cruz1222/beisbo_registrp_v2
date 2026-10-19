# ⚾ Sistema de Control de Alumnos y Selección de Béisbol

Aplicación web (HTML + CSS + JavaScript) para registrar alumnos, controlar sus calificaciones por materia y administrar la selección de béisbol. Los datos y el inicio de sesión viven en **Supabase** (Postgres + Auth), protegidos con **Row Level Security (RLS)**.

- Diseño responsive *mobile-first* con **Bootstrap 5** (CDN).
- Semáforo de calificaciones: 🟢 ≥ 80 · 🟡 70–79 · 🔴 < 70.
- Frontend estático: se publica en **GitHub Pages**; el backend es Supabase.

---

## 📁 Estructura

```
.
├── index.html            # Estructura, vistas y modales
├── style.css             # Estilos propios
├── app.js                # Lógica + conexión a Supabase (ver CONFIG)
├── supabase/schema.sql   # Tablas, trigger de registro y políticas RLS
└── README.md
```

---

## 👥 Roles y permisos

### Alumno (sin contraseña, solo número de control)
- **Registro:** nombre, número de control (único), carrera y las **materias que cursa con su calificación por unidad** (hasta 8 unidades; solo captura las que ya tiene). El promedio de cada materia se calcula solo.
- **Mi perfil:** se consulta escribiendo el número de control. Muestra sus datos, materias, calificaciones con semáforo, observaciones del manager, nivel, posiciones y estatus de selección.
- **Único cambio permitido:** agregar **comentarios** a sus materias (por ejemplo, "con este maestro tengo muchas faltas"). No puede editar calificaciones ni datos, ni borrar/editar comentarios.

### Manager (cuenta con rol en la tabla `managers`)
- **CRUD completo** de alumnos, materias, calificaciones por unidad (0–100) y observaciones por materia.
- Ve los comentarios que escriben los alumnos (solo lectura) dentro del editor del alumno.
- **Gestión deportiva:** nivel y posiciones; **selección del equipo** con candidatos, prioritarios y cobertura por posición.
- **Datos:** exportar/importar respaldo JSON, migrar los datos locales de la versión anterior, cargar datos de ejemplo y borrar todo.

---

## 🚀 Puesta en marcha con Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. **SQL Editor → New query**: pega y ejecuta todo `supabase/schema.sql`. En *Table Editor* deben aparecer `alumnos`, `materias`, `unidades`, `comentarios` y `managers`.
3. **Authentication → Users → Add user**: crea la cuenta del manager (correo + contraseña, marca *Auto Confirm User*). Luego, en el SQL Editor:
   ```sql
   insert into public.managers (user_id)
   select id from auth.users where email = 'tu-correo@ejemplo.com';
   ```
4. **Project Settings → API**: copia *Project URL* y la clave *anon / publishable* y pégalas en `CONFIG` de `app.js`:
   ```js
   SUPABASE_URL: 'https://xxxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJ...',
   ```
   La clave anon es pública por diseño; **nunca** pongas la `service_role` en el frontend.
5. **Authentication → URL Configuration**: agrega la URL de tu GitHub Pages (y `http://localhost` si pruebas en local) en *Site URL*.
6. Abre la página, entra a **Manager** y, si tenías datos de la versión anterior en este navegador, usa **Datos → Migrar datos locales anteriores** (o **Importar respaldo** con un JSON exportado).

> Para probar en local sirve la carpeta con un servidor (`npx serve` o `python3 -m http.server`) en lugar de abrir el archivo con doble clic.

### 🚀 GitHub Pages

```bash
git init && git add . && git commit -m "Control de béisbol con Supabase"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/control-beisbol.git
git push -u origin main
```
Luego **Settings → Pages → Deploy from a branch → main / (root)**.

---

## 🗄️ Modelo de datos (Supabase)

| Tabla | Contenido | Quién escribe |
|---|---|---|
| `alumnos` | número de control, nombre, carrera, nivel, posiciones, seleccionado | Manager; el alumno se crea al registrarse (función `registrar_alumno`) |
| `materias` | nombre y observación del manager | Manager; las del registro las crea `registrar_alumno` |
| `unidades` | calificación de cada unidad (1–8) de una materia | Manager; las del registro las crea `registrar_alumno` |
| `comentarios` | texto del alumno sobre una materia | **Alumno** (función `agregar_comentario`) y manager |
| `managers` | usuarios con rol de manager | Tú, desde el SQL Editor |

### 🔒 Seguridad (RLS)
- Las tablas solo las puede leer/escribir el **manager** (`es_manager()`); el rol sale de la tabla `managers`, no del navegador.
- El alumno **no tiene cuenta**: usa tres funciones de Supabase (`registrar_alumno`, `consultar_perfil`, `agregar_comentario`) que solo tocan los datos del número de control indicado. No hay forma de editar calificaciones ni de listar a otros alumnos.
- ⚠️ Como no hay contraseña, **quien conozca un número de control puede ver ese perfil y agregarle comentarios**. Si los números son fáciles de adivinar, considera añadir un NIP al registro.

Notas:
- Eliminar un alumno desde el panel borra sus materias, calificaciones y comentarios.

---

## 🛠️ Personalización rápida

| Qué cambiar | Dónde |
|---|---|
| URL y clave de Supabase | `CONFIG` en `app.js` |
| Posiciones y niveles | `POSICIONES` / `NIVELES` en `app.js` (y el `check` de `nivel` en `schema.sql`) |
| Número de unidades | `MAX_UNIDADES` en `app.js` y el `check (numero between 1 and 8)` de la tabla `unidades` en `schema.sql` |
| Umbrales del semáforo | `UMBRAL_VERDE` y `UMBRAL_AMARILLO` en `app.js` |
| Colores del tema | Variables `:root` en `style.css` |

---

## 📄 Licencia

Uso libre para fines educativos. Añade la licencia que prefieras (por ejemplo MIT) antes de publicarlo.
