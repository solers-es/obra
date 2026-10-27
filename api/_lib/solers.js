// Utilidades comunes de la API del superadmin de Solers (puerta y panel).
// Sin dependencias: habla con Supabase por HTTP (GoTrue + PostgREST).
const { createHmac, randomInt } = require('node:crypto');

// La cuenta maestra de Solers: el ÚNICO superadmin. Oculta: no pertenece a ningún cliente.
const CORREO_SUPERADMIN = 'admin@solers.es';

function entorno() {
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    anon: process.env.SUPABASE_ANON_KEY || '',
    servicio: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    secreto: process.env.SOLERS_LLAVE_SECRETO || ''
  };
}

/** Respuesta que nunca debe guardar ninguna caché (lleva sesiones). */
function sinCache(res, estado, tipo, cuerpo) {
  res.statusCode = estado;
  res.setHeader('Content-Type', tipo);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end(cuerpo);
}

// Freno de ritmo en memoria: una llave se prueba a mano, no a lo bruto.
const intentos = new Map();
function aBuenRitmo(clave, max) {
  const ahora = Date.now(), b = intentos.get(clave);
  if (!b || ahora > b.hasta) { intentos.set(clave, { n: 1, hasta: ahora + 60000 }); return true; }
  b.n++;
  return b.n <= max;
}
function ipDe(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon'; }

/** Llamada a Supabase. `clave` = service_role (por defecto) o la anónima, con `token` opcional del usuario. */
async function supa(ruta, { metodo = 'GET', cuerpo, clave, token, extra } = {}) {
  const e = entorno();
  const k = clave || e.servicio;
  const cabeceras = Object.assign({ apikey: k, Authorization: 'Bearer ' + (token || k), 'Content-Type': 'application/json' }, extra || {});
  const r = await fetch(e.url + ruta, { method: metodo, headers: cabeceras, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (x) { /* respuesta no JSON */ }
  return { ok: r.ok, estado: r.status, datos: j, mensaje: (j && (j.msg || j.message || j.error_description || j.error)) || '' };
}

/** Contraseña derivada: siempre la misma para este correo y este proyecto, nadie la teclea ni la ve. */
function claveDerivada(correo) {
  const pin = (process.env.SOLERS_PIN || '').trim();
  if (pin && correo === CORREO_SUPERADMIN) return pin;
  return createHmac('sha256', entorno().servicio).update('brigada:puerta-solers:' + correo).digest('base64url');
}

/** Contraseña aleatoria legible (sin 0/O/1/l/I) para dar de alta o resetear a un cliente. */
function claveAleatoria(largo = 14) {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < largo; i++) s += a[randomInt(a.length)];
  return s;
}

/** NIF/NIE/CIF español con dígito de control (mismo criterio que app.es_nif_valido en la base). */
function nifValido(nif) {
  const v = String(nif || '').toUpperCase().replace(/[\s.\-]/g, '');
  const L = 'TRWAGMYFPDXBNJZSQVHLCKE';
  if (/^[0-9]{8}[A-Z]$/.test(v)) return L[parseInt(v.slice(0, 8), 10) % 23] === v[8];
  if (/^[XYZ][0-9]{7}[A-Z]$/.test(v)) return L[parseInt('XYZ'.indexOf(v[0]) + v.slice(1, 8), 10) % 23] === v[8];
  if (/^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$/.test(v)) {
    let s = 0;
    for (let i = 0; i < 7; i++) { let d = parseInt(v[i + 1], 10); if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } s += d; }
    const c = (10 - (s % 10)) % 10, letra = 'JABCDEFGHI'[c];
    return /[PQRSNW]/.test(v[0]) ? v[8] === letra : (/[ABEH]/.test(v[0]) ? v[8] === String(c) : (v[8] === String(c) || v[8] === letra));
  }
  return false;
}
function nifNormal(nif) { return String(nif || '').toUpperCase().replace(/[\s.\-]/g, ''); }

/** Busca un usuario por correo exacto (sin distinguir mayúsculas). Devuelve {id,email} o null. */
async function usuarioPorCorreo(correo) {
  const c = String(correo || '').trim().toLowerCase();
  // `ilike` trata _ y % como comodines: se trae y se compara exacto.
  const r = await supa('/rest/v1/usuarios?select=id,email,es_superadmin&email=ilike.' + encodeURIComponent(c.replace(/[%*]/g, '')));
  if (!r.ok || !Array.isArray(r.datos)) return null;
  return r.datos.find((u) => String(u.email || '').toLowerCase() === c) || null;
}

/** Anota en la bitácora (con la service_role). Nunca recibe contraseñas ni enlaces. */
async function registrar(quien, accion, tenantId, objetivo, detalle) {
  try {
    await supa('/rest/v1/solers_registro', { metodo: 'POST', cuerpo: { quien, accion, tenant_id: tenantId || null, objetivo: objetivo || null, detalle: detalle || {} }, extra: { Prefer: 'return=minimal' } });
  } catch (x) { console.warn('[solers] no se pudo anotar en la bitácora:', accion); }
}

/** Lee el cuerpo JSON (Vercel ya lo trae en req.body; si no, se lee del flujo). */
async function leerJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch (x) { return null; } }
  const trozos = []; let n = 0;
  for await (const t of req) { n += t.length; if (n > 100000) return null; trozos.push(t); }
  try { return JSON.parse(Buffer.concat(trozos).toString('utf8') || '{}'); } catch (x) { return null; }
}

module.exports = { CORREO_SUPERADMIN, entorno, sinCache, aBuenRitmo, ipDe, supa, claveDerivada, claveAleatoria, nifValido, nifNormal, usuarioPorCorreo, registrar, leerJson };
