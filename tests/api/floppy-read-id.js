#!/usr/bin/env node

import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const emulator = new V86({
    wasm_path: new URL(+process.env.TEST_RELEASE_BUILD ? "../../build/v86.wasm" : "../../build/v86-debug.wasm", import.meta.url).pathname,
    memory_size: 8 * 1024 * 1024,
    hda: { buffer: new ArrayBuffer(512) },
    fda: { buffer: new ArrayBuffer(1440 * 1024) },
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));

const cpu = emulator.v86.cpu;
const fdc = cpu.devices.fdc;
const write = (port, value) => cpu.io.ports[port].write8.call(fdc, value);
const read = port => cpu.io.ports[port].read8.call(fdc, port);
let interrupts = 0;
const raise_irq = cpu.device_raise_irq;
cpu.device_raise_irq = irq => {
    if(irq === 6) interrupts++;
    raise_irq(irq);
};
function command()
{
    const start = performance.now();
    write(0x3F5, 0x4A);
    write(0x3F5, 0);
    return start;
}
function result()
{
    return Array.from({ length: 7 }, () => read(0x3F5));
}
function tick(now)
{
    return cpu.run_hardware_timers(false, now);
}
try
{
    // Results and IRQ must not be visible during the final command OUT.
    let start = command();
    assert.equal(interrupts, 0, "READ ID must not raise a synchronous IRQ");
    assert.equal(read(0x3F4) & 0xD0, 0x10, "controller must remain busy without a result");
    assert.ok(tick(start + 1) <= 20, "pending READ ID must wake an idle CPU");
    assert.equal(interrupts, 0, "READ ID must not complete early");
    tick(start + 25);
    assert.equal(interrupts, 1);
    assert.equal(read(0x3F4) & 0xD0, 0xD0);
    assert.deepEqual(result(), [0, 0, 0, 0, 0, 2, 2]);
    tick(start + 100);
    assert.equal(interrupts, 1, "completion must raise only one IRQ");

    // There are no host callbacks that can mutate a paused or destroyed VM.
    start = command();
    await pause(30);
    assert.equal(interrupts, 1, "stopped VM must not complete READ ID");
    tick(start + 40);
    assert.equal(interrupts, 2);
    result();

    // Saving/restoring an in-flight operation retains the remaining delay.
    command();
    const state = await emulator.save_state();
    tick(performance.now() + 100);
    result();
    await emulator.restore_state(state);
    const before_restore_tick = interrupts;
    assert.equal(read(0x3F4) & 0xD0, 0x10);
    tick(performance.now() + 25);
    assert.equal(interrupts, before_restore_tick + 1);
    assert.deepEqual(result().slice(0, 3), [0, 0, 0]);
    tick(performance.now() + 100);
    assert.equal(interrupts, before_restore_tick + 1);

    // Restoring an idle state replaces (and cancels) any pending command.
    const idle_state = await emulator.save_state();
    command();
    await emulator.restore_state(idle_state);
    let before = interrupts;
    tick(performance.now() + 100);
    assert.equal(interrupts, before);

    // Older snapshots have no pending timer field.
    const old_state = fdc.get_state().slice(0, 46);
    command();
    fdc.set_state(old_state);
    before = interrupts;
    tick(performance.now() + 100);
    assert.equal(interrupts, before);

    // Legacy register-only snapshots must not leave an abandoned command busy.
    command();
    fdc.set_state([]);
    tick(performance.now() + 100);
    assert.equal(interrupts, before);
    assert.equal(read(0x3F4) & 0xD0, 0x80);

    // Cancel on reset assertion, not just when reset is released.
    command();
    write(0x3F2, 0x08);
    before = interrupts;
    tick(performance.now() + 100);
    assert.equal(interrupts, before, "READ ID must not complete during reset");
    write(0x3F2, 0x0C);
    before = interrupts;
    tick(performance.now() + 100);
    assert.equal(interrupts, before, "reset must not leave a stale completion");
    for(let i = 0; i < 4; i++)
    {
        write(0x3F5, 8);
        read(0x3F5);
        read(0x3F5);
    }

    // A reset must not cancel a later command with a new deadline.
    start = command();
    tick(start + 1);
    assert.equal(interrupts, before);
    tick(start + 25);
    assert.equal(interrupts, before + 1);
    result();

    // Ejection while the command is pending cannot return a valid sector ID.
    start = command();
    emulator.eject_fda();
    tick(start + 25);
    assert.deepEqual(result().slice(0, 3), [0x40, 1, 0]);

    // Both the software reset and a whole-machine reset cancel pending work.
    await emulator.restore_state(idle_state);
    command();
    write(0x3F4, 0x80);
    before = interrupts;
    tick(performance.now() + 100);
    assert.equal(interrupts, before);
    await emulator.restore_state(idle_state);
    command();
    cpu.reboot_internal();
    before = interrupts;
    tick(performance.now() + 100);
    assert.equal(interrupts, before);
    assert.equal(read(0x3F4) & 0xD0, 0x80);

    await emulator.restore_state(idle_state);
    command();
    before = interrupts;
    await emulator.destroy();
    await pause(30);
    assert.equal(interrupts, before, "destroyed VM must not raise a late IRQ");
    console.log("Floppy READ ID timing, state and reset tests passed");
}
finally
{
    await emulator.destroy();
}
