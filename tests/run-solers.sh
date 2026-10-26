#!/bin/sh
# Prueba de extremo a extremo del superadmin: base limpia -> servidor de pruebas -> navegador.
# Necesita un Postgres local y playwright.  PGHOST=/var/tmp/pg PGPORT=54329 PGUSER=postgres sh tests/run-solers.sh
cd "$(dirname "$0")/.."
# base limpia con el esquema (sin los datos de prueba de supabase/tests/10 y 20)
DB=brigada_test; P="psql -q -d $DB -v ON_ERROR_STOP=1"
{ psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB" \
  && $P -f supabase/tests/00_stub_supabase.sql && $P -f supabase/esquema.sql && $P -f supabase/02_sync.sql && $P -f supabase/03_superadmin.sql; } >/dev/null 2>&1 \
  || { echo "No se pudo preparar la base (¿Postgres arrancado?)"; exit 1; }
PGDATABASE=brigada_test node tests/mock-supabase.js 54330 >/dev/null 2>&1 &
MOCK=$!; sleep 1.5
node tests/solers-ui.js; R=$?
kill $MOCK 2>/dev/null
exit $R
