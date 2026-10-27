// Ayudas para probar contra el Supabase REAL con la clave anónima (nunca la service_role).
// Los usuarios se crean por el camino normal: registro + correo de confirmación (buzón público de Mailinator).
// OJO: el proyecto usa el correo por defecto de Supabase, que solo permite 2 correos por hora.
const fs = require('fs'), path = require('path');
function env() {
  const e = Object.assign({}, process.env), f = path.resolve(__dirname, '..', '..', '.env.local');
  if (fs.existsSync(f)) fs.readFileSync(f, 'utf8').split('\n').forEach(l => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !e[m[1]]) e[m[1]] = m[2].trim(); });
  if (!e.SUPABASE_URL || !e.SUPABASE_ANON_KEY) throw new Error('Faltan SUPABASE_URL / SUPABASE_ANON_KEY (.env.local)');
  if (JSON.parse(Buffer.from(e.SUPABASE_ANON_KEY.split('.')[1], 'base64').toString()).role !== 'anon') throw new Error('La clave no es la anónima');
  return e;
}
const E = env(), sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(ruta, { method = 'GET', body, token } = {}) {
  const r = await fetch(E.SUPABASE_URL + ruta, { method, redirect: 'manual', headers: { apikey: E.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || E.SUPABASE_ANON_KEY) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
  return { status: r.status, json: j, headers: r.headers };
}
const login = async (email, password) => { const r = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }); return r.json && r.json.access_token ? r.json : null; };
async function crearUsuario(etiqueta) {
  const ts = Date.now(), email = `brigada-prueba-${ts}-${etiqueta}@mailinator.com`, password = `Prueba-${ts}-Aa1`;
  const s = await api('/auth/v1/signup', { method: 'POST', body: { email, password } });
  if (s.status >= 400) throw new Error('registro: ' + JSON.stringify(s.json));
  const box = email.split('@')[0]; let link = null;
  for (let i = 0; i < 20 && !link; i++) {
    await sleep(2500);
    const l = await (await fetch('https://www.mailinator.com/api/v2/domains/public/inboxes/' + box)).json();
    if (l.msgs && l.msgs.length) { const m = await (await fetch('https://www.mailinator.com/api/v2/domains/public/inboxes/' + box + '/messages/' + l.msgs[0].id)).json();
      const mm = JSON.stringify(m).match(/https:[^"\\\s<]*\/auth\/v1\/verify\?[^"\\\s<]*/); if (mm) link = mm[0].replace(/&amp;/g, '&'); }
  }
  if (!link) throw new Error('No llegó el correo de confirmación');
  await fetch(link, { redirect: 'manual' });                      // el clic del usuario en el enlace
  const ses = await login(email, password); if (!ses) throw new Error('No se pudo entrar tras confirmar');
  return { email, password, uid: ses.user.id, token: ses.access_token };
}
module.exports = { E, api, login, crearUsuario, sleep };
