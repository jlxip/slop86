#!/usr/bin/env node
import assert from "node:assert/strict";
import { PS2 } from "../../src/ps2.js";
import { VMwareMouse } from "../../src/vmware.js";

const callbacks = new Map();
const bus = {
    register(name, fn, owner) { const list = callbacks.get(name) || []; list.push(fn.bind(owner)); callbacks.set(name, list); },
    send(name, data) { for(const fn of callbacks.get(name) || []) fn(data); },
};
const cpu = {
    devices: {}, reg32: new Int32Array(8),
    io: { register_read() {}, register_write() {} },
    device_raise_irq() {}, device_lower_irq() {},
};
const ps2 = cpu.devices.ps2 = new PS2(cpu, bus);
const mouse = cpu.devices.vmware = new VMwareMouse(cpu, bus);
ps2.have_mouse = ps2.use_mouse = true;
ps2.enable_mouse_stream = true;
ps2.command_register &= ~0x20;
mouse.enabled = mouse.absolute = true;
function drain(expected)
{
    const records = mouse.queue.length / 4;
    assert.equal(records, expected.length);
    assert.equal(ps2.mouse_buffer.length, records * 3, "one PS/2 packet per VMware record");
    for(const status of expected)
    {
        // The driver reads one VMware record per PS/2 callback; PS/2 button
        // bits must be neutral so they cannot contaminate a later record.
        assert.deepEqual([ps2.mouse_buffer.shift(), ps2.mouse_buffer.shift(), ps2.mouse_buffer.shift()], [8, 0, 0]);
        assert.equal(mouse.queue.splice(0, 4)[0], status);
    }
    assert.equal(mouse.queue.length, 0);
}
bus.send("mouse-absolute", [10, 20, 100, 100]);
drain([0]); // Hover alone must wake the guest.
bus.send("mouse-absolute", [20, 30, 100, 100]);
bus.send("mouse-absolute", [70, 80, 100, 100]);
assert.equal(mouse.queue[1], Math.round(.7 * 65535));
drain([0]); // Coalesced motion has only one notification.
bus.send("mouse-absolute", [30, 40, 100, 100]);
bus.send("mouse-click", [true, false, false]);
bus.send("mouse-click", [false, false, false]);
drain([0, 0x20, 0]); // One tap drains the release without requiring another move.
bus.send("mouse-absolute", [40, 50, 100, 100]);
bus.send("mouse-absolute", [50, 60, 100, 100]);
bus.send("mouse-click", [false, false, true]);
bus.send("mouse-absolute", [60, 70, 100, 100]);
bus.send("mouse-click", [false, false, false]);
drain([0, 0x10, 0x10, 0]);
bus.send("mouse-wheel", [-1, 0]);
assert.equal(mouse.queue[3], 1);
drain([0]);
bus.send("mouse-pointer-lock", true);
bus.send("mouse-delta", [4, -3]);
bus.send("mouse-click", [true, false, false]);
bus.send("mouse-click", [false, false, false]);
drain([0x10000, 0x10020, 0x10000]);
mouse.absolute = false;
bus.send("mouse-delta", [2, 1]);
assert.equal(mouse.queue.length, 0);
assert.equal(ps2.mouse_buffer.length, 3, "non-absolute guest keeps legacy PS/2");
console.log("VMware absolute/relative notification ordering and PS/2 fallback PASS");
