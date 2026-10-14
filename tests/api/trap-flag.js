#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {setTimeout as pause} from "node:timers/promises";
import {fileURLToPath} from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const release = +process.env.TEST_RELEASE_BUILD;
const {V86} = await import(new URL(release ? "build/libv86.mjs" : "src/main.js", "file://" + root + "/"));
const source = fileURLToPath(new URL("trap-flag.asm", import.meta.url));
const output = path.join(root, "build/trap-flag-tests");
fs.mkdirSync(output, {recursive: true});
const cases = ["", "POPF", "clear TF with POPF", "IRET", "REP MOVSB", "REPE SCASB", "MOV SS", "POP SS", "STI", "INT3", "UD2", "zero-count REP", "MOV SS then clear TF", "REPNE SCASB", "cached entry with TF", "opposite-size POPF/prefix", "#DB before synchronous IRQ", "TF snapshot restore", "ICEBP", "GS-prefixed ICEBP", "ICEBP with TF", "user ICEBP through DPL0 gate", "ICEBP with multiple prefixes", "LOCK ICEBP", "LOCK INT3", "LOCK GS ICEBP", "LOCK register INC", "LOCK memory INC", "LOCK read-only ADD form", "LOCK memory BTC", "LOCK CMP immediate", "LOCK read-only BT", "LOCK with size overrides and TF", "LOCK across code-page boundary", "duplicate LOCK on ICEBP"];
let passed = 0;
for(const bits of [16, 32]) for(let test = 1; test < cases.length; test++)
{
    if(test === 21 && bits !== 32) continue;
    const binary = path.join(output, `${bits}-${test}.bin`);
    const result = spawnSync("nasm", ["-f", "bin", `-DMODE=${bits}`, `-DCASE=${test}`, source, "-o", binary], {encoding:"utf8"});
    assert.equal(result.status, 0, result.stderr);
    const code = fs.readFileSync(binary);
    const header = Array.from({length:8}, (_, i) => code.readUInt32LE(i*4));
    const [entry, db, bp, ud_handler, expect_ptr, count, irq, bad] = header;
    const expected = Array.from({length: count}, (_, i) => code.readUInt32LE(expect_ptr-0x1000+i*4));
    for(const interpreter of [true, false])
    {
        const emulator = new V86({memory_size:8<<20,autostart:false,disable_speaker:true,log_level:0,
            wasm_path:process.env.TF_WASM || path.join(root, release ? "build/v86.wasm" : "build/v86-debug.wasm")});
        try
        {
            await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
            const cpu = emulator.v86.cpu;
            cpu.write_blob(code, 0x1000);
            cpu.segment_offsets.fill(0);
            cpu.sreg.fill(0);
            cpu.segment_is_null.fill(0);
            cpu.segment_limits.fill(bits === 32 ? -1 : 0xFFFF);
            cpu.flags[0] = 2;
            cpu.flags_changed[0] = 0;
            cpu.reg32.fill(0);
            cpu.reg32[4] = 0xF000;
            cpu.instruction_pointer[0] = entry;
            cpu.in_hlt[0] = 0;
            cpu.dreg[6] = 0xFFFF0FF3 | 0;
            if(bits === 32)
            {
                cpu.protected_mode[0] = 1;
                cpu.cr[0] |= 1;
                cpu.is_32[0] = cpu.stack_size_32[0] = 1;
                cpu.gdtr_offset[0] = 0x7000;
                cpu.gdtr_size[0] = 23;
                cpu.write32(0x7008, 0xFFFF);
                cpu.write32(0x700C, 0xCF9B00);
                cpu.write32(0x7010, 0xFFFF);
                cpu.write32(0x7014, 0xCF9300);
                cpu.sreg.fill(16);
                cpu.sreg[1] = 8;
                cpu.segment_access_bytes.fill(0x93);
                cpu.segment_access_bytes[1] = 0x9B;
                cpu.idtr_offset[0] = 0x8000;
                cpu.idtr_size[0] = 0x7FF;
                for(const [vector, addr] of [[1,db],[3,bp],[6,ud_handler],[0x21,irq]])
                {
                    cpu.write32(0x8000+vector*8, (addr&0xFFFF)|8<<16);
                    cpu.write32(0x8004+vector*8, (addr&0xFFFF0000)|0x8E00);
                }
            }
            else for(const [vector, addr] of [[1,db],[3,bp],[6,ud_handler],[0x21,irq]]) cpu.write32(vector*4, addr);
            if(test === 21)
            {
                // Ring 3 code/stack, with an IDT gate whose DPL remains zero.
                // INT imm8 would #GP, whereas F1 must deliver #DB.
                cpu.gdtr_size[0] = 39;
                cpu.write32(0x7018, 0xFFFF);
                cpu.write32(0x701C, 0xCFFB00);
                cpu.write32(0x7020, 0xFFFF);
                cpu.write32(0x7024, 0xCFF300);
                cpu.sreg.fill(0x23);
                cpu.sreg[1] = 0x1B;
                cpu.cpl[0] = 3;
                cpu.segment_access_bytes.fill(0xF3);
                cpu.segment_access_bytes[1] = 0xFB;
                cpu.write32(0x8008, (db & 0xFFFF) | 0x1B << 16);
            }
            cpu.write32(0x9004, test === 2 ? 10 : Math.max(count, 1));
            cpu.update_state_flags();
            cpu.set_jit_config(0, +interpreter);
            if(!interpreter && !release)
            {
                async function compile(addr)
                {
                    await new Promise((resolve,reject) => {
                        const timer = setTimeout(() => reject(Error("JIT compilation timed out")), 2000);
                        cpu.test_hook_did_finalize_wasm = () => {clearTimeout(timer);cpu.test_hook_did_finalize_wasm=null;resolve();};
                        cpu.jit_force_generate(addr);
                    });
                }
                await compile(entry);
                if(test === 1 || test === 3) await compile(expected[0]-1);
            }
            if(test === 14 || test === 17) cpu.flags[0] |= 0x100;
            if(test === 17)
            {
                // This firmware-free fixture has PCI BAR holes that a BIOS
                // normally initializes before a full machine snapshot is saved.
                const pci = cpu.devices.pci;
                pci.devices.forEach((device, id) => {
                    if(!device) return;
                    for(let i = 0; i < device.pci_bars.length; i++)
                    {
                        if(!device.pci_bars[i]) pci.device_spaces[id][4+i] = 0;
                    }
                });
                const state = await emulator.save_state();
                cpu.flags[0] &= ~0x100;
                await emulator.restore_state(state);
                assert.ok(cpu.flags[0] & 0x100, "snapshot restores TF");
            }
            if(test === 16) cpu.io.register_write(0x2012, {}, value => {
                const ip = cpu.instruction_pointer[0], sp = cpu.reg32[4];
                cpu.device_raise_irq(1);
                assert.equal(cpu.instruction_pointer[0], ip, "IRQ must wait for #DB");
                assert.equal(cpu.reg32[4], sp, "IRQ must not alter the stepping stack");
            });
            emulator.run();
            for(let i=0;i<200 && !(test === 21 ? cpu.read32s(0x9020) : cpu.in_hlt[0]);i++) await pause(10);
            await emulator.stop();
            const label = `${bits}-bit ${interpreter ? "interpreter" : "JIT"}: ${cases[test]}`;
            assert.equal(test === 21 ? cpu.read32s(0x9020) : cpu.in_hlt[0], 1, label+": must finish");
            const actual_count = cpu.read32s(0x9000);
            assert.equal(actual_count, count, label+": trap count");
            const records = Array.from({length:actual_count}, (_, i) => Array.from({length:6}, (_, j) => cpu.read32s(0x9100+i*24+j*4)>>>0));
            assert.deepEqual(records.map(r=>r[0]), expected, label+": saved IP");
            for(const r of records)
            {
                assert.equal(r[2], test === 21 ? 0 : test >= 18 && test <= 22 ? 0xFFFF0FF3 : 0xFFFF4FF3, label+": DR6 state");
                assert.equal(r[4]&0x100, 0, label+": handler runs with TF clear");
            }
            if(test >= 18 && test <= 22 && test !== 20) for(const r of records) assert.equal(r[1]&0x100,0,label+": ICEBP requires no TF");
            else if(test === 2 || test === 12) assert.equal(records.at(-1)[1]&0x100,0,label+": POPF already cleared TF");
            else for(const r of records) assert.equal(r[1]&0x100,0x100,label+": saved TF");
            assert.equal(cpu.read32s(0x9008), +(test===9),label+": INT3 delivery");
            const ud = test === 10 || [23,24,25,26,28,30,31,33,34].includes(test);
            assert.equal(cpu.read32s(0x900C), +ud,label+": #UD delivery");
            if(test >= 23 && ud)
            {
                assert.equal(cpu.read32s(0x9024),bad,label+": fault points to first prefix");
                assert.equal(cpu.reg32[0],0x33,label+": invalid instruction has no side effects");
            }
            if([27,29,32].includes(test)) assert.equal(cpu.read32s(0xA000),{27:1,29:2,32:3}[test],label+": locked memory update");
            if(test===4 || test===5) assert.deepEqual(records.map(r=>r[3]),[2,1,0],label+": REP iterations");
            if(test===13) assert.equal(records[0][3],2,label+": REPNE termination");
            if(test === 16)
            {
                assert.equal(cpu.read32s(0x9010),1,label+": IRQ delivered");
                assert.equal(cpu.read32s(0x9014),1,label+": #DB precedes IRQ");
            }
            if(test >= 18 && test <= 22) assert.equal(cpu.dreg[6]>>>0,0xFFFF0FF3,label+": ICEBP preserves DR6");
            passed++;
            console.log("PASS "+label);
        }
        finally {await emulator.destroy();}
    }
}
console.log(`${passed} single-step tests passed`);
