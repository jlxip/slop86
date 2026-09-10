#!/usr/bin/env node

import assert from "node:assert/strict";
import { PIT, OSCILLATOR_FREQ } from "../../src/pit.js";

function timer()
{
    const cpu = {
        io: { register_read() {}, register_write() {} },
        device_raise_irq() {},
        device_lower_irq() {},
    };
    const pit = new PIT(cpu, { send() {} });
    pit.counter_enabled[0] = 1;
    pit.counter_mode[0] = 2;
    pit.counter_reload[0] = 1193;
    pit.counter_start_value[0] = 500;
    return pit;
}

// Windows polls this ~1 kHz PIT setting with interrupts disabled. Repeated
// updates on WebKit's 1 ms clock must not freeze the phase at the initial value.
const coarse = timer();
for(let now = 1; now <= 1000; now++)
{
    coarse.timer(now, false);
}
assert.equal(coarse.get_counter_value(0, 1000), 319);

// Sampling frequency must not change the total elapsed hardware time.
const fine = timer();
for(let now = 0.125; now <= 1000; now += 0.125)
{
    fine.timer(now, false);
}
assert.equal(fine.get_counter_value(0, 1000), coarse.get_counter_value(0, 1000));

// Check irregular updates, including missed periods, against the absolute phase.
const irregular = timer();
for(const now of [0.3, 1.4, 12.7, 13, 100.25, 1024.5, 10000.75])
{
    irregular.timer(now, false);
    const ticks = Math.floor(now * OSCILLATOR_FREQ);
    const expected = ((500 - ticks) % 1193 + 1193) % 1193;
    assert.equal(irregular.get_counter_value(0, now), expected);
}

// A snapshot from a different host clock must still rebase to the current time.
const restored = timer();
restored.counter_start_time[0] = 300000;
restored.timer(10, false);
assert.equal(restored.counter_start_time[0], 10);
assert.ok(Number.isFinite(restored.get_counter_value(0, 10)));

console.log("PIT phase with coarse, fine, irregular and restored clocks passed");
