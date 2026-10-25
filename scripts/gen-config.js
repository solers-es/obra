// Genera config.js a partir de variables de entorno (SUPABASE_URL y SUPABASE_ANON_KEY).
// Uso en el build de Vercel:  node scripts/gen-config.js
// Opcional: LEGAL_RAZON, LEGAL_NIF, LEGAL_DIRECCION, LEGAL_EMAIL (datos de quien ofrece Brigada, para los Términos/privacidad).
// La clave anónima es PÚBLICA por diseño (la seguridad la da RLS). Nunca pongas aquí la service_role.
const fs = require('fs'), path = require('path');
// En local lee .env.local (no se versiona); en el hosting las variables vienen del entorno.
const env = Object.assign({}, process.env), fl = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(fl)) fs.readFileSync(fl, 'utf8').split('\n').forEach(l => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !env[m[1]]) env[m[1]] = m[2].trim(); });
const url = (env.SUPABASE_URL || '').trim();
const key = (env.SUPABASE_ANON_KEY || '').trim();
if (!url && !key) { console.log('Sin SUPABASE_URL/SUPABASE_ANON_KEY: la app queda en modo local (config.js vacío).'); process.exit(0); }
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) { console.error('SUPABASE_URL no parece una URL de Supabase (https://xxxx.supabase.co)'); process.exit(1); }
try {
  const role = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString()).role;
  if (role !== 'anon') { console.error('La clave no es la anónima (role=' + role + '). Usa la "anon public", NUNCA la service_role.'); process.exit(1); }
} catch (e) { if (!/^sb_publishable_/.test(key)) { console.error('SUPABASE_ANON_KEY no es válida.'); process.exit(1); } }
fs.writeFileSync(path.join(__dirname, '..', 'config.js'),
  'window.BRIGADA_CONFIG = ' + JSON.stringify({ supabaseUrl: url.replace(/\/$/, ''), supabaseAnonKey: key,
    legal: { razon: env.LEGAL_RAZON || '', nif: env.LEGAL_NIF || '', direccion: env.LEGAL_DIRECCION || '', email: env.LEGAL_EMAIL || '' } }) + ';\n');
console.log('config.js generado para ' + url);
