// La app (index.html) contra el Supabase REAL: entrar, presupuesto -> obra, factura con número del servidor,
// y un segundo móvil que ve lo mismo.  node tests/real/app-real.js   (necesita .env.local y el usuario TEST_*_A)
const { chromium } = require('playwright'); const path = require('path'), assert = require('assert');
const { E, api, login } = require('./lib');
const url = 'file://' + path.resolve(__dirname, '..', '..', 'index.html');
const CFG = { supabaseUrl: E.SUPABASE_URL, supabaseAnonKey: E.SUPABASE_ANON_KEY };
async function movil(b, n) { const c = await b.newContext({ viewport: { width: 390, height: 844 } }); const p = await c.newPage(); p.errs = [];
  p.on('pageerror', e => p.errs.push(n + ': ' + e.message)); p.on('dialog', d => d.accept()); await p.addInitScript(c => { window.BRIGADA_CONFIG = c; }, CFG); await p.goto(url); await p.waitForTimeout(500); return p; }
async function entrar(p) { await p.evaluate(() => { cerrarModal(); abrirCuenta(); }); await p.fill('#ac-mail', E.TEST_EMAIL_A); await p.fill('#ac-pass', E.TEST_PASS_A); await p.click('button:has-text("Entrar")');
  await p.waitForFunction(() => Sync.activo(), null, { timeout: 15000 }); await p.waitForTimeout(1500); }
(async () => {
  const b = await chromium.launch(); const A = await movil(b, 'A');
  await A.fill('#em-n', 'Empresa de prueba Brigada'); await A.fill('#em-nif', '00000001R'); await A.check('#em-ok'); await A.click('text=✓ Empezar');
  await entrar(A); console.log('OK la app entra con una cuenta real y se conecta a su empresa:', await A.evaluate(() => Sync.estado().empresa + ' · ' + Sync.estado().rol));
  const nombre = 'Obra real ' + Date.now();
  await A.evaluate(() => { cerrarModal(); irTab('presupuestos'); abrirNuevoPresupuesto(); }); await A.fill('#pr-nom', nombre); await A.fill('#pr-cli', 'Cliente real');
  await A.evaluate(() => { crearPresupuesto(); addBanco(BANCO[0].codigo); addBanco(BANCO[1].codigo); cerrarModal(); contratarPresu(); });
  const obraId = await A.evaluate(() => obraActual);
  await A.click('.obratabs button[data-sub=o-cer]'); await A.click('text=Todo al 100 %'); await A.click('text=Certificar y facturar');
  if (await A.locator('#df-nif').isVisible()) { await A.fill('#df-nif', '12345678Z'); await A.fill('#df-dir', 'C/ Real 1'); await A.click('text=Guardar y facturar'); }
  await A.waitForTimeout(2500); await A.evaluate(() => cerrarModal());
  const fact = await A.evaluate(id => obraPorId(id).facturas.map(f => f.numeroCompleto), obraId); assert.strictEqual(fact.length, 1, 'debe haber factura'); console.log('OK factura con número del servidor:', fact[0]);
  await A.evaluate(() => Sync.sincronizar()); await A.waitForTimeout(1000);
  const ses = await login(E.TEST_EMAIL_A, E.TEST_PASS_A); const mem = await api('/rest/v1/membresias?select=tenant_id&estado=eq.activa', { token: ses.access_token });
  const docs = await api(`/rest/v1/brigada_docs?select=coleccion,datos&tenant_id=eq.${mem.json[0].tenant_id}&borrado=eq.false&coleccion=eq.obras`, { token: ses.access_token });
  assert.ok(docs.json.some(d => d.datos.nombre === nombre), 'la obra debe estar en el servidor'); console.log('OK la obra está guardada en el servidor real');
  const B = await movil(b, 'B'); await entrar(B);
  const visto = await B.evaluate(n => db.obras.some(o => o.nombre === n && o.facturas.length === 1 && o.capitulos.length >= 1), nombre); assert.ok(visto, 'el segundo móvil debe ver la obra con su factura'); console.log('OK un segundo móvil entra con la misma cuenta y ve la obra y su factura');
  // limpieza: se borran de la app los datos de la prueba (se sincronizan como borrados)
  await A.evaluate(() => { db.obras = []; db.presupuestos = []; db.clientes = []; guardar(); }); await A.evaluate(() => Sync.sincronizar()); await A.waitForTimeout(1500);
  const errs = [...A.errs, ...B.errs]; assert.deepStrictEqual(errs, [], errs.join(' | ')); await b.close(); console.log('APP REAL OK');
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
