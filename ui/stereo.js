/* SPDX-License-Identifier: Apache-2.0 */
/* Paired native SDK rectified RGB/disparity preview and color point cloud. */
(() => {
    "use strict";
    const $ = (id) => document.getElementById(id);
    const colorDisparityMax = 192;
    let enabled = false,
        online = false,
        lastId = "0",
        pending = false,
        dirty = false;
    let enableRequest = null,
        remoteState = {},
        configTarget = null,
        configError = "",
        configurationLocked = false;
    let latest = null,
        cloud = null,
        frames = 0,
        rateStart = performance.now();
    let modeWidth = 0,
        modeHeight = 0,
        streamEpoch = 0,
        allModes = [];
    let rangeFrame = null, rangePointer = null;
    const rangeOverlays = [];
    // Canvas pixels have already been rotated for display. Invert that exact
    // permutation to look up the original FP16 sample, never the colour image.
    function updateRange() {
        for (const entry of rangeOverlays) {
            entry.cross.hidden = true;
            entry.label.hidden = true;
        }
        if (!rangeFrame || !rangePointer || !enabled || document.hidden) return;
        const { w, h, projection, focal, baseline, cx, cy, fy, header, view } = rangeFrame,
            dw = projection === 1 ? h : w, dh = projection === 1 ? w : h;
        function imageBox(canvas) {
            const r = canvas.getBoundingClientRect(), factor = Math.min(r.width / dw, r.height / dh);
            return { left: r.left + (r.width - dw * factor) / 2,
                top: r.top + (r.height - dh * factor) / 2, factor };
        }
        const source = imageBox(rangePointer.canvas);
        if (!(source.factor > 0)) return;
        const sx = Math.floor((rangePointer.x - source.left) / source.factor),
            sy = Math.floor((rangePointer.y - source.top) / source.factor);
        if (sx < 0 || sx >= dw || sy < 0 || sy >= dh) return;
        const column = projection === 1 ? sy : sx,
            row = projection === 1 ? h - 1 - sx : sy,
            d = fp16Pixels[view.getUint16(header + 2 * (row * w + column), true)],
            depth = focal * baseline / d,
            range = depth * Math.hypot(1, (column - cx) / focal,
                projection === 1 ? 0 : (row - cy) / fy);
        const valid = Number.isFinite(d) && d > 0 && Number.isFinite(range) && range > 0;
        const text = valid
            ? `${projection === 1 ? "径向深度" : "深度"} ${depth.toFixed(3)} m · 距离 ${range.toFixed(3)} m`
            : "无有效深度";
        for (const entry of rangeOverlays) {
            const box = imageBox(entry.canvas), parent = entry.canvas.parentElement.getBoundingClientRect();
            if (!(box.factor > 0)) continue;
            entry.cross.style.left = `${box.left - parent.left - entry.canvas.parentElement.clientLeft + (sx + .5) * box.factor}px`;
            entry.cross.style.top = `${box.top - parent.top - entry.canvas.parentElement.clientTop + (sy + .5) * box.factor}px`;
            entry.cross.hidden = entry.label.hidden = false;
            entry.label.textContent = `${text} · (${column}, ${row})`;
        }
    }
    function bindRange() {
        for (const id of ["rectified-canvas", "disparity-canvas"]) {
            const canvas = $(id), parent = canvas.parentElement,
                cross = document.createElement("span"), label = document.createElement("span");
            cross.className = "stereo-reticle";
            cross.setAttribute("aria-hidden", "true");
            label.className = "stereo-depth-readout";
            cross.hidden = label.hidden = true;
            parent.append(cross, label);
            rangeOverlays.push({ canvas, cross, label });
            parent.addEventListener("pointermove", (event) => {
                rangePointer = { canvas, x: event.clientX, y: event.clientY };
                updateRange();
            });
            parent.addEventListener("pointerleave", () => { rangePointer = null; updateRange(); });
            new ResizeObserver(updateRange).observe(parent);
        }
        window.addEventListener("blur", () => { rangePointer = null; updateRange(); });
        document.addEventListener("visibilitychange", () => { rangePointer = null; updateRange(); });
    }
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
        $("stereo-fov-field").hidden = projection !== 1;
        $("stereo-fov-field").parentElement.classList.toggle(
            "cylindrical",
            projection === 1,
        );
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
    function configurationError(code) {
        return ({
            "-16": "相机正在被 SLAM 或其他任务使用。请先停止并保存 SLAM 地图，再修改深度参数。",
            "-22": "设备不支持这组深度参数，请检查分辨率、焦距和 FOV。",
            "-107": "相机连接已断开，请重新连接后再修改参数。",
            "-5": "设备写入或校验深度配置失败，请检查相机存储状态后重试。",
            "-11": "相机尚未就绪，请稍后重试。",
        })[String(code)] || `深度参数修改失败，设备返回错误码 ${code}。`;
    }
    window.updateStereoState = (remote) => {
        remoteState = remote;
        const info = remote.stereo || {},
            flags = Number(info.flags || 0);
        online = !!remote.connected;
        configurationLocked = !!remote.stereo_config_locked;
        if (enableRequest) {
            const reply = remote.stereo_enable_reply || {},
                acknowledged = enableRequest.requestId &&
                    String(reply.request_id) === enableRequest.requestId && reply.completed;
            if (!online || acknowledged) {
                configError = !online
                    ? configurationError(-107)
                    : Number(reply.result) !== 0
                      ? configurationError(Number(reply.result))
                      : "";
                pending = false;
                enableRequest = null;
            }
        }
        if (configTarget) {
            const reply = remote.stereo_config_reply || {},
                acknowledged = configTarget.requestId &&
                    String(reply.request_id) === configTarget.requestId && reply.completed;
            if (!online || (acknowledged && Number(reply.result) !== 0)) {
                configError = configurationError(online ? Number(reply.result) : -107);
                pending = false;
                configTarget = null;
            } else if (
                acknowledged && reply.status_received &&
                Number(info.mode) === configTarget.mode &&
                Number(info.projection || 0) === configTarget.projection &&
                Math.abs(Number(info.vertical_fov ?? 180) - configTarget.fov) <
                    0.001 &&
                Math.abs(Number(info.focal) - configTarget.focal) <=
                    Math.max(1e-6, configTarget.focal * 1e-6) &&
                Math.abs(Number(info.cy) - configTarget.cy) <=
                    Math.max(1e-5, Math.abs(configTarget.cy) * 1e-6)
            ) {
                dirty = false;
                pending = false;
                configTarget = null;
                configError = "";
            } else if (performance.now() > configTarget.deadline) {
                pending = false;
                configTarget = null;
                configError =
                    acknowledged
                        ? "设备返回的深度配置与请求不一致，请重新读取参数后重试。"
                        : "等待设备确认深度参数超时，请检查连接后重试。";
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
        if (!dirty && !["stereo-focal", "stereo-cy", "stereo-fov"].includes(document.activeElement?.id)) {
            $("stereo-mode").value = String(info.mode || "");
            $("stereo-usage").value = String(info.projection || 0);
            $("stereo-fov").value = String(info.vertical_fov || 180);
            if (info.focal > 0) $("stereo-focal").value = String(info.focal);
            const currentMode = modes.find((m) => Number(m.id) === Number(info.mode));
            if (Number.isFinite(info.cy)) $("stereo-cy").value = String(info.cy);
            else if (currentMode) $("stereo-cy").value = String((Number(currentMode.height) - 1) / 2);
            modeHeight = Number(currentMode?.height) || 0;
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
            `Disparity: blue 0 → red ${colorDisparityMax} px · Black: invalid · Max ${maxFps} fps`;
        $("stereo-rate-note").title =
            `Fixed disparity color scale: ${colorDisparityMax} px and above are red. Enabling disparity lowers a higher camera rate to this mode's ${maxFps} fps limit.`;
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
            "stereo-cy",
            "stereo-fov",
            "stereo-apply",
        ])
            $(id).disabled = pending || enabled || !available || configurationLocked;
        const reason =
            configError ||
            (!online
                ? "Camera offline"
                : configurationLocked
                  ? "SLAM 正在使用当前相机参数。请先停止并保存地图，再修改深度参数；深度预览可独立开关。"
                  : info.message ? info.message
                : !available
                  ? "Stereo matching unavailable: check calibration and installed models."
                  : enabled
                    ? `Live · FP16 stereo · Up to ${maxFps} fps`
                    : dirty
                      ? "Apply the mode/focal changes before enabling disparity."
                      : "Ready · Configuration is saved in camera EEPROM");
        $("stereo-notice").textContent = reason;
        $("stereo-notice").classList.toggle("validation-error", !!info.error || !!configError);
        if (!enabled && was) {
            lastId = "0";
            latest = null;
            rangeFrame = null;
            rangePointer = null;
            updateRange();
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
            this.points = new Float32Array();
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
            gl.clearColor(0.039, 0.063, 0.094, 1);
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
                    pivot: this.pickPoint(e.clientX, e.clientY),
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
                if (drag.pan) this.pan(dx, dy, drag.pivot);
                else this.rotate(dx, dy, drag.pivot);
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
                    const pixels = e.deltaY *
                        (e.deltaMode === 1 ? 16 :
                            e.deltaMode === 2 ? canvas.clientHeight : 1);
                    this.zoom(Math.max(-160, Math.min(160, pixels)));
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
            this.points = points;
            this.count = points.length / 6;
            const gl = this.gl;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, points, gl.DYNAMIC_DRAW);
            this.render();
        }
        pickPoint(clientX, clientY) {
            const rect = this.canvas.getBoundingClientRect(),
                m = this.viewProjection;
            if (!m || !rect.width || !rect.height) return null;
            const mouseX = clientX - rect.left,
                mouseY = clientY - rect.top,
                points = this.points,
                hits = [];
            let closest = 8 * 8;
            // Pick in CSS pixels so the hit radius is independent of zoom
            // and display DPI. This scan runs only when a drag starts.
            for (let i = 0; i < points.length; i += 6) {
                const x = points[i],
                    y = points[i + 1],
                    z = points[i + 2],
                    w = m[3] * x + m[7] * y + m[11] * z + m[15];
                if (!(w > 0)) continue;
                const px =
                        (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
                    py = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
                    pz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
                if (
                    !(Math.abs(px) <= 1 && Math.abs(py) <= 1 && Math.abs(pz) <= 1)
                )
                    continue;
                const dx = ((px + 1) * rect.width) / 2 - mouseX,
                    dy = ((1 - py) * rect.height) / 2 - mouseY,
                    distance = dx * dx + dy * dy;
                if (distance > 8 * 8) continue;
                closest = Math.min(closest, distance);
                hits.push({ index: i, distance, depth: w });
            }
            let selected = null;
            for (const hit of hits) {
                // Subpixel overlaps select the front surface, rather than
                // a point behind it whose projected center is slightly nearer.
                if (
                    hit.distance <= closest + 0.25 &&
                    (!selected || hit.depth < selected.depth)
                )
                    selected = hit;
            }
            return selected
                ? Array.from(points.subarray(selected.index, selected.index + 3))
                : null;
        }
        pan(dx, dy, pivot = null) {
            const { right, up, back } = this.viewBasis(),
                rect = this.canvas.getBoundingClientRect();
            // Keep the surface picked at pointer-down on a screen-parallel
            // plane. Its projected movement then matches the mouse exactly.
            const depth = pivot
                ? this.distance - pivot.reduce(
                    (sum, v, i) => sum + (v - this.target[i]) * back[i], 0)
                : this.distance;
            if (!(depth > 0) || !(rect.height > 0)) return;
            const scale = 2 * depth * Math.tan(Math.PI / 6) / rect.height;
            for (let i = 0; i < 3; i++)
                this.target[i] += (-dx * right[i] + dy * up[i]) * scale;
        }
        zoom(pixels) {
            this.distance = Math.max(
                0.03, Math.min(1000, this.distance * Math.exp(pixels * 0.00025)));
        }
        rotate(dx, dy, pivot = null) {
            const pixels = Math.hypot(dx, dy);
            if (!pixels) return;
            const previous = pivot ? this.viewBasis() : null;
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
            if (pivot) {
                // Rotate the eye and look-at target together about the picked
                // point. Its screen position stays fixed, with no recentering
                // jump when the mouse is pressed or a new depth frame arrives.
                const offset = this.target.map((v, i) => v - pivot[i]),
                    next = this.viewBasis(),
                    target = pivot.slice();
                for (const axis of ["right", "up", "back"]) {
                    const component = offset.reduce(
                        (sum, v, i) => sum + v * previous[axis][i],
                        0,
                    );
                    for (let i = 0; i < 3; i++)
                        target[i] += component * next[axis][i];
                }
                this.target = target;
            }
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
                rect = c.getBoundingClientRect(),
                w = Math.max(1, rect.width),
                h = Math.max(1, rect.height),
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
            this.viewProjection = m;
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
            const t = Math.min(1, d / colorDisparityMax);
            // Use a fixed scale so a disparity keeps its color across frames.
            rgba[offset] = 255 * Math.max(0, Math.min(1, 4 * t - 2));
            rgba[offset + 1] =
                255 * Math.max(0, Math.min(1, 2 - Math.abs(4 * t - 2)));
            rgba[offset + 2] = 255 * Math.max(0, Math.min(1, 2 - 4 * t));
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
        rangeFrame = { w, h, projection, focal, baseline, cx, cy, fy, header, view: v };
        updateRange();
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
        bindRange();
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
        const rescaleGeometry = (scaleFocal = true) => {
            const mode = allModes.find((m) => Number(m.id) === Number($("stereo-mode").value)),
                width = Number(mode?.width) || 0,
                height = Number(mode?.height) || 0,
                focal = Number($("stereo-focal").value),
                cy = Number($("stereo-cy").value),
                scaled = (focal * width) / modeWidth;
            if (scaleFocal && modeWidth > 0 && width > 0 && focal > 0 && Number.isFinite(scaled))
                $("stereo-focal").value = String(Number(scaled.toPrecision(7)));
            if (height > 0)
                $("stereo-cy").value = String(Number((modeHeight > 0 && Number.isFinite(cy)
                    ? (cy + 0.5) * height / modeHeight - 0.5
                    : (height - 1) / 2).toPrecision(8)));
            modeWidth = width;
            modeHeight = height;
            markDirty();
        };
        $("stereo-usage").addEventListener("change", () => {
            const p = Number($("stereo-usage").value);
            populateModes(p, 0);
            rescaleGeometry(false);
        });
        $("stereo-fov").addEventListener("input", markDirty);
        $("stereo-mode").addEventListener("change", () => rescaleGeometry());
        $("stereo-focal").addEventListener("input", markDirty);
        $("stereo-cy").addEventListener("input", markDirty);
        $("stereo-enable").addEventListener("click", async () => {
            if (pending || $("stereo-enable").disabled) return;
            const target = enabled ? 0 : 1,
                request = enableRequest = { requestId: null };
            pending = true;
            configError = "";
            window.updateStereoState(remoteState);
            try {
                const reply = await call("host_set_stereo", target);
                if (enableRequest !== request) return;
                if (!reply?.ok)
                    throw new Error(configurationError(reply?.result ?? -107));
                request.requestId = String(reply.request_id);
            } catch (error) {
                if (enableRequest !== request) return;
                enableRequest = null;
                pending = false;
                configError = error.message;
            }
            window.updateStereoState(remoteState);
        });
        $("stereo-apply").addEventListener("click", async () => {
            if (pending) return;
            if (configurationLocked) {
                configError = configurationError(-16);
                $("stereo-notice").textContent = configError;
                return;
            }
            const focal = Number($("stereo-focal").value),
                mode = Number($("stereo-mode").value);
            if (!Number.isFinite(focal) || focal <= 0) {
                $("stereo-notice").textContent =
                    "Focal length must be a positive number in pixels.";
                return;
            }
            const projection = Number($("stereo-usage").value),
                fov = Number($("stereo-fov").value),
                cy = Number($("stereo-cy").value);
            if ($("stereo-cy").value.trim() === "" || !Number.isFinite(cy)) {
                $("stereo-notice").textContent = "cy must be a finite number in output pixels.";
                return;
            }
            if (!Number.isFinite(fov) || fov < 30 || fov > 180) {
                $("stereo-notice").textContent =
                    "Vertical FOV must be between 30° and 180°.";
                return;
            }
            pending = true;
            configError = "";
            const target = configTarget = {
                mode,
                focal: Math.fround(focal),
                projection,
                fov: Math.fround(fov),
                cy: Math.fround(cy),
                requestId: null,
                deadline: performance.now() + 6000,
            };
            $("stereo-apply").disabled = true;
            try {
                const reply = await call(
                    "host_configure_stereo", mode, target.focal, projection, target.fov, target.cy,
                );
                if (configTarget !== target) return;
                if (!reply?.ok) throw new Error(configurationError(reply?.result ?? -107));
                target.requestId = String(reply.request_id);
            } catch (error) {
                if (configTarget !== target) return;
                pending = false;
                configTarget = null;
                configError = error.message;
                $("stereo-notice").textContent = configError;
                $("stereo-notice").classList.add("validation-error");
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
