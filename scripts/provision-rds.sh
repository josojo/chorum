#!/usr/bin/env bash
#
# Provision the managed Postgres (AWS RDS) that backs prod, replacing the
# on-box postgres container. See docs/DEPLOYMENT.md §4.
#
# Why RDS: it owns durability. Automated daily backups + point-in-time recovery
# (the retention window below) are stored off-box in AWS-managed S3, so a dead
# instance/volume no longer means losing the `registrations` table (which would
# force every user to re-scan their passport — a relaunch, not a recovery).
#
# This is a ONE-TIME operator step. It is deliberately conservative:
#   - single-AZ db.t4g.micro      (cheapest tier; backups/PITR still fully on)
#   - storage encrypted at rest
#   - NOT publicly accessible      (reachable only from inside the VPC)
#   - deletion protection ON       (a stray `aws rds delete` cannot wipe prod)
# Multi-AZ (HA standby + auto-failover) is a later cost/availability decision;
# it does not change the backup story this script sets up.
#
# Prereqgs:
#   - aws CLI v2 configured with creds that can rds:CreateDBInstance and (with
#     --push-ssm) ssm:PutParameter on /hearme/<env>/*.
#   - The admin (master) password ALREADY pushed to SSM, i.e. you have run
#     scripts/push-secrets-to-ssm.sh <env> with HEARME_<ENV>_POSTGRES_ADMIN_PASSWORD set.
#   - A DB subnet group spanning the VPC's private subnets (--subnet-group).
#   - A VPC security group (--security-group) whose inbound allows 5432 FROM
#     the EC2 box's security group. The DB is not public; this SG edge is the
#     only path to it.
#
# Usage:
#   scripts/provision-rds.sh \
#     --subnet-group hearme-db-subnets \
#     --security-group sg-0abc123 \
#     [--env prod] [--region eu-central-1] [--instance-id hearme-prod] \
#     [--instance-class db.t4g.micro] [--storage-gb 20] [--retention-days 7] \
#     [--engine-version 16] [--push-ssm]
#
# --push-ssm writes the resulting endpoint hostname to
# /hearme/<env>/HEARME_<ENV_UPPER>_POSTGRES_HOST (a plain String — not a secret).
set -euo pipefail

env_name="prod"
region="eu-central-1"
instance_id="hearme-prod"
instance_class="db.t4g.micro"
storage_gb="20"
retention_days="7"
engine_version="16"
subnet_group=""
security_group=""
push_ssm="0"

die() { echo "ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --env)             env_name="$2"; shift 2 ;;
    --region)          region="$2"; shift 2 ;;
    --instance-id)     instance_id="$2"; shift 2 ;;
    --instance-class)  instance_class="$2"; shift 2 ;;
    --storage-gb)      storage_gb="$2"; shift 2 ;;
    --retention-days)  retention_days="$2"; shift 2 ;;
    --engine-version)  engine_version="$2"; shift 2 ;;
    --subnet-group)    subnet_group="$2"; shift 2 ;;
    --security-group)  security_group="$2"; shift 2 ;;
    --push-ssm)        push_ssm="1"; shift ;;
    -h | --help)       sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

case "$env_name" in prod | staging) ;; *) die "--env must be prod|staging" ;; esac
[ -n "$subnet_group" ]   || die "--subnet-group is required"
[ -n "$security_group" ] || die "--security-group is required"

env_upper="$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
admin_pw_param="/hearme/${env_name}/HEARME_${env_upper}_POSTGRES_ADMIN_PASSWORD"
host_param="/hearme/${env_name}/HEARME_${env_upper}_POSTGRES_HOST"

echo "[provision-rds] reading master password from SSM ${admin_pw_param}"
master_pw="$(aws ssm get-parameter --region "$region" \
  --name "$admin_pw_param" --with-decryption \
  --query 'Parameter.Value' --output text)" \
  || die "could not read ${admin_pw_param} — run push-secrets-to-ssm.sh first"
[ -n "$master_pw" ] && [ "$master_pw" != "None" ] || die "master password empty in SSM"

if aws rds describe-db-instances --region "$region" \
     --db-instance-identifier "$instance_id" >/dev/null 2>&1; then
  die "RDS instance '${instance_id}' already exists in ${region} — refusing to recreate"
fi

echo "[provision-rds] creating ${instance_id} (${instance_class}, ${storage_gb}GB gp3, postgres ${engine_version})"
echo "                single-AZ, encrypted, private, ${retention_days}-day backups, deletion-protection ON"
aws rds create-db-instance \
  --region "$region" \
  --db-instance-identifier "$instance_id" \
  --db-name hearme \
  --engine postgres \
  --engine-version "$engine_version" \
  --db-instance-class "$instance_class" \
  --allocated-storage "$storage_gb" \
  --storage-type gp3 \
  --storage-encrypted \
  --master-username hearme_admin \
  --master-user-password "$master_pw" \
  --db-subnet-group-name "$subnet_group" \
  --vpc-security-group-ids "$security_group" \
  --no-publicly-accessible \
  --backup-retention-period "$retention_days" \
  --no-multi-az \
  --auto-minor-version-upgrade \
  --deletion-protection \
  --copy-tags-to-snapshot \
  --tags "Key=app,Value=hearme" "Key=env,Value=${env_name}" \
  >/dev/null

echo "[provision-rds] waiting for db-instance-available (this takes several minutes)..."
aws rds wait db-instance-available --region "$region" --db-instance-identifier "$instance_id"

endpoint="$(aws rds describe-db-instances --region "$region" \
  --db-instance-identifier "$instance_id" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"
[ -n "$endpoint" ] && [ "$endpoint" != "None" ] || die "instance available but no endpoint?"

echo "[provision-rds] available at: ${endpoint}"

if [ "$push_ssm" = "1" ]; then
  echo "[provision-rds] writing ${host_param} (String)"
  aws ssm put-parameter --region "$region" \
    --name "$host_param" --value "$endpoint" --type String --overwrite >/dev/null
  echo "[provision-rds] done — render the .env and run scripts/bootstrap-rds.sh next"
else
  cat <<EOF
[provision-rds] NOT pushed to SSM (no --push-ssm). To wire it in:
    aws ssm put-parameter --region ${region} \\
      --name ${host_param} --value ${endpoint} --type String --overwrite
Then render the prod .env and run scripts/bootstrap-rds.sh.
EOF
fi
