// Retención de garantía y cobros parciales (modo local).  node tests/cobros.js
const { chromium } = require('playwright'); const path = require('path'), assert = require('assert');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } }); const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto('file://' + path.resolve(__dirname, '..', 'index.html')); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(300);
  await p.fill('#em-n', 'Retenciones SL'); await p.fill('#em-ret', '5'); await p.check('#em-ok'); await p.click('text=✓ Empezar'); await p.evaluate(() => cerrarModal());
  // presupuesto de 1000 € (partida propia) -> obra con retención del 5 % heredada de la empresa
  await p.evaluate(() => { irTab('presupuestos'); abrirNuevoPresupuesto(); }); await p.fill('#pr-nom', 'Obra ret'); await p.fill('#pr-cli', 'Cli');
  await p.evaluate(() => { crearPresupuesto(); cerrarModal(); abrirPartidaPropia(); }); await p.fill('#pp-d', 'Trabajo'); await p.fill('#pp-c', '1'); await p.fill('#pp-p', '1000'); await p.click('text=✓ Añadir');
  await p.click('text=Lo han aceptado');
  assert.strictEqual(await p.evaluate(() => obraPorId(obraActual).retPct), 5, 'la obra hereda la retención de la empresa');
  await p.click('text=Avance'); await p.click('text=Todo al 100 %'); await p.click('text=Certificar y facturar');
  if (await p.locator('#df-nif').isVisible()) { await p.click('text=Facturar sin NIF'); }
  await p.waitForTimeout(300); await p.evaluate(() => cerrarModal());
  const f = () => p.evaluate(() => { const x = obraPorId(obraActual).facturas[0]; return { total: x.total, ret: x.retencion, aCobrar: x.aCobrar, pend: pendienteDe(x), cobr: cobradoDe(x), retPend: retPendienteDe(x), estado: x.estado }; });
  let r = await f(); assert.deepStrictEqual([r.total, r.ret, r.aCobrar, r.pend], [1210, 50, 1160, 1160], JSON.stringify(r));
  // cobro parcial de 500 -> falta 660
  await p.click('text=Cobros'); await p.click('text=Ya me han pagado'); await p.fill('#cb-imp', '500'); await p.click('text=✓ Apuntar cobro');
  r = await f(); assert.deepStrictEqual([r.cobr, r.pend, r.estado], [500, 660, 'parcial']);
  // no se puede cobrar más de lo que falta
  await p.click('text=Ya me han pagado'); await p.fill('#cb-imp', '9999'); await p.click('text=✓ Apuntar cobro');
  r = await f(); assert.strictEqual(r.pend, 660, 'no debe aceptar más de lo que falta'); await p.evaluate(() => cerrarModal());
  // resto -> cobrada, la retención sigue pendiente
  await p.click('text=Ya me han pagado'); await p.click('text=✓ Apuntar cobro');
  r = await f(); assert.deepStrictEqual([r.pend, r.estado, r.retPend], [0, 'cobrada', 50]);
  // liberar retención
  await p.click('text=Cobrar retención'); await p.click('text=✓ Apuntar cobro');
  r = await f(); assert.strictEqual(r.retPend, 0);
  assert.deepStrictEqual(errs, []); await b.close(); console.log('OK cobros parciales y retención');
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
