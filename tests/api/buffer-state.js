#!/usr/bin/env node

import assert from "node:assert/strict";
import { SyncBuffer, buffer_from_object } from "../../src/buffer.js";

const size = 1024;
const offset = 256;
const contents = new Uint8Array(256).fill(0x5A);

const remote = buffer_from_object({ url: "disk.img", size });
remote.set(offset, contents, () => {});

const base = new Uint8Array(size).fill(0xA5);
const local = new SyncBuffer(base.buffer);
local.set_state(remote.get_state());

assert.deepEqual(local.get_from_cache(offset, contents.length), contents);
assert.equal(local.get_from_cache(0, 1)[0], 0xA5);
