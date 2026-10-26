// LA PUERTA DEL CENTRO DE SOLERS · https://<brigada>/solers?llave=…
//
// Alex y Stalin entran como superadmin de Brigada desde el Centro de trabajo, con
// su llave, sin teclear nada y sin que se vea en ningún menú. Mismo patrón que
// /solers de Brasa y de GestorOS. La llave se comprueba aquí (api/_lib/llave-solers.js).
//
// Entra SIEMPRE como admin@solers.es (la cuenta maestra, oculta, única). Esa cuenta
// no es de ningún cliente: no tiene membresías ni sale en ninguna lista de equipo.
//
// Cómo se hace la sesión: contraseña DERIVADA (HMAC de la service_role) que siempre
// sale igual; se escribe una vez en la vida del usuario y después es un inicio de
// sesión normal con la clave anónima. Brigada guarda la sesión en localStorage (no
// usa cookies), así que la respuesta es una página mínima que la deja en el
// navegador y salta a la app. Va con `no-store`: ninguna caché puede dársela a otro.
const { verificarLlave } = require('./_lib/llave-solers');
const S = require('./_lib/solers');

function cerrada(res, motivo, estado) {
  console.warn('[solers] puerta cerrada:', motivo);
  S.sinCache(res, estado || 403, 'text/plain; charset=utf-8', 'Brigada · esta llave no abre.');
}

/** Una precarga (Next, el navegador, la vista previa de WhatsApp) no es una decisión de nadie. */
function esUnaPrecarga(req) {
  const h = req.headers;
  return h['next-router-prefetch'] === '1' || String(h.purpose || '').toLowerCase() === 'prefetch' ||
    String(h['x-purpose'] || '').toLowerCase() === 'preview' || String(h['sec-purpose'] || '').toLowerCase().includes('prefetch');
}

/** Deja listo al superadmin: existe, tiene la marca y su contraseña es la derivada. */
async function prepararSuperadmin(clave) {
  let u = await S.usuarioPorCorreo(S.CORREO_SUPERADMIN);
  if (!u) {
    const c = await S.supa('/auth/v1/admin/users', { metodo: 'POST', cuerpo: { email: S.CORREO_SUPERADMIN, password: clave, email_confirm: true, user_metadata: { nombre: 'Solers' } } });
    if (!c.ok) return { error: 'NOSEPUDOCREAR:' + c.mensaje };
    u = await S.usuarioPorCorreo(S.CORREO_SUPERADMIN);
    if (!u) return { error: 'SINPERFIL' };
  }
  if (u.es_superadmin !== true) {
    // El disparador de la base solo deja marcar a admin@solers.es.
    const r = await S.supa('/rest/v1/usuarios?id=eq.' + u.id, { metodo: 'PATCH', cuerpo: { es_superadmin: true }, extra: { Prefer: 'return=minimal' } });
    if (!r.ok) return { error: 'NOSUPERADMIN:' + r.mensaje };
  }
  return { id: u.id };
}

async function iniciarSesion(clave) {
  const e = S.entorno();
  return S.supa('/auth/v1/token?grant_type=password', { metodo: 'POST', clave: e.anon, cuerpo: { email: S.CORREO_SUPERADMIN, password: clave } });
}

/** La página que deja la sesión en el navegador y entra en la app (nada de la sesión va en la URL). */
function paginaDeEntrada(ses) {
  // `<` escapado para que nada del JSON pueda cerrar el <script>
  const datos = JSON.stringify(ses).replace(/</g, '\\u003c');
  return '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Brigada</title>' +
    '<body style="font-family:system-ui;background:#0b1320;color:#cfd8e3;display:grid;place-items:center;height:100vh;margin:0">Entrando…' +
    '<script>(function(){try{var n=' + datos + ',k="brigada_sync",o={};' +
    'try{o=JSON.parse(localStorage.getItem(k)||"{}")||{};}catch(e){}' +
    // Se limpia cualquier entrada anterior en un cliente: la sesión es la del superadmin, sin empresa.
    'Object.keys(localStorage).forEach(function(x){if(x.indexOf("brigada_solers_imp_")===0)localStorage.removeItem(x);});' +
    'o.ses=n.ses;o.tenant=null;o.rol=null;o.imp=null;o.sol=true;o.cursor=0;o.snap={};o.cola={};o.err="";' +
    'localStorage.setItem(k,JSON.stringify(o));}catch(e){}' +
    'location.replace("/#solers");})();</script></body>';
}

module.exports = async function (req, res) {
  if (esUnaPrecarga(req)) return S.sinCache(res, 204, 'text/plain', '');
  if (req.method === 'HEAD') return S.sinCache(res, 204, 'text/plain', ''); // un HEAD (vistas previas, comprobadores) nunca abre sesión
  if (req.method !== 'GET') return cerrada(res, 'METODO', 405);
  if (!S.aBuenRitmo('puerta:' + S.ipDe(req), 20)) return cerrada(res, 'RITMO', 429);

  const e = S.entorno();
  if (!e.url || !e.anon || !e.servicio) return cerrada(res, 'SINLLAVEMAESTRA', 503);

  const llave = new URL(req.url, 'http://x').searchParams.get('llave');
  const v = verificarLlave(llave, e.secreto);
  if (!v.ok) return cerrada(res, v.motivo);

  const clave = S.claveDerivada(S.CORREO_SUPERADMIN);
  const listo = await prepararSuperadmin(clave);
  if (listo.error) return cerrada(res, listo.error, 503);

  // Si la contraseña no es la derivada (primera vez, o alguien la cambió) se pone y se reintenta: idempotente.
  let s = await iniciarSesion(clave);
  if (!s.ok) {
    const f = await S.supa('/auth/v1/admin/users/' + listo.id, { metodo: 'PUT', cuerpo: { password: clave, email_confirm: true } });
    if (!f.ok) return cerrada(res, 'NOSEPUDOARMAR:' + f.mensaje, 503);
    s = await iniciarSesion(clave);
  }
  if (!s.ok || !s.datos || !s.datos.access_token) return cerrada(res, 'NOENTRA:' + s.mensaje, 503);

  await S.registrar(v.quien, 'puerta', null, S.CORREO_SUPERADMIN, {});
  const d = s.datos;
  const ses = { access: d.access_token, refresh: d.refresh_token, exp: Date.now() + (d.expires_in || 3600) * 1000, email: S.CORREO_SUPERADMIN, uid: listo.id };
  S.sinCache(res, 200, 'text/html; charset=utf-8', paginaDeEntrada({ ses }));
};
