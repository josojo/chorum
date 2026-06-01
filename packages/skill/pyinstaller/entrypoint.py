"""PyInstaller entry point for the standalone ``hearme-skill`` binary.

This is the single script PyInstaller freezes (see ``hearme-skill.spec``). It
just delegates to the same ``cli()`` the ``hearme-skill`` console script uses,
so the binary and the pip-installed CLI expose an identical command surface.
"""

from hearme_skill.skill import cli

if __name__ == "__main__":
    raise SystemExit(cli())
