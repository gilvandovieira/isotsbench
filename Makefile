# Thin aliases; the logic lives in scripts/ so it also works without make.
BENCH_ARGS ?=
# CPU list for bench-official, e.g. CPUS=8,10 (see docs/methodology.md).
CPUS ?=
# Run directories for compare, e.g. RUNS="results/raw/<id-a> results/raw/<id-b>".
RUNS ?=
# Suites to run (boundary, payload, return), e.g. SUITE=return; empty runs all.
SUITE ?=
SUITE_ARG = $(if $(SUITE),--suite $(SUITE))

.PHONY: build test check bench bench-quick bench-official compare clean

build:
	node scripts/build.ts

test:
	cargo test --workspace

check:
	cargo clippy --workspace --all-targets -- -D warnings
	deno check bench/run.ts scripts/*.ts

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

compare:
	$(if $(RUNS),,$(error set RUNS to one or more results/raw/<run-id> directories))
	node scripts/compare.ts $(RUNS)

clean:
	cargo clean
	rm -rf build
