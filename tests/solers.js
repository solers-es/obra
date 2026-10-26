// Superadmin de Solers: llave firmada, puerta /solers y API del panel.  node tests/solers.js
// Usa un Supabase falso en memoria (GoTrue + PostgREST mínimos): no toca ninguna base real.
const http = require('http'), assert = require('assert');
const { emitirLlave, verificarLlave } = require('../api/_lib/llave-solers');

const SECRETO = 'secreto-de-prueba', SERVICIO = 'service-role-de-prueba', ANON = 'anon-de-prueba';
// ---------- 1. La llave (pura) ----------
(function llave() {
  const l = emitirLlave('alex', SECRETO, 1790000000);
  assert.deepStrictEqual(verificarLlave(l, SECRETO), { ok: true, quien: 'alex', emitida: 1790000000 });
  assert.strictEqual(verificarLlave(emitirLlave('stalin', SECRETO), SECRETO).quien, 'stalin');
  const m = (x, s) => verificarLlave(x, s).motivo;
  assert.strictEqual(m(l, 'otro-secreto'), 'FIRMA');
  assert.strictEqual(m(l.replace('alex', 'stalin'), SECRETO), 'FIRMA', 'cambiar el nombre invalida la firma');
  assert.strictEqual(m(l.replace('1790000000', '1790000001'), SECRETO), 'FIRMA');
  assert.strictEqual(m('', SECRETO), 'VACIA');
  assert.strictEqual(m(null, SECRETO), 'VACIA');
  assert.strictEqual(m(l, ''), 'SINSECRETO', 'sin secreto en el entorno la puerta no existe');
  assert.strictEqual(m('a.b.c', SECRETO), 'FORMATO');
  assert.strictEqual(m(emitirLlave('mallory', SECRETO), SECRETO), 'QUIEN');
  assert.strictEqual(m(l + 'x', SECRETO), 'FIRMA');
  assert.strictEqual(m(l.slice(0, -2), SECRETO), 'FIRMA');
  console.log('✓ llave firmada');
})();

// ---------- 2. Supabase falso ----------
const bd = { auth: [], usuarios: [], tenants: [], membresias: [], registro: [] };
let n = 0; const uid = () => '00000000-0000-0000-0000-' + String(++n).padStart(12, '0');
const tokens = {}; // token -> id de usuario
const fallos = { tenants: false, membresias: false };

function servidor() {
  return http.createServer((req, res) => {
    let cuerpo = ''; req.on('data', (c) => cuerpo += c); req.on('end', () => {
      const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams, m = req.method;
      const b = cuerpo ? JSON.parse(cuerpo) : {};
      const auth = (req.headers.authorization || '').replace('Bearer ', '');
      const out = (e, d) => { res.writeHead(e, { 'content-type': 'application/json' }); res.end(d === undefined ? '' : JSON.stringify(d)); };
      const esServicio = auth === SERVICIO;
      const eq = (v) => String(v || '').replace(/^eq\./, '');
      let r;
      if (p === '/auth/v1/user') { const id = tokens[auth]; const a = bd.auth.find((x) => x.id === id); return a ? out(200, { id: a.id, email: a.email }) : out(401, { msg: 'jwt' }); }
      if (p === '/auth/v1/token') {
        const a = bd.auth.find((x) => x.email === b.email && x.password === b.password);
        if (!a) return out(400, { error_description: 'Invalid login credentials' });
        const t = 'tok-' + a.id; tokens[t] = a.id; return out(200, { access_token: t, refresh_token: 'ref-' + a.id, expires_in: 3600, user: { id: a.id, email: a.email } });
      }
      if (p.startsWith('/auth/v1/admin/') && !esServicio) return out(403, { msg: 'not_admin' });
      if (p === '/auth/v1/admin/users' && m === 'POST') {
        if (bd.auth.find((x) => x.email === b.email)) return out(422, { msg: 'email_exists' });
        const a = { id: uid(), email: b.email, password: b.password }; bd.auth.push(a);
        bd.usuarios.push({ id: a.id, email: a.email, es_superadmin: false }); return out(200, { id: a.id, email: a.email });
      }
      if ((r = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(p))) {
        const a = bd.auth.find((x) => x.id === r[1]); if (!a) return out(404, { msg: 'no' });
        if (m === 'PUT') { if (b.password) a.password = b.password; return out(200, { id: a.id }); }
        if (m === 'DELETE') { bd.auth = bd.auth.filter((x) => x !== a); bd.usuarios = bd.usuarios.filter((x) => x.id !== a.id); return out(200, {}); }
      }
      if (p === '/auth/v1/admin/generate_link') return out(200, { action_link: 'https://ejemplo.supabase.co/verify?token=abc&type=recovery' });
      if (!esServicio && p.startsWith('/rest/v1/')) return out(401, { message: 'sin permiso' });
      if (p === '/rest/v1/usuarios') {
        if (m === 'GET') { const e = q.get('email'), i = q.get('id'); let l = bd.usuarios;
          if (e) { const pat = new RegExp('^' + e.replace(/^ilike\./, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.').replace(/%/g, '.*') + '$', 'i'); l = l.filter((x) => pat.test(x.email)); }
          if (i) l = l.filter((x) => x.id === eq(i)); return out(200, l); }
        if (m === 'PATCH') { const x = bd.usuarios.find((y) => y.id === eq(q.get('id'))); if (b.es_superadmin && x.email.toLowerCase() !== 'admin@solers.es') return out(403, { message: 'El único superadmin es admin@solers.es' }); Object.assign(x, b); return out(204); }
      }
      if (p === '/rest/v1/tenants') {
        if (m === 'GET') return out(200, bd.tenants.filter((t) => t.nif === eq(q.get('nif'))));
        if (m === 'POST') { if (fallos.tenants) return out(500, { message: 'boom' }); if (bd.tenants.find((t) => t.nif === b.nif)) return out(409, { message: 'duplicado' }); const t = Object.assign({ id: uid() }, b); bd.tenants.push(t); return out(201, [t]); }
        if (m === 'DELETE') { bd.tenants = bd.tenants.filter((t) => t.id !== eq(q.get('id'))); return out(204); }
      }
      if (p === '/rest/v1/membresias' && m === 'POST') { if (fallos.membresias) return out(500, { message: 'boom' }); bd.membresias.push(b); return out(201); }
      if (p === '/rest/v1/solers_registro') {
        if (m === 'POST') { bd.registro.push(b); return out(201); }
        if (m === 'GET') return out(200, bd.registro.slice().reverse().slice(0, 50));
      }
      out(404, { message: 'no existe ' + m + ' ' + p });
    });
  });
}

// ---------- 3. Llamadas a los manejadores ----------
function llamar(manejador, { metodo = 'GET', url = '/', cabeceras = {}, cuerpo } = {}) {
  return new Promise((resolve) => {
    const req = { method: metodo, url, headers: Object.assign({ 'x-forwarded-for': '9.9.9.' + (++n) }, cabeceras), body: cuerpo };
    const h = {}; const res = { statusCode: 200, setHeader(k, v) { h[k.toLowerCase()] = v; }, end(t) { resolve({ estado: res.statusCode, cabeceras: h, texto: t || '' }); } };
    manejador(req, res);
  });
}

(async () => {
  const srv = servidor(); await new Promise((r) => srv.listen(0, r));
  Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:' + srv.address().port, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICIO, SOLERS_LLAVE_SECRETO: SECRETO });
  const puerta = require('../api/solers'), panel = require('../api/superadmin');
  const llaveBuena = emitirLlave('alex', SECRETO);
  const abre = (l, c) => llamar(puerta, { url: '/solers?llave=' + encodeURIComponent(l), cabeceras: c });

  // --- la puerta ---
  let r = await abre('solers1.alex.1790000000.firmamala');
  assert.strictEqual(r.estado, 403); assert.ok(!r.texto.includes('access'), 'una llave mala no suelta nada');
  r = await llamar(puerta, { url: '/solers' }); assert.strictEqual(r.estado, 403, 'sin llave no abre');
  r = await abre(llaveBuena, { 'next-router-prefetch': '1' }); assert.strictEqual(r.estado, 204, 'una precarga no abre sesión'); assert.strictEqual(bd.auth.length, 0);
  r = await abre(llaveBuena, { 'sec-purpose': 'prefetch;prerender' }); assert.strictEqual(r.estado, 204);
  r = await llamar(puerta, { metodo: 'POST', url: '/solers?llave=' + llaveBuena }); assert.strictEqual(r.estado, 405);
  r = await llamar(puerta, { metodo: 'HEAD', url: '/solers?llave=' + llaveBuena }); assert.strictEqual(r.estado, 204); assert.strictEqual(bd.auth.length, 0, 'un HEAD no abre sesión');
  r = await abre(llaveBuena);
  assert.strictEqual(r.estado, 200); assert.ok(/no-store/.test(r.cabeceras['cache-control']), 'la sesión no se cachea');
  assert.ok(r.texto.includes('brigada_sync') && r.texto.includes('location.replace("/#solers")'));
  assert.ok(!r.texto.includes(SERVICIO) && !r.texto.includes(SECRETO), 'ni la service_role ni el secreto salen del servidor');
  const admin = bd.usuarios.find((u) => u.email === 'admin@solers.es');
  assert.ok(admin && admin.es_superadmin === true, 'admin@solers.es se crea con la marca de superadmin');
  assert.strictEqual(bd.membresias.length, 0, 'la cuenta maestra no pertenece a ningún cliente');
  assert.deepStrictEqual(bd.registro.map((x) => [x.quien, x.accion]), [['alex', 'puerta']], 'queda en la bitácora quién entró');
  const ses = JSON.parse(/var n=(\{.*?\}),k=/s.exec(r.texto)[1]).ses;
  assert.strictEqual(ses.email, 'admin@solers.es'); assert.ok(ses.access && ses.refresh && ses.exp > Date.now());
  // segunda vez: idempotente (mismo usuario, no se duplica); si alguien cambió la contraseña, se rearma
  admin && (bd.auth.find((a) => a.id === admin.id).password = 'cambiada-a-mano');
  r = await abre(emitirLlave('stalin', SECRETO)); assert.strictEqual(r.estado, 200);
  assert.strictEqual(bd.auth.filter((a) => a.email === 'admin@solers.es').length, 1);
  assert.strictEqual(bd.registro[1].quien, 'stalin');
  console.log('✓ puerta /solers');

  // --- la API del panel ---
  const post = (cuerpo, token) => llamar(panel, { metodo: 'POST', url: '/api/superadmin', cabeceras: token ? { authorization: 'Bearer ' + token } : {}, cuerpo });
  const tokAdmin = ses.access;
  assert.strictEqual((await post({ accion: 'registro' })).estado, 403, 'sin token no');
  assert.strictEqual((await post({ accion: 'registro' }, 'inventado')).estado, 403);
  assert.strictEqual((await llamar(panel, { metodo: 'GET' })).estado, 405);
  // un cliente cualquiera (con token válido) tampoco
  bd.auth.push({ id: 'cliente-1', email: 'ana@cliente.es', password: 'x' }); bd.usuarios.push({ id: 'cliente-1', email: 'ana@cliente.es', es_superadmin: false });
  tokens['tok-ana'] = 'cliente-1';
  assert.strictEqual((await post({ accion: 'alta_cliente', razon_social: 'X', nif: 'A58818501', email_admin: 'x@x.es' }, 'tok-ana')).estado, 403, 'un cliente no da de alta');
  assert.strictEqual((await post({ accion: 'clave', email: 'ana@cliente.es' }, 'tok-ana')).estado, 403, 'un cliente no resetea claves');
  // aunque el correo fuese el bueno, sin la marca en la base no vale
  admin.es_superadmin = false; assert.strictEqual((await post({ accion: 'registro' }, tokAdmin)).estado, 403, 'sin marca de superadmin en la base no vale'); admin.es_superadmin = true;
  assert.strictEqual((await post({ accion: 'registro' }, tokAdmin)).estado, 200);
  assert.strictEqual((await post({ accion: 'borrar_todo' }, tokAdmin)).estado, 400);

  // 1) alta de cliente
  const alta = { accion: 'alta_cliente', razon_social: 'Reformas Vega SL', nif: 'a-58818501', email_admin: 'Jefe@Vega.es', nombre: 'Marta', telefono: '600000000' };
  r = await post(Object.assign({}, alta, { nif: 'A1234' }), tokAdmin); assert.strictEqual(r.estado, 400, 'NIF inválido');
  r = await post(Object.assign({}, alta, { email_admin: 'no-es-correo' }), tokAdmin); assert.strictEqual(r.estado, 400);
  r = await post(Object.assign({}, alta, { email_admin: 'admin@solers.es' }), tokAdmin); assert.strictEqual(r.estado, 400, 'no se puede crear un cliente con la cuenta maestra');
  r = await post(Object.assign({}, alta, { clave: 'corta' }), tokAdmin); assert.strictEqual(r.estado, 400);
  assert.strictEqual(bd.tenants.length, 0, 'las validaciones no crean nada');
  r = await post(alta, tokAdmin); let j = JSON.parse(r.texto);
  assert.strictEqual(r.estado, 200, r.texto); assert.ok(j.clave && j.clave.length >= 12, 'se genera una contraseña y se enseña una vez');
  assert.strictEqual(bd.tenants.length, 1); assert.strictEqual(bd.tenants[0].nif, 'A58818501'); assert.strictEqual(bd.tenants[0].estado, 'prueba');
  assert.deepStrictEqual(bd.membresias.map((x) => x.rol), ['admin']); assert.strictEqual(bd.membresias[0].tenant_id, j.tenant_id);
  assert.strictEqual(bd.auth.find((a) => a.email === 'jefe@vega.es').password, j.clave);
  assert.ok(!JSON.stringify(bd.registro).includes(j.clave), 'la contraseña no se apunta en la bitácora');
  assert.strictEqual(bd.registro.at(-1).accion, 'alta_cliente');
  r = await post(alta, tokAdmin); assert.strictEqual(r.estado, 409, 'mismo NIF: no se duplica'); assert.strictEqual(bd.tenants.length, 1);
  // administrador que ya tiene cuenta: se reutiliza y NO se le toca la contraseña
  const antes = bd.auth.find((a) => a.email === 'ana@cliente.es').password;
  r = await post(Object.assign({}, alta, { razon_social: 'Otra Obra SL', nif: '12345678Z', email_admin: 'ana@cliente.es' }), tokAdmin); j = JSON.parse(r.texto);
  assert.strictEqual(r.estado, 200, r.texto); assert.strictEqual(j.usuario_existente, true); assert.strictEqual(j.clave, undefined);
  assert.strictEqual(bd.auth.find((a) => a.email === 'ana@cliente.es').password, antes, 'no se rompe el acceso de quien ya tenía cuenta');
  // si falla a medias, se deshace todo (sin empresas ni usuarios huérfanos)
  const nAuth = bd.auth.length, nTen = bd.tenants.length;
  fallos.tenants = true; r = await post(Object.assign({}, alta, { razon_social: 'Falla SL', nif: 'B12345674', email_admin: 'nuevo@falla.es' }), tokAdmin);
  assert.strictEqual(r.estado, 502); assert.deepStrictEqual([bd.auth.length, bd.tenants.length], [nAuth, nTen], 'sin tenant: el usuario recién creado se borra'); fallos.tenants = false;
  fallos.membresias = true; r = await post(Object.assign({}, alta, { razon_social: 'Falla SL', nif: 'B12345674', email_admin: 'nuevo@falla.es' }), tokAdmin);
  assert.strictEqual(r.estado, 502); assert.deepStrictEqual([bd.auth.length, bd.tenants.length], [nAuth, nTen], 'sin membresía: se borran empresa y usuario'); fallos.membresias = false;
  console.log('✓ alta de cliente');

  // 4) contraseña
  r = await post({ accion: 'clave', email: 'ana@cliente.es', clave: 'NuevaClave2026' }, tokAdmin); j = JSON.parse(r.texto);
  assert.strictEqual(r.estado, 200); assert.strictEqual(bd.auth.find((a) => a.email === 'ana@cliente.es').password, 'NuevaClave2026');
  r = await post({ accion: 'clave', email: 'ANA@cliente.es' }, tokAdmin); j = JSON.parse(r.texto);
  assert.ok(j.clave && j.clave.length >= 12 && bd.auth.find((a) => a.email === 'ana@cliente.es').password === j.clave, 'sin contraseña: se genera una');
  r = await post({ accion: 'clave', email: 'ana@cliente.es', modo: 'enlace' }, tokAdmin); j = JSON.parse(r.texto);
  assert.ok(/^https:\/\/.+recovery/.test(j.enlace), 'enlace de recuperación');
  assert.strictEqual((await post({ accion: 'clave', email: 'nadie@nada.es' }, tokAdmin)).estado, 404);
  assert.strictEqual((await post({ accion: 'clave', email: 'ana@cliente.es', clave: 'corta' }, tokAdmin)).estado, 400);
  assert.strictEqual((await post({ accion: 'clave', email: 'admin@solers.es', clave: 'unaclavecualquiera' }, tokAdmin)).estado, 400, 'la cuenta maestra se gobierna por la puerta');
  assert.strictEqual((await post({ accion: 'clave', email: 'a_a@cliente.es' }, tokAdmin)).estado, 404, '_ no es comodín: no resetea a otra persona');
  assert.ok(!JSON.stringify(bd.registro).includes('NuevaClave2026') && !JSON.stringify(bd.registro).includes('recovery'), 'ni claves ni enlaces en la bitácora');
  console.log('✓ cambiar contraseña');

  // la bitácora
  r = JSON.parse((await post({ accion: 'registro' }, tokAdmin)).texto);
  assert.ok(r.registros.some((x) => x.accion === 'alta_cliente') && r.registros.some((x) => x.accion === 'clave'));
  console.log('✓ bitácora'); srv.close();
})().catch((e) => { console.error('✗', e); process.exit(1); });
