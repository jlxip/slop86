#!/usr/bin/env node
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buffer_from_object } from "../../src/buffer.js";

const release = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(release ? "../../build/libv86.mjs" : "../../src/main.js");
const timeout = setTimeout(() => { throw Error("Disk adapter test timed out"); }, 30000);
timeout.unref();

class MemoryDisk
{
    constructor(asynchronous)
    {
        this.bytes = new Uint8Array(1024 * 1024);
        this.byteLength = this.bytes.length;
        this.asynchronous = asynchronous;
        this.calls = [];
        this.cache = undefined;
        this.saved = 0;
        this.restored = 0;
    }
    complete(callback)
    {
        if(this.asynchronous) Promise.resolve().then(callback);
        else callback();
    }
    load()
    {
        this.calls.push(["load"]);
        this.complete(() => this.onload({ buffer: this }));
    }
    get(start, length, done)
    {
        this.calls.push(["get", start, length]);
        this.complete(() => done(this.bytes.slice(start, start + length)));
    }
    get_and_cache(start, length, done)
    {
        this.calls.push(["get_and_cache", start, length]);
        this.get(start, length, bytes =>
        {
            this.cache = { start, bytes };
            done(bytes);
        });
    }
    get_from_cache(start, length)
    {
        this.calls.push(["get_from_cache", start, length]);
        if(this.cache && start >= this.cache.start && start + length <= this.cache.start + this.cache.bytes.length)
        {
            return this.cache.bytes.slice(start - this.cache.start, start - this.cache.start + length);
        }
    }
    set(start, bytes, done)
    {
        this.calls.push(["set", start, bytes.length]);
        this.complete(() =>
        {
            this.bytes.set(bytes, start);
            this.cache = undefined;
            done();
        });
    }
    get_state()
    {
        this.saved++;
        return [1, this.byteLength, this.bytes.slice()];
    }
    set_state(state)
    {
        this.restored++;
        assert.equal(state[0], 1);
        assert.equal(state[1], this.byteLength);
        this.bytes.set(state[2]);
        this.cache = undefined;
    }
}

const valid = new MemoryDisk(false);
assert.ok(buffer_from_object({ disk_adapter: valid }) === valid, "adapter must not be wrapped or copied");
assert.ok(buffer_from_object({ disk_adapter: valid, buffer: new ArrayBuffer(512) }) === valid);
const error = { message: "Invalid encrypted disk adapter" };
for(const byte_length of [undefined, 0, -512, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "512"])
{
    const adapter = new MemoryDisk(false);
    adapter.byteLength = byte_length;
    assert.throws(() => buffer_from_object({ disk_adapter: adapter }), error);
}
for(const byte_length of [1, Number.MAX_SAFE_INTEGER])
{
    const adapter = new MemoryDisk(false);
    adapter.byteLength = byte_length;
    assert.ok(buffer_from_object({ disk_adapter: adapter }) === adapter);
}
for(const method of ["load", "get", "set", "get_from_cache"])
{
    for(const value of [undefined, 1])
    {
        const adapter = new MemoryDisk(false);
        adapter[method] = value;
        assert.throws(() => buffer_from_object({ disk_adapter: adapter }), error);
    }
}
// Keep the existing validation boundary. These additional methods are part of
// the documented runtime contract, but are not checked by this entry point.
const partial = new MemoryDisk(false);
partial.get_and_cache = partial.get_state = partial.set_state = undefined;
assert.equal(buffer_from_object({ disk_adapter: partial }), partial);

async function create(image)
{
    const emulator = new V86({
        hda: image, memory_size: 8 * 1024 * 1024,
        wasm_path: fileURLToPath(new URL(release ? "../../build/v86.wasm" : "../../build/v86-debug.wasm", import.meta.url)),
        autostart: false, disable_speaker: true, log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    return emulator;
}

function command(io, sector, opcode)
{
    io.port_write8(0x1F6, 0xE0);
    io.port_write8(0x1F2, 1);
    io.port_write8(0x1F3, sector);
    io.port_write8(0x1F4, 0);
    io.port_write8(0x1F5, 0);
    io.port_write8(0x1F7, opcode);
}

function event(emulator, name)
{
    return new Promise(resolve =>
    {
        const listener = data =>
        {
            emulator.remove_listener(name, listener);
            resolve(data);
        };
        emulator.add_listener(name, listener);
    });
}

async function read(emulator, sector)
{
    const io = emulator.v86.cpu.io;
    const completed = event(emulator, "ide-read-end");
    command(io, sector, 0x20);
    await completed;
    assert.ok(io.port_read8(0x1F7) & 8, "read must expose DRQ after completion");
    const data = new Uint8Array(512);
    for(let i = 0; i < data.length; i += 2)
    {
        const word = io.port_read16(0x1F0);
        data[i] = word & 255;
        data[i + 1] = word >>> 8;
    }
    return data;
}

async function write(emulator, sector, data)
{
    const io = emulator.v86.cpu.io;
    const completed = event(emulator, "ide-write-end");
    command(io, sector, 0x30);
    assert.ok(io.port_read8(0x1F7) & 8, "write must request data");
    for(let i = 0; i < data.length; i += 2)
    {
        io.port_write16(0x1F0, data[i] | data[i + 1] << 8);
    }
    await completed;
}

try
{
    for(const asynchronous of [false, true])
    {
        const adapter = new MemoryDisk(asynchronous);
        assert.equal(adapter.get_from_cache(0, 512), undefined);
        const emulator = await create({ disk_adapter: adapter });
        try
        {
            assert.equal(emulator.v86.cpu.devices.ide.primary.master.buffer, adapter);
            assert.equal(typeof adapter.onload, "function");
            assert.ok(adapter.calls.some(call => call[0] === "get_and_cache" && call[1] === 0 && call[2] === 512));
            assert.deepEqual(adapter.get_from_cache(0, 512), new Uint8Array(512));
            const payload = Uint8Array.from({ length: 512 }, (_, i) => (i * 17 + 3) & 255);
            await write(emulator, 7, payload);
            assert.equal(adapter.get_from_cache(0, 512), undefined, "writes invalidate cache");
            assert.deepEqual(await read(emulator, 7), payload);
            assert.ok(adapter.calls.some(call => call[0] === "set" && call[1] === 7 * 512 && call[2] === 512));
            assert.ok(adapter.calls.some(call => call[0] === "get" && call[1] === 7 * 512 && call[2] === 512));
            emulator.v86.cpu.mem8[0x70000] = 41;
            const state = await emulator.save_state();
            assert.equal(adapter.saved, 1);
            await write(emulator, 7, new Uint8Array(512));
            emulator.v86.cpu.mem8[0x70000] = 99;
            await emulator.restore_state(state);
            assert.equal(adapter.restored, 1);
            assert.equal(emulator.v86.cpu.devices.ide.primary.master.buffer, adapter);
            assert.equal(emulator.v86.cpu.mem8[0x70000], 41);
            assert.deepEqual(await read(emulator, 7), payload);
            console.log(`Disk adapter ${asynchronous ? "async" : "sync"}: initialization, IDE IO, cache and snapshot PASS`);
        }
        finally { await emulator.destroy(); }
    }
    const original = new ArrayBuffer(1024 * 1024);
    const emulator = await create({ buffer: original, disk_adapter: null });
    try
    {
        const bytes = new Uint8Array(512).fill(0xA5);
        await write(emulator, 3, bytes);
        assert.deepEqual(await read(emulator, 3), bytes);
        assert.deepEqual(new Uint8Array(original, 3 * 512, 512), bytes);
        console.log("ArrayBuffer disk regression PASS");
    }
    finally { await emulator.destroy(); }
}
finally { clearTimeout(timeout); }
console.log(`Disk adapter validation and ${release ? "release bundle" : "source"} API tests PASS`);
