// API DEL SUPERADMIN DE SOLERS · POST /api/superadmin
//
// Lo que NO se puede hacer con la clave anónima + RLS (necesita la API de
// administración de Auth, es decir, la service_role, que vive solo aquí, en el
// servidor, y nunca llega al navegador):
//   · alta_cliente → crea la empresa y a su primer administrador
//   · clave        → pone una contraseña nueva a cualquiera (o genera un enlace de recuperación)
//   · registro     → últimas acciones de la bitácora
// Listar clientes y entrar dentro de uno son funciones SQL (supabase/03_superadmin.sql).
//
// Quién llama: solo admin@solers.es. Se comprueba en CADA llamada contra Supabase
// (el token del navegador se valida con /auth/v1/user y la marca es_superadmin se
// lee de la base), no se fía de lo que diga el cliente.
const S = require('./_lib/solers');

const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function responder(res, estado, obj) { S.sinCache(res, estado, 'application/json; charset=utf-8', JSON.stringify(obj)); }

async function quienLlama(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const e = S.entorno();
  const u = await S.supa('/auth/v1/user', { clave: e.anon, token: m[1] });
  if (!u.ok || !u.datos || !u.datos.id) return null;
  if (String(u.datos.email || '').toLowerCase() !== S.CORREO_SUPERADMIN) return null;
  const p = await S.supa('/rest/v1/usuarios?select=es_superadmin&id=eq.' + encodeURIComponent(u.datos.id));
  if (!p.ok || !Array.isArray(p.datos) || !p.datos[0] || p.datos[0].es_superadmin !== true) return null;
  return { id: u.datos.id, email: u.datos.email };
}

const texto = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** 1) Dar de alta un cliente (constructora): empresa + primer administrador. */
async function altaCliente(b) {
  const razon = texto(b.razon_social, 200), nif = S.nifNormal(b.nif), correo = texto(b.email_admin, 200).toLowerCase();
  if (!razon) return [400, { error: 'Falta el nombre de la empresa' }];
  if (!S.nifValido(nif)) return [400, { error: 'El NIF/CIF no es válido' }];
  if (!RE_CORREO.test(correo)) return [400, { error: 'El correo del administrador no es válido' }];
  if (correo === S.CORREO_SUPERADMIN) return [400, { error: 'Ese correo es la cuenta maestra de Solers' }];
  let clave = texto(b.clave, 100);
  if (clave && clave.length < 8) return [400, { error: 'La contraseña debe tener al menos 8 caracteres' }];

  const dup = await S.supa('/rest/v1/tenants?select=id,razon_social&nif=eq.' + encodeURIComponent(nif));
  if (dup.ok && Array.isArray(dup.datos) && dup.datos.length) return [409, { error: 'Ya existe un cliente con ese NIF: ' + dup.datos[0].razon_social }];

  // El administrador: si ya tiene cuenta se reutiliza (sin tocar su contraseña); si no, se crea.
  let usuario = await S.usuarioPorCorreo(correo), creado = false;
  if (!usuario) {
    if (!clave) clave = S.claveAleatoria();
    const c = await S.supa('/auth/v1/admin/users', { metodo: 'POST', cuerpo: { email: correo, password: clave, email_confirm: true, user_metadata: { nombre: texto(b.nombre, 100) } } });
    if (!c.ok || !c.datos || !c.datos.id) return [502, { error: 'No se pudo crear el usuario: ' + c.mensaje }];
    usuario = { id: c.datos.id, email: correo }; creado = true;
  } else { clave = ''; }

  const deshacer = async (tenantId) => {
    if (tenantId) await S.supa('/rest/v1/tenants?id=eq.' + tenantId, { metodo: 'DELETE', extra: { Prefer: 'return=minimal' } });
    if (creado) await S.supa('/auth/v1/admin/users/' + usuario.id, { metodo: 'DELETE' });
  };

  const hasta = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const t = await S.supa('/rest/v1/tenants', { metodo: 'POST', extra: { Prefer: 'return=representation' }, cuerpo: {
    nif, razon_social: razon, nombre_comercial: texto(b.nombre_comercial, 200) || null, direccion: texto(b.direccion, 200) || null,
    municipio: texto(b.municipio, 100) || null, provincia: texto(b.provincia, 100) || null,
    email_contacto: correo, telefono: texto(b.telefono, 40) || null, estado: 'prueba', plan: 'prueba', prueba_hasta: hasta } });
  if (!t.ok || !Array.isArray(t.datos) || !t.datos[0]) { await deshacer(null); return [t.estado === 409 ? 409 : 502, { error: 'No se pudo crear la empresa: ' + t.mensaje }]; }
  const tenantId = t.datos[0].id;

  const m = await S.supa('/rest/v1/membresias', { metodo: 'POST', cuerpo: { tenant_id: tenantId, usuario_id: usuario.id, rol: 'admin' }, extra: { Prefer: 'return=minimal' } });
  if (!m.ok) { await deshacer(tenantId); return [502, { error: 'No se pudo dar acceso al administrador: ' + m.mensaje }]; }

  await S.registrar('admin', 'alta_cliente', tenantId, razon, { nif, admin: correo, usuario_nuevo: creado });
  return [200, { ok: true, tenant_id: tenantId, usuario_id: usuario.id, email: correo, usuario_existente: !creado, clave: clave || undefined }];
}

/** 4) Cambiar/resetear la contraseña de cualquiera (excepto la cuenta maestra, que la gobierna la puerta). */
async function cambiarClave(b) {
  const correo = texto(b.email, 200).toLowerCase();
  if (!RE_CORREO.test(correo)) return [400, { error: 'Pon el correo de la persona' }];
  if (correo === S.CORREO_SUPERADMIN) return [400, { error: 'La cuenta maestra no tiene contraseña que cambiar: entra por la puerta del Centro' }];
  const u = await S.usuarioPorCorreo(correo);
  if (!u) return [404, { error: 'No hay ninguna cuenta con ese correo' }];

  if (b.modo === 'enlace') {
    const l = await S.supa('/auth/v1/admin/generate_link', { metodo: 'POST', cuerpo: { type: 'recovery', email: correo } });
    const enlace = l.datos && (l.datos.action_link || (l.datos.properties && l.datos.properties.action_link));
    if (!l.ok || !enlace) return [502, { error: 'No se pudo generar el enlace: ' + l.mensaje }];
    await S.registrar('admin', 'clave_enlace', null, correo, {});
    return [200, { ok: true, email: correo, enlace }];
  }

  let clave = texto(b.clave, 100);
  if (clave && clave.length < 8) return [400, { error: 'La contraseña debe tener al menos 8 caracteres' }];
  if (!clave) clave = S.claveAleatoria();
  const r = await S.supa('/auth/v1/admin/users/' + u.id, { metodo: 'PUT', cuerpo: { password: clave } });
  if (!r.ok) return [502, { error: 'No se pudo cambiar la contraseña: ' + r.mensaje }];
  await S.registrar('admin', 'clave', null, correo, {});
  return [200, { ok: true, email: correo, clave }];
}

async function ultimosRegistros() {
  const r = await S.supa('/rest/v1/solers_registro?select=cuando,quien,accion,objetivo&order=id.desc&limit=50');
  return [r.ok ? 200 : 502, r.ok ? { ok: true, registros: r.datos } : { error: r.mensaje }];
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') return responder(res, 405, { error: 'Método no permitido' });
  const e = S.entorno();
  if (!e.url || !e.anon || !e.servicio) return responder(res, 503, { error: 'Servidor sin configurar' });
  if (!S.aBuenRitmo('panel:' + S.ipDe(req), 60)) return responder(res, 429, { error: 'Más despacio' });

  const quien = await quienLlama(req);
  if (!quien) return responder(res, 403, { error: 'No autorizado' });

  const b = await S.leerJson(req);
  if (!b || typeof b !== 'object') return responder(res, 400, { error: 'Petición no válida' });
  try {
    const [estado, cuerpo] = b.accion === 'alta_cliente' ? await altaCliente(b)
      : b.accion === 'clave' ? await cambiarClave(b)
      : b.accion === 'registro' ? await ultimosRegistros()
      : [400, { error: 'Acción desconocida' }];
    responder(res, estado, cuerpo);
  } catch (x) {
    console.error('[superadmin]', b.accion, x && x.message);
    responder(res, 500, { error: 'Error en el servidor' });
  }
};
