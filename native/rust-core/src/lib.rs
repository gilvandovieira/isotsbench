//! Benchmark operations shared by every binding.
//!
//! Plain Rust with no knowledge of Node-API, FFI or WASM. Integer arithmetic
//! wraps on overflow to match the TypeScript reference (`(a + b) | 0`).

pub fn noop() {}

pub fn add_i32(a: i32, b: i32) -> i32 {
    a.wrapping_add(b)
}

pub fn sum_i32(data: &[i32]) -> i32 {
    data.iter().fold(0i32, |acc, &x| acc.wrapping_add(x))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_wraps() {
        assert_eq!(add_i32(2, 3), 5);
        assert_eq!(add_i32(-7, 3), -4);
        assert_eq!(add_i32(i32::MAX, 1), i32::MIN);
    }

    #[test]
    fn sum_wraps() {
        assert_eq!(sum_i32(&[]), 0);
        assert_eq!(sum_i32(&[1, 2, 3, -4]), 2);
        assert_eq!(sum_i32(&[i32::MAX, 1]), i32::MIN);
    }
}
