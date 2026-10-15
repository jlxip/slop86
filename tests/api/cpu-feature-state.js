#!/usr/bin/env node
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
const release = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(release ? "../../build/libv86.mjs" : "../../src/main.js");

async function machine(net_device)
{
    const emulator = new V86({ memory_size: 8 << 20, autostart: false,
        bios: { url: new URL("../../bios/seabios.bin", import.meta.url).pathname },
        vga_bios: { url: new URL("../../bios/vgabios.bin", import.meta.url).pathname },
        disable_speaker: true, log_level: 0, net_device });
    await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
    return emulator;
}

const options = Object.freeze({ mtu: 1500 });
const emulator = await machine(options);
try
{
    // Let firmware initialize PCI BARs before exercising a complete machine snapshot.
    emulator.run();
    // Firmware can take over 20 seconds under emulated CI hosts.
    const deadline = Date.now() + 60000;
    while(Date.now() < deadline && !emulator.screen_adapter.get_text_screen().some(line => line.includes("No bootable device"))) await pause(10);
    await emulator.stop();
    const screen = emulator.screen_adapter.get_text_screen();
    assert.ok(screen.some(line => line.includes("No bootable device")), "firmware initialization completes\n" + screen.join("\n"));
    const cpu = emulator.v86.cpu;
    assert.ok(cpu.devices.net, "partial network options retain the default NE2000");
    assert.deepEqual(options, { mtu: 1500 }, "network defaults do not mutate caller options");
    assert.deepEqual(Array.from(cpu.pat), [0x00070406, 0x00070406]);
    assert.deepEqual(Array.from(cpu.efer), [0, 0]);
    cpu.pat.set([0x07060504, 0x01000706]);
    cpu.efer.set([0x800, 0]);
    cpu.flags[0] |= 0x100;
    const saved = await emulator.save_state();
    cpu.pat.fill(0);
    cpu.efer.fill(0);
    cpu.flags[0] &= ~0x100;
    await emulator.restore_state(saved);
    assert.deepEqual(Array.from(cpu.pat), [0x07060504, 0x01000706], "PAT snapshot round trip");
    assert.deepEqual(Array.from(cpu.efer), [0x800, 0], "EFER snapshot round trip");
    assert.ok(cpu.flags[0] & 0x100, "TF survives the extended CPU snapshot");

    // Older CPU snapshots end before the new EFER/PAT slots.
    const get_state = cpu.get_state;
    let legacy;
    try
    {
        cpu.get_state = function() { return get_state.call(this).slice(0, 92); };
        legacy = await emulator.save_state();
    }
    finally
    {
        cpu.get_state = get_state;
    }
    cpu.pat.fill(0);
    cpu.efer.fill(0xFFFFFFFF);
    await emulator.restore_state(legacy);
    assert.deepEqual(Array.from(cpu.pat), [0x00070406, 0x00070406], "legacy snapshot defaults PAT");
    assert.deepEqual(Array.from(cpu.efer), [0, 0], "legacy snapshot disables NX");
    console.log("PASS: partial NE2000 options, immutable config, PAT/EFER/TF snapshot and legacy CPU state");
}
finally
{
    await emulator.destroy();
}

const virtio = await machine({ type: "virtio", mtu: 1500 });
try
{
    assert.ok(virtio.v86.cpu.devices.virtio_net, "explicit VirtIO remains selected");
    assert.equal(virtio.v86.cpu.devices.net, undefined);
    console.log("PASS: explicit VirtIO network selection");
}
finally
{
    await virtio.destroy();
}
