/* SPDX-License-Identifier: Apache-2.0 */
(() => {
    "use strict";
    const root = document.getElementById("report"), colors = ["#65b5ff", "#5ed6a2", "#f5bb61", "#d49bff", "#ff8493", "#85dce8"];
    const number = value => typeof value === "number" && Number.isFinite(value) ?
        (value === 0 ? "0" : Math.abs(value) < .001 || Math.abs(value) >= 1e6 ? value.toExponential(5) : Number(value.toPrecision(7)).toString()) : "—";
    const text = value => Array.isArray(value) ? value.map(number).join(", ") :
        typeof value === "number" ? number(value) : value === true ? "是" : value === false ? "否" : value ?? "—";
    const element = (tag, parent, value, className) => {
        const e = document.createElement(tag);
        if (value !== undefined) e.textContent = value;
        if (className) e.className = className;
        parent.append(e); return e;
    };
    let redraws = [], observer;
    function card(title, parent = root) {
        const section = element("section", parent, undefined, "card");
        element("h2", section, title); return section;
    }
    function table(parent, rows, headers = ["项目", "值"]) {
        const t = element("table", element("div", parent, undefined, "scroll"));
        const head = element("tr", element("thead", t));
        headers.forEach(label => element("th", head, label));
        const body = element("tbody", t);
        rows.forEach(row => { const tr = element("tr", body); row.forEach(value => element("td", tr, text(value))); });
    }
    function pre(parent, value) { element("pre", parent, value); }
    function matrix(parent, name, values) {
        element("h3", parent, name);
        pre(parent, (values || []).map(row => row.map(x => typeof x === "number" ? x.toFixed(9).padStart(14) : "—").join(" ")).join("\n"));
    }
    function noise(parent, value) {
        if (!value) return;
        table(parent, [["加速度计白噪声密度", value.accelerometer_noise_density, "m/s²/√Hz"],
            ["陀螺仪白噪声密度", value.gyroscope_noise_density, "rad/s/√Hz"],
            ["加速度计零偏随机游走", value.accelerometer_random_walk, "(m/s²)/√s"],
            ["陀螺仪零偏随机游走", value.gyroscope_random_walk, "(rad/s)/√s"],
            ["采样率", value.update_rate > 0 ? value.update_rate : "未记录", "Hz"]], ["噪声参数", "值", "单位"]);
        element("p", parent, "参数以连续时间标准差系数保存。采样间隔为 Δt 秒时，单样本白噪声标准差为噪声密度 / √Δt，零偏增量标准差为随机游走系数 × √Δt。", "hint");
    }
    function canvas(parent, className, draw) {
        const c = element("canvas", parent, undefined, className);
        const update = () => {
            const w = Math.max(240, c.clientWidth), h = c.clientHeight || 250, ratio = devicePixelRatio || 1;
            c.width = Math.round(w * ratio); c.height = Math.round(h * ratio);
            const ctx = c.getContext("2d"); ctx.scale(ratio, ratio); draw(ctx, w, h, c);
        };
        redraws.push(update); return {c, update};
    }
    function legend(parent, names) {
        const row = element("div", parent, undefined, "legend");
        names.forEach((name, i) => {
            const span = element("span", row), swatch = element("i", span);
            swatch.style.background = colors[i % colors.length]; span.append(document.createTextNode(name));
        });
    }
    function plot(parent, rows, series, xLabel = "时间（秒）", yLabel = "", logarithmic = false) {
        canvas(parent, "plot", (ctx, w, h) => {
            const convert = x => typeof x !== "number" || !Number.isFinite(x) || logarithmic && x <= 0 ? NaN : logarithmic ? Math.log10(x) : x;
            let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
            for (const row of rows) for (const s of series) {
                const x = convert(row[0]), y = convert(row[s.index]);
                if (Number.isFinite(x) && Number.isFinite(y)) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
            }
            ctx.font = "11px system-ui"; ctx.fillStyle = "#9aafc7";
            if (!Number.isFinite(xmin)) { ctx.fillText("没有有效曲线数据", 20, 35); return; }
            if (xmin === xmax) xmax = xmin + 1;
            if (ymin === ymax) { ymin -= .5; ymax += .5; }
            const left = 72, right = w - 18, top = 24, bottom = h - 44;
            const X = x => left + (x - xmin) / (xmax - xmin) * (right - left);
            const Y = y => bottom - (y - ymin) / (ymax - ymin) * (bottom - top);
            for (let i = 0; i <= 4; ++i) {
                const x = xmin + (xmax - xmin) * i / 4, y = ymin + (ymax - ymin) * i / 4;
                ctx.strokeStyle = "#213247"; ctx.beginPath(); ctx.moveTo(left, Y(y)); ctx.lineTo(right, Y(y)); ctx.stroke();
                ctx.fillStyle = "#9aafc7"; ctx.textAlign = "right";
                const tick = value => logarithmic ? Math.pow(10, value).toExponential(1) : Number(value.toPrecision(3)).toString();
                ctx.fillText(tick(y), left - 8, Y(y) + 4);
                ctx.textAlign = "center"; ctx.fillText(tick(x), X(x), bottom + 18);
            }
            ctx.textAlign = "left"; ctx.fillText(yLabel, 12, 15);
            ctx.textAlign = "right"; ctx.fillText(xLabel, right, h - 7);
            series.forEach((s, i) => {
                ctx.strokeStyle = colors[i % colors.length]; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false;
                for (const row of rows) {
                    const x = convert(row[0]), y = convert(row[s.index]);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) { started = false; continue; }
                    if (started) ctx.lineTo(X(x), Y(y)); else ctx.moveTo(X(x), Y(y)); started = true;
                }
                ctx.stroke();
            });
        });
        legend(parent, series.map(s => s.name));
    }
    function imagePlot(parent, camera, worst = false) {
        canvas(parent, "image-canvas", (ctx, w, h) => {
            const scale = Math.min((w - 40) / camera.width, (h - 34) / camera.height);
            const ox = (w - camera.width * scale) / 2, oy = 12;
            const X = x => ox + x * scale, Y = y => oy + y * scale;
            if (!worst) {
                const grid = camera.coverage_grid || [], maximum = Math.max(1, ...grid);
                grid.forEach((value, i) => {
                    ctx.fillStyle = value ? `rgba(55,175,134,${.16 + .65 * Math.log1p(value) / Math.log1p(maximum)})` : "#172334";
                    ctx.fillRect(X(i % 16 * camera.width / 16), Y(Math.floor(i / 16) * camera.height / 12), camera.width / 16 * scale - 1, camera.height / 12 * scale - 1);
                });
                ctx.fillStyle = "#77d8bc";
                for (const p of camera.scatter || []) { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 1.2, 0, 2 * Math.PI); ctx.fill(); }
            } else for (const p of camera.worst_frame?.points || []) {
                ctx.strokeStyle = "#a4aebd"; ctx.beginPath(); ctx.moveTo(X(p[0]), Y(p[1])); ctx.lineTo(X(p[2]), Y(p[3])); ctx.stroke();
                [0, 2].forEach((j, i) => { ctx.strokeStyle = colors[i]; ctx.beginPath(); ctx.arc(X(p[j]), Y(p[j+1]), 2.5, 0, 2*Math.PI); ctx.stroke(); });
            }
            ctx.strokeStyle = "#597089"; ctx.strokeRect(ox, oy, camera.width * scale, camera.height * scale);
            ctx.fillStyle = "#a8b8cb"; ctx.font = "11px system-ui"; ctx.fillText(`${camera.width} × ${camera.height} 像素坐标`, 12, h - 7);
        });
    }
    function trajectory(parent, rows) {
        let q = [.18, .3, 0, .94], zoom = 1, drag;
        const normalize = a => { const n = Math.hypot(...a) || 1; return a.map(x => x / n); };
        const multiply = (a,b) => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
        const rotate = p => multiply(multiply(q,[...p,0]),[-q[0],-q[1],-q[2],q[3]]).slice(0,3);
        const groups = ["left","right","imu"], points = rows.flatMap(row => groups.map(key=>row[key])).filter(p => Array.isArray(p) && p.every(Number.isFinite));
        const lo = [0,1,2].map(k=>Math.min(...points.map(p=>p[k]))), hi = [0,1,2].map(k=>Math.max(...points.map(p=>p[k])));
        const center = lo.map((v,k)=>(v+hi[k])/2), span = Math.max(1e-5,...lo.map((v,k)=>hi[k]-v));
        q = normalize(q);
        const {c,update} = canvas(parent,"trajectory",(ctx,w,h)=>{
            if (!points.length) return;
            const project = p => { const v = rotate(p.map((x,k)=>x-center[k])); return [w/2+v[0]*h*.7/span*zoom,h/2-v[1]*h*.7/span*zoom]; };
            groups.forEach((key,i)=>{
                ctx.strokeStyle = colors[i]; ctx.lineWidth = 1.7; ctx.beginPath();
                rows.forEach((row,j)=>{const [x,y]=project(row[key]);if(j)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();
            });
            ctx.font="12px system-ui";
            for(let k=0;k<3;k++){const p=[0,0,0];p[k]=1;const v=rotate(p);ctx.strokeStyle=colors[k];ctx.beginPath();ctx.moveTo(42,h-45);ctx.lineTo(42+v[0]*28,h-45-v[1]*28);ctx.stroke();ctx.fillStyle=colors[k];ctx.fillText("XYZ"[k],42+v[0]*36,h-45-v[1]*36);}
        });
        const sphere = e => {const b=c.getBoundingClientRect(),s=Math.min(b.width,b.height)/2,x=(e.clientX-b.left-b.width/2)/s,y=-(e.clientY-b.top-b.height/2)/s,z=Math.sqrt(Math.max(0,1-x*x-y*y));return normalize([x,y,z]);};
        c.onpointerdown=e=>{drag=sphere(e);c.setPointerCapture(e.pointerId);};
        c.onpointermove=e=>{if(!drag)return;const v=sphere(e),cross=[drag[1]*v[2]-drag[2]*v[1],drag[2]*v[0]-drag[0]*v[2],drag[0]*v[1]-drag[1]*v[0]],dot=drag.reduce((s,x,k)=>s+x*v[k],0);if(dot>-.99999)q=normalize(multiply(normalize([...cross,1+dot]),q));drag=v;update();};
        c.onpointerup=c.onpointercancel=c.onlostpointercapture=()=>{drag=null;};
        c.onwheel=e=>{e.preventDefault();zoom=Math.max(.15,Math.min(12,zoom*Math.exp(-e.deltaY*.001)));update();};
        legend(parent,["左相机","右相机","IMU"]);element("p",parent,"拖动旋转，滚轮缩放。坐标系固定在标定板，长度单位为米。", "note");
    }
    function render(r) {
        observer?.disconnect();redraws=[];root.replaceChildren();
        document.getElementById("title").textContent = {current:"当前标定参数",joint:"双目与相机–IMU 联合标定报告",imu:"IMU 静态噪声标定报告"}[r.kind];
        const date = new Date(r.created_utc || r.modified_utc || "");
        const dateLabel = Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 ? date.toLocaleString() : "未记录有效时间";
        document.getElementById("subtitle").textContent = `${r.created_utc ? "生成时间" : "文件修改时间"}：${dateLabel}`;
        if (r.kind === "current") {
            const s=card("IMU 噪声参数");noise(s,r.noise);if(r.noise_error)element("p",s,r.noise_error,"warning");
            element("p",root,"当前参数直接来自板端 YAML。详细误差、轨迹和 Allan 曲线在完成对应阶段的标定后生成。");
        } else {
            const s=card("采集与求解概况");
            table(s,[["采集时长（秒）",r.duration_s],["IMU 样本数",r.imu_samples],...(r.kind==="joint"?[["有效观测组数",r.frames],["检测帧数",r.processed_frames],["左目 / 右目检测次数",r.detections],["IMU 丢样数",r.imu_drops],["双目基线（米）",r.baseline_m],["求解迭代次数",r.optimization.iterations],["初始 / 最终代价",[r.optimization.initial_cost,r.optimization.final_cost]],["收敛条件满足",r.optimization.converged],["结束原因",r.optimization.termination]]:[["采样率（Hz）",r.frequency_hz]])]);
            noise(card("使用或估计的 IMU 噪声参数"),r.noise);
        }
        if(r.kind==="joint"){
            element("p",root,r.plot_note,"note");
            const target=r.target||{};table(card("AprilGrid 标定板"),[["标签行 / 列",[target.rows,target.cols]],["黑框边长（米）",target.tag_size_m],["间距 / 黑框边长",target.spacing],["标签族 / 黑边宽度","Tag36h11 / 2"]]);
            const columns=element("div",root,undefined,"columns");
            for(const camera of r.cameras){
                const s=card(camera.id?"右相机":"左相机",columns),e=camera.reprojection;
                table(s,[["模型",camera.model],["分辨率",`${camera.width} × ${camera.height}`],["内参 [fx, fy, cx, cy, xi, lambda, alpha]",camera.intrinsics],["全部角点数",e.count],["单目阶段 RMS（像素）",camera.monocular_rms_px??null],["双目阶段 RMS（像素）",camera.stereo_rms_px],["相机–IMU 联合 RMS（像素）",e.rms],["联合误差：平均 / 标准差 / 最大值（像素）",[e.mean,e.stddev,e.max]],["网格覆盖率",`${number(camera.coverage_percent)}%`]]);
                element("h3",s,"角点覆盖分布");imagePlot(s,camera);
                element("h3",s,"逐帧重投影误差");plot(s,camera.per_frame,[{name:"RMS",index:1},{name:"最大值",index:2}],"时间（秒）","像素");
                element("h3",s,"最大误差帧的角点与投影");imagePlot(s,camera,true);legend(s,["检测坐标","投影坐标"]);
                element("p",s,`帧序号 ${camera.worst_frame?.sequence??"—"}，最大误差 ${number(camera.worst_frame?.maximum_px)} 像素。图中为像素坐标示意。`,"note");
                matrix(s,"T_cam0_cam：本相机坐标 → 左相机坐标",camera.T_cam0_cam);
                matrix(s,"T_cam_imu：IMU 坐标 → 本相机坐标",camera.T_cam_imu);
            }
            trajectory(card("联合优化后的采集轨迹"),r.trajectory);
            const imu=r.imu,s=card("相机–IMU 参数与运动激励");
            table(s,[["时间偏移（秒）",imu.time_shift_s],["时间定义","t_imu = t_cam + time_shift_s"],["陀螺仪零偏（rad/s）",imu.gyro_bias_rad_s],["加速度计零偏（m/s²）",imu.accel_bias_m_s2],["重力（m/s²）",imu.gravity_m_s2],["加速度计尺度与非正交系数",imu.accel_map_coeff],["陀螺仪尺度与非正交系数",imu.gyro_map_coeff],["系数顺序","[m00, m11, m22, m01, m02, m12]，上三角矩阵"],["加速度计 → 陀螺仪轴对齐（旋转向量，rad）",imu.accel_to_gyro_rotation_rad],["旋转激励方向秩",imu.rotation_rank],["累计旋转跨度（rad）",imu.rotation_span_rad],["时间偏移主峰 / 次峰评分",[imu.time_shift_peak_score,imu.time_shift_secondary_score]],["次峰时间偏移（秒）",imu.time_shift_secondary_s]]);
            matrix(s,"T_cam0_imu",imu.T_cam0_imu);matrix(s,"T_imu_cam0",imu.T_imu_cam0);
            plot(card("联合求解代价变化"),r.optimization.cost_history.map((v,i)=>[i,v]),[{name:"代价",index:1}],"已接受的更新次数","代价");
            const errors=card("IMU 预积分残差统计");table(errors,[["角速度",r.gyro_residual.mean,r.gyro_residual.stddev,r.gyro_residual.rms,r.gyro_residual.max,"rad/s"],["加速度",r.accel_residual.mean,r.accel_residual.stddev,r.accel_residual.rms,r.accel_residual.max,"m/s²"]],["残差","均值","标准差","RMS","最大值","单位"]);
            plot(card("角速度残差"),r.residuals,[{name:"残差模长",index:1}],"时间（秒）","rad/s");
            plot(card("加速度残差"),r.residuals,[{name:"残差模长",index:2}],"时间（秒）","m/s²");
            plot(card("噪声归一化残差"),r.residuals,[{name:"旋转因子",index:3},{name:"速度因子",index:4}],"时间（秒）","无量纲模长");
            plot(card("采集的陀螺仪数据"),r.raw_imu,[{name:"X",index:1},{name:"Y",index:2},{name:"Z",index:3}],"相机时间原点下的原始 IMU 时间（秒）","rad/s");
            plot(card("采集的加速度计数据"),r.raw_imu,[{name:"X",index:4},{name:"Y",index:5},{name:"Z",index:6}],"相机时间原点下的原始 IMU 时间（秒）","m/s²");
            for(const [key,title,unit] of [["gyro_bias","陀螺仪零偏随时间变化","rad/s"],["accel_bias","加速度计零偏随时间变化","m/s²"]])
                plot(card(title),r.trajectory.map(v=>[v.t,...v[key]]),[{name:"X",index:1},{name:"Y",index:2},{name:"Z",index:3}],"时间（秒）",unit);
        }
        if(r.kind==="imu"){
            for(const w of r.warnings||[])element("p",root,w,"warning");
            const columns=element("div",root,undefined,"columns");
            (r.axes||[]).forEach((axis,i)=>{
                const s=card(`${i<3?"陀螺仪":"加速度计"} ${"XYZ"[i%3]} 轴 Allan 标准差`,columns);
                plot(s,r.tau_s.map((tau,j)=>[tau,axis.deviation[j],axis.fitted[j]]),[{name:"实测",index:1},{name:"拟合",index:2}],"平均时间 τ（秒，对数）",i<3?"rad/s（对数）":"m/s²（对数）",true);
                const unit = i < 3 ? "rad/s" : "m/s²";
                table(s,[["白噪声密度",axis.noise_density,`(${unit})/√Hz`],["零偏随机游走",axis.random_walk,`(${unit})/√s`],["零偏不稳定性",axis.bias_instability,unit],["对数拟合 RMS",axis.log_fit_rms,"无量纲"],["白噪声 / 随机游走已辨识",`${text(axis.white_noise_identified)} / ${text(axis.random_walk_identified)}`,"—"],["方差多项式系数 [c0…c4]",axis.coefficients,"各项按 τ 的秒单位计算"]],["参数","值","单位"]);
            });
            table(card("各平均时间的有效差分项数"),r.tau_s.map((v,i)=>[v,r.allan_terms[i]]),["τ（秒）","差分项数"]);
        }
        const params=card(r.kind==="current"?"camera_imu_calibration.yaml":"报告生成时的标定参数快照");pre(params,r.yaml||"未提供参数快照");
        observer=new ResizeObserver(()=>requestAnimationFrame(()=>redraws.forEach(draw=>draw())));
        observer.observe(root);requestAnimationFrame(()=>redraws.forEach(draw=>draw()));
    }
    window.addEventListener("message",event=>{
        if(event.source!==parent||event.origin!==location.origin||event.data?.type!=="calibration-report")return;
        try{render(event.data.report);}catch(error){root.replaceChildren();element("p",root,`报告显示失败：${error.message}`,"warning");}
    });
})();
