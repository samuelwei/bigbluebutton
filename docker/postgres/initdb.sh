#!/bin/bash
# Runs once via /docker-entrypoint-initdb.d when the data directory is empty.
# Mirrors bbb-graphql-server/deploy.sh / packaging after-install.sh.

set -euo pipefail

echo "Creating database bbb_graphql"
psql -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS bbb_graphql WITH (FORCE)"
psql -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE bbb_graphql WITH TEMPLATE template0 LC_COLLATE 'C.UTF-8'"
psql -v ON_ERROR_STOP=1 -q -c "ALTER DATABASE bbb_graphql SET timezone TO 'UTC'"

echo "Creating tables in bbb_graphql"
psql -v ON_ERROR_STOP=1 -U postgres -d bbb_graphql -q -f "/bbb-graphql-server/bbb_schema.sql"

echo "Creating users"

# hasura_app@hasura_app (Hasura metadata)
psql -tc "SELECT 1 FROM pg_roles WHERE rolname='hasura_app'" | grep -q 1 || \
  psql -v ON_ERROR_STOP=1 -c "CREATE USER hasura_app WITH PASSWORD '${POSTGRES_HASURA_APP_PASSWORD}'"

HASURA_DATABASE_NAME="hasura_app"
psql -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS ${HASURA_DATABASE_NAME} WITH (FORCE);"
psql -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE ${HASURA_DATABASE_NAME} OWNER hasura_app;"

# bbb_core@bbb_graphql (akka-apps)
psql -tc "SELECT 1 FROM pg_roles WHERE rolname='bbb_core'" | grep -q 1 || \
  psql -v ON_ERROR_STOP=1 -c "CREATE USER bbb_core WITH PASSWORD '${POSTGRES_BBB_CORE_PASSWORD}'"
psql -v ON_ERROR_STOP=1 -q -c "GRANT CONNECT ON DATABASE bbb_graphql TO bbb_core"
psql -v ON_ERROR_STOP=1 -q -d bbb_graphql -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bbb_core"
psql -v ON_ERROR_STOP=1 -q -d bbb_graphql -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bbb_core"
psql -v ON_ERROR_STOP=1 -q -d bbb_graphql -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bbb_core"
psql -v ON_ERROR_STOP=1 -q -d bbb_graphql -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bbb_core"

# bbb_hasura@bbb_graphql (Hasura read-only)
psql -tc "SELECT 1 FROM pg_roles WHERE rolname='bbb_hasura'" | grep -q 1 || \
  psql -v ON_ERROR_STOP=1 -c "CREATE USER bbb_hasura WITH PASSWORD '${POSTGRES_BBB_HASURA_PASSWORD}'"
psql -v ON_ERROR_STOP=1 -q -c "GRANT CONNECT ON DATABASE bbb_graphql TO bbb_hasura"
psql -v ON_ERROR_STOP=1 -q -d bbb_graphql -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO bbb_hasura"
psql -v ON_ERROR_STOP=1 -q -d bbb_graphql -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO bbb_hasura"

echo "Postgres BBB init complete"
