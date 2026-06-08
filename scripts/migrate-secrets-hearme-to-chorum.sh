#!/usr/bin/env bash
#
# One-shot rebrand of an environment's secrets from the old `hearme` naming to
# the new `chorum` naming, applying the SAME case-preserving rename used across
# the codebase (hearme->chorum, HEARME->CHORUM, Hearme->Chorum).
#
# Source of truth is AWS SSM Parameter Store. This reads the OLD tree
#   /hearme/<env>/HEARME_*          (left intact as a backup)
# and writes the NEW tree
#   /chorum/<env>/CHORUM_*
#
# What gets rewritten:
#   * Parameter NAMES (path prefix + leaf key)            -> always.
#   * SecureString VALUES (passwords, signing keys, DSNs,
#     the Self scope "staging-hearme-v1", API keys, ...)  -> always, so any
#       embedded db/user/scope/domain names follow the code.
#   * String (public) VALUES — the *_POSTGRES_HOST /
#     *_CADDY_SITE_HOST / *_SELF_ENDPOINT addresses       -> copied VERBATIM.
#       These are real infra endpoints (RDS, sslip host) the rename must not
#       presume to change. If one still contains "hearme" (e.g. an RDS instance
#       literally named hearme-prod) it is FLAGGED so you rename the resource
#       and fix that one parameter by hand.
#
# Secret VALUES are never printed. The dry run shows only name mappings and
# whether each value changed.
#
# Requires AWS creds (default region — eu-central-1 for this project) with:
#   ssm:GetParametersByPath + kms:Decrypt   on parameter/hearme/<env>/*
#   ssm:PutParameter        + kms:Encrypt   on parameter/chorum/<env>/*
#
# Usage:
#   scripts/migrate-secrets-hearme-to-chorum.sh staging              # dry run (SSM -> SSM)
#   scripts/migrate-secrets-hearme-to-chorum.sh staging --apply      # write /chorum/staging
#   scripts/migrate-secrets-hearme-to-chorum.sh prod --apply         # write /chorum/prod
#
#   # If an env's secrets are still in an on-box .env (not yet in SSM):
#   scripts/migrate-secrets-hearme-to-chorum.sh prod --from-file ./prod.env           # print transformed KEY=VALUE
#   scripts/migrate-secrets-hearme-to-chorum.sh prod --from-file ./prod.env --apply   # push to /chorum/prod
#
# After verifying the new tree, delete the old backup:
#   aws ssm get-parameters-by-path --path /hearme/<env> --recursive --query 'Parameters[].Name' --output text \
#     | tr '\t' '\n' | xargs -n1 aws ssm delete-parameter --name
set -euo pipefail

env_name="${1:-}"
case "$env_name" in
  staging | prod) ;;
  *)
    echo "usage: $0 <staging|prod> [--apply] [--from-file <env-file>]" >&2
    exit 2
    ;;
esac
shift

apply=0
from_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --from-file)
      from_file="${2:-}"
      [ -n "$from_file" ] || { echo "--from-file needs a path" >&2; exit 2; }
      shift
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

src_prefix="/hearme/${env_name}"
dst_prefix="/chorum/${env_name}"

# Case-preserving hearme->chorum, identical to the codebase rename.
xform() { printf '%s' "$1" | sed -e 's/hearme/chorum/g' -e 's/HEARME/CHORUM/g' -e 's/Hearme/Chorum/g'; }

# Public, non-secret keys (stored as plain String) — same list as
# scripts/push-secrets-to-ssm.sh. Used only in --from-file mode, where SSM hasn't
# told us the type yet.
is_public_key() {
  case "$1" in
    *_CADDY_SITE_HOST | *_SELF_ENDPOINT | *_POSTGRES_HOST) return 0 ;;
    *) return 1 ;;
  esac
}

contains_hearme() { case "$1" in *[Hh][Ee][Aa][Rr][Mm][Ee]*) return 0 ;; *) return 1 ;; esac; }

n=0
warned=0

# Handle a single (name, value, type) triple: print the plan and, if --apply,
# write the renamed parameter. `type` is "String" or "SecureString".
handle() {
  local name="$1" value="$2" type="$3"
  local newname newvalue changed
  newname="$(xform "$name")"
  if [ "$type" = "String" ]; then
    newvalue="$value" # public endpoint: keep verbatim
    if contains_hearme "$value"; then
      printf 'WARN  %s value still contains "hearme" — rename the resource, then fix this one by hand\n' "$newname" >&2
      warned=$((warned + 1))
    fi
  else
    newvalue="$(xform "$value")"
  fi
  if [ "$newvalue" = "$value" ]; then changed="value:unchanged"; else changed="value:rewritten"; fi
  printf '%s\n   -> %s   [%s, %s]\n' "$name" "$newname" "$type" "$changed"
  if [ "$apply" -eq 1 ]; then
    aws ssm put-parameter --name "$newname" --value "$newvalue" --type "$type" --overwrite >/dev/null
  fi
  n=$((n + 1))
}

if [ -n "$from_file" ]; then
  # ----- on-box .env source -------------------------------------------------
  [ -f "$from_file" ] || { echo "no such file: ${from_file}" >&2; exit 2; }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    [ -n "$key" ] && [ "$key" != "$line" ] || continue
    if is_public_key "$key"; then type="String"; else type="SecureString"; fi
    # In --from-file mode the "name" is a bare KEY; give it the dst path so the
    # plan/put targets /chorum/<env>/<KEY>.
    handle "${dst_prefix}/${key}" "$value" "$type"
  done < "$from_file"
else
  # ----- SSM source ---------------------------------------------------------
  out="$(
    aws ssm get-parameters-by-path \
      --path "$src_prefix" \
      --recursive \
      --with-decryption \
      --query 'Parameters[].[Name,Value,Type]' \
      --output text
  )"
  if [ -z "$out" ]; then
    echo "ERROR: no parameters under ${src_prefix} — wrong env/region/IAM, or this env's secrets are still in an on-box .env (use --from-file)." >&2
    exit 1
  fi
  # Values are single-line (passwords / base64 seeds / API keys / hostnames),
  # same assumption as scripts/render-secrets-env.sh, so tab-splitting is safe.
  while IFS=$'\t' read -r name value type; do
    [ -n "$name" ] || continue
    handle "$name" "$value" "$type"
  done < <(printf '%s\n' "$out")
fi

echo "----"
echo "${n} parameter(s) processed; ${warned} flagged for manual hostname fix."
if [ "$apply" -eq 1 ]; then
  echo "WROTE new tree under ${dst_prefix}. Old ${src_prefix} left intact as backup."
else
  echo "(dry run) re-run with --apply to write under ${dst_prefix}."
fi
