# Thin aliases; the logic lives in scripts/ so it also works without make.
BENCH_ARGS ?=

.PHONY: build test check bench bench-quick clean

build:
	node scripts/build.ts

test:
	cargo test --workspace

check:
	cargo clippy --workspace --all-targets -- -D warnings
	deno check bench/run.ts scripts/bench.ts scripts/build.ts

bench:
	node scripts/bench.ts $(BENCH_ARGS)

# Smoke run: validates the pipeline, not for publishable numbers.
bench-quick:
	node scripts/bench.ts --warmup 2 --samples 5 --sample-ms 5 $(BENCH_ARGS)

clean:
	cargo clean
	rm -rf build
