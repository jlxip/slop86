# External disk adapters

Pass an application-owned backend instead of a disk URL or `ArrayBuffer`:

```js
const emulator = new V86({
    // Other machine options, BIOS and WebAssembly settings as usual.
    hda: { disk_adapter: adapter },
});
```

The emulator keeps the exact object supplied in `disk_adapter`. It does not
wrap it, copy the whole image, or implement its storage, encryption or
persistence. `V86DiskAdapter` and `V86DiskAdapterImage` in `v86.d.ts` describe
this interface. Use this form for block-device images; BIOS and initial-state
images still require their usual synchronous data representation. Avoid
combining it with `url` or `buffer` options in the same image descriptor.

## Loading and IO

- `byteLength` is a positive safe integer containing the disk size in bytes.
  It must be available before `load()` is called.
- V86 assigns `onload` before calling `load()`. The object must permit this
  assignment. Invoke `onload` exactly once after the disk is ready; it may run
  synchronously or asynchronously. Its event payload is not used for disks.
- `get(start, length, done, options?)` reads a byte range and calls
  `done(Uint8Array)` once with exactly `length` bytes. IDE may supply an
  `AbortSignal` in `options.signal` to cancel obsolete reads.
- `set(start, bytes, done)` writes a byte range and calls `done()` once after
  completion. Do not retain the caller's bytes beyond completion. Copy them
  if the backend queues work while the caller may reuse its buffer.
- `get_from_cache(start, length)` is synchronous: return the complete range
  as a `Uint8Array`, or `undefined` on a cache miss. Never start an asynchronous
  read from this method.
- `get_and_cache(start, length, done)` reads and caches the requested range,
  then calls `done(bytes)`. During cold initialization, hard disks use it to
  preload bytes 0–511; IDE reads that cached sector to determine geometry.
  Keep the cache coherent with subsequent writes and state restoration.

Offsets and lengths are in bytes. Read and write completion callbacks may
be synchronous or asynchronous. This interface has no error argument for IO
callbacks: the application must handle backend failures and recovery. Never
report successful completion with fabricated data after a failure.

## Snapshots

`get_state()` and `set_state(state)` are needed to save and restore a VM.
`get_state()` returns an adapter-defined array compatible with the existing
state serializer: primitives, nested arrays, maps and supported typed arrays. Wrap raw
`ArrayBuffer` data in a supported typed array such as `Uint8Array`. Ordinary
object literals and functions are not state values. `set_state()` receives that serialized data on the existing backend;
it must validate its own format and restore or invalidate caches as needed.

The emulator does not choose how disk changes are represented. An adapter
may store bytes in its state, or store a version/size marker and have the
application capture the disk's writes separately. Drain pending IO and
coordinate external disk state with the VM snapshot before capturing it.
Do not include credentials or other secrets in serialized state.

## Validation boundary

To preserve the existing adapter behavior, initial validation checks only
`byteLength` and that `load`, `get`, `set`, and `get_from_cache` are functions.
Invalid values throw `Error("Invalid encrypted disk adapter")`; this historical
message does not require adapters to use encryption.

`get_and_cache`, snapshot methods and writable `onload` are part of the
runtime contract but are not validated at that entry point. Missing methods
can therefore fail later during initialization or snapshot operations. The
TypeScript interface describes the complete contract, not merely the four
checks. URL, file and `ArrayBuffer` backends retain their existing behavior.

## Tests

Run `make disk-adapter-test` to test loading, IDE port reads/writes, cache,
state round trips and the `ArrayBuffer` regression using both source modules
and the production bundle. This target is included in `api-tests` and the
pre-commit hook and needs no downloaded guest image.
