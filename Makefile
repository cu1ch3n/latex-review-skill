# Python tests run inside the renderer's pinned environment, so the PDF tests run too.
RENDER = uv run --quiet --no-project --with pymupdf==1.28.2 --with pillow==12.0.0 python

.PHONY: check demo lint test

check: lint test

lint:
	python3 -m compileall -q latex_review scripts tests examples
	uvx pyflakes latex_review scripts tests examples
	node --check web/app.js
	node --check web/model.js

test:
	cd tests && $(RENDER) -m unittest discover -p 'test_*.py'
	node --test tests/

demo:
	python3 examples/demo.py
