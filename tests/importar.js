// Importar clientes y partidas desde Excel/CSV (modo local).  node tests/importar.js
const { chromium } = require('playwright'); const path = require('path'), assert = require('assert');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 } }); const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto('file://' + path.resolve(__dirname, '..', 'index.html')); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(300);
  await p.click('text=Ver con datos de ejemplo');
  // Clientes pegados desde Excel (separados por tabuladores) con acentos, comillas y un duplicado por NIF
  const nClientes = await p.evaluate(() => db.clientes.length);
  await p.evaluate(() => { irTab('clientes'); abrirMigracion(); });
  await p.fill('#im-txt', 'Nombre\tNIF\tTeléfono\tCorreo\tDirección\nAna López\t12345678Z\t600111222\tana@x.es\t"C/ Sol, 3"\nBeto SL\tB12345674\t\t\t\nRepe\t12345678Z\t\t\t\n');
  assert.ok((await p.textContent('#im-vista')).includes('3 clientes'));
  await p.click('text=✓ Importar');
  assert.strictEqual(await p.evaluate(() => db.clientes.length), nClientes + 2, 'el duplicado por NIF no se importa');
  assert.strictEqual(await p.evaluate(() => db.clientes.find(c => c.nif === '12345678Z' && c.razon === 'Ana López').dir), 'C/ Sol, 3');
  // Partidas con coma decimal y miles, desde un presupuesto nuevo
  await p.evaluate(() => { irTab('presupuestos'); abrirNuevoPresupuesto(); }); await p.fill('#pr-nom', 'Desde Excel'); await p.fill('#pr-cli', 'Ana López'); await p.evaluate(() => { crearPresupuesto(); cerrarModal(); });
  await p.click("button:visible:has-text('De Excel')");
  await p.fill('#im-txt', 'Capítulo;Descripción;Unidad;Cantidad;Precio\nDemolición;Picado de alicatado;m2;12;8,50\nAlbañilería;Tabique;m2;9;1.032,40\n;Sin capítulo;ud;2;10\n');
  await p.click('text=✓ Importar');
  const t = await p.evaluate(() => { const pr = presuPorId(presuActual); return { caps: pr.capitulos.map(c => c.nombre), venta: presuTotales(pr).venta }; });
  assert.deepStrictEqual(t.caps, ['Demolición', 'Albañilería', 'Trabajos']); assert.strictEqual(t.venta, 12 * 8.5 + 9 * 1032.4 + 20);
  // y se convierte en obra con esos importes
  await p.click('text=Lo han aceptado'); assert.strictEqual(await p.evaluate(() => presupuestoObra(obraPorId(obraActual))), t.venta);
  // BC3 real (windows-1252): capítulos, cantidades de la descomposición y precio calculado si la partida no lo trae
  await p.evaluate(() => { irTab('presupuestos'); abrirNuevoPresupuesto(); }); await p.fill('#pr-nom', 'Desde BC3'); await p.fill('#pr-cli', 'Ana López'); await p.evaluate(() => { crearPresupuesto(); cerrarModal(); });
  await p.click("button:visible:has-text('De Excel')");
  await p.setInputFiles('#im-bc3', path.resolve(__dirname, 'ejemplo.bc3'));
  await p.waitForFunction(() => document.getElementById('im-txt').value.length > 20);
  assert.ok((await p.textContent('#im-vista')).includes('4 partidas'), await p.textContent('#im-vista'));
  await p.click('text=✓ Importar');
  const bc = await p.evaluate(() => presuPorId(presuActual).capitulos.map(c => [c.nombre, c.partidas.map(q => [q.descripcion, q.ud, q.cantidad, q.venta])]));
  assert.deepStrictEqual(bc, [['Demolición', [['Picado de alicatado y solado', 'm2', 25, 8.5], ['Demolición de tabique', 'm2', 9.5, 12]]], ['Albañilería y revestimientos', [['Tabique ladrillo hueco doble', 'm2', 40, 32.4], ['Colocación de puerta', 'ud', 3, 149.25]]]], JSON.stringify(bc));
  assert.deepStrictEqual(errs, []); await b.close(); console.log('OK importar clientes, partidas y BC3');
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
