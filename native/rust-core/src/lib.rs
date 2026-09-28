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

/// Byte length of a string that the binding has already encoded as UTF-8.
///
/// The work being measured is getting the string's bytes to native code;
/// once they are here, the length is known.
pub fn string_len(utf8: &[u8]) -> usize {
    utf8.len()
}

/// Length of a byte buffer that native code received.
pub fn bytes_len(data: &[u8]) -> usize {
    data.len()
}

/// 32-bit FNV-1a hash of the bytes: a serial, data-dependent pass over
/// every byte that the compiler cannot vectorise away.
pub fn checksum_bytes(data: &[u8]) -> u32 {
    data.iter().fold(0x811c_9dc5u32, |h, &b| {
        (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
    })
}

// ---- Return path (native → JS) -------------------------------------------
//
// These produce data for the bindings to hand back to JS. They write into
// memory the caller provides and never decide who owns it: that is the
// binding's job (native scratch buffer, JS-allocated buffer, JS objects).

/// The scalar returned by `return_f64`: not an integer, so an engine cannot
/// represent it as a small integer.
pub const RETURN_F64: f64 = 1.5;

pub fn return_f64() -> f64 {
    RETURN_F64
}

/// Fills `out` with printable ASCII: byte `i` is `'!' + i % 94`.
pub fn fill_ascii(out: &mut [u8]) {
    for (i, b) in out.iter_mut().enumerate() {
        *b = b'!' + (i % 94) as u8;
    }
}

/// UTF-8 pattern with one code point of each width: 1 + 2 + 3 + 4 bytes.
pub const UTF8_PATTERN: &str = "aé€😀";

/// Fills `out` with valid UTF-8 of exactly `out.len()` bytes: whole copies
/// of [`UTF8_PATTERN`], then `'x'` for the remaining (< 10) bytes.
pub fn fill_utf8(out: &mut [u8]) {
    let pattern = UTF8_PATTERN.as_bytes();
    let whole = out.len() / pattern.len() * pattern.len();
    for (chunk, dst) in out[..whole]
        .chunks_exact_mut(pattern.len())
        .zip(std::iter::repeat(pattern))
    {
        chunk.copy_from_slice(dst);
    }
    out[whole..].fill(b'x');
}

/// Fills `out` with deterministic bytes: byte `i` is `(i * 131 + 17) mod 256`.
pub fn fill_bytes(out: &mut [u8]) {
    for (i, b) in out.iter_mut().enumerate() {
        *b = (i.wrapping_mul(131).wrapping_add(17)) as u8;
    }
}

/// One row of the structured return benchmark. `name` is ASCII
/// `"row-{index}"`, at most 14 bytes, stored inline to avoid allocating.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Row {
    pub id: i32,
    pub score: f64,
    pub active: bool,
    pub name: [u8; ROW_NAME_CAPACITY],
    pub name_len: u8,
}

pub const ROW_NAME_CAPACITY: usize = 16;

impl Row {
    pub fn name(&self) -> &[u8] {
        &self.name[..self.name_len as usize]
    }
}

/// Row `index` of the deterministic dataset.
pub fn row(index: u32) -> Row {
    let mut name = [0u8; ROW_NAME_CAPACITY];
    name[..4].copy_from_slice(b"row-");
    let mut digits = [0u8; 10];
    let mut n = index;
    let mut count = 0;
    loop {
        digits[count] = b'0' + (n % 10) as u8;
        count += 1;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    for (dst, &d) in name[4..4 + count]
        .iter_mut()
        .zip(digits[..count].iter().rev())
    {
        *dst = d;
    }
    Row {
        id: index as i32,
        score: f64::from(index) * 0.5 + 0.25,
        active: index.is_multiple_of(3),
        name,
        name_len: 4 + count as u8,
    }
}

/// Bytes per row in the packed layout (little-endian):
/// `[0,4)` id i32 · `[4]` active u8 · `[5]` name length u8 · `[6,8)` zero ·
/// `[8,16)` score f64 · `[16,32)` name bytes, zero-padded.
pub const PACKED_ROW_SIZE: usize = 32;

/// Writes rows `0..out.len() / PACKED_ROW_SIZE` into `out` in the packed
/// layout and returns the row count. `out.len()` must be a multiple of
/// [`PACKED_ROW_SIZE`].
pub fn fill_rows_packed(out: &mut [u8]) -> usize {
    assert_eq!(
        out.len() % PACKED_ROW_SIZE,
        0,
        "packed rows: length is not a multiple of 32"
    );
    for (index, record) in out
        .as_chunks_mut::<PACKED_ROW_SIZE>()
        .0
        .iter_mut()
        .enumerate()
    {
        let r = row(index as u32);
        record[0..4].copy_from_slice(&r.id.to_le_bytes());
        record[4] = u8::from(r.active);
        record[5] = r.name_len;
        record[6..8].fill(0);
        record[8..16].copy_from_slice(&r.score.to_le_bytes());
        record[16..32].copy_from_slice(&r.name);
    }
    out.len() / PACKED_ROW_SIZE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills() {
        let mut a = [0u8; 96];
        fill_ascii(&mut a);
        assert_eq!((a[0], a[93], a[94]), (b'!', b'~', b'!'));

        let mut u = [0u8; 23];
        fill_utf8(&mut u);
        assert_eq!(std::str::from_utf8(&u).unwrap(), "aé€😀aé€😀xxx");

        let mut b = [0u8; 3];
        fill_bytes(&mut b);
        assert_eq!(b, [17, 148, 23]);
    }

    #[test]
    fn rows() {
        let r = row(12345);
        assert_eq!(
            (r.id, r.score, r.active, r.name()),
            (12345, 6172.75, true, &b"row-12345"[..])
        );
        assert_eq!(row(0).name(), b"row-0");
        assert_eq!(row(u32::MAX).name(), b"row-4294967295");

        let mut packed = [0xffu8; 2 * PACKED_ROW_SIZE];
        assert_eq!(fill_rows_packed(&mut packed), 2);
        let second = &packed[PACKED_ROW_SIZE..];
        assert_eq!(i32::from_le_bytes(second[0..4].try_into().unwrap()), 1);
        assert_eq!((second[4], second[5]), (0, 5));
        assert_eq!(f64::from_le_bytes(second[8..16].try_into().unwrap()), 0.75);
        assert_eq!(&second[16..21], b"row-1");
        assert!(second[21..32].iter().all(|&b| b == 0));
    }

    #[test]
    fn add_wraps() {
        assert_eq!(add_i32(2, 3), 5);
        assert_eq!(add_i32(-7, 3), -4);
        assert_eq!(add_i32(i32::MAX, 1), i32::MIN);
    }

    #[test]
    fn lengths() {
        assert_eq!(string_len("h€llo".as_bytes()), 7);
        assert_eq!(bytes_len(&[1, 2, 3]), 3);
    }

    #[test]
    fn checksum_is_fnv1a() {
        // Published FNV-1a 32-bit test vectors.
        assert_eq!(checksum_bytes(b""), 0x811c_9dc5);
        assert_eq!(checksum_bytes(b"a"), 0xe40c_292c);
        assert_eq!(checksum_bytes(b"foobar"), 0xbf9c_f968);
    }

    #[test]
    fn sum_wraps() {
        assert_eq!(sum_i32(&[]), 0);
        assert_eq!(sum_i32(&[1, 2, 3, -4]), 2);
        assert_eq!(sum_i32(&[i32::MAX, 1]), i32::MIN);
    }
}
