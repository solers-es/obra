// Prueba del flujo principal de Brigada en un movil (390x844), solo con clics:
// presupuesto -> obra -> avance -> factura -> cobro -> parte de trabajo.
// Uso: npm i playwright (una vez) y  node tests/flujo.js
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  const url = 'file://' + path.resolve(__dirname, '..', 'index.html');

  for (const vacio of [false, true]) {
    await p.goto(url); await p.waitForTimeout(400);
    if (vacio) { await p.evaluate(() => empezarVacio()); await p.reload(); await p.waitForTimeout(400); }
    await p.click('text=Hacer un presupuesto');
    await p.fill('#pr-nom', 'Reforma cocina Ana');
    await p.selectOption('#pr-cli', '__nuevo'); await p.fill('#pr-cnuevo', 'Ana Lopez');
    await p.click('text=Crear y añadir partidas');
    await p.click('#modal-cont .lin >> nth=0 >> text=＋');
    await p.click('#modal-cont .lin >> nth=1 >> text=＋');
    await p.click('text=✓ Listo');
    await p.click("button:visible:has-text('Mi propia partida')");
    await p.fill('#pp-d', 'Alicatado'); await p.fill('#pp-c', '12'); await p.fill('#pp-p', '35.5');
    await p.click('text=✓ Añadir');
    await p.click('text=Lo han aceptado');
    const o = await p.evaluate(() => { const o = db.obras[db.obras.length - 1]; return { partidas: o.capitulos.reduce((n, c) => n + c.partidas.length, 0), total: presupuestoObra(o) }; });
    assert.strictEqual(o.partidas, 3, 'la obra debe nacer con las 3 partidas');
    await p.click('text=Avance'); await p.click('text=Todo al 100 %');
    await p.click('text=Certificar y facturar');
    await p.evaluate(() => cerrarModal());
    await p.click('text=Cobros'); await p.click('text=Ya me han pagado');
    assert.deepStrictEqual(await p.evaluate(() => db.obras[db.obras.length - 1].facturas.map(f => f.estado)), ['cobrada']);
    await p.click("button:visible:has-text('Parte de hoy')");
    if (vacio) await p.fill('#pa-opn', 'Pepe');
    await p.fill('#pa-d', 'Cocina'); await p.click('text=Guardar parte');
    assert.ok((await p.evaluate(() => db.partes.length)) >= 1, 'debe haber un parte');
    console.log(vacio ? 'OK base vacia' : 'OK datos de ejemplo');
  }
  assert.deepStrictEqual(errs, [], 'errores de JS: ' + errs.join(' | '));
  await b.close();
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
