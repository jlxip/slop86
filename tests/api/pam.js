#!/usr/bin/env node

import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";

const release = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(release ? "../../build/libv86.mjs" : "../../src/main.js");
const emulator = new V86({
    wasm_path: new URL(release ? "../../build/v86.wasm" : "../../build/v86-debug.wasm", import.meta.url).pathname,
    memory_size: 8 * 1024 * 1024,
    autostart: false,
    disable_speaker: true,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
const cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
const pam = value => pci.pci_write8(0x8000005A | 0, value);

async function run(code, force_compile = false)
{
    if(code) cpu.write_blob(new Uint8Array(code), 0x1000);
    cpu.segment_offsets[1] = 0;
    cpu.sreg[1] = 0;
    cpu.instruction_pointer[0] = 0x1000;
    cpu.flags[0] = 2;
    cpu.in_hlt[0] = 0;
    cpu.reg32[1] = 20000;
    cpu.update_state_flags();
    if(force_compile && !release)
    {
        await new Promise(resolve => {
            cpu.test_hook_did_finalize_wasm = () => {
                cpu.test_hook_did_finalize_wasm = null;
                resolve();
            };
            cpu.jit_force_generate(0x1000);
        });
    }
    emulator.run();
    for(let i = 0; i < 500 && !cpu.in_hlt[0]; i++) await pause(10);
    await emulator.stop();
    assert.equal(cpu.in_hlt[0], 1, "guest must reach HLT");
}

try
{
    // All thirteen PAM fields, independently writable in 16/64 KiB units.
    for(let region = 0; region < 16; region++)
    {
        const reg = region < 12 ? 0x5A + (region >> 1) : 0x59;
        const shift = region < 12 ? (region & 1) * 4 : 4;
        const addr = 0xC0000 + region * 0x4000;
        pci.pci_write8(0x80000000 | reg, 1 << shift);
        cpu.mem8[addr] = 0xA5;
        cpu.write8(addr, 0xFF);
        assert.equal(cpu.read8(addr), 0xA5);
        pci.pci_write8(0x80000000 | reg, 3 << shift);
        cpu.write8(addr, 0x5A);
        assert.equal(cpu.read8(addr), 0x5A);
    }
    // Aligned PCI word/dword accesses overlapping the PAM registers.
    pci.pci_write16(0x8000005A | 0, 0x1111);
    cpu.mem8.fill(0xA5, 0xC0000, 0xD0000);
    cpu.write32(0xC0000, -1);
    assert.equal(cpu.read32s(0xC0000), 0xA5A5A5A5 | 0);
    pci.pci_write32(0x80000058 | 0, 0x33333000);
    cpu.write32(0xC0000, -1);
    assert.equal(cpu.read32s(0xC0000), -1);

    pam(0x31); // first region protected, second writable
    cpu.mem8.fill(0xA5, 0xC3FFC, 0xC4004);
    cpu.write32(0xC3FFE, 0x11223344);
    assert.deepEqual(Array.from(cpu.mem8.slice(0xC3FFE, 0xC4002)), [0xA5, 0xA5, 0x22, 0x11]);
    // Only the host bridge is needed here; unconfigured BARs on unrelated
    // devices are normally initialized by firmware before a full snapshot.
    const saved = pci.get_state().map((value, i) =>
        value && (i === 0 || i >= 256) ? value.slice() : undefined);
    pam(0x33);
    pci.set_state(saved);
    cpu.write16(0xC0000, 0);
    assert.equal(cpu.read16(0xC0000), 0xFFFF, "snapshot restores PAM protection");

    // MOV and read-modify-write in a hot loop. Reuse compiled code across PAM changes.
    const loop = [0x67, 0x66, 0xC7, 0x07, 0x44, 0x33, 0x22, 0x11,
        0x67, 0x66, 0x83, 0x07, 1, 0x66, 0x49, 0x75, 0xEF, 0xF4];
    for(const interpreter of [true, false])
    {
        cpu.set_jit_config(0, +interpreter);
        cpu.reg32[7] = 0xC0100;
        pam(0x33);
        await run(loop, !interpreter);
        assert.equal(cpu.read32s(0xC0100), 0x11223345);
        pam(0x11);
        cpu.mem8.fill(0xA5, 0xC0100, 0xC0104);
        await run();
        assert.equal(cpu.read32s(0xC0100), 0xA5A5A5A5 | 0);
        pam(0x33);
        await run();
        assert.equal(cpu.read32s(0xC0100), 0x11223345);

        pam(0x31);
        cpu.mem8.fill(0xA5, 0xC3FFE, 0xC4002);
        cpu.reg32[7] = 0xC3FFE;
        await run();
        assert.deepEqual(Array.from(cpu.mem8.slice(0xC3FFE, 0xC4002)), [0xA5, 0xA5, 0x22, 0x11]);

        // Scalar and SSE stores, including 64/128-bit writes across PAM regions.
        cpu.cr[4] |= 0x200; // OSFXSR
        cpu.reg_xmm32s.fill(0);
        cpu.reg32[0] = 0;
        for(const [store, bytes] of [
            [[0x67, 0x88, 0x07], 1], [[0x67, 0x89, 0x07], 2],
            [[0x67, 0x0F, 0x13, 0x07], 8], [[0x67, 0x0F, 0x11, 0x07], 16],
        ])
        {
            const code = [...store, 0x66, 0x49, 0x75, 256 - store.length - 4, 0xF4];
            for(const crossing of [false, true])
            {
                const addr = crossing ? 0xC4000 - Math.max(1, bytes / 2) : 0xC0100;
                pam(0x31);
                cpu.reg32[7] = addr;
                cpu.mem8.fill(0xA5, addr, addr + bytes);
                await run(code, !interpreter);
                for(let i = 0; i < bytes; i++)
                {
                    assert.equal(cpu.mem8[addr + i], addr + i < 0xC4000 ? 0xA5 : 0);
                }
                pam(0x33);
                await run();
                assert.ok(cpu.mem8.slice(addr, addr + bytes).every(x => x === 0));
            }
        }

        // The same physical ROM through a writable, global virtual alias.
        cpu.mem32s.fill(0, 0x40000 >> 2, 0x42000 >> 2);
        cpu.mem32s[0x40000 >> 2] = 0x41003;
        for(let i = 0; i < 1024; i++) cpu.mem32s[(0x41000 >> 2) + i] = i * 4096 | 0x103;
        cpu.mem32s[(0x41000 >> 2) + 0x200] = 0xC0103;
        cpu.cr[3] = 0x40000;
        cpu.cr[4] |= 0x80;
        cpu.cr[0] |= 0x80000001;
        cpu.protected_mode[0] = 1;
        cpu.full_clear_tlb();
        cpu.reg32[7] = 0x200100;
        pam(0x33);
        await run(loop, !interpreter);
        assert.equal(cpu.read32s(0xC0100), 0x11223345);
        pam(0x11);
        cpu.mem8.fill(0xA5, 0xC0100, 0xC0104);
        await run();
        assert.equal(cpu.read32s(0xC0100), 0xA5A5A5A5 | 0);
        cpu.cr[0] &= ~0x80000001;
        cpu.protected_mode[0] = 0;
        cpu.full_clear_tlb();

        // REP STOSB and MOVSB must not use a bulk-copy bypass into ROM.
        for(const opcode of [0xAA, 0xA4])
        {
            pam(0x11);
            cpu.reg32[7] = 0xC0000;
            cpu.reg32[6] = 0x20000;
            cpu.reg32[0] = 0xFF;
            cpu.mem8.fill(0xFF, 0x20000, 0x28000);
            cpu.mem8.fill(0xA5, 0xC0000, 0xC8000);
            await run([0x67, 0xF3, opcode, 0xF4], !interpreter);
            assert.ok(cpu.mem8.slice(0xC0000, 0xC8000).every(x => x === 0xA5));
        }
    }
    console.log("PAM permissions, PCI access widths, boundaries, snapshots, interpreter and JIT passed");
}
finally
{
    await emulator.destroy();
}
