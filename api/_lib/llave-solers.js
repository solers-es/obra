// LA LLAVE DE SOLERS · quién puede entrar por /solers como superadmin.
//
// Es la misma llave que usan Brasa (universo-bistro) y GestorOS: la lleva la app
// del Centro de trabajo de cada socio y el resto del mundo no la tiene.
//
// Formato: `solers1.<quien>.<emitida>.<firma>`, donde la firma es HMAC-SHA256 del
// secreto compartido (SOLERS_LLAVE_SECRETO, el mismo en el Centro y en cada
// aplicación) sobre `solers1.<quien>.<emitida>`. No caduca: se anula cambiando el
// secreto, que anula todas a la vez y obliga a repartir llaves nuevas.
//
// Esto es puro (sin red) y se prueba en tests/solers.js. Nunca imprime la llave ni el secreto.
const { createHmac, timingSafeEqual } = require('node:crypto');

const QUIENES = ['alex', 'stalin'];

function firmar(cuerpo, secreto) {
  return createHmac('sha256', secreto).update(cuerpo).digest('base64url');
}

/** Fabrica una llave. Solo la usa scripts/emitir-llave.js, en el ordenador de un socio. */
function emitirLlave(quien, secreto, emitida) {
  const t = emitida || Math.floor(Date.now() / 1000);
  const cuerpo = `solers1.${quien}.${t}`;
  return `${cuerpo}.${firmar(cuerpo, secreto)}`;
}

/** Comprueba una llave. Comparación en tiempo constante. */
function verificarLlave(llave, secreto) {
  if (!secreto) return { ok: false, motivo: 'SINSECRETO' };
  const l = String(llave || '').trim();
  if (!l) return { ok: false, motivo: 'VACIA' };
  const partes = l.split('.');
  if (partes.length !== 4 || partes[0] !== 'solers1') return { ok: false, motivo: 'FORMATO' };
  const [, quien, emitida, firma] = partes;
  if (!QUIENES.includes(quien)) return { ok: false, motivo: 'QUIEN' };
  if (!/^\d{9,11}$/.test(emitida)) return { ok: false, motivo: 'FORMATO' };
  const a = Buffer.from(firma), b = Buffer.from(firmar(`solers1.${quien}.${emitida}`, secreto));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, motivo: 'FIRMA' };
  return { ok: true, quien, emitida: Number(emitida) };
}

module.exports = { QUIENES, emitirLlave, verificarLlave };
