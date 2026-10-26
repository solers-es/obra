// Superadmin de Solers de extremo a extremo: puerta /solers -> panel -> alta de cliente -> entrar dentro ->
// contraseña, con navegador real y Postgres local real (RLS de verdad).
// Antes:  sh supabase/tests/run.sh  y  node tests/mock-supabase.js 54330     (o:  sh tests/run-solers.sh)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { emitirLlave } = require('../api/_lib/llave-solers');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RAIZ = path.resolve(__dirname, '..'), SECRETO = 'secreto-e2e';
const MOCK = 'http://localhost:54330';
Object.assign(process.env, { SUPABASE_URL: MOCK, SUPABASE_ANON_KEY: 'anon-test', SUPABASE_SERVICE_ROLE_KEY: 'service-test', SOLERS_LLAVE_SECRETO: SECRETO });
const puerta = require('../api/solers'), panel = require('../api/superadmin');
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

// Servidor local = Vercel en pequeño: ficheros estáticos + rewrite /solers -> api/solers + api/superadmin
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/solers') return puerta(req, res);
  if (u.pathname === '/api/superadmin') return panel(req, res);
  const f = path.join(RAIZ, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('content-type', TIPOS[path.extname(f)] || 'text/plain'); res.end(fs.readFileSync(f));
});

async function movil(b, nombre, base) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p = await ctx.newPage(); p.errs = [];
  p.on('pageerror', e => p.errs.push(nombre + ': ' + e.message)); p.on('dialog', d => d.accept());
  await p.addInitScript(c => { window.BRIGADA_CONFIG = c; }, { supabaseUrl: MOCK, supabaseAnonKey: 'anon-test' });
  return p;
}
async function entrarCuenta(p, mail, pass) {
  await p.evaluate(() => { cerrarModal(); abrirCuenta(); });
  await p.fill('#ac-mail', mail); await p.fill('#ac-pass', pass); await p.click('button:has-text("Entrar")');
  await p.waitForFunction(() => !/Un momento/.test((document.getElementById('ac-msg') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(700);
}

(async () => {
  await new Promise(r => srv.listen(0, r)); const base = 'http://localhost:' + srv.address().port;
  const b = await chromium.launch();
  const llave = emitirLlave('alex', SECRETO);

  // --- 0. Una llave mala no abre nada
  assert.strictEqual((await fetch(base + '/solers?llave=solers1.alex.1790000000.mala')).status, 403);
  assert.strictEqual((await fetch(base + '/solers')).status, 403);

  // --- 1. La puerta: sin teclear nada, entra como admin@solers.es y cae en el panel
  const S = await movil(b, 'S', base);
  await S.goto(base + '/solers?llave=' + llave);
  await S.waitForFunction(() => window.Sync && Sync.estado().solers && document.getElementById('p-solers').classList.contains('activa'), null, { timeout: 10000 });
  let est = await S.evaluate(() => Sync.estado());
  assert.strictEqual(est.email, 'admin@solers.es'); assert.ok(!est.tenant, 'la cuenta maestra no pertenece a ningún cliente');
  assert.strictEqual(await S.evaluate(() => document.getElementById('a-solers').style.display), '', 'el menú del panel aparece para el superadmin');
  assert.ok(!(await S.evaluate(() => /Mi empresa|Empezar/.test((document.getElementById('modal-cont') || {}).textContent || '') && document.getElementById('modal').classList.contains('on'))), 'no le sale el alta de empresa');
  await S.waitForFunction(() => /Todavía no hay|cliente/.test(document.getElementById('sol-estado').textContent), null, { timeout: 8000 });
  console.log('OK puerta /solers: entra oculto como admin@solers.es y abre el panel');

  // --- 2. Alta de cliente desde el panel
  await S.evaluate(() => abrirAltaCliente());
  await S.fill('#al-r', 'Reformas Vega SL'); await S.fill('#al-n', 'B12345674'); await S.fill('#al-e', 'jefe@vega.es'); await S.fill('#al-nom', 'Marta');
  await S.click('#al-ok'); await S.waitForSelector('text=Cliente creado', { timeout: 8000 }).catch(async e => { console.log('MSG', await S.textContent('#al-msg')); throw e; });
  const clave1 = (await S.textContent('#modal-cont .lin .d')).trim(); assert.ok(clave1.length >= 12, 'se enseña la contraseña generada');
  await S.click('text=Hecho'); await S.waitForFunction(() => /Reformas Vega SL/.test(document.getElementById('sol-lista').textContent), null, { timeout: 8000 });
  // mismo NIF otra vez: no se duplica
  await S.evaluate(() => abrirAltaCliente()); await S.fill('#al-r', 'Otra'); await S.fill('#al-n', 'B12345674'); await S.fill('#al-e', 'otro@vega.es'); await S.click('#al-ok');
  await S.waitForFunction(() => /Ya existe/.test(document.getElementById('al-msg').textContent)); await S.evaluate(() => cerrarModal());
  console.log('OK alta de cliente (constructora + administrador) y sin duplicar');

  // --- 3. El cliente entra con lo que le han dado y trabaja
  const C = await movil(b, 'C', base); await C.goto(base); await C.waitForTimeout(500);
  await C.fill('#em-n', 'Reformas Vega SL'); await C.fill('#em-nif', 'B12345674'); await C.check('#em-ok'); await C.click('text=✓ Empezar'); await C.evaluate(() => cerrarModal());
  await entrarCuenta(C, 'jefe@vega.es', clave1);
  assert.ok(await C.evaluate(() => Sync.activo()), 'el cliente entra con la contraseña dada y cae en su empresa');
  assert.strictEqual(await C.evaluate(() => Sync.estado().solers), false, 'un cliente nunca es superadmin');
  await C.evaluate(() => { irTab('presupuestos'); abrirNuevoPresupuesto(); }); await C.fill('#pr-nom', 'Cocina Vega'); await C.fill('#pr-cli', 'Luis');
  await C.evaluate(() => crearPresupuesto()); await C.evaluate(() => { addBanco(BANCO[0].codigo); cerrarModal(); contratarPresu(); });
  await C.evaluate(() => Sync.sincronizar()); await sleep(300);
  // el equipo del cliente NO incluye al superadmin
  const equipo = await C.evaluate(() => Sync.equipo()); assert.deepStrictEqual(equipo.map(e => e.email), ['jefe@vega.es']);
  // un cliente no puede usar la API ni el panel
  const intento = await C.evaluate(() => Sync.solersApi({ accion: 'registro' }).then(() => 'ABIERTO', e => e.message)); assert.notStrictEqual(intento, 'ABIERTO');
  const lista = await C.evaluate(() => Sync.solersClientes().then(() => 'ABIERTO', e => e.message)); assert.notStrictEqual(lista, 'ABIERTO');
  console.log('OK el cliente trabaja; el superadmin no sale en su equipo; la API le dice que no');

  // --- 4. Ver lista de clientes y sus datos
  await S.evaluate(() => pintarSolers());
  await S.waitForFunction(() => /1 obras/.test(document.getElementById('sol-lista').textContent), null, { timeout: 8000 });
  const ficha = await S.textContent('#sol-lista');
  assert.ok(/Reformas Vega SL/.test(ficha) && /B12345674/.test(ficha) && /jefe@vega\.es/.test(ficha) && /1 usuario/.test(ficha) && /En prueba/.test(ficha), ficha);
  console.log('OK lista de clientes con sus datos (admin, usuarios, obras, estado)');

  // --- 5. Entrar dentro del cliente (impersonar)
  const tid = await S.evaluate(() => _solCli[0].tenant_id);
  await Promise.all([S.waitForNavigation(), S.evaluate(t => solersEntrarEn(t), tid)]);
  await S.waitForFunction(() => window.Sync && Sync.estado().imp && db.obras.length === 1, null, { timeout: 10000 });
  assert.strictEqual(await S.evaluate(() => db.obras[0].nombre), 'Cocina Vega', 've los datos del cliente');
  assert.ok(await S.isVisible('#solers-aviso'), 'aviso de que está dentro del cliente');
  assert.ok(await S.evaluate(() => !localStorage.getItem('brigada_proto_v6')), 'no mezcla con la copia local del propio dispositivo');
  await S.evaluate(() => { db.obras[0].nombre = 'Cocina Vega (retocada por Solers)'; guardar(); }); await S.evaluate(() => Sync.sincronizar()); await sleep(300);
  await C.evaluate(() => Sync.sincronizar()); await sleep(300);
  assert.strictEqual(await C.evaluate(() => db.obras[0].nombre), 'Cocina Vega (retocada por Solers)', 'lo que cambia Solers llega al cliente');
  assert.strictEqual((await C.evaluate(() => Sync.equipo())).length, 1, 'el cliente sigue sin ver al superadmin');
  console.log('OK entrar dentro: ve y edita los datos del cliente, y le llegan');

  // --- 6. Volver al panel: se limpian los datos del cliente del dispositivo
  await Promise.all([S.waitForNavigation(), S.evaluate(() => solersSalir())]);
  await S.waitForFunction(() => window.Sync && !Sync.estado().imp && document.getElementById('p-solers').classList.contains('activa'), null, { timeout: 10000 });
  assert.ok(await S.evaluate(() => !Object.keys(localStorage).some(k => k.indexOf('brigada_solers_imp_') === 0)), 'no quedan datos del cliente en el dispositivo');
  assert.ok(!(await S.isVisible('#solers-aviso')));
  console.log('OK volver al panel sin dejar datos del cliente');

  // --- 7. Cambiar la contraseña de cualquiera
  await S.evaluate(() => abrirClaveSolers('jefe@vega.es')); await S.fill('#ck-c', 'ClaveNueva2026'); await S.click('#ck-ok');
  await S.waitForSelector('text=Contraseña nueva', { timeout: 8000 });
  const D = await movil(b, 'D', base); await D.goto(base); await D.waitForTimeout(400); await D.evaluate(() => cerrarModal());
  await entrarCuenta(D, 'jefe@vega.es', clave1); assert.ok(!(await D.evaluate(() => Sync.activo())), 'la contraseña vieja ya no vale');
  await entrarCuenta(D, 'jefe@vega.es', 'ClaveNueva2026'); assert.ok(await D.evaluate(() => Sync.activo()), 'la nueva sí');
  console.log('OK cambio de contraseña');

  // --- 8. Bitácora
  const reg = await S.evaluate(() => Sync.solersApi({ accion: 'registro' }));
  const acciones = reg.registros.map(r => r.accion);
  for (const a of ['puerta', 'alta_cliente', 'entrar', 'clave']) assert.ok(acciones.includes(a), 'falta en la bitácora: ' + a + ' -> ' + acciones);
  assert.ok(!JSON.stringify(reg).includes('ClaveNueva2026') && !JSON.stringify(reg).includes(clave1), 'la bitácora no guarda contraseñas');
  console.log('OK bitácora:', acciones.reverse().join(' > '));

  const errs = [S, C, D].flatMap(p => p.errs); assert.deepStrictEqual(errs, [], 'errores de JS: ' + errs.join(' | '));
  await b.close(); srv.close(); console.log('\nTODO BIEN · superadmin de Solers');
})().catch(e => { console.error('✗', e); process.exit(1); });
