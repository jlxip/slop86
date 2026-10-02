import assert from "node:assert/strict";

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

const prototype = Object.getPrototypeOf(emulator.v86);
function pending_machine()
{
    const pending = [], events = [];
    const machine = Object.assign(Object.create(prototype), {
        running: true, stopping: false, idle: true, tick_counter: 4,
        cpu: { main_loop() { throw new Error("CPU executed after stop request"); } },
        bus: { send(name) { events.push(name); } },
        yield(delay, tick) { pending.push({ delay, tick }); },
    });
    machine.next_tick(60000);
    return { machine, pending, events };
}

try
{
    // Transfer my98's regression: wake a pending idle timer without a CPU tick.
    const { machine, pending, events } = pending_machine();
    machine.stop();
    assert.deepEqual(pending, [{ delay: 60000, tick: 5 }, { delay: 0, tick: 6 }]);
    machine.yield_callback(5);
    assert.deepEqual(events, [], "the pending timer is stale");
    machine.yield_callback(6);
    assert.equal(machine.running, false);
    assert.equal(machine.stopping, false);
    assert.deepEqual(events, ["emulator-stopped"]);
    machine.yield_callback(5);
    machine.stop();
    assert.equal(pending.length, 2, "stopping a stopped machine is a no-op");
    assert.deepEqual(events, ["emulator-stopped"], "no duplicate stop event");

    // Multiple requests invalidate earlier wakeups as well as the idle timer.
    const repeated = pending_machine();
    repeated.machine.stop();
    repeated.machine.stop();
    repeated.machine.yield_callback(5);
    repeated.machine.yield_callback(6);
    assert.deepEqual(repeated.events, []);
    repeated.machine.yield_callback(7);
    repeated.machine.yield_callback(5);
    repeated.machine.yield_callback(6);
    assert.deepEqual(repeated.events, ["emulator-stopped"]);

    // A run before stop acknowledgement cancels the stop and keeps one timer.
    const resumed = pending_machine();
    let ticks = 0;
    resumed.machine.cpu.main_loop = () => { ticks++; return 60000; };
    resumed.machine.stop();
    resumed.machine.run();
    resumed.machine.yield_callback(5);
    resumed.machine.yield_callback(6);
    assert.equal(ticks, 0);
    resumed.machine.yield_callback(7);
    resumed.machine.yield_callback(5);
    resumed.machine.yield_callback(6);
    assert.equal(ticks, 1);
    assert.equal(resumed.machine.running, true);
    assert.deepEqual(resumed.events, []);
    resumed.machine.stop();
    resumed.machine.yield_callback(8);
    resumed.machine.yield_callback(9);
    assert.equal(ticks, 1, "no CPU tick after the subsequent stop");
    assert.deepEqual(resumed.events, ["emulator-stopped"]);

    // The public stop promise resolves when the immediate wakeup is delivered.
    const core = emulator.v86, callbacks = [];
    core.yield = (delay, tick) => callbacks.push({ delay, tick });
    core.run();
    core.next_tick(60000);
    const old_timer = callbacks.at(-1);
    const stopped = emulator.stop();
    const wakeup = callbacks.at(-1);
    assert.equal(wakeup.delay, 0);
    assert.ok(wakeup.tick > old_timer.tick);
    core.yield_callback(old_timer.tick);
    assert.equal(core.running, true);
    core.yield_callback(wakeup.tick);
    await stopped;
    assert.equal(emulator.is_running(), false);
    core.yield_callback(old_timer.tick);
    console.log("Stop wakeup, stale ticks, repeated requests, resume and public promise PASS (" +
        (release ? "production" : "source") + ")");
}
finally
{
    // Also release any public stop listener if an assertion fails.
    emulator.v86.running = emulator.v86.stopping = false;
    emulator.v86.bus.send("emulator-stopped");
    await emulator.destroy();
}
