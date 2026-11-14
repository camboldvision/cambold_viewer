/* SPDX-License-Identifier: Apache-2.0 */
import { logMessage } from "./messages.js";
let pendingMapDeltas = [];
const $ = (id) => document.getElementById(id);
const embeddedSdk = window.parent !== window;
// WebView2 injects the native binding into child frames too, but its replies
// are delivered to the top-level frame. Embedded views must use that frame's
// binding so requests and Promise resolutions share the same context.
const nativeViewer = () =>
    embeddedSdk
        ? typeof window.parent.viewer === "function"
            ? window.parent.viewer
            : null
        : typeof window.viewer === "function"
          ? window.viewer
          : null;
if (embeddedSdk) {
    document.body.classList.add("embedded");
    for (const id of ["port", "scan", "connect", "disconnect"])
        $(id).hidden = true;
}
let lastData = null,
    rendering = null,
    busy = false,
    generation = null,
    lastBoundary = null,
    subscriptionSession = null;
const gyroSamples = [],
    accelSamples = [];
let localError = "",
    boardError = "";
function showError() {
    const text = boardError || localError;
    $("error").hidden = !text;
    $("error").textContent = text;
}
function error(text) {
    localError = String(text ?? "");
    showError();
}
function mapError(text) {
    if (String(text).includes("CAMERA_CONFIG_FAILED:"))
        return `自动配置相机失败：${String(text).split("CAMERA_CONFIG_FAILED:")[1].trim()}`;
    const labels = {
        MAP_NO_FEATURES:
            "所选地图缺少局部特征，请选择“重新建图”建立新地图后再使用续图或纯定位。",
        CAMERA_BUSY:
            "相机正在被其他板端算法使用，请先停止该算法，再启动 CamBold SLAM。",
        CAMERA_CONTROL_UNAVAILABLE:
            "无法自动配置相机，请确认 stereo-imu-capture 服务运行正常，并已更新到配套版本。",
        MAP_PROJECTION_MISMATCH:
            "地图的相机几何参数不受当前 SLAM 模式支持，请选择兼容地图或重新建图。",
        MAP_NOT_FOUND: "所选地图不存在，请刷新地图列表。",
        MAP_EMPTY: "所选地图没有有效地图节点，请重新建图。",
        MAP_INVALID: "所选地图文件无效，请检查文件或重新建图。",
        MAP_BUSY: "地图数据库尚未关闭，请等待当前写入结束。",
        INVALID_MAP_NAME: "地图名称无效，请检查长度、首尾空格和保留字符。",
    };
    return (
        Object.entries(labels).find(([code]) =>
            String(text).includes(code),
        )?.[1] || String(text ?? "")
    );
}
function boardStatus(state) {
    boardError = "";
    if (state.connection === "READY" && state.last_error) {
        const labels = {
            CALIBRATION_MISSING: "标定文件缺失",
            CALIBRATION_UNREADABLE: "标定文件不可读",
            CALIBRATION_INVALID: "标定文件无效",
            CALIBRATION_UNAVAILABLE: "标定文件无法访问",
        };
        const label = labels[state.error_code] || "板端错误";
        boardError = `${label}：${mapError(state.last_error)}`;
        if (state.calibration_ready === false)
            boardError += "。请写入有效标定文件，设备会自动重试。";
    }
    showError();
}
async function api(action, values = {}) {
    if (!nativeViewer())
        throw new Error("原生连接未就绪，请使用 CamBold 上位机打开此界面。");
    const response = JSON.parse(await nativeViewer()({ action, ...values }));
    if (!response.ok) throw new Error(response.error || "请求失败");
    return response;
}
function action(id, fn) {
    $(id).addEventListener("click", async () => {
        try {
            error("");
            await fn();
        } catch (e) {
            error(e.message);
        }
    });
}
async function scanPorts() {
    const result = await api("ports"),
        select = $("port"),
        previous = select.value;
    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = "自动识别 SDK 设备";
    select.replaceChildren(
        automatic,
        ...result.ports.map((port) => {
            const option = document.createElement("option");
            option.value = option.textContent = port;
            return option;
        }),
    );
    select.value = result.ports.includes(previous) ? previous : "";
}
action("scan", scanPorts);
action("connect", () => api("connect", { port: $("port").value.trim() }));
action("disconnect", () => api("disconnect"));
let mapEntries = [],
    mapOptionKey = "",
    mapDefaultsSession = null,
    mapConfirmationPending = false,
    commandPendingUntil = 0,
    lastOperation = "";
const runningStates = new Set([
    "CONFIGURING_CAMERA",
    "STARTING",
    "INITIALIZING",
    "RUNNING",
    "STOPPING",
]);
function mapSelection() {
    const mode = $("map-mode").value;
    const name =
        mode === "new" ? $("map-name").value.trim() : $("map-select").value;
    if (!name)
        throw new Error(mode === "new" ? "请输入地图名称" : "请选择已保存地图");
    if (
        new TextEncoder().encode(name).length > 80 ||
        /^[. ]|[. ]$|[\x00-\x1f\x7f/\\:*?"<>|]/.test(name)
    )
        throw new Error(
            "地图名称最多 80 字节，不能包含路径分隔符、保留字符或首尾空格和句点",
        );
    return {
        map_name: name,
        map_mode: mode,
        dense_reconstruction: $("dense-reconstruction").checked,
    };
}
function renderMapOptions(state = lastData?.state || {}) {
    const mode = $("map-mode").value,
        key = JSON.stringify([mode, mapEntries]);
    if (key !== mapOptionKey) {
        mapOptionKey = key;
        const select = $("map-select"),
            previous = select.value;
        const options = mapEntries.map((entry) => {
            const option = document.createElement("option");
            option.value = entry.name;
            option.textContent = entry.name;
            option.title = `${entry.name} · ${(entry.bytes / 1048576).toFixed(2)} MiB`;
            return option;
        });
        if (mode === "new" || !options.length) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = mode === "new" ? "新地图…" : "暂无已保存地图";
            options.unshift(option);
        }
        select.replaceChildren(...options);
        const preferred = mapEntries.some((e) => e.name === previous)
            ? previous
            : mapEntries.some((e) => e.name === state.map_name)
              ? state.map_name
              : mode === "new"
                ? ""
                : mapEntries[0]?.name || "";
        select.value = preferred;
    }
    $("map-name-row").hidden = mode !== "new";
}
$("map-mode").addEventListener("change", () => {
    renderMapOptions();
    applyMapControls(lastData || {});
});
$("map-select").addEventListener("change", () => {
    if ($("map-mode").value === "new")
        $("map-name").value = $("map-select").value;
    applyMapControls(lastData || {});
});
$("map-name").addEventListener("input", () => applyMapControls(lastData || {}));
$("dense-reconstruction").addEventListener("change", () =>
    applyMapControls(lastData || {}),
);
action("refresh-maps", () => api("maps"));
async function confirmMapRebuild(name) {
    const dialog = $("map-confirm-dialog");
    $("map-confirm-message").textContent = `是否重新建立“${name}”地图？`;
    dialog.returnValue = "cancel";
    mapConfirmationPending = true;
    applyMapControls(lastData || {});
    try {
        return await new Promise((resolve, reject) => {
            const onClose = () => resolve(dialog.returnValue === "confirm");
            dialog.addEventListener("close", onClose, { once: true });
            try {
                dialog.showModal();
            } catch (e) {
                dialog.removeEventListener("close", onClose);
                reject(e);
            }
        });
    } finally {
        mapConfirmationPending = false;
        applyMapControls(lastData || {});
        if (!$("start").disabled) $("start").focus();
    }
}
document.querySelectorAll("[data-command]").forEach((button) =>
    button.addEventListener("click", async () => {
        if (mapConfirmationPending) return;
        try {
            error("");
            const command = button.dataset.command;
            const args = command === "STOP" ? {} : mapSelection();
            const session = lastData?.state?.session_id;
            if (
                command === "START" &&
                args.map_mode === "new" &&
                mapEntries.some((e) => e.name === args.map_name) &&
                !(await confirmMapRebuild(args.map_name))
            )
                return;
            // The connection or algorithm state may change while the dialog is open.
            if (button.disabled || session !== lastData?.state?.session_id) return;
            commandPendingUntil = performance.now() + 1500;
            applyMapControls(lastData || {});
            await api("command", { command, args });
        } catch (e) {
            commandPendingUntil = 0;
            error(e.message);
        }
    }),
);
function applyMapControls(data) {
    const state = data.state || {},
        ready = state.connection === "READY";
    const supported =
        Array.isArray(state.capabilities) &&
        state.capabilities.includes("map_management");
    const active = runningStates.has(state.state),
        pending = mapConfirmationPending || performance.now() < commandPendingUntil;
    const defaults = data.descriptors?.map_options;
    if (ready && defaults && mapDefaultsSession !== state.session_id) {
        mapDefaultsSession = state.session_id;
        $("map-mode").value = state.map_mode || defaults.default_mode || "new";
        $("map-name").value = state.map_name || defaults.default_map || "";
        mapOptionKey = "";
    }
    mapEntries = data.map_catalog?.maps || [];
    renderMapOptions(state);
    for (const id of [
        "map-mode",
        "map-select",
        "map-name",
        "dense-reconstruction",
    ])
        $(id).disabled = !ready || !supported || active || pending;
    if (active)
        $("dense-reconstruction").checked =
            state.dense_reconstruction !== false;
    $("reconstruction-hint").textContent = $("dense-reconstruction").checked
        ? "生成彩色稠密地图。运行期间关闭 SDK 的 IMU 上传，相机继续使用 IMU 进行定位。"
        : "生成稀疏地图，支持建图与重定位。可单独开启深度预览。";
    $("refresh-maps").disabled = !ready || !supported;
    let valid = false;
    try {
        mapSelection();
        valid = true;
    } catch (_) {}
    $("start").disabled =
        !ready ||
        !supported ||
        active ||
        pending ||
        !valid ||
        state.calibration_ready === false ||
        state.model_ready === false;
    $("stop").disabled =
        !ready || !active || pending || state.state === "STOPPING";
    $("stop").textContent =
        state.map_mode === "localization" ? "停止定位" : "停止并保存";
    $("active-map").textContent = state.map_name || "—";
    $("active-map").title = state.map_name || "";
    $("localization-state").textContent =
        {
            MAPPING: "建图中",
            SEARCHING: "等待重定位",
            LOCALIZED: "已定位",
            ODOMETRY: "位姿推算",
        }[state.map_localization] || "—";
    $("map-save-state").textContent = state.map_read_only
        ? "原地图只读"
        : state.map_saved
          ? "已保存"
          : active
            ? state.map_mode === "resume" && !state.map_aligned
                ? "等待重定位"
                : "停止后保存"
            : "—";
    const hints = {
        new: "填写新名称可创建地图；同名重新建图会自动备份原地图。停止时保存。",
        resume: "加载所选地图，完成重定位后继续建图，停止时保存更新。",
        localization:
            "加载所选地图进行定位，原地图内容保持不变。识别到已知场景后显示地图坐标位姿。",
    };
    $("map-hint").textContent =
        ready && !supported
            ? "板端版本尚未提供地图管理，请更新程序。"
            : data.map_catalog?.loading
              ? "正在读取板端地图列表…"
              : hints[$("map-mode").value];
    const operation = state.last_result;
    if (
        operation?.status === "failed" &&
        operation.operation_id !== lastOperation
    ) {
        lastOperation = operation.operation_id;
        commandPendingUntil = 0;
        error(mapError(operation.message || "板端操作失败"));
    }
}
function clearPreview(message = "左目图像订阅已关闭") {
    const img = $("image0");
    img.removeAttribute("src");
    img.dataset.frame = "";
    img.dataset.stamp = "";
    img.removeAttribute("width");
    img.removeAttribute("height");
    img.style.width = "";
    img.style.height = "";
    img.style.transform = "";
    img.parentElement.style.aspectRatio = "";
    $("image-meta0").textContent = message;
}
function subscribe() {
    return api("subscribe", {
        images: $("images").checked,
        dense: $("dense").checked,
    });
}
$("images").addEventListener("change", () => {
    if (!$("images").checked) clearPreview();
    if (lastData?.state?.connection === "READY")
        subscribe().catch((e) => error(e.message));
});
$("dense").addEventListener("change", () => {
    if (lastData?.state?.connection === "READY")
        subscribe().catch((e) => error(e.message));
});
action("clear", () => api("clear"));
action("home", () => rendering?.home(false));
action("top", () => rendering?.home(true));
const fixed = (v, n = 3) =>
    Number.isFinite(Number(v)) ? Number(v).toFixed(n) : "—";
function frequency(mhz) {
    if (mhz == null || !Number.isFinite(Number(mhz)) || Number(mhz) <= 0)
        return "—";
    return Number(mhz) >= 1000
        ? `${fixed(Number(mhz) / 1000, 3)} GHz`
        : `${fixed(mhz, 0)} MHz`;
}
const timingRows = [
    ["processing_ms", "位姿处理"],
    ["mapping_ms", "地图处理（平均）"],
];
const timingCells = new Map();
for (const [key, label] of timingRows) {
    const row = document.createElement("tr");
    const name = document.createElement("th");
    name.textContent = label;
    const cell = document.createElement("td");
    cell.textContent = "—";
    row.append(name, cell);
    $("timing-stages").appendChild(row);
    timingCells.set(key, cell);
}
function applyTiming(state) {
    $("timing-window").textContent =
        state.state === "RUNNING" ? "设备处理耗时" : "等待运行";
    for (const [key, cell] of timingCells)
        cell.textContent = state[key] == null ? "—" : fixed(state[key], 2);
}
function plot(id, samples) {
    const canvas = $(id),
        rect = canvas.getBoundingClientRect(),
        ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * ratio)),
        height = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, width, height);
    c.strokeStyle = "#29374a";
    c.lineWidth = ratio;
    c.beginPath();
    c.moveTo(0, height / 2);
    c.lineTo(width, height / 2);
    c.stroke();
    let bound = 1;
    for (const sample of samples)
        for (const value of sample) bound = Math.max(bound, Math.abs(value));
    ["#59cbdc", "#f3b65c", "#bf9cff"].forEach((color, axis) => {
        c.strokeStyle = color;
        c.beginPath();
        samples.forEach((sample, i) => {
            const x = (width * i) / Math.max(1, samples.length - 1),
                y = height / 2 - (sample[axis] / bound) * height * 0.43;
            i ? c.lineTo(x, y) : c.moveTo(x, y);
        });
        c.stroke();
        c.fillStyle = color;
        c.font = `${10 * ratio}px sans-serif`;
        c.fillText("XYZ"[axis], (8 + axis * 22) * ratio, 12 * ratio);
    });
}
function image(camera, data) {
    if (String(camera) !== "0" || !$("images").checked) return;
    const img = $(`image${camera}`);
    // Frame metadata is authoritative, including resolution changes on reconnect.
    img.width = data.width;
    img.height = data.height;
    const descriptor = (lastData?.descriptors?.cameras || []).find(
        (entry) => Number(entry.camera_id) === Number(camera),
    );
    const rotated = Number(descriptor?.projection || 0) === 1;
    img.parentElement.style.aspectRatio = rotated
        ? `${data.height} / ${data.width}`
        : `${data.width} / ${data.height}`;
    img.style.width = `${rotated ? (data.width / data.height) * 100 : 100}%`;
    img.style.height = `${rotated ? (data.height / data.width) * 100 : 100}%`;
    img.style.transform =
        "translate(-50%, -50%)" + (rotated ? " rotate(90deg)" : "");
    img.dataset.frame = data.frame_id;
    img.dataset.stamp = data.timestamp_ns;
    if (img.src !== data.jpeg) img.src = data.jpeg;
    $(`image-meta${camera}`).textContent =
        `${data.width}×${data.height} · frame ${data.frame_id} · ${data.source === 101 ? "跟踪特征" : `${(data.features || []).length} 特征`}`;
}
function apply(data) {
    lastData = data;
    const state = data.state || {};
    boardStatus(state);
    $("connection").textContent = state.connection || "DISCONNECTED";
    $("connection").classList.toggle("ready", state.connection === "READY");
    $("algorithm").textContent =
        { WAITING_CALIBRATION: "等待标定", CONFIGURING_CAMERA: "配置相机中" }[
            state.state
        ] ||
        state.state ||
        "IDLE";
    $("run").textContent = state.run_id || "—";
    $("run").title = state.run_id || "";
    $("epoch").textContent = state.epoch ?? "—";
    const camera = state.camera_configuration;
    $("camera-configuration").textContent =
        state.state === "CONFIGURING_CAMERA"
            ? "正在自动配置相机…"
            : camera
              ? `${camera.source === "map" ? "地图相机参数" : "相机配置"}：${camera.projection === 1 ? "垂直圆柱" : "水平针孔"} · ${camera.width}×${camera.height} · ${camera.frame_rate} fps · 焦距 ${fixed(camera.focal_px, 2)} px${camera.projection === 1 ? ` · FOV ${fixed(camera.vertical_fov, 1)}°` : ""}${camera.adjusted ? "（已自动调整并保存）" : ""}`
              : "启动时自动配置相机分辨率与帧率；加载地图时恢复地图的相机参数。";
    $("rtt").textContent =
        state.rtt_ms == null ? "—" : `${fixed(state.rtt_ms, 1)} ms`;
    $("pose-rate").textContent =
        state.pose_rate_hz == null ? "—" : `${fixed(state.pose_rate_hz, 1)} Hz`;
    $("processing").textContent =
        state.processing_ms == null
            ? "—"
            : `${fixed(state.processing_ms, 1)} ms`;
    $("board-temperature").textContent =
        state.board_temperature_c == null
            ? "—"
            : `${fixed(state.board_temperature_c, 1)} °C`;
    $("cpu-frequency").textContent = frequency(state.cpu_big_current_mhz);
    applyTiming(state);
    $("map-nodes").textContent = state.map_nodes ?? 0;
    $("loops-label").textContent =
        state.map_mode === "localization" ? "地图匹配" : "回环";
    $("loops").textContent =
        (state.map_mode === "localization"
            ? state.map_matches
            : state.loop_closures) ?? 0;
    $("image-health").textContent =
        $("images").checked && state.image_rate_hz != null
            ? `${fixed(state.image_rate_hz, 1)} fps`
            : "";
    const pose = data.pose;
    if (pose) {
        $("position").textContent = pose.p.map((v) => fixed(v)).join("  ");
        $("orientation").textContent = pose.q.map((v) => fixed(v)).join("  ");
        $("velocity").textContent = pose.v.map((v) => fixed(v)).join("  ");
    } else {
        $("position").textContent = "—";
        $("orientation").textContent = "—";
        $("velocity").textContent = "—";
    }
    const ready = state.connection === "READY";
    applyMapControls(data);
    $("port").options[0].textContent = ready
        ? `自动识别 · ${state.connection_detail || "SDK bulk"}`
        : "自动识别 SDK 设备";
    if (ready && subscriptionSession !== state.session_id) {
        subscriptionSession = state.session_id;
        subscribe().catch((e) => error(e.message));
    }
    if (!ready) subscriptionSession = null;
    $("logs").textContent = (data.logs || [])
        .slice(-60)
        .map(logMessage)
        .filter(Boolean)
        .join("\n");
    const boundary = `${state.run_id}:${state.epoch}`;
    if (generation !== data.generation) {
        generation = data.generation;
        rendering?.clear();
    }
    if (lastBoundary !== boundary || lastBoundary === null) {
        lastBoundary = boundary;
        gyroSamples.length = 0;
        accelSamples.length = 0;
        clearPreview("等待本次运行的左目图像");
    }
    if (rendering) rendering.update(data);
    else if (data.map_delta) pendingMapDeltas.push(data.map_delta);
    if (!$("pause-view").checked) {
        for (const [camera, value] of Object.entries(data.images || {}))
            image(camera, value);
        for (const sample of data.imu || []) {
            gyroSamples.push(sample.slice(1, 4));
            accelSamples.push(sample.slice(4, 7));
        }
        while (gyroSamples.length > 400) gyroSamples.shift();
        while (accelSamples.length > 400) accelSamples.shift();
        plot("gyro", gyroSamples);
        plot("accel", accelSamples);
    }
}
async function poll() {
    if (!busy && nativeViewer()) {
        busy = true;
        try {
            apply((await api("poll")).data);
        } catch (e) {
            error(e.message);
        } finally {
            busy = false;
        }
    }
    requestAnimationFrame(poll);
}
async function scene() {
    try {
        const [
            THREE,
            { OrbitControls },
            { LineSegments2 },
            { LineSegmentsGeometry },
            { LineMaterial },
            { MapLayer },
        ] = await Promise.all([
            import("./vendor/three/three.module.js"),
            import("./vendor/three/OrbitControls.js"),
            import("./vendor/three/lines/LineSegments2.js"),
            import("./vendor/three/lines/LineSegmentsGeometry.js"),
            import("./vendor/three/lines/LineMaterial.js"),
            import("./map_layer.js"),
        ]);
        const container = $("scene"),
            world = new THREE.Scene();
        world.background = new THREE.Color("#0a1018");
        const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
        camera.up.set(0, 0, 1);
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        container.appendChild(renderer.domElement);
        // Apply pointer deltas immediately; no inertial tail after releasing.
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = false;
        let interacting = false,
            renderNeeded = true;
        controls.addEventListener("change", () => {
            renderNeeded = true;
        });
        controls.addEventListener("start", () => {
            interacting = true;
        });
        controls.addEventListener("end", () => {
            interacting = false;
        });
        const grid = new THREE.GridHelper(20, 40, "#425b77", "#223246");
        grid.rotation.x = Math.PI / 2;
        const worldAxes = new THREE.AxesHelper(1);
        world.add(grid, worldAxes);
        const body = new THREE.Group();
        const cameras = new THREE.Group();
        body.add(cameras);
        world.add(body);
        body.visible = false;
        const mapLayer = new MapLayer();
        world.add(mapLayer.points, mapLayer.keyframes);
        let descriptorKey = "",
            targetPosition = new THREE.Vector3(),
            targetQuaternion = new THREE.Quaternion(),
            havePose = false;
        const bodyStep = new THREE.Vector3();
        $("follow").addEventListener("change", () => {
            if ($("follow").checked && havePose) {
                bodyStep.subVectors(body.position, controls.target);
                camera.position.add(bodyStep);
                controls.target.copy(body.position);
                controls.update();
            }
        });
        function home(top) {
            camera.position.set(top ? 0 : 4, top ? -0.01 : -6, top ? 10 : 4);
            controls.target.set(0, 0, 0);
            controls.update();
        }
        function clear() {
            mapLayer.clear();
            havePose = false;
            body.visible = false;
            renderNeeded = true;
        }
        function cameraShape(entry, z) {
            const ray = (u, v) => {
                const a = (u - entry.cx) / entry.fx,
                    b = (v - entry.cy) / entry.fy;
                return Number(entry.projection) === 1
                    ? new THREE.Vector3(a * z, Math.sin(b) * z, Math.cos(b) * z)
                    : new THREE.Vector3(a * z, b * z, z);
            };
            const points = [],
                corners = [
                    [0, 0],
                    [entry.width - 1, 0],
                    [entry.width - 1, entry.height - 1],
                    [0, entry.height - 1],
                ];
            for (let i = 0; i < 4; i++) {
                points.push(new THREE.Vector3(), ray(...corners[i]));
                const a = corners[i],
                    b = corners[(i + 1) % 4],
                    steps = Number(entry.projection) === 1 ? 24 : 1;
                for (let j = 0; j < steps; j++)
                    points.push(
                        ray(
                            a[0] + ((b[0] - a[0]) * j) / steps,
                            a[1] + ((b[1] - a[1]) * j) / steps,
                        ),
                        ray(
                            a[0] + ((b[0] - a[0]) * (j + 1)) / steps,
                            a[1] + ((b[1] - a[1]) * (j + 1)) / steps,
                        ),
                    );
            }
            return points;
        }
        function frustums(descriptors) {
            const list = descriptors.cameras || [],
                hash = JSON.stringify(list);
            if (hash === descriptorKey) return false;
            descriptorKey = hash;
            let shape = [];
            while (cameras.children.length) {
                const object = cameras.children[0];
                cameras.remove(object);
                object.geometry.dispose();
                object.material.dispose();
            }
            for (const entry of list) {
                // Represent the single VIO pose with the left camera only.
                if (entry.camera_id !== 0) continue;
                if (
                    !Array.isArray(entry.T_imu_camera) ||
                    entry.T_imu_camera.length !== 16 ||
                    !(entry.fx > 0) ||
                    !(entry.fy > 0)
                )
                    continue;
                const transform = new THREE.Matrix4().set(
                    ...entry.T_imu_camera,
                );
                const g = new LineSegmentsGeometry();
                g.setPositions(
                    cameraShape(entry, 0.25).flatMap((p) => p.toArray()),
                );
                // Screen-space width keeps the live pose legible when zoomed
                // out. Draw it over map geometry so dense points cannot hide it.
                const object = new LineSegments2(
                    g,
                    new LineMaterial({
                        color: "#35eb7f",
                        linewidth: 3,
                        depthTest: false,
                        depthWrite: false,
                    }),
                );
                object.renderOrder = 10;
                object.matrixAutoUpdate = false;
                object.matrix.copy(transform);
                cameras.add(object);
                shape = cameraShape(entry, 0.12).map((p) =>
                    p.clone().applyMatrix4(transform),
                );
                break;
            }
            mapLayer.setFrustumShape(shape);
            return true;
        }
        function update(data) {
            if (frustums(data.descriptors || {})) renderNeeded = true;
            const delta = data.map_delta;
            if (delta) {
                mapLayer.apply(delta);
                renderNeeded = true;
            }
            if (data.pose) {
                const p = data.pose.p,
                    q = data.pose.q;
                if (
                    !havePose ||
                    targetPosition.x !== p[0] ||
                    targetPosition.y !== p[1] ||
                    targetPosition.z !== p[2] ||
                    targetQuaternion.x !== q[0] ||
                    targetQuaternion.y !== q[1] ||
                    targetQuaternion.z !== q[2] ||
                    targetQuaternion.w !== q[3]
                )
                    renderNeeded = true;
                targetPosition.fromArray(p);
                targetQuaternion.fromArray(q);
                if (!havePose) {
                    body.position.copy(targetPosition);
                    body.quaternion.copy(targetQuaternion);
                }
                havePose = true;
            } else {
                if (havePose) renderNeeded = true;
                havePose = false;
            }
            $("point-count").textContent =
                `${mapLayer.count} 点 · ${mapLayer.keyframeCount} 关键帧视锥`;
            $("scene-message").textContent =
                data.state.map_sync_error ||
                (data.state.calibration_ready === false
                    ? "等待有效标定文件；请查看顶部错误信息"
                    : havePose
                      ? `地图：${data.state.map_name || "—"}`
                      : data.state.map_localization === "SEARCHING"
                        ? "已加载地图，等待识别已知场景"
                        : "等待初始化或有效位姿");
        }
        home(false);
        function animate(now) {
            requestAnimationFrame(animate);
            const width = Math.max(1, container.clientWidth),
                height = Math.max(1, container.clientHeight);
            if (
                renderer.domElement.width !==
                    Math.floor(width * renderer.getPixelRatio()) ||
                renderer.domElement.height !==
                    Math.floor(height * renderer.getPixelRatio())
            ) {
                renderer.setSize(width, height, false);
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
                renderNeeded = true;
            }
            const bodyVisible = havePose && $("show-body").checked,
                gridVisible = $("show-grid").checked;
            if (
                body.visible !== bodyVisible ||
                grid.visible !== gridVisible ||
                mapLayer.keyframes.visible !== $("show-keyframes").checked ||
                mapLayer.points.visible !== $("show-dense").checked
            )
                renderNeeded = true;
            body.visible = havePose && $("show-body").checked;
            grid.visible = worldAxes.visible = $("show-grid").checked;
            mapLayer.keyframes.visible = $("show-keyframes").checked;
            mapLayer.points.visible = $("show-dense").checked;
            if (havePose && !$("pause-view").checked) {
                bodyStep.copy(body.position);
                body.position.copy(targetPosition);
                bodyStep.subVectors(body.position, bodyStep);
                body.quaternion.copy(targetQuaternion);
                if ($("follow").checked && !interacting) {
                    camera.position.add(bodyStep);
                    controls.target.add(bodyStep);
                }
            }
            controls.update();
            if (renderNeeded && !$("pause-view").checked && !document.hidden) {
                renderer.render(world, camera);
                renderNeeded = false;
            }
        }
        requestAnimationFrame(animate);
        rendering = { update, clear, home };
        for (const delta of pendingMapDeltas)
            update({ ...lastData, map_delta: delta });
        pendingMapDeltas = [];
        window.__svioRendererReady = true;
    } catch (e) {
        $("scene-message").textContent =
            `3D 不可用：${e.message}。连接和数值仍可使用。`;
        window.__svioRendererError = e.message;
    }
}
scene();
poll();
window.addEventListener("error", (event) => error(event.message));
