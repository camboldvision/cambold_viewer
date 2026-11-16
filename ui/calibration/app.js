/* SPDX-License-Identifier: Apache-2.0 */
(() => {
    "use strict";
    const $ = id => document.getElementById(id);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    let sequence = 0, status = {}, busy = false, online = false, queryAt = 0;
    let lastHeartbeat = 0, heartbeatAt = 0, lastCostKey = "", cost = [], commandError = "";
    const acknowledgements = new Map();
    const phases = ["validate", "left", "right", "stereo", "imu_initialize", "joint", "check"];
    const labels = {
        idle:"等待任务", ready:"标定模式已就绪", collect:"采集数据", validate:"检查采集数据",
        left:"左相机内参标定", right:"右相机内参标定", stereo:"双目外参标定",
        imu_initialize:"相机–IMU 初始化", joint:"相机–IMU 联合优化", check:"校验标定结果",
        report:"生成详细报告", save:"写入并回读", done:"标定完成", cancelled:"任务已取消", error:"标定失败", allan_fit:"IMU 噪声拟合"
    };
    const time = seconds => {
        seconds = Math.max(0, Math.floor(seconds || 0));
        return `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
    };
    function notice(text, error = false) {
        $("notice").textContent = text;
        $("notice").classList.toggle("error", error);
    }
    async function call(request) {
        if (typeof window.parent.host_calibration !== "function")
            throw Error("标定接口不可用，请使用配套版本 Viewer");
        const value = await window.parent.host_calibration(request);
        const reply = typeof value === "string" ? JSON.parse(value) : value;
        if (!reply.ok) throw Error(reply.error || "标定请求失败");
        return reply;
    }
    function confirm(title, message) {
        $("confirm-title").textContent = title;
        $("confirm-message").textContent = message;
        const dialog = $("confirm");
        dialog.returnValue = "cancel";
        return new Promise(resolve => {
            dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), {once:true});
            dialog.showModal();
        });
    }
    function setControls() {
        const active = !!status.active;
        const collecting = status.task === "camera" || status.task === "imu";
        const solving = status.task === "solving";
        const available = online && active && status.hardware_ready && !collecting && !solving && !busy;
        $("enter").disabled = !online || active || busy;
        $("show-report").disabled = !online;
        $("leave").disabled = !online || !active || collecting || solving || busy;
        $("start-imu").disabled = !available;
        $("stop-imu").disabled = !online || status.task !== "imu" || busy;
        $("start-camera").disabled = !available || !status.noise_available;
        $("solve").disabled = !online || status.task !== "camera" || status.frames < 60 || status.imu_samples < 1000 || busy;
        $("fit-imu").disabled = !online || status.task !== "imu" || status.quiet_elapsed_s < 7200 || busy;
        $("cancel").disabled = !online || (!collecting && !solving) || busy || status.phase === "save";
        for (const id of ["rows", "cols", "tag-size", "spacing"]) $(id).disabled = collecting || solving || busy;
    }
    function drawCost() {
        const c = $("cost"), ctx = c.getContext("2d"), width = c.clientWidth;
        c.width = width * devicePixelRatio;
        c.height = 90 * devicePixelRatio;
        ctx.scale(devicePixelRatio, devicePixelRatio);
        if (cost.length < 2 || !width) return;
        const values = cost.map(x => Math.log10(Math.max(x, 1e-12)));
        const lo = Math.min(...values), hi = Math.max(...values);
        ctx.strokeStyle = "#66b2f4"; ctx.lineWidth = 1.5; ctx.beginPath();
        values.forEach((v, i) => {
            const x = 8 + i * (width - 16) / (values.length - 1);
            const y = 78 - (v - lo) * 60 / Math.max(hi - lo, 1e-8);
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.stroke();
    }
    function render(s) {
        status = s;
        if (!s.active) {
            $("preview").hidden = true;
            $("preview").removeAttribute("src");
            $("empty").hidden = false;
        }
        $("phase").textContent = s.active && s.phase === "ready" && !s.hardware_ready ? "正在准备相机" : labels[s.phase] || s.phase || "等待任务";
        $("step").textContent = s.step || "进入标定模式后选择采集任务。";
        $("countdown").textContent = time(s.remaining_s ?? 7200);
        $("quiet").textContent = time(s.quiet_elapsed_s);
        $("static-progress").style.width = Math.min(100, 100 * (s.quiet_elapsed_s || 0) / 7200) + "%";
        $("imu").textContent = s.imu_hz ? `${s.imu_hz.toFixed(1)} Hz / ${(s.imu_samples || 0).toLocaleString()}` : "—";
        $("resets").textContent = s.static_resets || 0;
        $("noise").textContent = s.noise_available ? "YAML 中已有有效 IMU 噪声参数，可直接进行联合标定。" : s.noise_error || "未找到有效 IMU 噪声参数，请先完成静态标定。";
        $("frames").textContent = `${s.frames || 0} / ${s.processed_frames || 0}`;
        $("coverage").textContent = (s.coverage_percent || [0, 0]).map(n => n.toFixed(1) + "%").join(" / ");
        $("phase-time").textContent = time(s.phase_elapsed_s);
        $("iteration").textContent = s.iteration ? `迭代 ${s.iteration} / 上限 ${s.max_iterations}` : s.total ? `${s.completed} / ${s.total}` : "—";
        $("eta").textContent = s.stage_eta_range_s ? `${time(s.stage_eta_range_s[0])} ～ ${time(s.stage_eta_range_s[1])}` :
            s.iteration_budget_s ? `至迭代上限约 ${time(s.iteration_budget_s)}` : s.task === "solving" ? "正在估算" : "—";
        $("detail").textContent = s.iteration ?
            `当前平均每轮 ${(s.mean_iteration_s || 0).toFixed(2)} 秒，可能提前收敛。最近计算进展：${time(s.progress_age_s)} 前。` :
            `最近计算进展：${time(s.progress_age_s)} 前。采集期间 IMU 丢样：${s.imu_drops || 0}。`;
        const stage = ["report", "save"].includes(s.phase) ? 6 : phases.indexOf(s.phase);
        [...$("stages").children].forEach((e, i) => {
            e.classList.toggle("active", i === stage);
            e.classList.toggle("done", s.phase === "done" || (stage >= 0 && i < stage));
        });
        $("solve-progress").style.width = s.phase === "done" ? "100%" : Math.max(0, stage) * 100 / 7 + "%";
        $("solve-progress").classList.toggle("working", s.task === "solving");
        const error = commandError || s.error || s.hardware_error;
        if (error) notice(error, true);
        else if (s.warning) notice(s.warning);
        else notice(s.active ? "标定模式已占用 bulk 数据通道；原始 UVC 预览保持可用。" : "原始 UVC 预览可继续使用。标定模式暂停普通 IMU、深度图和 SLAM 的 bulk 传输。");
        const key = s.phase + ":" + s.iteration;
        if (s.cost > 0 && key !== lastCostKey) {
            if (s.phase !== lastCostKey.split(":")[0]) cost = [];
            lastCostKey = key; cost.push(s.cost);
            if (cost.length > 260) cost.shift();
            drawCost();
        }
        setControls();
    }
    async function requestReply(request) {
        const r = await call(request), deadline = performance.now() + 8000;
        while (!acknowledgements.has(r.request_id)) {
            if (performance.now() > deadline) throw Error("板端未确认标定请求，请检查连接后读取任务状态");
            await pause(25);
        }
        const reply = acknowledgements.get(r.request_id);
        acknowledgements.delete(r.request_id);
        if (!reply?.ok) throw Error(reply?.error || "板端未接受标定请求");
        return reply;
    }
    const command = (action, options = {}) => requestReply({action, ...options});
    let reportGeneration = 0;
    async function loadReport() {
        const generation = ++reportGeneration, kind = $("report-kind").value;
        $("report-refresh").disabled = $("report-kind").disabled = true;
        $("report-frame").hidden = true;
        $("report-state").textContent = "正在读取板端报告…";
        try {
            let revision = 0, total = 0, text = "", hash = 2166136261;
            do {
                const reply = await requestReply({action:"report", kind, revision, offset:text.length});
                if (generation !== reportGeneration || !$("report-dialog").open) return;
                const part = reply.report_chunk;
                if (!part || part.kind !== kind || part.offset !== text.length ||
                    !Number.isInteger(part.total) || part.total <= 0 || part.total > 2 * 1024 * 1024 ||
                    !Number.isInteger(part.revision) || part.revision < 0 || part.revision > 0xffffffff ||
                    typeof part.data !== "string" || !part.data.length || /[^\x00-\x7f]/.test(part.data) ||
                    text.length + part.data.length > part.total ||
                    (text.length && (part.revision !== revision || part.total !== total)))
                    throw Error("标定报告分片不完整，请重新读取");
                revision = part.revision; total = part.total;
                text += part.data;
                for (let i = 0; i < part.data.length; ++i)
                    hash = Math.imul(hash ^ part.data.charCodeAt(i), 16777619) >>> 0;
                $("report-state").textContent = `正在读取报告：${(text.length * 100 / total).toFixed(0)}% · ${(total / 1024).toFixed(1)} KiB`;
            } while (text.length < total);
            if (hash !== revision) throw Error("标定报告校验失败，请重新读取");
            const report = JSON.parse(text);
            if (report.version !== 1 || report.kind !== kind) throw Error("不支持的标定报告版本");
            const frame = $("report-frame");
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(Error("报告页面加载超时")), 6000);
                frame.onload = () => { clearTimeout(timer); resolve(); };
                frame.src = "report.html";
            });
            if (generation !== reportGeneration || !$("report-dialog").open) return;
            frame.hidden = false;
            frame.contentWindow.postMessage({type:"calibration-report", report}, location.origin);
            $("report-state").textContent = kind === "current" ?
                "直接读取 camera_imu_calibration.yaml 中的当前参数。" :
                `报告生成于 ${report.created_utc || "—"}，参数快照保存在报告末尾。`;
        } catch (error) {
            if (generation === reportGeneration) $("report-state").textContent = error.message || String(error);
        } finally {
            if (generation === reportGeneration) $("report-refresh").disabled = $("report-kind").disabled = false;
        }
    }
    $("show-report").onclick = () => { $("report-dialog").showModal(); loadReport(); };
    $("report-refresh").onclick = loadReport;
    $("report-kind").onchange = loadReport;
    $("report-close").onclick = () => $("report-dialog").close();
    $("report-dialog").addEventListener("close", () => {
        ++reportGeneration;
        $("report-frame").src = "about:blank";
        $("report-refresh").disabled = $("report-kind").disabled = false;
    });
    async function enter() {
        const pre = await call({action:"preflight"});
        let message = "进入标定模式后将暂停普通 IMU、深度图和 SLAM 的 bulk 传输。原始 UVC 预览保持可用。";
        if (pre.recording) message += "\n当前录制需要先停止。";
        if (pre.slam_running) message += "\n当前 SLAM 需要先停止并保存地图。";
        if (!await confirm("进入相机标定", message)) return;
        if (pre.recording) await window.parent.host_stop_bag();
        if (pre.slam_running) {
            let r = await window.parent.viewer({action:"command", command:"STOP"});
            r = typeof r === "string" ? JSON.parse(r) : r;
            if (!r.ok) throw Error(r.error);
            for (let i = 0; i < 300; ++i) {
                await pause(100);
                if (!(await call({action:"preflight"})).slam_running) break;
                if (i === 299) throw Error("SLAM 尚未停止，请稍后重试");
            }
        }
        await command("enter");
    }
    function bind(id, fn) {
        $(id).addEventListener("click", async () => {
            if (busy) return;
            busy = true; commandError = ""; setControls();
            try { await fn(); }
            catch (e) { commandError = e.message || String(e); notice(commandError, true); }
            finally { busy = false; setControls(); }
        });
    }
    bind("enter", enter);
    bind("leave", () => command("leave"));
    bind("start-imu", async () => {
        if (await confirm("开始 IMU 静态采集", "请固定相机，保持静止和供电稳定至少 120 分钟。检测到运动或数据中断后会重新计时。"))
            await command("start_imu");
    });
    bind("start-camera", async () => {
        const rows = Number($("rows").value), cols = Number($("cols").value);
        const tag_size_m = Number($("tag-size").value), spacing = Number($("spacing").value);
        if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows * cols < 2 || rows * cols > 587 ||
            !(tag_size_m > 0) || tag_size_m > 2 || !Number.isFinite(spacing) || spacing < 0 || spacing > 2)
            throw Error("请检查 AprilGrid 参数");
        if (await confirm("开始联合采集", `标定板：${rows} 行 × ${cols} 列，黑框边长 ${tag_size_m} 米，间距比 ${spacing}。\n固定标定板，移动相机覆盖图像边缘和角落，并进行多轴转动。`))
            await command("start_camera", {rows, cols, tag_size_m, spacing});
    });
    bind("solve", async () => {
        if (await confirm("结束采集并开始标定", "请确认左右图像已充分覆盖，且采集包含多轴运动。求解期间会显示实际处理阶段、迭代和耗时。"))
            await command("solve");
    });
    bind("fit-imu", () => command("solve"));
    const cancelTask = async () => {
        const imu = status.task === "imu";
        if (await confirm(imu ? "停止 IMU 静态采集" : "取消标定", imu ?
            "停止本次采集并丢弃尚未保存的数据？已有标定文件将保留。" : "取消当前任务并保留已有标定文件？"))
            await command("cancel");
    };
    bind("stop-imu", cancelTask);
    bind("cancel", cancelTask);
    async function poll() {
        try {
            if (performance.now() - heartbeatAt > 2000 && performance.now() - queryAt > 2000) {
                queryAt = performance.now(); await call({action:"status"});
            }
            const visible = !window.parent.document.getElementById("tab-calibration")?.hidden;
            const r = await call({action:"poll", after:sequence, preview:visible});
            online = true;
            for (const reply of r.replies || []) {
                acknowledgements.set(reply.request_id, reply.data);
                if (acknowledgements.size > 64) acknowledgements.delete(acknowledgements.keys().next().value);
            }
            if (r.status?.version && r.status.heartbeat_ns !== lastHeartbeat) {
                lastHeartbeat = r.status.heartbeat_ns; heartbeatAt = performance.now(); render(r.status);
            }
            if (r.jpeg && status.active) {
                sequence = r.sequence; $("preview").src = "data:image/jpeg;base64," + r.jpeg;
                $("preview").hidden = false; $("empty").hidden = true;
            }
            const fresh = heartbeatAt && performance.now() - heartbeatAt < 2500;
            $("heartbeat").textContent = fresh ? "已连接 · 状态正常" : "等待板端状态";
            $("connection").textContent = fresh ? "板端在线" : "等待状态";
            $("connection").classList.toggle("online", !!fresh);
        } catch (e) {
            online = false; sequence = 0; lastHeartbeat = 0;
            $("connection").textContent = "未连接"; $("heartbeat").textContent = "连接中断";
        } finally { setControls(); setTimeout(poll, 25); }
    }
    new ResizeObserver(drawCost).observe($("cost"));
    poll();
})();
