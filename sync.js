/* Brigada · sincronización con Supabase (opcional).
   Sin configuración (config.js vacío) no hace nada: la app funciona solo en el móvil.
   Con configuración: cuenta (email+contraseña), empresa, y sincronización por documentos
   (un documento por obra/parte/presupuesto…) con RLS por empresa. Gana el último en editar.
   Trabaja sin conexión: los cambios se encolan y se envían al volver la red. */
var Sync = (function () {
  var COLS = ['obras', 'presupuestos', 'clientes', 'equipo', 'partes', 'oportunidades', 'sat', 'ots'];
  var cfg = window.BRIGADA_CONFIG || {};
  var URL = (cfg.supabaseUrl || '').replace(/\/$/, ''), KEY = cfg.supabaseAnonKey || '';
  var configurado = !!(URL && KEY);
  var LS = 'brigada_sync';
  var S = { ses: null, tenant: null, tenantNombre: '', rol: null, cursor: 0, snap: {}, cola: {}, ult: 0, err: '' };
  try { var raw = localStorage.getItem(LS); if (raw) S = Object.assign(S, JSON.parse(raw)); } catch (e) {}
  var ocupado = false, timerPush = null, timerLoop = null;

  function persistir() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {} }
  function ahora() { return Date.now(); }
  function estable(v) { // JSON con claves ordenadas: el mismo documento da siempre el mismo texto
    if (Array.isArray(v)) return '[' + v.map(estable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + estable(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h + ':' + s.length; }

  /* ---------- red ---------- */
  function http(method, ruta, body, conToken) {
    var h = { 'apikey': KEY, 'Content-Type': 'application/json' };
    var pre = conToken === false ? Promise.resolve() : token().then(function (t) { h['Authorization'] = 'Bearer ' + t; });
    return pre.then(function () {
      return fetch(URL + ruta, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined });
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var m = (j && (j.message || j.msg || j.error_description || j.error)) || ('Error ' + r.status); var e = new Error(m); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function token() {
    if (!S.ses) return Promise.reject(new Error('Sin sesión'));
    if (S.ses.exp - ahora() > 60000) return Promise.resolve(S.ses.access);
    return http('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: S.ses.refresh }, false).then(function (r) { guardarSesion(r); return S.ses.access; })
      .catch(function (e) { if (e.status === 400 || e.status === 401) { S.ses = null; persistir(); } throw e; });
  }
  function guardarSesion(r) {
    S.ses = { access: r.access_token, refresh: r.refresh_token, exp: ahora() + (r.expires_in || 3600) * 1000, email: (r.user && r.user.email) || (S.ses && S.ses.email) || '', uid: (r.user && r.user.id) || (S.ses && S.ses.uid) || '' };
    persistir();
  }

  /* ---------- cuenta ---------- */
  function entrar(email, pass) {
    return http('POST', '/auth/v1/token?grant_type=password', { email: email, password: pass }, false).then(function (r) { guardarSesion(r); return conectar(); });
  }
  function registrar(email, pass) {
    return http('POST', '/auth/v1/signup', { email: email, password: pass }, false).then(function (r) {
      if (!r.access_token) return { confirmar: true };
      guardarSesion(r); return conectar();
    });
  }
  function salir() { S.ses = null; S.tenant = null; S.rol = null; S.cursor = 0; S.snap = {}; S.cola = {}; S.err = ''; persistir(); pararBucle(); if (window._rolReal) { window._rolReal = false; window._verComo = null; if (window.aplicarVerComo) aplicarVerComo(); } }

  function conectar() { // tras entrar: ¿a qué empresa pertenezco?
    return http('GET', '/rest/v1/membresias?select=tenant_id,rol,tenants(razon_social)&usuario_id=eq.' + S.ses.uid + '&estado=eq.activa&order=creado_en.asc').then(function (m) {
      if (!m || !m.length) { S.tenant = null; persistir(); return { sinEmpresa: true }; }
      var x = m[0]; S.tenant = x.tenant_id; S.rol = x.rol; S.tenantNombre = (x.tenants && x.tenants.razon_social) || ''; persistir();
      return sincronizar().then(function () { arrancarBucle(); aplicarRol(); return { ok: true }; });
    });
  }
  function nifValido(nif) {
    var v = String(nif || '').toUpperCase().replace(/[\s.\-]/g, '');
    if (/^[0-9]{8}[A-Z]$/.test(v)) return 'TRWAGMYFPDXBNJZSQVHLCKE'[parseInt(v.slice(0, 8), 10) % 23] === v[8];
    if (/^[XYZ][0-9]{7}[A-Z]$/.test(v)) return 'TRWAGMYFPDXBNJZSQVHLCKE'[parseInt(('XYZ'.indexOf(v[0])) + v.slice(1, 8), 10) % 23] === v[8];
    if (/^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$/.test(v)) {
      var s = 0; for (var i = 0; i < 7; i++) { var d = parseInt(v[i + 1], 10); if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } s += d; }
      var c = (10 - (s % 10)) % 10, L = 'JABCDEFGHI'[c];
      return /[A-HJNPQRSUVW]/.test(v[0]) && (/[PQRSNW]/.test(v[0]) ? v[8] === L : (/[ABEH]/.test(v[0]) ? v[8] === String(c) : (v[8] === String(c) || v[8] === L)));
    }
    return false;
  }
  function crearEmpresa(e) {
    return http('POST', '/rest/v1/rpc/crear_empresa', { p_nif: e.nif, p_razon_social: e.nombre, p_direccion: e.dir || null, p_email: e.email || null, p_telefono: e.tel || null })
      .then(function () { return conectar(); });
  }
  function invitar(email, rol) { return http('POST', '/rest/v1/rpc/invitar_usuario', { p_tenant: S.tenant, p_email: email, p_rol: rol }); }

  /* ---------- roles ---------- */
  var ROL_APP = { admin: 'Dueño', jefe_obra: 'Oficina', administrativo: 'Oficina', operario: 'Operario', solo_lectura: 'Cliente' };
  function aplicarRol() {
    var r = ROL_APP[S.rol] || 'Dueño';
    window._rolReal = true; window._verComo = (r === 'Dueño') ? null : r;
    if (window.aplicarVerComo) aplicarVerComo();
  }
  function esOperario() { return S.rol === 'operario'; }
  function soloLectura() { return S.rol === 'solo_lectura'; }

  /* ---------- documentos locales ---------- */
  function docsLocales() {
    var out = {};
    if (esOperario()) { (db.partes || []).forEach(function (p) { out['partes/' + p.id] = { col: 'partes', id: p.id, datos: p }; }); return out; }
    COLS.forEach(function (c) { (db[c] || []).forEach(function (x) { if (x && x.id && !x._lite) out[c + '/' + x.id] = { col: c, id: x.id, datos: x }; }); });
    (db.obras || []).forEach(function (o) { if (!o._lite) out['obras_lite/' + o.id] = { col: 'obras_lite', id: o.id, datos: { id: o.id, nombre: o.nombre } }; });
    out['ajustes/config'] = { col: 'ajustes', id: 'config', datos: { empresa: db.empresa || null, contadorFactura: db.contadorFactura || 0, contadorPresu: db.contadorPresu || 0, contadorOts: db.contadorOts || 0 } };
    return out;
  }
  function cambio() { // lo llama guardar(): detecta qué documentos han cambiado y los encola
    if (!configurado || !S.tenant || !S.ses || soloLectura()) return;
    var cur = docsLocales(), t = ahora(), hubo = false;
    Object.keys(cur).forEach(function (k) {
      var h = hash(estable(cur[k].datos)), s = S.snap[k];
      if (!s || s.h !== h) { S.snap[k] = { h: h, m: t }; S.cola[k] = { coleccion: cur[k].col, doc_id: cur[k].id, datos: cur[k].datos, mod_ms: t, borrado: false }; hubo = true; }
    });
    Object.keys(S.snap).forEach(function (k) {
      if (cur[k]) return; var c = k.split('/')[0];
      if (esOperario() && c !== 'partes') return; // el operario no gestiona el resto
      if (S.snap[k].lite) return;
      S.cola[k] = { coleccion: c, doc_id: k.slice(c.length + 1), datos: {}, mod_ms: t, borrado: true }; delete S.snap[k]; hubo = true;
    });
    if (hubo) { persistir(); clearTimeout(timerPush); timerPush = setTimeout(function () { empujar(); }, 1200); }
  }

  /* ---------- enviar / traer ---------- */
  function empujar() {
    if (!configurado || !S.tenant || !S.ses || ocupado || (navigator.onLine === false)) return Promise.resolve();
    var claves = Object.keys(S.cola); if (!claves.length) return Promise.resolve();
    ocupado = true;
    var lote = claves.slice(0, 200), docs = lote.map(function (k) { return S.cola[k]; });
    return http('POST', '/rest/v1/rpc/subir_docs', { p_tenant: S.tenant, p_docs: docs }).then(function () {
      lote.forEach(function (k) { if (S.cola[k] && S.cola[k].mod_ms === docs[lote.indexOf(k)].mod_ms) delete S.cola[k]; });
      S.err = ''; S.ult = ahora(); persistir(); ocupado = false;
      if (Object.keys(S.cola).length) return empujar();
    }).catch(function (e) { ocupado = false; S.err = e.message; persistir(); pintarEstado(); });
  }
  function aplicarRemoto(d) {
    var k = d.coleccion + '/' + d.doc_id, q = S.cola[k];
    if (q && q.mod_ms > d.mod_ms) return;                    // lo mío es más reciente: se enviará y ganará
    if (q) delete S.cola[k];
    var c = d.coleccion;
    if (c === 'ajustes') {
      var a = d.datos || {}; if (a.empresa) db.empresa = a.empresa;
      db.contadorFactura = Math.max(db.contadorFactura || 0, a.contadorFactura || 0); db.contadorPresu = Math.max(db.contadorPresu || 0, a.contadorPresu || 0); db.contadorOts = Math.max(db.contadorOts || 0, a.contadorOts || 0);
      S.snap[k] = { h: hash(estable({ empresa: db.empresa || null, contadorFactura: db.contadorFactura || 0, contadorPresu: db.contadorPresu || 0, contadorOts: db.contadorOts || 0 })), m: d.mod_ms };
      return;
    }
    if (c === 'obras_lite') {
      if (!esOperario()) return;
      db.obras = db.obras || [];
      if (d.borrado) { db.obras = db.obras.filter(function (o) { return o.id !== d.doc_id; }); return; }
      var ex = db.obras.find(function (o) { return o.id === d.doc_id; });
      if (ex) ex.nombre = d.datos.nombre; else db.obras.push({ id: d.doc_id, nombre: d.datos.nombre, cliente: '', _lite: true, capitulos: [], certificaciones: [], facturas: [], costesMaterial: [], costesManoObra: [] });
      return;
    }
    if (COLS.indexOf(c) < 0) return;
    if (esOperario() && c !== 'partes') return;
    db[c] = db[c] || [];
    var i = db[c].findIndex(function (x) { return x.id === d.doc_id; });
    if (d.borrado) { if (i >= 0) db[c].splice(i, 1); delete S.snap[k]; return; }
    var it = d.datos || {};
    if (c === 'obras') { it.capitulos = it.capitulos || []; it.certificaciones = it.certificaciones || []; it.facturas = it.facturas || []; it.costesMaterial = it.costesMaterial || []; it.costesManoObra = it.costesManoObra || []; }
    if (i >= 0) db[c][i] = it; else db[c].push(it);
    S.snap[k] = { h: hash(estable(it)), m: d.mod_ms };
  }
  function traer() {
    if (!configurado || !S.tenant || !S.ses || (navigator.onLine === false)) return Promise.resolve();
    function pagina() {
      return http('GET', '/rest/v1/brigada_docs?select=coleccion,doc_id,datos,mod_ms,seq,borrado&tenant_id=eq.' + S.tenant + '&seq=gt.' + S.cursor + '&order=seq.asc&limit=500').then(function (rows) {
        rows.forEach(function (d) { aplicarRemoto(d); if (d.seq > S.cursor) S.cursor = d.seq; });
        if (rows.length) { reconstruirManoObra(); guardarLocal(); }
        if (rows.length >= 500) return pagina();
        return rows.length;
      });
    }
    return pagina().then(function (n) { S.err = ''; S.ult = ahora(); persistir(); if (n && window.refrescarPantalla) refrescarPantalla(); }).catch(function (e) { S.err = e.message; persistir(); });
  }
  function costeDe(p) { var op = (db.equipo || []).find(function (e) { return e.nombre === p.operario; }); if (op && window.costeHoraOperario) return costeHoraOperario(op); return p.horas && p.coste ? redondear(p.coste / p.horas) : 20; }
  function reconstruirManoObra() { // el coste de mano de obra de cada obra sale de los partes (los suben los operarios)
    if (esOperario()) return;
    var ids = {}; (db.partes || []).forEach(function (p) { ids[p.id] = p; });
    (db.obras || []).forEach(function (o) {
      if (o._lite) return;
      o.costesManoObra = (o.costesManoObra || []).filter(function (m) { return !m.parteId || ids[m.parteId]; });
      var tengo = {}; o.costesManoObra.forEach(function (m) { if (m.parteId) tengo[m.parteId] = 1; });
      (db.partes || []).forEach(function (p) {
        if (p.obraId !== o.id || tengo[p.id]) return;
        o.costesManoObra.push({ id: 'cp_' + p.id, parteId: p.id, operario: p.operario + ' (parte)', horas: p.horas, costeHora: costeDe(p), fecha: p.fecha });
      });
    });
  }
  function sincronizar() { return traer().then(function () { cambio(); return empujar(); }).then(pintarEstado); }

  /* ---------- bucle ---------- */
  function arrancarBucle() {
    pararBucle();
    timerLoop = setInterval(function () { if (!document.hidden) sincronizar(); }, 25000);
  }
  function pararBucle() { clearInterval(timerLoop); timerLoop = null; }
  window.addEventListener('online', function () { if (S.tenant) sincronizar(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.tenant) sincronizar(); });

  /* ---------- numeración de facturas ---------- */
  function reservarNumero(desde) {
    var serie = 'A-' + new Date().getFullYear();
    return http('POST', '/rest/v1/rpc/siguiente_numero', { p_tenant: S.tenant, p_serie: serie, p_desde: desde || 0 });
  }

  /* ---------- estado para la pantalla ---------- */
  function estado() {
    return { configurado: configurado, sesion: !!(S.ses), email: S.ses ? S.ses.email : '', tenant: S.tenant, empresa: S.tenantNombre, rol: S.rol, pendientes: Object.keys(S.cola).length, ult: S.ult, err: S.err, online: navigator.onLine !== false };
  }
  function pintarEstado() { try { if (window.pintarBadgeSync) pintarBadgeSync(); if (window.pintarCuenta) pintarCuenta(); } catch (e) {} }
  function activo() { return configurado && !!S.tenant && !!S.ses; }
  function guardarLocal() { try { localStorage.setItem(window.CLAVE || 'brigada_proto_v6', JSON.stringify(db)); } catch (e) {} }

  /* ---------- arranque ---------- */
  function iniciar() { if (activo()) { aplicarRol(); arrancarBucle(); sincronizar(); } }

  return { configurado: configurado, conectar: conectar, entrar: entrar, registrar: registrar, salir: salir, crearEmpresa: crearEmpresa, invitar: invitar, nifValido: nifValido,
           cambio: cambio, sincronizar: sincronizar, estado: estado, activo: activo, reservarNumero: reservarNumero, iniciar: iniciar, esOperario: esOperario, soloLectura: soloLectura };
})();
