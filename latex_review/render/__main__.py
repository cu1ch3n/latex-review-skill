import sys

from .round import main

if len(sys.argv) != 2:
    sys.exit('usage: python -m latex_review.render REQUEST.json')
main(sys.argv[1])
