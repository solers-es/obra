# Obra · "Brigada" (nombre provisional)

Programa de **gestión de obra e instaladores** para constructoras, reformas y empresas de instalaciones (fontanería, electricidad, albañilería…). La alternativa a Eureka, pensada para **pasarle por encima**: la obra y la parte fiscal/contable en un solo programa, con IA de verdad.

> **Producto NUEVO e independiente.** No comparte base de datos ni datos con GestorOS. Reutiliza como *plantilla* lo bueno de GestorOS (facturación, VeriFactu, multiempresa, portal), pero vive solo: su propio repositorio, su propia base y su propio despliegue.

## Qué hace (MVP)

El flujo principal, de principio a fin:

**Obra → presupuesto por capítulos y partidas → certificación por avance → factura (VeriFactu) → imputación de costes (albaranes + horas × coste/hora real) → margen real en vivo.**

Y encima: partes del operario (móvil, foto, firma), compras/albaranes con IA (OCR que imputa a la obra), SAT/mantenimientos, y portal del promotor.

## Por qué ganamos a Eureka (los 3 golpes)

1. **Obra + contabilidad/fiscal en un solo programa** (Eureka delega lo contable fuera).
2. **IA de verdad**: lee albaranes y los imputa solos a la obra, avisa de desviaciones *antes* de perder margen.
3. **Margen real por obra** con el coste/hora de verdad (sueldo + Seguridad Social ÷ horas reales), no estimado.

## Stack previsto

Next.js / React / Supabase (PostgreSQL con seguridad a nivel de fila), igual que GestorOS. Multiempresa con `tenant_id` + RLS.

## Estado

- [x] Normativa de cumplimiento (España, 2026) — `docs/normativa.html`
- [x] Modelo de datos del MVP — `docs/modelo-datos.html` y `supabase/esquema.sql`
- [x] Demo visual y prototipo funcional (localStorage) — ver `docs/`
- [x] Esquema validado en Postgres real (RLS, roles, sincronización) — `supabase/tests`
- [x] App lista para conectar por configuración (`config.js` / variables de entorno)
- [x] Proyecto Supabase de Brigada creado y esquema aplicado
- [x] Probado contra Supabase real (RLS, alta de empresa, sincronización, numeración, app de extremo a extremo)
- [ ] SMTP propio + Site URL + plantillas en español (Alex)
- [ ] Prueba con una constructora piloto y datos legales revisados
- [ ] VeriFactu real (contra la especificación oficial de la AEAT)

## Probar el flujo

`node tests/flujo.js` (necesita `playwright`): recorre solo con clics, en móvil, presupuesto → obra → avance → factura → cobro → parte, con datos de ejemplo y con la base vacía.

## Servidor (Supabase) — creado y probado

Proyecto `brigada` (Frankfurt, `tgonhsoasogjnvmcvcwf`). Ya tiene `supabase/esquema.sql` y `supabase/02_sync.sql` aplicados (21 tablas de negocio con RLS + sincronización, alta de empresa, equipo, numeración). **No se vuelve a aplicar el esquema.** Si se recrea el proyecto: ejecutar ambos en el SQL Editor, en ese orden.

Variables (ver `.env.example`):
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — van al frontend (públicas; la seguridad la da RLS). En local, ponerlas en `.env.local` (no se versiona) y ejecutar `node scripts/gen-config.js` para generar `config.js` (no commitear ese cambio). En el hosting, `vercel.json` ya ejecuta ese comando en el build con las variables del entorno.
- `SUPABASE_SERVICE_ROLE_KEY` — **secreta, solo la pone Alex en el despliegue del backend; la app actual NO la usa** y nunca debe ir en el repo ni en el navegador. Haría falta solo para lo que deba saltarse RLS desde un servidor propio: borrar usuarios, tareas administrativas, y VeriFactu cuando llegue.
- Opcionales `LEGAL_RAZON`, `LEGAL_NIF`, `LEGAL_DIRECCION`, `LEGAL_EMAIL` (Términos y privacidad).

**Configuración del proyecto que debe tocar Alex antes de vender** (Authentication en el panel de Supabase):
1. **Site URL** está en `http://localhost:3000`: los enlaces de confirmación de correo llevan ahí. Poner la URL real de Brigada (y añadirla a *Redirect URLs*).
2. **SMTP propio.** Con el correo por defecto de Supabase el límite es de **2 correos por hora** en todo el proyecto: no se pueden dar de alta operarios. Configurar un SMTP (Resend, Brevo, SES…).
3. La confirmación de correo está activada (bien). Subir la longitud mínima de contraseña (ahora 6) a 8+.
4. Los textos de los correos de Supabase están en inglés: traducirlos (Authentication → Email Templates).

Cómo funciona: cada obra, parte, presupuesto, cliente… es un documento por empresa con RLS. Trabaja sin conexión y sincroniza al volver la red; si dos personas editan lo mismo gana el último. El operario solo ve y escribe sus partes (y el nombre de las obras). Los números de factura los da el servidor (no se repiten entre móviles; facturar exige conexión cuando está conectado). Primer uso: «Más → Mi cuenta» → crear cuenta → confirmar el correo → «Crear empresa y subir mis datos»; el administrador invita a su gente.

## Pruebas

- `node tests/flujo.js` — flujo completo en móvil, modo local (necesita `playwright`).
- `node tests/cobros.js` — cobros parciales y retención de garantía.
- `node tests/importar.js` — importar clientes, partidas (Excel/CSV) y BC3.
- `node tests/real/supabase-real.js` y `node tests/real/app-real.js` — contra el **Supabase real** (solo clave anónima; necesitan `.env.local` con `TEST_EMAIL_A/TEST_PASS_A`, un usuario ya confirmado; crear usuarios nuevos está limitado a 2 por hora hasta tener SMTP propio).
- `sh supabase/tests/run.sh` — esquema + RLS + roles contra un Postgres local (`PGHOST/PGPORT/PGUSER`).
- `sh tests/run-sync.sh` — 2 móviles de oficina + 1 operario contra un servidor de pruebas sobre ese Postgres real.

Limitaciones conocidas: dos personas editando la **misma obra** a la vez → gana el último; VeriFactu **no** está implementado (ver PR); no probado todavía contra un Supabase real (solo Postgres local con un `auth` simulado).

## Cumplimiento (lo obligatorio)

VeriFactu (RD 1007/2023 tras el RD-ley 15/2025; sociedades 1-1-2027, resto 1-7-2027; Hacienda ha anunciado octubre de 2028, pendiente de norma), TicketBAI si hay clientes vascos, Facturae en obra pública, Libro de Subcontratación + REA, registro de jornada, seguridad y salud (RD 1627/1997). Detalle en `docs/normativa.html`.

---

Hecho por el equipo de Solers (Stalin · Alex · Claude). Documento interno.
