"""Review AI edits to a LaTeX document as PDF diffs: accept, reject or comment per change."""
from functools import cache
import hashlib
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
SKILL_ROOT = PACKAGE.parent
WEB = SKILL_ROOT / 'web'

# Pinned renderer dependencies, installed on demand by uv.
RENDER_REQUIREMENTS = ('pymupdf==1.28.2', 'pillow==12.0.0')


@cache
def code_version():
    """A fingerprint of this checkout. A running server with another one is restarted."""
    digest = hashlib.sha256()
    for path in sorted([*PACKAGE.rglob('*.py'), *WEB.glob('*.*')]):
        digest.update(path.relative_to(SKILL_ROOT).as_posix().encode() + b'\0' + path.read_bytes())
    return digest.hexdigest()[:16]
