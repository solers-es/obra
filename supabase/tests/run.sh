#!/bin/sh
# Prueba el esquema + la sincronización en un Postgres local (necesita un servidor Postgres accesible).
# Uso: PGHOST=/var/tmp PGPORT=54329 PGUSER=postgres sh supabase/tests/run.sh
set -e
cd "$(dirname "$0")/.."
DB=brigada_test
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
P="psql -q -d $DB -v ON_ERROR_STOP=1"
$P -f tests/00_stub_supabase.sql
$P -f esquema.sql 2>&1 | grep -v NOTICE || true
$P -f 02_sync.sql 2>&1 | grep -v NOTICE || true
$P -f 03_superadmin.sql 2>&1 | grep -v NOTICE || true
psql -q -tA -d $DB -f tests/10_rls_sync.sql 2>&1 | grep -v '^$' | grep -v set_config
psql -q -tA -d $DB -f tests/20_superadmin.sql 2>&1 | grep -v '^$' | grep -v set_config
