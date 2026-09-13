import { ScreenAdapter } from "../../src/browser/screen.js";
import { VGAScreen } from "../../src/vga.js";

export function run()
{
    let checks = 0;
    function check(condition, message)
    {
        if(!condition) throw new Error(message);
        checks++;
    }
    for(const graphical_text of [false, true])
    {
        const host = document.createElement("div");
        host.className = "host";
        host.innerHTML = '<div class="text"></div><canvas></canvas>';
        document.body.appendChild(host);
        const adapter = new ScreenAdapter({ container: host, use_graphical_text: graphical_text }, () => {});
        const text = host.querySelector("div"), canvas = host.querySelector("canvas");
        // Exercise VGAScreen's real mode propagation without a CPU/guest boot.
        const vga = Object.assign(Object.create(VGAScreen.prototype), {
            graphical_mode: true, screen: adapter,
            cpu: { wasm_memory: { buffer: new ArrayBuffer(16 << 20) },
                svga_allocate_dest_buffer() { return 0; }, svga_mark_dirty() {} },
            bus: { send() {} },
        });
        function dimensions(element, aspect)
        {
            const rect = element.getBoundingClientRect();
            check(Math.abs(rect.width / rect.height - aspect) < 0.005,
                `${graphical_text}: ${rect.width}x${rect.height}, expected aspect ${aspect}`);
            check(Math.abs(adapter.get_aspect_ratio() - aspect) < 0.0001, "Aspect metadata differs from display");
            return rect;
        }
        try
        {
            adapter.set_font_bitmap(16, true, false, true, new Uint8Array(8192), true);
            adapter.pause();
            const initial = dimensions(graphical_text ? canvas : text, 4 / 3);
            const box = host.getBoundingClientRect();
            check(Math.abs(box.width - initial.width) < 1 && Math.abs(box.height - initial.height) < 1,
                "Display layout must reserve its visible area");
            for(const [width, height, svga] of [
                [320, 400, false], [320, 200, false], [640, 350, false],
                [640, 480, false], [800, 600, true], [1280, 1024, true], [1280, 720, true],
                // Same framebuffer dimensions, different pixel aspect.
                [320, 400, true], [320, 400, false],
            ])
            {
                adapter.set_mode(true);
                vga.svga_enabled = svga;
                vga.set_size_graphical(width, height, width, height, svga ? 32 : 8);
                const aspect = svga ? width / height : 4 / 3;
                adapter.set_scale(1, 1);
                const first = dimensions(canvas, aspect);
                adapter.set_scale(2, 2);
                const doubled = dimensions(canvas, aspect);
                check(Math.abs(doubled.width - first.width * 2) < 1, "Scale should double once");
                for(let i = 0; i < 3; i++) adapter.set_scale(1, 1);
                const repeated = dimensions(canvas, aspect);
                check(Math.abs(repeated.width - first.width) < 1 && Math.abs(repeated.height - first.height) < 1,
                    "Scale must not accumulate");
                host.style.transform = "scale(1.5)";
                adapter.set_scale(1, 1);
                const transformed = dimensions(canvas, aspect);
                check(Math.abs(transformed.width - first.width * 1.5) < 1, "Host transform fed back into adapter scale");
                host.style.transform = "";
                check(canvas.width === width && canvas.height === height, "Framebuffer must remain unchanged");
            }
            // Restore-like transition to the already allocated 80x25 text mode.
            adapter.set_mode(false);
            adapter.set_size_text(80, 25);
            const target = graphical_text ? canvas : text;
            adapter.set_scale(1, 1);
            const first = dimensions(target, 4 / 3);
            for(const scale of [2, 1, 1, 1]) adapter.set_scale(scale, scale);
            const repeated = dimensions(target, 4 / 3);
            check(Math.abs(first.width - repeated.width) < 1 && Math.abs(first.height - repeated.height) < 1,
                "Text scale must not accumulate");
        }
        finally
        {
            adapter.destroy();
            host.remove();
        }
    }
    return checks;
}

// Invoke from a user gesture. Uses the standalone application's fullscreen CSS.
export async function run_fullscreen()
{
    const host = document.createElement("div");
    host.id = "screen_container";
    host.innerHTML = '<div id="screen"></div><canvas id="vga"></canvas>';
    document.body.appendChild(host);
    const adapter = new ScreenAdapter({ container: host, use_graphical_text: false }, () => {});
    let checks = 0;
    try
    {
        adapter.pause();
        await host.requestFullscreen();
        for(const [width, height, aspect] of [[320, 400, 4 / 3], [320, 200, 4 / 3],
            [640, 480, 4 / 3], [1280, 720, 16 / 9]])
        {
            adapter.set_mode(true);
            adapter.set_size_graphical(width, height, width, height, aspect);
            const rect = host.querySelector("canvas").getBoundingClientRect();
            if(Math.abs(rect.width / rect.height - aspect) > 0.005 ||
                rect.width > window.innerWidth + 1 || rect.height > window.innerHeight + 1 ||
                Math.abs(rect.x + rect.width / 2 - window.innerWidth / 2) > 1 ||
                Math.abs(rect.y + rect.height / 2 - window.innerHeight / 2) > 1)
            {
                throw new Error(`Fullscreen ${width}x${height}: wrong aspect, clipping or centering`);
            }
            checks++;
        }
    }
    finally
    {
        if(document.fullscreenElement === host) await document.exitFullscreen();
        adapter.destroy();
        host.remove();
    }
    return checks;
}
