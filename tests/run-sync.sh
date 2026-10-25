#!/bin/sh
# Prueba completa de sincronización: base limpia -> servidor de pruebas -> 2 móviles de oficina + 1 operario.
# Necesita un Postgres local y playwright.  PGHOST=/var/tmp PGPORT=54329 PGUSER=postgres sh tests/run-sync.sh
cd "$(dirname "$0")/.."
sh supabase/tests/run.sh >/dev/null 2>&1 || { echo "No se pudo preparar la base (¿Postgres arrancado?)"; exit 1; }
PGDATABASE=brigada_test node tests/mock-supabase.js 54330 >/dev/null 2>&1 &
MOCK=$!; sleep 1.5
node tests/sync.js; R=$?
kill $MOCK 2>/dev/null
exit $R
