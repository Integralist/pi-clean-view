.PHONY: deps test typecheck verify load-check try

deps:
	npm install --ignore-scripts --legacy-peer-deps

test:
	./node_modules/.bin/vitest run $(TEST_FILTER)

typecheck:
	./node_modules/.bin/tsc --noEmit

verify: test typecheck load-check

load-check:
	node --import tsx --input-type=module -e 'const m = await import("./extensions/clean-view.ts"); if (typeof m.default !== "function") throw new Error("Missing extension factory"); console.log("Extension module loads");'

# Loads only this checkout: an installed copy of Clean View would register the
# same tools and refuse to load beside it.
try:
	pi --no-extensions -e ./extensions/clean-view.ts
