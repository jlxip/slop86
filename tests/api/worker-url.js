import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Evaluate the real scheduler in a browser-like realm; CPU/state are not used.
const created = [], revoked = [], workers = [], ticks = [];
const construction_error = new Error("Worker construction failed");
let fail_construction = false;
const context = vm.createContext({
    Blob,
    URL: {
        createObjectURL(blob)
        {
            assert.equal(blob.type, "text/javascript");
            const url = "blob:test-" + created.length;
            created.push(url);
            return url;
        },
        revokeObjectURL(url) { revoked.push(url); },
    },
    Worker: class
    {
        constructor(url)
        {
            if(fail_construction) throw construction_error;
            assert(!revoked.includes(url));
            this.url = url;
            this.terminated = false;
            workers.push(this);
        }
        postMessage(message) { this.message = message; }
        terminate() { this.terminated = true; }
    },
});
const source = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
const module = new vm.SourceTextModule(source, { context });
await module.link(() => new vm.SourceTextModule(
    "export class CPU {} export class V86 {} export function save_state() {} export function restore_state() {}",
    { context }
));
await module.evaluate();
const core = Object.create(module.namespace.v86.prototype);
core.yield_callback = tick => ticks.push(tick);

core.register_yield();
assert.equal(revoked.length, 0, "Keep URL alive while Worker is loading");
core.yield(7, 42);
assert.equal(workers[0].message.t, 7);
assert.equal(workers[0].message.tick, 42);
workers[0].onmessage({ data: 42 });
assert.deepEqual(revoked, [created[0]], "Release after first response");
workers[0].onmessage({ data: 43 });
workers[0].onerror({});
core.unregister_yield();
core.unregister_yield();
assert.deepEqual(ticks, [42, 43], "Continue forwarding subsequent ticks");
assert.equal(revoked.length, 1, "Cleanup is idempotent");
assert(workers[0].terminated);
assert.equal(core.worker, null);
assert.equal(core.worker_cleanup, null);

core.register_yield();
assert.equal(revoked.length, 1);
core.unregister_yield();
assert.deepEqual(revoked, created, "Destroy before first response releases URL");
assert(workers[1].terminated);

core.register_yield();
workers[2].onerror({});
assert.deepEqual(revoked, created, "Asynchronous startup failure releases URL");
core.unregister_yield();
assert.equal(revoked.length, 3);

fail_construction = true;
assert.throws(() => core.register_yield(), error => error === construction_error);
assert.deepEqual(revoked, created, "Synchronous startup failure releases URL");
assert.equal(core.worker_cleanup, null);
core.unregister_yield();

fail_construction = false;
core.register_yield();
workers[0].onerror({});
assert.equal(revoked.length, 4, "Old callbacks cannot release a new URL");
workers[3].onmessage({ data: 44 });
core.unregister_yield();
assert.deepEqual(revoked, created);
assert.deepEqual(ticks, [42, 43, 44]);
console.log("Worker URL lifecycle: PASS (startup, messages, errors, teardown, retry)");
