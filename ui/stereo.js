/* SPDX-License-Identifier: Apache-2.0 */
/* Paired native SDK rectified RGB/disparity preview and color point cloud. */
(() => {
    "use strict";
    const $ = (id) => document.getElementById(id);
    let enabled = false,
        online = false,
        lastId = "0",
        pending = false,
        dirty = false;
    let configTarget = null,
        configError = "";
    let latest = null,
        cloud = null,
        frames = 0,
        rateStart = performance.now();
    let modeWidth = 0,
        streamEpoch = 0,
        allModes = [];
    function populateModes(projection, selected) {
        const modes = allModes.filter(
            (m) => Number(m.projection || 0) === projection,
        );
        $("stereo-mode").replaceChildren(
            ...modes.map((m) => {
                const o = document.createElement("option"),
                    g = gcd(m.width, m.height);
                o.value = m.id;
                o.textContent = `${m.width / g}:${m.height / g} · ${m.width} × ${m.height} · ≤ ${m.max_fps || 20} fps`;
                return o;
            }),
        );
        if (modes.some((m) => Number(m.id) === selected))
            $("stereo-mode").value = String(selected);
        $("stereo-fov").hidden = $("stereo-fov-label").hidden =
            projection !== 1;
    }
    const call = async (name, ...args) =>
        typeof window[name] === "function"
            ? await window[name](...args)
            : false;
    function gcd(a, b) {
        while (b) {
            const t = b;
            b = a % b;
            a = t;
        }
        return a;
    }
    window.updateStereoState = (remote) => {
        const info = remote.stereo || {},
            flags = Number(info.flags || 0);
        online = !!remote.connected;
        if (configTarget) {
            if (
                Number(info.mode) === configTarget.mode &&
                Number(info.projection || 0) === configTarget.projection &&
                Math.abs(Number(info.vertical_fov || 180) - configTarget.fov) <
                    0.001 &&
                Math.abs(Number(info.focal) - configTarget.focal) <=
                    Math.max(1e-6, configTarget.focal * 1e-6)
            ) {
                dirty = false;
                pending = false;
                configTarget = null;
                configError = "";
            } else if (!online || performance.now() > configTarget.deadline) {
                pending = false;
                configTarget = null;
                configError =
                    "The camera did not confirm the configuration. Check the connection and EEPROM, then apply again.";
            }
        }
        const was = enabled;
        enabled = online && !!(flags & 8);
        if (enabled !== was) streamEpoch++;
        allModes = info.modes || [];
        const signature =
            JSON.stringify(allModes) +
            ":" +
            (dirty ? $("stereo-usage").value : Number(info.projection || 0));
        if ($("stereo-mode").dataset.modes !== signature) {
            const projection = dirty
                ? Number($("stereo-usage").value)
                : Number(info.projection || 0);
            $("stereo-usage").value = String(projection);
            populateModes(
                projection,
                dirty ? Number($("stereo-mode").value) : Number(info.mode),
            );
            $("stereo-mode").dataset.modes = signature;
        }
        const modes = allModes;
        if (!dirty && document.activeElement !== $("stereo-focal")) {
            $("stereo-mode").value = String(info.mode || "");
            $("stereo-usage").value = String(info.projection || 0);
            $("stereo-fov").value = String(info.vertical_fov || 180);
            if (info.focal > 0) $("stereo-focal").value = String(info.focal);
            modeWidth =
                Number(
                    modes.find((m) => Number(m.id) === Number(info.mode))
                        ?.width,
                ) || 0;
        }
        const available = online && !!(flags & 1);
        const selected = modes.find(
            (m) => Number(m.id) === Number($("stereo-mode").value),
        );
        const maxFps = Number(selected?.max_fps) || 20;
        $("stereo-rate-note").textContent =
            `Disparity: blue = near 0 px, red = 192 px; black = invalid. This mode supports up to ${maxFps} fps. Enabling lowers a higher camera rate to ${maxFps} fps.`;
        $("stereo-enable").disabled =
            pending || (!enabled && (!available || dirty));
        $("stereo-enable").textContent = pending
            ? "Please wait…"
            : enabled
              ? "Disable disparity"
              : "Enable disparity";
        for (const id of [
            "stereo-usage",
            "stereo-mode",
            "stereo-focal",
            "stereo-fov",
            "stereo-apply",
        ])
            $(id).disabled = pending || enabled || !available;
        const reason =
            info.message ||
            configError ||
            (!online
                ? "Camera offline"
                : !available
                  ? "Stereo matching unavailable: check calibration and installed models."
                  : enabled
                    ? `Live · FP16 stereo · Up to ${maxFps} fps`
                    : dirty
                      ? "Apply the mode/focal changes before enabling disparity."
                      : "Ready · Configuration is saved in camera EEPROM");
        $("stereo-notice").textContent = reason;
        $("stereo-notice").classList.toggle("validation-error", !!info.error);
        if (!enabled && was) {
            lastId = "0";
            latest = null;
            frames = 0;
            rateStart = performance.now();
            for (const name of ["rectified", "disparity"]) {
                $(name + "-canvas").hidden = true;
                $(name + "-empty").hidden = false;
            }
            $("disparity-rate").textContent = "-- Hz";
            if (cloud) cloud.setPoints(new Float32Array());
            if (cloud) $("cloud-count").textContent = "0 points";
        }
    };
    class Cloud {
        constructor(canvas) {
            this.canvas = canvas;
            this.gl = canvas.getContext("webgl", {
                antialias: true,
                alpha: false,
            });
            if (!this.gl)
                throw Error("WebGL is unavailable for point cloud preview");
            const gl = this.gl;
            const shader = (type, code) => {
                const s = gl.createShader(type);
                gl.shaderSource(s, code);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                    throw Error(gl.getShaderInfoLog(s));
                return s;
            };
            const program = gl.createProgram();
            gl.attachShader(
                program,
                shader(
                    gl.VERTEX_SHADER,
                    `attribute vec3 position;attribute vec3 color;uniform mat4 vp;varying vec3 rgb;void main(){gl_Position=vp*vec4(position,1.0);gl_PointSize=2.0;rgb=color;}`,
                ),
            );
            gl.attachShader(
                program,
                shader(
                    gl.FRAGMENT_SHADER,
                    `precision mediump float;varying vec3 rgb;void main(){gl_FragColor=vec4(rgb,1.0);}`,
                ),
            );
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
                throw Error(gl.getProgramInfoLog(program));
            gl.useProgram(program);
            this.program = program;
            this.buffer = gl.createBuffer();
            this.count = 0;
            this.vp = gl.getUniformLocation(program, "vp");
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            for (const [name, offset] of [
                ["position", 0],
                ["color", 12],
            ]) {
                const a = gl.getAttribLocation(program, name);
                gl.enableVertexAttribArray(a);
                gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 24, offset);
            }
            gl.enable(gl.DEPTH_TEST);
            gl.clearColor(0.035, 0.05, 0.075, 1);
            this.reset();
            let drag = null;
            const finishDrag = (e) => {
                if (
                    !drag ||
                    (e?.pointerId !== undefined &&
                        e.pointerId !== drag.pointerId)
                )
                    return;
                const id = drag.pointerId;
                drag = null;
                canvas.style.cursor = "";
                if (canvas.hasPointerCapture(id))
                    canvas.releasePointerCapture(id);
            };
            this.cancelDrag = finishDrag;
            canvas.addEventListener("contextmenu", (e) => e.preventDefault());
            canvas.addEventListener("pointerdown", (e) => {
                if (
                    drag ||
                    e.isPrimary === false ||
                    ![0, 1, 2].includes(e.button)
                )
                    return;
                e.preventDefault();
                drag = {
                    pointerId: e.pointerId,
                    buttons: [1, 4, 2][e.button],
                    x: e.clientX,
                    y: e.clientY,
                    pan: e.button !== 0 || e.shiftKey,
                };
                canvas.setPointerCapture(e.pointerId);
                canvas.style.cursor = drag.pan ? "move" : "grabbing";
            });
            canvas.addEventListener("pointermove", (e) => {
                if (!drag || e.pointerId !== drag.pointerId) return;
                if (e.pointerType === "mouse" && !(e.buttons & drag.buttons)) {
                    finishDrag(e);
                    return;
                }
                const dx = e.clientX - drag.x,
                    dy = e.clientY - drag.y;
                drag.x = e.clientX;
                drag.y = e.clientY;
                if (drag.pan) {
                    const { right, up } = this.viewBasis();
                    // A pixel at the orbit focus follows a pixel of mouse
                    // movement, independent of yaw, pitch, zoom and DPI.
                    const s =
                        (2 * this.distance * Math.tan(Math.PI / 6)) /
                        Math.max(1, canvas.clientHeight);
                    for (let i = 0; i < 3; i++)
                        this.target[i] += (-dx * right[i] + dy * up[i]) * s;
                } else this.rotate(dx, dy);
                this.render();
            });
            for (const event of [
                "pointerup",
                "pointercancel",
                "lostpointercapture",
            ])
                canvas.addEventListener(event, finishDrag);
            window.addEventListener("blur", () => finishDrag());
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) finishDrag();
            });
            canvas.addEventListener(
                "wheel",
                (e) => {
                    e.preventDefault();
                    this.distance = Math.max(
                        0.03,
                        Math.min(
                            1000,
                            this.distance * Math.exp(e.deltaY * 0.001),
                        ),
                    );
                    this.render();
                },
                { passive: false },
            );
            new ResizeObserver(() => this.render()).observe(canvas);
            canvas.addEventListener("webglcontextlost", (e) => {
                e.preventDefault();
                $("stereo-notice").textContent =
                    "Point cloud graphics context lost; reopen the application.";
            });
        }
        reset() {
            if (this.cancelDrag) this.cancelDrag();
            this.orientation = [0, 0, 0, 1];
            this.distance = 2.5;
            this.target = [0, 0, 2];
            this.render();
        }
        setPoints(points) {
            this.count = points.length / 6;
            const gl = this.gl;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, points, gl.DYNAMIC_DRAW);
            this.render();
        }
        rotate(dx, dy) {
            const pixels = Math.hypot(dx, dy);
            if (!pixels) return;
            // Compose a rotation around the current screen axes. No fixed
            // world-up direction or Euler pitch clamp is imposed at poles.
            const half = (pixels * 0.006) / 2,
                s = Math.sin(half) / pixels;
            const bx = dy * s,
                by = dx * s,
                bw = Math.cos(half),
                [x, y, z, w] = this.orientation;
            const q = [
                w * bx + x * bw - z * by,
                w * by + y * bw + z * bx,
                x * by - y * bx + z * bw,
                w * bw - x * bx - y * by,
            ];
            const norm = Math.hypot(...q);
            this.orientation = q.map((v) => v / norm);
        }
        viewBasis() {
            const [x, y, z, w] = this.orientation;
            // Display coordinates retain optical +Z forward and use +Y up.
            return {
                right: [
                    1 - 2 * (y * y + z * z),
                    2 * (x * y + z * w),
                    2 * (x * z - y * w),
                ],
                up: [
                    2 * (x * y - z * w),
                    1 - 2 * (x * x + z * z),
                    2 * (y * z + x * w),
                ],
                back: [
                    -2 * (x * z + y * w),
                    -2 * (y * z - x * w),
                    -1 + 2 * (x * x + y * y),
                ],
            };
        }
        render() {
            const c = this.canvas,
                gl = this.gl,
                w = Math.max(1, c.clientWidth),
                h = Math.max(1, c.clientHeight),
                ratio = Math.min(2, devicePixelRatio || 1);
            if (
                c.width !== Math.round(w * ratio) ||
                c.height !== Math.round(h * ratio)
            ) {
                c.width = Math.round(w * ratio);
                c.height = Math.round(h * ratio);
            }
            gl.viewport(0, 0, c.width, c.height);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            const { right: x, up: y, back: z } = this.viewBasis();
            const eye = this.target.map((a, i) => a + this.distance * z[i]);
            const dot = (a, b) => a.reduce((v, n, i) => v + n * b[i], 0);
            const view = [
                x[0],
                y[0],
                z[0],
                0,
                x[1],
                y[1],
                z[1],
                0,
                x[2],
                y[2],
                z[2],
                0,
                -dot(x, eye),
                -dot(y, eye),
                -dot(z, eye),
                1,
            ];
            const f = 1 / Math.tan(Math.PI / 6),
                near = 0.01,
                far = 2000;
            const projection = [
                (f * h) / w,
                0,
                0,
                0,
                0,
                f,
                0,
                0,
                0,
                0,
                (far + near) / (near - far),
                -1,
                0,
                0,
                (2 * far * near) / (near - far),
                0,
            ];
            const m = new Float32Array(16);
            for (let col = 0; col < 4; col++)
                for (let row = 0; row < 4; row++)
                    for (let k = 0; k < 4; k++)
                        m[col * 4 + row] +=
                            projection[k * 4 + row] * view[col * 4 + k];
            gl.useProgram(this.program);
            gl.uniformMatrix4fv(this.vp, false, m);
            gl.drawArrays(gl.POINTS, 0, this.count);
        }
    }
    // Positive IEEE-754 binary16 values; NaN/Inf slots stay NaN. Decode once
    // so the preview loop does not require native browser Float16 support.
    const fp16Pixels = new Float32Array(0x8000);
    for (let bits = 0; bits < fp16Pixels.length; bits++) {
        const exponent = bits >>> 10,
            fraction = bits & 1023;
        fp16Pixels[bits] =
            exponent === 31
                ? NaN
                : exponent === 0
                  ? fraction * 2 ** -24
                  : (1024 + fraction) * 2 ** (exponent - 25);
    }
    function drawFrame(buffer, force = false) {
        const v = new DataView(buffer);
        if (
            v.byteLength < 64 ||
            ![2, 3].includes(v.getUint32(0, true)) ||
            v.getUint32(52, true) !== 1
        )
            return;
        const header = v.getUint32(0, true) === 3 ? 80 : 64;
        if (v.byteLength < header) return;
        const projection = header === 80 ? v.getUint32(64, true) : 0,
            fy =
                header === 80 ? v.getFloat32(68, true) : v.getFloat32(36, true);
        if (
            projection > 1 ||
            !Number.isFinite(fy) ||
            fy <= 0 ||
            (header === 80 && v.getUint32(76, true) !== 80)
        )
            return;
        const frameId = v.getBigUint64(8, true).toString();
        if (!force && frameId === lastId) return;
        const w = v.getUint32(28, true),
            h = v.getUint32(32, true),
            pixels = w * h;
        if (
            !w ||
            !h ||
            w > 512 ||
            h > 512 ||
            buffer.byteLength !== header + pixels * 4 ||
            v.getUint32(56, true) !== pixels * 2 ||
            v.getUint32(60, true) !== pixels * 2
        )
            return;
        const focal = v.getFloat32(36, true),
            cx = v.getFloat32(40, true),
            cy = v.getFloat32(44, true),
            baseline = v.getFloat32(48, true);
        if (
            !Number.isFinite(focal) ||
            focal <= 0 ||
            !Number.isFinite(cx) ||
            !Number.isFinite(cy) ||
            !Number.isFinite(baseline) ||
            baseline <= 0
        )
            return;
        const displayWidth = projection === 1 ? h : w,
            displayHeight = projection === 1 ? w : h;
        const canvas = $("disparity-canvas");
        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
            canvas.width = displayWidth;
            canvas.height = displayHeight;
        }
        const context = canvas.getContext("2d"),
            image = context.createImageData(displayWidth, displayHeight),
            rgba = image.data;
        const rectified = $("rectified-canvas");
        if (
            rectified.width !== displayWidth ||
            rectified.height !== displayHeight
        ) {
            rectified.width = displayWidth;
            rectified.height = displayHeight;
        }
        const colorContext = rectified.getContext("2d"),
            colorImage = colorContext.createImageData(
                displayWidth,
                displayHeight,
            ),
            colorRgba = colorImage.data;
        const points = new Float32Array(pixels * 6),
            limit = Number($("cloud-depth").value) || 10;
        let count = 0;
        for (let i = 0; i < pixels; i++) {
            const row = Math.floor(i / w),
                column = i % w;
            // Rotate the displayed planes clockwise; SDK pixels and geometry
            // retain the original calibrated coordinates.
            const offset =
                (projection === 1 ? column * h + h - 1 - row : i) * 4;
            const raw = v.getUint16(header + i * 2, true),
                d = fp16Pixels[raw];
            rgba[offset + 3] = 255;
            // Color is the rectified left image bundled with this disparity
            // frame. Show every RGB pixel, including invalid-depth regions.
            const color = v.getUint16(header + pixels * 2 + i * 2, true);
            const r = ((color >> 11) & 31) / 31,
                g = ((color >> 5) & 63) / 63,
                b = (color & 31) / 31;
            colorRgba[offset] = r * 255;
            colorRgba[offset + 1] = g * 255;
            colorRgba[offset + 2] = b * 255;
            colorRgba[offset + 3] = 255;
            if (!Number.isFinite(d) || d <= 0) continue;
            const t = Math.max(0, Math.min(1, d / 192));
            rgba[offset] =
                255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 3)));
            rgba[offset + 1] =
                255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 2)));
            rgba[offset + 2] =
                255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 1)));
            const radius = (focal * baseline) / d,
                theta = (row - cy) / fy;
            if (!Number.isFinite(radius) || radius <= 0) continue;
            const x = ((column - cx) * radius) / focal,
                y =
                    projection === 1
                        ? radius * Math.sin(theta)
                        : radius * theta,
                z = projection === 1 ? radius * Math.cos(theta) : radius;
            const distance = projection === 1 ? Math.hypot(x, y, z) : z;
            if (distance < 0.03 || distance > limit || z <= 0) continue;
            // The product is held with the left sensor above the right sensor.
            // Optical -X is display up; algorithm/calibration axes stay unchanged.
            points[count++] = projection === 1 ? -y : x;
            points[count++] = projection === 1 ? -x : -y;
            points[count++] = z;
            points[count++] = r;
            points[count++] = g;
            points[count++] = b;
        }
        // Both planes come from one SDK frame and are painted in one task.
        colorContext.putImageData(colorImage, 0, 0);
        context.putImageData(image, 0, 0);
        rectified.hidden = false;
        canvas.hidden = false;
        $("rectified-empty").hidden = true;
        $("disparity-empty").hidden = true;
        $("cloud-count").textContent =
            `${(count / 6).toLocaleString()} points · ${w} × ${h}`;
        if (cloud) cloud.setPoints(points.subarray(0, count));
        latest = buffer;
        lastId = frameId;
        if (force) return;
        frames++;
        const now = performance.now();
        if (now - rateStart >= 1000) {
            $("disparity-rate").textContent =
                ((frames * 1000) / (now - rateStart)).toFixed(1) + " Hz";
            rateStart = now;
            frames = 0;
        }
    }
    async function poll() {
        const start = performance.now();
        if (enabled && !document.hidden && !$("tab-camera").hidden) {
            const epoch = streamEpoch;
            try {
                const r = await fetch(`/disparity.frame?after=${lastId}`, {
                    cache: "no-store",
                });
                const b = await r.arrayBuffer();
                if (enabled && epoch === streamEpoch && b.byteLength)
                    drawFrame(b);
            } catch (e) {
                $("stereo-notice").textContent = e.message;
            }
        }
        setTimeout(poll, Math.max(1, 40 - (performance.now() - start)));
    }
    document.addEventListener("DOMContentLoaded", () => {
        try {
            cloud = new Cloud($("cloud-canvas"));
        } catch (e) {
            $("cloud-count").textContent = e.message;
        }
        const markDirty = () => {
            dirty = true;
            configError = "";
            $("stereo-enable").disabled = true;
        };
        $("stereo-usage").addEventListener("change", () => {
            const p = Number($("stereo-usage").value);
            populateModes(p, 0);
            modeWidth =
                Number(
                    allModes.find(
                        (m) => Number(m.id) === Number($("stereo-mode").value),
                    )?.width,
                ) || 0;
            markDirty();
        });
        $("stereo-fov").addEventListener("input", markDirty);
        $("stereo-mode").addEventListener("change", () => {
            const modes = allModes;
            const width =
                Number(
                    modes.find(
                        (m) => Number(m.id) === Number($("stereo-mode").value),
                    )?.width,
                ) || 0;
            const focal = Number($("stereo-focal").value),
                scaled = (focal * width) / modeWidth;
            // Preserve horizontal field of view when choosing more pixels.
            // The resulting pixel focal length remains freely editable.
            if (
                modeWidth > 0 &&
                width > 0 &&
                focal > 0 &&
                Number.isFinite(scaled)
            )
                $("stereo-focal").value = String(Number(scaled.toPrecision(7)));
            modeWidth = width;
            markDirty();
        });
        $("stereo-focal").addEventListener("input", markDirty);
        $("stereo-enable").addEventListener("click", async () => {
            pending = true;
            $("stereo-enable").disabled = true;
            const ok = await call("host_set_stereo", enabled ? 0 : 1);
            if (!ok)
                $("stereo-notice").textContent =
                    "Unable to submit stereo request";
            setTimeout(() => {
                pending = false;
            }, 1200);
        });
        $("stereo-apply").addEventListener("click", async () => {
            const focal = Number($("stereo-focal").value),
                mode = Number($("stereo-mode").value);
            if (!Number.isFinite(focal) || focal <= 0) {
                $("stereo-notice").textContent =
                    "Focal length must be a positive number in pixels.";
                return;
            }
            const projection = Number($("stereo-usage").value),
                fov = Number($("stereo-fov").value);
            if (!Number.isFinite(fov) || fov < 30 || fov > 180) {
                $("stereo-notice").textContent =
                    "Vertical FOV must be between 30° and 180°.";
                return;
            }
            pending = true;
            configTarget = {
                mode,
                focal,
                projection,
                fov,
                deadline: performance.now() + 6000,
            };
            $("stereo-apply").disabled = true;
            const ok = await call(
                "host_configure_stereo",
                mode,
                focal,
                projection,
                fov,
            );
            if (!ok) {
                pending = false;
                configTarget = null;
                configError = "Unable to submit stereo configuration";
                $("stereo-notice").textContent = configError;
            }
        });
        $("cloud-reset").addEventListener("click", () => {
            if (cloud) cloud.reset();
        });
        $("cloud-depth").addEventListener("change", () => {
            if (latest) drawFrame(latest, true);
        });
        poll();
    });
})();
