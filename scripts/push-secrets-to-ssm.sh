#!/usr/bin/env bash
#
# Push an environment's secrets INTO AWS SSM Parameter Store from a local
# `.env`-style file. Use it for the one-time migration off the on-box .env and
# for rotation; afterwards SSM is the source of truth (read back with
# scripts/render-secrets-env.sh).
#
# Every key is written as SecureString (KMS-encrypted) EXCEPT the public
# hostname/URL values, written as plain String for readability. Existing
# parameters are overwritten in place.
#
# Requires AWS creds (default region) with:
#   ssm:PutParameter  on  arn:aws:ssm:<region>:<acct>:parameter/hearme/<env>/*
#   kms:Encrypt       on  the key SSM used (alias/aws/ssm by default)
#
# Usage:
#   scripts/push-secrets-to-ssm.sh staging ./staging.env
#   shred -u ./staging.env      # delete the plaintext file afterwards
set -euo pipefail

env_name="${1:-}"
env_file="${2:-}"
case "$env_name" in
  staging | prod) ;;
  *)
    echo "usage: $0 <staging|prod> <env-file>" >&2
    exit 2
    ;;
esac
[ -f "$env_file" ] || {
  echo "no such file: ${env_file}" >&2
  exit 2
}

prefix="/hearme/${env_name}"

# Public, non-secret values — stored as plain String so they are readable in
# the console without decryption.
is_public() {
  case "$1" in
    *_CADDY_SITE_HOST | *_SELF_ENDPOINT) return 0 ;;
    *) return 1 ;;
  esac
}

while IFS= read -r line || [ -n "$line" ]; do
  # Skip blank lines and comments.
  case "$line" in '' | \#*) continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  # Require a real KEY=VALUE (a line with no '=' leaves key == line).
  [ -n "$key" ] && [ "$key" != "$line" ] || continue

  if is_public "$key"; then type="String"; else type="SecureString"; fi

  aws ssm put-parameter \
    --name "${prefix}/${key}" \
    --value "$value" \
    --type "$type" \
    --overwrite >/dev/null
  echo "put ${prefix}/${key} (${type})"
done < "$env_file"
