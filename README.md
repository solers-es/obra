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
- [ ] Proyecto Supabase de Brigada creado (decide Alex) y esquema aplicado
- [ ] Probado contra Supabase real
- [ ] VeriFactu real (contra la especificación oficial de la AEAT)

## Probar el flujo

`node tests/flujo.js` (necesita `playwright`): recorre solo con clics, en móvil, presupuesto → obra → avance → factura → cobro → parte, con datos de ejemplo y con la base vacía.

## Conectar el servidor (Supabase) — cuando Alex decida la base

La app funciona sola en el móvil (modo local). Para cuentas, varios usuarios y sincronización:

1. Crear un proyecto Supabase **solo de Brigada** (no reutilizar el de otros productos).
2. En el SQL Editor, ejecutar en orden: `supabase/esquema.sql` y `supabase/02_sync.sql`.
3. Authentication → Providers → Email activo (para pruebas se puede desactivar «Confirm email»).
4. Variables de entorno en el hosting: `SUPABASE_URL` y `SUPABASE_ANON_KEY` (la clave **anon public**; el script rechaza la `service_role`).
5. Comando de build: `node scripts/gen-config.js` (genera `config.js`). Sin variables, la app queda en modo local.
6. Primer uso: «Más → Mi cuenta» → crear cuenta → «Crear empresa y subir mis datos». Después el administrador invita a su gente (jefe de obra, administrativo, operario, solo lectura).

Cómo funciona: cada obra, parte, presupuesto, cliente… es un documento por empresa con RLS. Trabaja sin conexión y sincroniza al volver la red; si dos personas editan lo mismo gana el último. El operario solo ve y escribe sus partes (y el nombre de las obras). Los números de factura los da el servidor (no se repiten entre móviles; facturar exige conexión cuando está conectado).

## Pruebas

- `node tests/flujo.js` — flujo completo en móvil, modo local (necesita `playwright`).
- `sh supabase/tests/run.sh` — esquema + RLS + roles contra un Postgres local (`PGHOST/PGPORT/PGUSER`).
- `sh tests/run-sync.sh` — 2 móviles de oficina + 1 operario contra un servidor de pruebas sobre ese Postgres real.

Limitaciones conocidas: dos personas editando la **misma obra** a la vez → gana el último; VeriFactu **no** está implementado (ver PR); no probado todavía contra un Supabase real (solo Postgres local con un `auth` simulado).

## Cumplimiento (lo obligatorio)

VeriFactu (RD 1007/2023 tras el RD-ley 15/2025; sociedades 1-1-2027, resto 1-7-2027; Hacienda ha anunciado octubre de 2028, pendiente de norma), TicketBAI si hay clientes vascos, Facturae en obra pública, Libro de Subcontratación + REA, registro de jornada, seguridad y salud (RD 1627/1997). Detalle en `docs/normativa.html`.

---

Hecho por el equipo de Solers (Stalin · Alex · Claude). Documento interno.
