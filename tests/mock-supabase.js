// Servidor de PRUEBA que imita lo mínimo de Supabase (GoTrue + PostgREST) sobre un Postgres local REAL
// con supabase/esquema.sql + 02_sync.sql + 03_superadmin.sql aplicados (RLS y funciones de verdad). Solo para tests.
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
      // ---- Superadmin de Solers: API de administración de Auth y tablas con la service_role (solo tests)
      const esServicio = (req.headers.authorization || '') === 'Bearer service-test';
      const psql = (c) => execFileSync('psql', ['-qtA', '-d', DB, '-v', 'ON_ERROR_STOP=1'], { input: c, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const json = (consulta) => { const o = psql("select coalesce(jsonb_agg(r),'[]'::jsonb) from (" + consulta + ") r;"); return JSON.parse(o.split('\n').filter(l => l.startsWith('[')).pop() || '[]'); };
      const eqv = k => (u.searchParams.get(k) || '').replace(/^(eq|ilike)\./, '');
      if (p === '/auth/v1/user') { const sb = subDe(req), em = (() => { try { return JSON.parse(Buffer.from((req.headers.authorization || '').replace('Bearer ', ''), 'base64url').toString()).email; } catch (e) { return null; } })(); return sb ? ok({ id: sb, email: em }) : err('JWT inválido', 401); }
      if (esServicio) {
        let r;
        if (p === '/auth/v1/admin/users' && req.method === 'POST') {
          if (claves[j.email]) return err('email_exists', 422);
          const id = psql("insert into auth.users(email) values (" + q(j.email) + ") returning id;").trim().split('\n')[0];
          claves[j.email] = { id, pass: j.password }; return ok({ id, email: j.email });
        }
        if ((r = p.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/))) {
          const e = Object.keys(claves).find(k => claves[k].id === r[1]);
          if (req.method === 'PUT') { if (!e) return err('no existe', 404); if (j.password) claves[e].pass = j.password; return ok({ id: r[1] }); }
          if (req.method === 'DELETE') { if (e) delete claves[e]; psql("delete from auth.users where id=" + q(r[1]) + "::uuid;"); return ok({}); }
        }
        if (p === '/auth/v1/admin/generate_link') return ok({ action_link: 'http://localhost/verify?type=recovery&email=' + encodeURIComponent(j.email) });
        if (p === '/rest/v1/usuarios' && req.method === 'GET') return ok(u.searchParams.get('email') ? json("select id,email,es_superadmin from public.usuarios where lower(email)=lower(" + q(eqv('email')) + ")") : json("select id,email,es_superadmin from public.usuarios where id=" + q(eqv('id')) + "::uuid"));
        if (p === '/rest/v1/usuarios' && req.method === 'PATCH') { psql("update public.usuarios set es_superadmin=" + (j.es_superadmin ? 'true' : 'false') + " where id=" + q(eqv('id')) + "::uuid;"); res.writeHead(204, cors); return res.end(); }
        if (p === '/rest/v1/tenants' && req.method === 'GET') return ok(json("select id,razon_social from public.tenants where nif=" + q(eqv('nif'))));
        if (p === '/rest/v1/tenants' && req.method === 'POST') return ok(JSON.parse(psql("with x as (insert into public.tenants(nif,razon_social,nombre_comercial,direccion,municipio,provincia,email_contacto,telefono,estado,plan,prueba_hasta) values (" + [j.nif, j.razon_social, j.nombre_comercial, j.direccion, j.municipio, j.provincia, j.email_contacto, j.telefono].map(x => x ? q(x) : 'null').join(',') + ",'prueba','prueba'," + q(j.prueba_hasta) + "::date) returning id) select jsonb_agg(x) from x;").trim().split('\n').pop()), 201);
        if (p === '/rest/v1/tenants' && req.method === 'DELETE') { psql("delete from public.tenants where id=" + q(eqv('id')) + "::uuid;"); res.writeHead(204, cors); return res.end(); }
        if (p === '/rest/v1/membresias' && req.method === 'POST') { psql("insert into public.membresias(tenant_id,usuario_id,rol) values (" + q(j.tenant_id) + "::uuid," + q(j.usuario_id) + "::uuid," + q(j.rol) + ");"); res.writeHead(201, cors); return res.end(); }
        if (p === '/rest/v1/solers_registro' && req.method === 'POST') { psql("insert into public.solers_registro(quien,accion,tenant_id,objetivo,detalle) values (" + [q(j.quien), q(j.accion), j.tenant_id ? q(j.tenant_id) + '::uuid' : 'null', j.objetivo ? q(j.objetivo) : 'null', q(JSON.stringify(j.detalle || {})) + '::jsonb'].join(',') + ");"); res.writeHead(201, cors); return res.end(); }
        if (p === '/rest/v1/solers_registro' && req.method === 'GET') return ok(json("select cuando,quien,accion,objetivo from public.solers_registro order by id desc limit 50"));
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
          soy_solers: () => `public.soy_solers()`,
          solers_clientes: () => `* from public.solers_clientes()`,
          solers_usuarios: () => `* from public.solers_usuarios(${q(j.p_tenant)}::uuid)`,
          solers_entrar: () => `* from public.solers_entrar(${q(j.p_tenant)}::uuid)`,
          invitar_usuario: () => `public.invitar_usuario(${q(j.p_tenant)}::uuid, ${q(j.p_email)}, ${q(j.p_rol)}::app.rol_tenant)` }[f];
        if (!lit) return err('rpc desconocida', 404);
        if (['equipo_empresa', 'solers_clientes', 'solers_usuarios', 'solers_entrar'].includes(f)) return ok(sql(sub, 'select ' + lit()));
        const r = sql(sub, 'select ' + lit() + ' as v'); return ok(r[0] ? r[0].v : null);
      }
      err('no existe', 404);
    } catch (e) { const msg = String(e.stderr || e.message).match(/ERROR:\s+(.*)/); err(msg ? msg[1] : e.message, 400); }
  });
}).listen(port, () => console.log('mock supabase en ' + port));
