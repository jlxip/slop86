#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

var emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    multiboot: { url: process.argv[2] },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
});

emulator.bus.register("emulator-started", function()
{
    const cpu = emulator.v86.cpu;
    // Raise IRQ1 synchronously during the instruction protected by STI
    cpu.io.register_write(0x2011, {}, undefined, undefined, function()
    {
        const ip = cpu.instruction_pointer[0];
        const sp = cpu.reg32[4];
        cpu.device_raise_irq(1);
        assert.equal(cpu.instruction_pointer[0], ip, "IRQ delivered during STI's protected instruction");
        assert.equal(cpu.reg32[4], sp, "IRQ changed the stack during STI's protected instruction");
    });

    emulator.v86.cpu.io.register_write_consecutive(0xF4, {},
        function(value)
        {
            console.log("Test exited with code " + value);
            process.exit(value);
        },
        function() {},
        function() {},
        function() {});
});

emulator.add_listener("serial0-output-byte", function(byte)
{
    var chr = String.fromCharCode(byte);
    process.stdout.write(chr);
});
