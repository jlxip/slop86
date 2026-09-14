import { SpeakerAdapter } from "../../src/browser/speaker.js";

export async function run()
{
    let checks = 0;
    const check = (value, message) => { if(!value) throw Error(message); checks++; };
    const tick = () => new Promise(resolve => setTimeout(resolve, 20));
    function make()
    {
        const listeners = new Map();
        const bus = {
            initialized: 0,
            register(name, fn, self) { listeners.set(name, (...args) => fn.apply(self, args)); },
            send(name) { if(name === "speaker-has-initialized") this.initialized++; },
            emit(name, value) { listeners.get(name)?.(value); },
        };
        const adapter = new SpeakerAdapter(bus);
        adapter.mixer.set_volume(0, undefined);
        return { adapter, bus, context: adapter.audio_context };
    }
    const prototype = AudioWorklet.prototype, addModule = prototype.addModule;
    let release, entered;
    async function delayed(action)
    {
        const called = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        prototype.addModule = function(...args)
        {
            entered();
            return addModule.apply(this, args).then(() => gate);
        };
        const current = make();
        try { await called; await action(current); }
        finally { release(); prototype.addModule = addModule; await current.adapter.destroy(); }
    }
    console.log("Audio delayed start/stop");
    await delayed(async ({adapter, bus, context}) =>
    {
        console.log("Audio module loading");
        adapter.resume(); bus.emit("emulator-started");
        bus.emit("dac-tell-sampling-rate", 22050); bus.emit("dac-enable");
        await tick();
        check(context.state === "suspended", "Rendering started before worklet readiness");
        check(!adapter.initialized, "Rendering was initialized too early");
        bus.emit("emulator-stopped"); release(); await adapter.ready; await tick();
        check(context.state === "suspended", "Pending resume undid stop");
        check(adapter.dac.enabled && adapter.dac.sampling_rate === 22050, "Early DAC state was lost");
        check(bus.initialized === 1, "Initialization handshake missing");
        console.log("Audio resuming after delayed module");
        await adapter.resume(); check(context.state === "running", "Resume did not start audio");
        const before = context.currentTime; await new Promise(resolve => setTimeout(resolve, 100));
        check(context.currentTime > before, "Audio renderer is not advancing");
    });
    await delayed(async ({adapter, bus, context}) =>
    {
        const dac = adapter.dac;
        const closed = adapter.destroy(); release(); await Promise.all([adapter.ready, closed]);
        check(context.state === "closed", "Destroy did not close context");
        check(dac.node_processor === null && !adapter.initialized, "Destroyed adapter completed initialization");
    });
    const immediate = make(); await immediate.adapter.destroy(); await immediate.adapter.ready;
    check(immediate.context.state === "closed", "Immediate destroy failed");
    const warn = console.warn, revoke = URL.revokeObjectURL;
    let warnings = 0, revoked = 0;
    console.warn = () => warnings++;
    URL.revokeObjectURL = url => { revoked++; revoke.call(URL, url); };
    prototype.addModule = () => Promise.reject(Error("Injected module failure"));
    const failed = make();
    try
    {
        await failed.adapter.ready; await failed.adapter.resume();
        check(warnings === 1 && revoked === 1, "Module failure was not reported/cleaned up");
        check(failed.context.state === "suspended" && !failed.adapter.initialized, "Failed module started audio");
    }
    finally { await failed.adapter.destroy(); prototype.addModule = addModule; console.warn = warn; URL.revokeObjectURL = revoke; }
    const Worklet = window.AudioWorklet;
    window.AudioWorklet = undefined;
    const fallback = make();
    try { await fallback.adapter.ready; await fallback.adapter.resume(); check(fallback.context.state === "running", "Buffer fallback failed"); }
    finally { await fallback.adapter.destroy(); window.AudioWorklet = Worklet; }
    return {checks};
}
