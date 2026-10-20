#!/usr/bin/env python3
"""Entry point for agents: python3 /path/to/latex-review-skill/scripts/review.py COMMAND ..."""
from pathlib import Path
import sys

if sys.version_info < (3, 10):
    sys.exit('latex-review needs Python 3.10 or newer.')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from latex_review.cli import main  # noqa: E402

main()
