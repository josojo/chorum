"""Tiny CLI: forward a phone-produced identity bundle into the skill.

Usage::

    python -m hearme_skill.identity_cli accept ./from-phone.json
    cat ./from-phone.json | python -m hearme_skill.identity_cli accept -

The accepted bundle is a DelegationToken JSON (carrying a structured
``ZkPassportProof`` inside ``zkpassport_proof``) produced by the user's phone
(or by ``scripts/mock-phone.py`` in dev). The skill runs structural
binding checks and stores the token at the path resolved from
``HEARME_SKILL_ROOT_DIR`` (default ``/data`` inside the container,
``~/.hermes/hearme`` elsewhere).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .onboarding import IdentityBundleError, accept_identity_bundle


def _default_root() -> Path:
    env = os.environ.get("HEARME_SKILL_ROOT_DIR")
    if env:
        return Path(env)
    return Path.home() / ".hermes" / "hearme"


def _read_input(arg: str) -> str:
    if arg == "-":
        return sys.stdin.read()
    return Path(arg).read_text()


def cmd_accept(args: argparse.Namespace) -> int:
    raw = _read_input(args.bundle)
    delegation_path = (
        Path(args.out) if args.out else _default_root() / "delegation.token"
    )
    delegation_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        token = accept_identity_bundle(raw_json=raw, delegation_path=delegation_path)
    except IdentityBundleError as exc:
        print(f"identity bundle rejected: {exc}", file=sys.stderr)
        return 2
    print(f"accepted; stored at {delegation_path}")
    print(f"  unique_identifier = {token.unique_identifier}")
    print(f"  agent_key         = {token.agent_key}")
    print(f"  expires_at        = {token.expires_at.isoformat()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m hearme_skill.identity_cli")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser(
        "accept", help="Receive a DelegationToken JSON from the phone."
    )
    p.add_argument("bundle", help="Path to a JSON file, or '-' for stdin.")
    p.add_argument(
        "--out",
        help="Override the destination path (default: $HEARME_SKILL_ROOT_DIR/delegation.token).",
    )
    p.set_defaults(func=cmd_accept)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
