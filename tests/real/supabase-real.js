// Prueba contra el Supabase REAL (solo clave anónima + usuarios de prueba creados por el registro normal).
//   node tests/real/supabase-real.js
// Necesita .env.local con SUPABASE_URL, SUPABASE_ANON_KEY y TEST_EMAIL_A/TEST_PASS_A (usuario ya confirmado).
// Opcional TEST_EMAIL_B/TEST_PASS_B (otro usuario confirmado) para probar aislamiento entre empresas y rol operario.
const assert = require('assert');
const { E, api, login } = require('./lib');
const rpc = (fn, body, token) => api('/rest/v1/rpc/' + fn, { method: 'POST', body, token });
const rest = (ruta, token, opts = {}) => api('/rest/v1/' + ruta, Object.assign({ token }, opts));
const ok = (m) => console.log('OK', m);
const dniValido = () => { const n = String(10000000 + Math.floor(Math.random() * 89999999)); return n + 'TRWAGMYFPDXBNJZSQVHLCKE'[+n % 23]; };

(async () => {
  // 1) Anónimo: no puede leer ni escribir nada
  const an = await rest('brigada_docs?select=*&limit=1'); assert.ok(an.status === 401 || (an.status === 200 && an.json.length === 0), 'anónimo no debe leer brigada_docs: ' + an.status); ok('anónimo no lee documentos');
  const an2 = await rpc('crear_empresa', { p_nif: dniValido(), p_razon_social: 'Intruso' }); assert.ok(an2.status >= 400, 'anónimo no puede crear empresa'); ok('anónimo no puede crear empresas');
  const an3 = await rest('tenants?select=id&limit=1'); assert.ok(an3.status === 401 || (an3.json || []).length === 0); ok('anónimo no ve empresas');

  // 2) Usuario A
  const A = await login(E.TEST_EMAIL_A, E.TEST_PASS_A); assert.ok(A, 'no se pudo entrar con el usuario de prueba A (¿sigue confirmado?)'); const ta = A.access_token; ok('usuario A entra con su correo confirmado');
  const perfil = await rest('usuarios?select=id,email', ta); assert.strictEqual(perfil.json.length, 1, 'el disparador debe crear el perfil de A'); ok('perfil creado por el disparador al registrarse');
  const bad = await rpc('crear_empresa', { p_nif: 'B1234', p_razon_social: 'Mala SL' }, ta); assert.ok(bad.status >= 400 && /NIF/.test(JSON.stringify(bad.json))); ok('NIF inválido rechazado por el servidor');
  const directo = await rest('tenants', ta, { method: 'POST', body: { nif: dniValido(), razon_social: 'Directa' } }); assert.ok(directo.status >= 400); ok('no se puede insertar una empresa a mano (solo con crear_empresa)');

  let mem = await rest('membresias?select=tenant_id,rol&estado=eq.activa', ta), tenant;
  if (mem.json.length) tenant = mem.json[0].tenant_id; else { const c = await rpc('crear_empresa', { p_nif: dniValido(), p_razon_social: 'Empresa de prueba Brigada', p_direccion: 'C/ Prueba 1' }, ta); assert.strictEqual(c.status, 200, JSON.stringify(c.json)); tenant = c.json; }
  mem = await rest('membresias?select=tenant_id,rol&estado=eq.activa', ta); assert.strictEqual(mem.json[0].rol, 'admin'); ok('A es administrador de su empresa ' + tenant.slice(0, 8));

  // 3) Sincronización por documentos + LWW + borrado
  const id = 'prueba_' + Date.now(), t0 = Date.now();
  let r = await rpc('subir_docs', { p_tenant: tenant, p_docs: [{ coleccion: 'obras', doc_id: id, datos: { nombre: 'Obra real' }, mod_ms: t0 }, { coleccion: 'partes', doc_id: id, datos: { horas: 6 }, mod_ms: t0 }] }, ta); assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  await rpc('subir_docs', { p_tenant: tenant, p_docs: [{ coleccion: 'obras', doc_id: id, datos: { nombre: 'VIEJO' }, mod_ms: t0 - 5000 }] }, ta);
  let l = await rest(`brigada_docs?select=coleccion,doc_id,datos,seq&tenant_id=eq.${tenant}&doc_id=eq.${id}&order=coleccion`, ta); assert.strictEqual(l.json.length, 2); assert.strictEqual(l.json[0].datos.nombre, 'Obra real', 'un cambio viejo no debe pisar al nuevo'); ok('subir/leer documentos y "gana el último"');
  const w = await rest('brigada_docs', ta, { method: 'POST', body: { tenant_id: tenant, coleccion: 'obras', doc_id: 'x', mod_ms: 1 } }); assert.ok(w.status >= 400); ok('escritura directa a brigada_docs denegada (solo por subir_docs)');
  const w2 = await rpc('subir_docs', { p_tenant: '00000000-0000-0000-0000-000000000001', p_docs: [{ coleccion: 'obras', doc_id: 'x', datos: {}, mod_ms: 1 }] }, ta); assert.ok(w2.status >= 400); ok('no se puede escribir en una empresa ajena');

  // 4) Numeración atómica y equipo
  const n1 = await rpc('siguiente_numero', { p_tenant: tenant, p_serie: 'T' + t0, p_desde: 7 }, ta), n2 = await rpc('siguiente_numero', { p_tenant: tenant, p_serie: 'T' + t0, p_desde: 3 }, ta);
  assert.deepStrictEqual([n1.json, n2.json], [8, 9]); ok('numeración de facturas del servidor: 8 -> 9 (no retrocede)');
  const eq = await rpc('equipo_empresa', { p_tenant: tenant }, ta); assert.strictEqual(eq.status, 200); const yo = eq.json.find(u => u.usuario_id === A.user.id); assert.ok(yo);
  const quitarme = await rpc('quitar_usuario', { p_tenant: tenant, p_usuario: A.user.id }, ta); assert.ok(quitarme.status >= 400 && /administrador/.test(JSON.stringify(quitarme.json))); ok('no se puede dejar la empresa sin administrador');

  // 5) Tablas de negocio con RLS (esquema base): clientes
  const cli = await rest('clientes', ta, { method: 'POST', body: { tenant_id: tenant, razon_social: 'Cliente RLS ' + t0, nif: dniValido() } }); 
  console.log('   clientes insert →', cli.status, cli.status >= 400 ? JSON.stringify(cli.json).slice(0, 160) : 'ok');
  const cliAjeno = await rest('clientes', ta, { method: 'POST', body: { tenant_id: '00000000-0000-0000-0000-000000000001', razon_social: 'X' } }); assert.ok(cliAjeno.status >= 400); ok('RLS: no se inserta un cliente en otra empresa');

  // 6) Aislamiento y rol operario (solo si hay usuario B)
  if (E.TEST_EMAIL_B) {
    const B = await login(E.TEST_EMAIL_B, E.TEST_PASS_B); assert.ok(B); const tb = B.access_token;
    assert.strictEqual((await rest(`brigada_docs?select=doc_id&tenant_id=eq.${tenant}`, tb)).json.length, 0); ok('B no ve los documentos de A');
    assert.ok((await rpc('subir_docs', { p_tenant: tenant, p_docs: [{ coleccion: 'obras', doc_id: 'h', datos: {}, mod_ms: 1 }] }, tb)).status >= 400); ok('B no puede escribir en la empresa de A');
    const inv = await rpc('invitar_usuario', { p_tenant: tenant, p_email: E.TEST_EMAIL_B, p_rol: 'operario' }, ta); assert.strictEqual(inv.status, 204 === inv.status ? 204 : 200);
    const vis = await rest(`brigada_docs?select=coleccion&tenant_id=eq.${tenant}`, tb); assert.ok(vis.json.every(d => ['partes', 'obras_lite'].includes(d.coleccion)), 'el operario solo ve partes y obras_lite'); ok('operario real: solo ve partes y la lista de obras');
    assert.ok((await rpc('subir_docs', { p_tenant: tenant, p_docs: [{ coleccion: 'obras', doc_id: 'h', datos: {}, mod_ms: 1 }] }, tb)).status >= 400); ok('operario real: no puede escribir obras');
    await rpc('quitar_usuario', { p_tenant: tenant, p_usuario: B.user.id }, ta); assert.strictEqual((await rest(`brigada_docs?select=doc_id&tenant_id=eq.${tenant}`, tb)).json.length, 0); ok('al quitarle el acceso, B ya no ve nada');
  } else console.log('   (sin TEST_EMAIL_B: pendiente probar aislamiento entre empresas y rol operario con otro usuario real)');

  // limpieza: el cliente de prueba (RLS permite borrar los propios) y los documentos de esta prueba
  const del = await rest(`clientes?tenant_id=eq.${tenant}&razon_social=like.${encodeURIComponent('Cliente RLS *')}`, ta, { method: 'DELETE' }); ok('RLS: se puede borrar un cliente propio (' + del.status + ')');
 se marcan como borrados
  await rpc('subir_docs', { p_tenant: tenant, p_docs: [{ coleccion: 'obras', doc_id: id, datos: {}, mod_ms: Date.now(), borrado: true }, { coleccion: 'partes', doc_id: id, datos: {}, mod_ms: Date.now(), borrado: true }] }, ta);
  console.log('SERVIDOR REAL OK');
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
