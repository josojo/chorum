# PyInstaller spec for the standalone, single-file `hearme-skill` binary.
#
# Build (from packages/skill/):
#   pip install . pyinstaller
#   pyinstaller pyinstaller/hearme-skill.spec
#   -> dist/hearme-skill
#
# CI (.github/workflows/build-binaries.yml) runs this on Linux x86_64 and
# aarch64 and publishes the results as release assets. PyInstaller does NOT
# cross-compile — each artifact is built on a runner of the matching arch.
#
# The bundled third-party packages have C extensions / data files / lazy imports
# that PyInstaller can't always trace statically, so we collect_all() them.
# Inference uses the host agent's own model, so no model SDK is bundled.

from PyInstaller.utils.hooks import collect_all

_COLLECT = [
    "hearme_skill",
    "pydantic",
    "pydantic_core",
    "pydantic_settings",
    "nacl",          # PyNaCl — cffi/libsodium native ext
    "cffi",          # nacl binds libsodium through cffi
    "qrcode",
    "httpx",
    "httpcore",
    "h11",
    "anyio",
    "aiosqlite",
    "dateutil",
    "yaml",
]

datas, binaries, hiddenimports = [], [], []
for _pkg in _COLLECT:
    _d, _b, _h = collect_all(_pkg)
    datas += _d
    binaries += _b
    hiddenimports += _h

# `_cffi_backend` is a top-level compiled extension (not under the cffi package),
# loaded by PyNaCl at runtime via ffi — PyInstaller's static analysis misses it,
# so name it explicitly. Without it the binary builds but dies at startup with
# `ModuleNotFoundError: No module named '_cffi_backend'`.
hiddenimports += ["_cffi_backend"]


a = Analysis(
    ["entrypoint.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Dev/test-only deps that must never end up in the shipped binary.
    excludes=["pytest", "ruff", "testcontainers", "asyncpg", "tkinter"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="hearme-skill",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
