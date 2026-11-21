#!/bin/bash
# Deletes the simulated boxes (and their readings) from the database.
# Run on the mqtt-ingest server, in a Session Manager shell, as root:   sudo -i   then paste this script.
# Usage: bash cleanup-on-server.sh [first-box-number] [how-many]      (default: 2 20 = BOX-002 to BOX-021)
set -euo pipefail
START=${1:-2}
COUNT=${2:-20}
. /opt/coldchain/env
S=$(aws secretsmanager get-secret-value --region $REGION --secret-id $DB_SECRET_ARN --query SecretString --output text)
export PGPASSWORD=$(echo "$S" | jq -r .password)
DBU=$(echo "$S" | jq -r .username)
IDS=""
for i in $(seq $START $((START + COUNT - 1))); do IDS="$IDS,'$(printf 'BOX-%03d' $i)'"; done
IDS=${IDS#,}
docker run --rm -e PGPASSWORD -e PGSSLMODE=require postgres:16-alpine \
  psql -h $DB_HOST -U $DBU -d $DB_NAME -c "DELETE FROM boxes WHERE id IN ($IDS);"
