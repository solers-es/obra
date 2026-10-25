// Prueba de la sincronización con DOS móviles de oficina y UN operario contra tests/mock-supabase.js
// (Postgres local real con RLS). Antes:  sh supabase/tests/run.sh  y  node tests/mock-supabase.js 54330
const { chromium } = require('playwright');
const path = require('path'), assert = require('assert');
const url = 'file://' + path.resolve(__dirname, '..', 'index.html');
const CFG = { supabaseUrl: 'http://localhost:54330', supabaseAnonKey: 'anon-test' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function movil(b, nombre) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); p.errs = [];
  p.on('pageerror', e => p.errs.push(nombre + ': ' + e.message)); p.on('dialog', d => d.accept());
  await p.addInitScript(c => { window.BRIGADA_CONFIG = c; }, CFG);
  await p.goto(url); await p.waitForTimeout(400);
  return p;
}
async function cuenta(p, accion, mail) {
  await p.evaluate(() => { cerrarModal(); abrirCuenta(); });
  await p.fill('#ac-mail', mail); await p.fill('#ac-pass', 'secreto1'); if (accion === 'reg') await p.check('#ac-ok');
  await p.click(accion === 'reg' ? 'button:has-text("Crear cuenta")' : 'button:has-text("Entrar")');
  await p.waitForFunction(() => !/Un momento/.test((document.getElementById('ac-msg') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(600);
}
const sync = p => p.evaluate(() => Sync.sincronizar());

(async () => {
  const b = await chromium.launch();
  const A = await movil(b, 'A');
  // --- Empresa nueva en el movil A
  await A.fill('#em-n', 'Reformas Sync SL'); await A.fill('#em-nif', '00000001R'); await A.fill('#em-dir', 'C/ Sol 1, Palma');
  await A.check('#em-ok'); await A.click('text=✓ Empezar'); await A.evaluate(() => cerrarModal());
  await cuenta(A, 'reg', 'ana@a.es');
  await A.click('text=Crear empresa y subir mis datos'); await A.waitForTimeout(1500);
  assert.ok(await A.evaluate(() => Sync.activo()), 'A debe quedar conectado a su empresa');
  // --- A hace un presupuesto y lo contrata (obra) + un cliente con NIF
  await A.evaluate(() => { irTab('presupuestos'); abrirNuevoPresupuesto(); });
  await A.fill('#pr-nom', 'Cocina Sync'); await A.selectOption('#pr-cli', '__nuevo'); await A.fill('#pr-cnuevo', 'Luis Cliente');
  await A.evaluate(() => crearPresupuesto()); await A.evaluate(() => { addBanco(BANCO[0].codigo); addBanco(BANCO[1].codigo); cerrarModal(); contratarPresu(); });
  await sync(A);
  const obraId = await A.evaluate(() => db.obras[0].id);
  console.log('OK A: empresa creada, presupuesto -> obra subidos');

  // --- Otro movil de la oficina (B): entra con la misma cuenta y ve lo mismo
  const B = await movil(b, 'B'); await B.evaluate(() => cerrarModal());
  await cuenta(B, 'in', 'ana@a.es');
  if (process.env.DEBUG) console.log(await B.evaluate(() => JSON.stringify(Sync.estado()) + ' ' + (document.getElementById('ac-msg')||{}).textContent));
  const vistoB = await B.evaluate(() => ({ obras: db.obras.map(o => o.nombre), pres: db.presupuestos.length, empresa: db.empresa && db.empresa.nombre, caps: db.obras[0] && db.obras[0].capitulos.length }));
  assert.deepStrictEqual(vistoB.obras, ['Cocina Sync']); assert.strictEqual(vistoB.pres, 1); assert.strictEqual(vistoB.empresa, 'Reformas Sync SL'); assert.ok(vistoB.caps >= 1);
  console.log('OK B: ve la obra, el presupuesto y la empresa de A');

  // --- Cambio en B llega a A (y gana el ultimo en editar)
  await B.evaluate(() => { db.obras[0].nombre = 'Cocina Sync (editada en B)'; guardar(); }); await sync(B); await sleep(300);
  await sync(A);
  assert.strictEqual(await A.evaluate(() => db.obras[0].nombre), 'Cocina Sync (editada en B)');
  console.log('OK: cambio hecho en B llega a A');

  // --- Operario: se registra, A lo invita, entra y solo ve partes/obras (sin precios)
  const O = await movil(b, 'O'); await O.evaluate(() => cerrarModal());
  await cuenta(O, 'reg', 'pepe@a.es');
  assert.ok(!(await O.evaluate(() => Sync.activo())), 'sin invitacion no pertenece a ninguna empresa');
  await A.evaluate(() => { cerrarModal(); abrirCuenta(); });
  await A.click('text=Invitar a alguien'); await A.fill('#iv-mail', 'pepe@a.es'); await A.selectOption('#iv-rol', 'operario'); await A.click('button:has-text("Invitar")');
  await A.waitForTimeout(800);
  await O.click('text=Ya me han invitado'); await O.waitForTimeout(1500);
  const verO = await O.evaluate(() => ({ activo: Sync.activo(), rol: Sync.estado().rol, obras: db.obras.map(o => [o.nombre, o.capitulos.length, o.facturas.length, !!o._lite]), pres: db.presupuestos.length, clientes: db.clientes.length }));
  if (process.env.DEBUG) console.log('O', JSON.stringify(verO), await O.evaluate(() => JSON.stringify(Sync.estado())));
  assert.ok(verO.activo); assert.strictEqual(verO.rol, 'operario');
  assert.deepStrictEqual(verO.obras, [['Cocina Sync (editada en B)', 0, 0, true]], 'el operario solo ve el nombre de la obra');
  assert.strictEqual(verO.pres, 0); assert.strictEqual(verO.clientes, 0);
  console.log('OK operario: entra con rol real y NO recibe presupuestos, precios, clientes ni facturas');

  // --- El operario pone un parte; A lo recibe y se imputa a la obra
  await O.evaluate(() => { cerrarModal(); abrirNuevoParte(); });
  await O.fill('#pa-d', 'Tabique'); await O.click('.hrapida[data-h="6"]'); await O.evaluate(() => guardarParte());
  await sync(O); await sleep(300); await sync(A);
  const parteA = await A.evaluate(() => ({ partes: db.partes.map(p => [p.operario, p.horas]), mo: db.obras[0].costesManoObra.map(m => [m.operario, m.horas]) }));
  assert.deepStrictEqual(parteA.partes, [['pepe', 6]]); assert.deepStrictEqual(parteA.mo, [['pepe (parte)', 6]]);
  console.log('OK: parte del operario -> llega a la oficina e imputa 6 h a la obra');

  // --- Operario NO puede escribir fuera de partes (intento directo contra el servidor)
  const intento = await O.evaluate(async () => { const s = JSON.parse(localStorage.getItem('brigada_sync')); const r = await fetch(BRIGADA_CONFIG.supabaseUrl + '/rest/v1/rpc/subir_docs', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: 'x', Authorization: 'Bearer ' + s.ses.access }, body: JSON.stringify({ p_tenant: s.tenant, p_docs: [{ coleccion: 'obras', doc_id: 'x', datos: { nombre: 'HACK' }, mod_ms: Date.now() + 1e9 }] }) }); return r.status; });
  assert.strictEqual(intento, 400, 'el servidor debe rechazar al operario'); console.log('OK: el servidor rechaza escribir obras a un operario');

  // --- Facturas: numeracion del servidor, sin repetir entre moviles
  async function facturar(p, id, nif) {
    await p.evaluate(i => { cerrarModal(); abrirObra(i); }, id); await p.click('.obratabs button[data-sub=o-cer]'); await p.click('text=Todo al 100 %');
    await p.click('text=Certificar y facturar');
    if (await p.locator('#df-nif').isVisible()) { await p.fill('#df-nif', nif); await p.click('text=Guardar y facturar'); }
    await p.waitForTimeout(1500); await p.evaluate(() => cerrarModal());
  }
  await facturar(A, obraId, '12345678Z');
  const numA = await A.evaluate(() => db.obras[0].facturas.map(f => f.numeroCompleto));
  assert.strictEqual(numA.length, 1);
  await sync(A); await sleep(300); await sync(B);
  // B crea otra obra y factura: el servidor da el numero siguiente
  const obra2 = await B.evaluate(() => { irTab('presupuestos'); abrirNuevoPresupuesto(); return 1; });
  await B.fill('#pr-nom', 'Segunda obra'); await B.evaluate(() => crearPresupuesto());
  const id2 = await B.evaluate(() => { addBanco(BANCO[0].codigo); cerrarModal(); contratarPresu(); return obraActual; });
  await facturar(B, id2, '12345678Z');
  const numB = await B.evaluate(id => obraPorId(id).facturas.map(f => f.numeroCompleto), id2);
  assert.strictEqual(numB.length, 1); assert.notStrictEqual(numA[0], numB[0], 'los numeros no se pueden repetir entre moviles');
  const n = x => +x.split('/')[1]; assert.strictEqual(n(numB[0]), n(numA[0]) + 1, 'B debe seguir la numeracion de A');
  console.log('OK numeracion sin repetir entre moviles:', numA[0], '->', numB[0]);

  // --- Sin conexion: los cambios se encolan y suben al volver
  await A.context().setOffline(true);
  await A.evaluate(() => { db.clientes.push({ id: 'cli_off', razon: 'Cliente offline', comercial: 'Cliente offline', activo: true }); guardar(); });
  assert.ok((await A.evaluate(() => Sync.estado().pendientes)) > 0);
  await A.context().setOffline(false); await sync(A); await sleep(300); await sync(B);
  assert.ok(await B.evaluate(() => db.clientes.some(c => c.id === 'cli_off')), 'el cambio hecho sin conexion debe llegar');
  console.log('OK: lo hecho sin conexion se envia al volver la red');

  const errs = [...A.errs, ...B.errs, ...O.errs]; assert.deepStrictEqual(errs, [], 'errores JS: ' + errs.join(' | '));
  await b.close(); console.log('SYNC OK');
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
