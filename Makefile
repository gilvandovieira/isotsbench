# Thin aliases; the logic lives in scripts/ so it also works without make.
BENCH_ARGS ?=
# CPU list for bench-official, e.g. CPUS=8,10 (see docs/methodology.md).
CPUS ?=
# Run directories for compare, e.g. RUNS="results/raw/<id-a> results/raw/<id-b>".
RUNS ?=
# Suites to run (boundary, payload, return), e.g. SUITE=return; empty runs all.
SUITE ?=
SUITE_ARG = $(if $(SUITE),--suite $(SUITE))

.PHONY: build test check setup teardown bench bench-quick bench-official bench-browser bench-browser-quick bench-browser-official compare normalize site site-serve clean

build:
	node scripts/build.ts

# The TypeScript tests need the addon, the FFI library and the WASM builds, not the scriptc executable.
# The browser tests skip any browser that is not installed (CHROMIUM_PATH / FIREFOX_PATH select one).
test:
	cargo test --workspace
	node scripts/build.ts --skip-scriptc
	node tests/wasm.test.ts
	node tests/browser.test.ts
	node tests/system-setup.test.ts

check:
	cargo clippy --workspace --all-targets -- -D warnings
	deno check bench/run.ts bench/scriptc/run.ts bench/browser/page.ts bench/browser/worker.ts scripts/*.ts tests/*.ts

# Official-run conditions (Linux, root through sudo): performance governor and EPP,
# turbo off, performance platform profile. setup saves the current values to
# .official-setup.json first; teardown writes exactly those back. The benchmark
# runners themselves never change system settings. CPUS=... only adds the pinning
# checks to the report printed after setup.
setup:
	node scripts/system-setup.ts apply $(if $(CPUS),--cpus $(CPUS))

teardown:
	node scripts/system-setup.ts restore

# Fresh process per case, shuffled order, one run, unpinned.
bench:
	node scripts/bench.ts $(SUITE_ARG) $(BENCH_ARGS)

# Smoke run: one process per runtime, short batches. Not for publishable numbers.
bench-quick:
	node scripts/bench.ts --isolation runtime --warmup 2 --samples 5 --sample-ms 5 $(SUITE_ARG) $(BENCH_ARGS)

# Official profile: pinned, both isolation modes, shuffled, 3 runs. Changes no system settings.
bench-official:
	$(if $(CPUS),,$(error set CPUS, e.g. make bench-official CPUS=8,10))
	node scripts/bench.ts --official --cpus $(CPUS) $(SUITE_ARG) $(BENCH_ARGS)

# Browsers (Chromium, Firefox): main thread and Worker, fresh browser per case, 1 run.
bench-browser:
	node scripts/bench-browser.ts $(BENCH_ARGS)

# Smoke run: one page per browser and thread, short batches. Not for publishable numbers.
bench-browser-quick:
	node scripts/bench-browser.ts --isolation runtime --warmup 2 --samples 5 --sample-ms 5 $(BENCH_ARGS)

# Official profile for browsers: pinned, fresh and shared pages, shuffled, 3 runs.
bench-browser-official:
	$(if $(CPUS),,$(error set CPUS, e.g. make bench-browser-official CPUS=8,10))
	node scripts/bench-browser.ts --official --cpus $(CPUS) $(BENCH_ARGS)

compare:
	$(if $(RUNS),,$(error set RUNS to one or more results/raw/<run-id> directories))
	node scripts/compare.ts $(RUNS)

# results/normalized/ from the committed official runs listed in scripts/normalize-results.ts.
normalize:
	node scripts/normalize-results.ts

# The GitHub Pages report: site/ with its data symlink resolved, in build/site/.
site: normalize
	rm -rf build/site
	cp -RL site build/site
	rm build/site/README.md

# http://127.0.0.1:8000/isotsbench/, as GitHub Pages serves it.
site-serve: site
	node scripts/serve-site.ts build/site

clean:
	cargo clean
	rm -rf build
