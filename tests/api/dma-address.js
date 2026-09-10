#!/usr/bin/env node

import assert from "node:assert/strict";
import { DMA } from "../../src/dma.js";

const cpu = {
    io: { register_read() {}, register_write() {} },
    mem8: new Uint8Array(16 << 20),
};
const dma = new DMA(cpu);

function transfer(channel, page, address, expected)
{
    cpu.mem8.fill(0);
    const payload = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    cpu.mem8.set(payload, expected);
    dma.channel_page[channel] = page;
    dma.channel_addr[channel] = address;
    dma.channel_count[channel] = channel >= 5 ? 15 : 31;
    let completed = false;
    dma.do_write({
        byteLength: payload.length,
        set(offset, data, done)
        {
            assert.equal(offset, 0);
            assert.deepEqual(data, payload, `DMA channel ${channel}, page ${page}, address ${address}`);
            done();
        },
    }, 0, payload.length, channel, error =>
    {
        assert.equal(error, false);
        completed = true;
    });
    assert.ok(completed);
    assert.equal(dma.channel_count[channel], 0xFFFF);
}

// Windows 98's 16-bit SB16 buffer: page FC, word offset 8000 means FD0000.
// Preserve address bit 16, and ignore bit 0 of the page on word channels.
for(const channel of [5, 6, 7])
{
    transfer(channel, 0xFC, 0x8000, 0xFD0000);
    transfer(channel, 0xFD, 0x0000, 0xFC0000);
    transfer(channel, 0xFD, 0x8000, 0xFD0000);
    transfer(channel, 0xFC, 0x7FF8, 0xFCFFF0);
}

// Byte channels retain all page bits and byte-based addressing.
for(const channel of [0, 1, 2, 3])
{
    transfer(channel, 0xFD, 0x8000, 0xFD8000);
}

console.log("DMA byte/word addressing and transfers passed");
