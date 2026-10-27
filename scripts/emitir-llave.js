// Fabrica la llave de /solers (y el enlace completo) en el ordenador de un socio.
// Uso:  SOLERS_LLAVE_SECRETO=… node scripts/emitir-llave.js alex https://TU-DOMINIO-BRIGADA
// Imprime el enlace para el botón del Centro. NO lo pegues en chats ni en el repo: abre la puerta.
const { emitirLlave, QUIENES } = require('../api/_lib/llave-solers');
const quien = process.argv[2], base = (process.argv[3] || '').replace(/\/$/, '');
const secreto = process.env.SOLERS_LLAVE_SECRETO;
if (!secreto || !QUIENES.includes(quien)) { console.error('Uso: SOLERS_LLAVE_SECRETO=… node scripts/emitir-llave.js <' + QUIENES.join('|') + '> https://dominio'); process.exit(1); }
console.log((base || 'https://TU-DOMINIO-BRIGADA') + '/solers?llave=' + emitirLlave(quien, secreto));
