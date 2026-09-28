// Pure TypeScript reference implementations. Semantics match
// native/rust-core: i32 arithmetic wraps on overflow.

export function noop(): void {}

export function add_i32(a: number, b: number): number {
  return (a + b) | 0;
}

export function sum_i32(data: Int32Array): number {
  let acc = 0;
  for (let i = 0; i < data.length; i++) acc = (acc + data[i]) | 0;
  return acc;
}
