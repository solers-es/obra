// Servidor de PRUEBA que imita lo mínimo de Supabase (GoTrue + PostgREST) sobre un Postgres local REAL
// con supabase/esquema.sql + 02_sync.sql aplicados (RLS y funciones de verdad). Solo para tests.
// Uso: PGHOST=/var/tmp PGPORT=54329 PGUSER=postgres PGDATABASE=brigada_test node tests/mock-supabase.js 54330
const http = require('http'), { execFileSync } = require('child_process');
const port = +process.argv[2] || 54330, DB = process.env.PGDATABASE || 'brigada_test';
const claves = {}; // email -> {id, pass}
const q = s => "$q$" + String(s).replace(/\$q\$/g, '') + "$q$";
function sql(sub, consulta) {
  const pre = sub ? "set local role authenticated; select set_config('request.jwt.claim.sub','" + sub + "',true);" : '';
  const script = 'begin; ' + pre + ' select coalesce(jsonb_agg(r),\'[]\'::jsonb) from (' + consulta + ') r; commit;';
  const out = execFileSync('psql', ['-qtA', '-d', DB, '-v', 'ON_ERROR_STOP=1'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.split('\n').filter(l => l.startsWith('[') ).pop() || '[]');
}
function sesion(id, email) {
  const t = Buffer.from(JSON.stringify({ sub: id, email })).toString('base64url');
  return { access_token: t, refresh_token: 'r.' + t, expires_in: 3600, user: { id, email } };
}
const subDe = req => { try { return JSON.parse(Buffer.from((req.headers.authorization || '').replace('Bearer ', ''), 'base64url').toString()).sub; } catch (e) { return null; } };
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x'), p = u.pathname; let j = {}; try { j = body ? JSON.parse(body) : {}; } catch (e) {}
    const ok = (o, c = 200) => { res.writeHead(c, cors); res.end(JSON.stringify(o)); };
    const err = (m, c = 400) => { res.writeHead(c, cors); res.end(JSON.stringify({ message: m })); };
    try {
      if (p === '/auth/v1/signup') {
        if (claves[j.email]) return err('User already registered');
        const id = execFileSync('psql', ['-qtA', '-d', DB], { input: "insert into auth.users(email) values (" + q(j.email) + ") returning id;", encoding: 'utf8' }).trim().split('\n')[0];
        claves[j.email] = { id, pass: j.password }; return ok(sesion(id, j.email));
      }
      if (p === '/auth/v1/recover') return ok({});
      if (p === '/auth/v1/token') {
        if (u.searchParams.get('grant_type') === 'refresh_token') { const t = JSON.parse(Buffer.from(j.refresh_token.slice(2), 'base64url').toString()); return ok(sesion(t.sub, t.email)); }
        const c = claves[j.email]; if (!c || c.pass !== j.password) return err('Invalid login credentials');
        return ok(sesion(c.id, j.email));
      }
      const sub = subDe(req); if (!sub) return err('JWT inválido', 401);
      if (p === '/rest/v1/membresias')
        return ok(sql(sub, "select m.tenant_id, m.rol, json_build_object('razon_social',t.razon_social) as tenants from public.membresias m join public.tenants t on t.id=m.tenant_id where m.estado='activa' and m.usuario_id=" + q(u.searchParams.get('usuario_id').replace('eq.','')) + "::uuid" + (u.searchParams.get('tenant_id') ? " and m.tenant_id=" + q(u.searchParams.get('tenant_id').replace('eq.','')) + "::uuid" : '') + " order by m.creado_en"));
      if (p === '/rest/v1/brigada_docs') {
        const tid = u.searchParams.get('tenant_id').replace('eq.', ''), seq = +u.searchParams.get('seq').replace('gt.', '');
        return ok(sql(sub, "select coleccion,doc_id,datos,mod_ms,seq,borrado from public.brigada_docs where tenant_id=" + q(tid) + "::uuid and seq>" + seq + " order by seq limit 500"));
      }
      const m = p.match(/^\/rest\/v1\/rpc\/(\w+)$/);
      if (m) {
        const f = m[1];
        const lit = { crear_empresa: () => `public.crear_empresa(${q(j.p_nif)}, ${q(j.p_razon_social)}, ${j.p_direccion ? q(j.p_direccion) : 'null'}, null, null)`,
          subir_docs: () => `public.subir_docs(${q(j.p_tenant)}::uuid, ${q(JSON.stringify(j.p_docs))}::jsonb)`,
          siguiente_numero: () => `public.siguiente_numero(${q(j.p_tenant)}::uuid, ${q(j.p_serie)}, ${+j.p_desde || 0})`,
          equipo_empresa: () => `* from public.equipo_empresa(${q(j.p_tenant)}::uuid)`,
          cambiar_rol: () => `public.cambiar_rol(${q(j.p_tenant)}::uuid, ${q(j.p_usuario)}::uuid, ${q(j.p_rol)}::app.rol_tenant)`,
          quitar_usuario: () => `public.quitar_usuario(${q(j.p_tenant)}::uuid, ${q(j.p_usuario)}::uuid)`,
          invitar_usuario: () => `public.invitar_usuario(${q(j.p_tenant)}::uuid, ${q(j.p_email)}, ${q(j.p_rol)}::app.rol_tenant)` }[f];
        if (!lit) return err('rpc desconocida', 404);
        if (f === 'equipo_empresa') return ok(sql(sub, 'select ' + lit()));
        const r = sql(sub, 'select ' + lit() + ' as v'); return ok(r[0] ? r[0].v : null);
      }
      err('no existe', 404);
    } catch (e) { const msg = String(e.stderr || e.message).match(/ERROR:\s+(.*)/); err(msg ? msg[1] : e.message, 400); }
  });
}).listen(port, () => console.log('mock supabase en ' + port));
