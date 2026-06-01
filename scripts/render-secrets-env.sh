#!/usr/bin/env bash
#
# Render an environment's secrets from AWS SSM Parameter Store as `KEY=VALUE`
# lines on stdout — the `.env` that docker compose consumes. SSM is the single
# source of truth (see docs/DEPLOYMENT.md §1); this reconstructs the file the
# staging/prod overlays reference as ${HEARME_<ENV>_*}.
#
# Each parameter lives at /hearme/<env>/<EXACT_ENV_VAR_NAME>; the leaf name is
# emitted verbatim, so the compose overlays need zero changes. Secrets are
# stored as SecureString and public values (hostnames/URLs) as String;
# --with-decryption covers both.
#
# Requires AWS creds (default region) with:
#   ssm:GetParametersByPath  on  arn:aws:ssm:<region>:<acct>:parameter/hearme/<env>/*
#   kms:Decrypt              on  the key SSM used (alias/aws/ssm by default)
#
# Usage:
#   scripts/render-secrets-env.sh staging > .env
#   scripts/render-secrets-env.sh prod | ssh prod 'umask 077; cat > ~/hearme/.env'
set -euo pipefail

env_name="${1:-}"
case "$env_name" in
  staging | prod) ;;
  *)
    echo "usage: $0 <staging|prod>" >&2
    exit 2
    ;;
esac

prefix="/hearme/${env_name}"

# --output text yields one "Name<TAB>Value" row per parameter. Our values are
# all single-line (passwords / base64 seeds / API keys / hostnames), so
# tab-splitting and line-reading are safe. The CLI auto-paginates.
out="$(
  aws ssm get-parameters-by-path \
    --path "$prefix" \
    --recursive \
    --with-decryption \
    --query 'Parameters[].[Name,Value]' \
    --output text
)"

if [ -z "$out" ]; then
  echo "ERROR: no parameters under ${prefix} — wrong env, missing IAM perms, or wrong region?" >&2
  exit 1
fi

printf '%s\n' "$out" | while IFS=$'\t' read -r name value; do
  [ -n "$name" ] || continue
  # Leaf segment of the SSM path is the exact env var name.
  printf '%s=%s\n' "${name##*/}" "$value"
done
