#!/usr/bin/env node

import assert from "node:assert/strict";
import { PS2 } from "../../src/ps2.js";

function controller()
{
    const levels = new Uint8Array(16);
    const edges = new Uint32Array(16);
    const reads = new Map();
    const writes = new Map();
    const cpu = {
        io: {
            register_read(port, device, handler) { reads.set(port, handler.bind(device)); },
            register_write(port, device, handler) { writes.set(port, handler.bind(device)); },
        },
        device_raise_irq(irq)
        {
            if(!levels[irq]) edges[irq]++;
            levels[irq] = 1;
        },
        device_lower_irq(irq) { levels[irq] = 0; },
    };
    new PS2(cpu, { register() {}, send() {} });
    return {
        levels, edges,
        read(port) { return reads.get(port)(); },
        write(port, value) { writes.get(port)(value); },
        mode(value) { writes.get(0x64)(0x60); writes.get(0x60)(value); },
    };
}

// DOS KEYB inhibits the keyboard in IRQ1 while consuming the F2 response.
// Delivering the next byte before AE reenters its handler and loses the ID,
// selecting an AT layout instead of an enhanced keyboard layout.
const identify = controller();
identify.write(0x60, 0xF2);
for(const [index, byte] of [0xFA, 0xAB, 0x83].entries())
{
    assert.equal(identify.levels[1], 1);
    assert.equal(identify.edges[1], index + 1);
    identify.write(0x64, 0xAD);
    assert.equal(identify.levels[1], 0, "AD must lower IRQ1");
    assert.equal(identify.read(0x64) & 1, 1, "inhibited data remains readable");
    assert.equal(identify.read(0x60), byte);
    assert.equal(identify.edges[1], index + 1, "no nested IRQ1 during KEYB's handler");
    assert.equal(identify.levels[1], 0);
    identify.write(0x64, 0xAE);
    assert.equal(identify.levels[1], index < 2 ? 1 : 0);
    const edges = identify.edges[1];
    identify.write(0x64, 0xAE);
    assert.equal(identify.edges[1], edges, "repeated AE must not create another edge");
}
assert.equal(identify.read(0x64) & 1, 0);

// Mode writes must also mask/resume pending IRQ1. Neither enable path may
// bypass the other mask, and writing the mode must not generate an ACK.
for(const mask of [0x04, 0x15, 0x14])
{
    const kbd = controller();
    kbd.write(0x60, 0xF2);
    kbd.mode(mask);
    assert.equal(kbd.levels[1], 0);
    assert.equal(kbd.read(0x60), 0xFA);
    assert.equal(kbd.edges[1], 1);
    if(!(mask & 1))
    {
        kbd.write(0x64, 0xAE);
        assert.equal(kbd.levels[1], 0, "AE must respect the IRQ enable bit");
    }
    kbd.mode(0x05);
    assert.equal(kbd.levels[1], 1);
    assert.equal(kbd.edges[1], 2);
    kbd.mode(0x05);
    assert.equal(kbd.edges[1], 2);
    assert.equal(kbd.read(0x60), 0xAB);
    assert.equal(kbd.read(0x60), 0x83);
    assert.equal(kbd.read(0x64) & 1, 0);
    kbd.mode(0x05);
    assert.equal(kbd.levels[1], 0, "no phantom IRQ on an empty buffer");
}

// Firmware can poll all identification bytes and controller replies with
// the keyboard inhibited. Reenabling after draining must not interrupt.
const polling = controller();
polling.write(0x64, 0xAD);
polling.write(0x60, 0xF2);
for(const byte of [0xFA, 0xAB, 0x83])
{
    assert.equal(polling.read(0x64) & 1, 1);
    assert.equal(polling.read(0x60), byte);
}
for(const [command, reply] of [[0x20, 0x15], [0xAA, 0x55], [0xAB, 0]])
{
    polling.write(0x64, command);
    assert.equal(polling.read(0x64) & 1, 1);
    assert.equal(polling.read(0x60), reply);
}
polling.write(0x64, 0xAE);
assert.equal(polling.edges[1], 0);

// Keyboard inhibition must not suppress AUX or relabel pending mouse data
// as keyboard data when AE or a command-register write resumes IRQ1.
const mouse = controller();
mouse.mode(0x17);
mouse.write(0x64, 0xD4);
mouse.write(0x60, 0xF2);
assert.equal(mouse.levels[12], 1);
assert.equal(mouse.read(0x64) & 0x21, 0x21);
const mouse_edges = mouse.edges[12];
mouse.write(0x64, 0xAE);
mouse.mode(0x07);
assert.equal(mouse.read(0x64) & 0x21, 0x21);
assert.equal(mouse.levels[12], 1);
assert.equal(mouse.edges[12], mouse_edges);
assert.equal(mouse.edges[1], 0);
assert.equal(mouse.read(0x60), 0xFA);
assert.equal(mouse.read(0x60), 0);
assert.equal(mouse.levels[12], 0);

console.log("PS/2 keyboard identification, IRQ inhibition, polling and AUX passed");
