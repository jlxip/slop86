pub const PREFIX_REPZ: u8 = 0b01000;
pub const PREFIX_REPNZ: u8 = 0b10000;
pub const PREFIX_MASK_REP: u8 = PREFIX_REPZ | PREFIX_REPNZ;

pub const PREFIX_MASK_OPSIZE: u8 = 0b100000;
pub const PREFIX_MASK_ADDRSIZE: u8 = 0b1000000;

pub const PREFIX_66: u8 = PREFIX_MASK_OPSIZE;
pub const PREFIX_67: u8 = PREFIX_MASK_ADDRSIZE;
pub const PREFIX_F2: u8 = PREFIX_REPNZ;
pub const PREFIX_F3: u8 = PREFIX_REPZ;

pub const SEG_PREFIX_ZERO: u8 = 7;

pub const PREFIX_MASK_SEGMENT: u8 = 0b111;

// The remaining prefix bit records LOCK until the complete opcode is decoded.
pub const PREFIX_LOCK: u8 = 0x80;

pub fn is_legacy_prefix(opcode: u8) -> bool {
    matches!(
        opcode,
        0x26 | 0x2E | 0x36 | 0x3E | 0x64 | 0x65 | 0x66 | 0x67 | 0xF0 | 0xF2 | 0xF3
    )
}

// Allowed ModR/M.reg groups for LOCK. Every allowed form must also have a
// memory destination (ModR/M.mod != 3). Intel SDM Vol. 2A, LOCK.
pub fn lock_modrm_mask(opcode: u32) -> u8 {
    match opcode {
        0x00 | 0x01 | 0x08 | 0x09 | 0x10 | 0x11 | 0x18 | 0x19 | 0x20 | 0x21 | 0x28 | 0x29
        | 0x30 | 0x31 | 0x86 | 0x87 | 0x0FAB | 0x0FB3 | 0x0FBB | 0x0FB0 | 0x0FB1 | 0x0FC0
        | 0x0FC1 => 0xFF,
        0x80 | 0x81 | 0x82 | 0x83 => 0x7F, // ALU immediate, excluding CMP
        0xF6 | 0xF7 => 0x0C,               // NOT/NEG
        0xFE | 0xFF => 0x03,               // INC/DEC
        0x0FBA => 0xE0,                    // BTS/BTR/BTC immediate, excluding BT
        0x0FC7 => 0x02,                    // CMPXCHG8B
        _ => 0,
    }
}

pub fn lock_modrm_valid(mask: u8, modrm: u8) -> bool {
    modrm < 0xC0 && mask & (1 << (modrm >> 3 & 7)) != 0
}
