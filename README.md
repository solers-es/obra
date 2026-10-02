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
- [ ] Base de datos Supabase creada y esquema aplicado
- [ ] MVP conectado a la base (obra → presupuesto → certificación → factura)
- [ ] VeriFactu real (contra la especificación oficial de la AEAT)

## Cumplimiento (lo obligatorio)

VeriFactu (RD 1007/2023; sociedades 1-1-2027, resto 1-7-2027), TicketBAI si hay clientes vascos, Facturae en obra pública, Libro de Subcontratación + REA, registro de jornada, seguridad y salud (RD 1627/1997). Detalle en `docs/normativa.html`.

---

Hecho por el equipo de Solers (Stalin · Alex · Claude). Documento interno.
