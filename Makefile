.PHONY: check demo lint test browser corpus
check:
	npm run check
lint:
	npm run typecheck
test:
	npm test
demo:
	npm run demo
browser:
	npm run test:browser
corpus:
	npm run test:corpus
