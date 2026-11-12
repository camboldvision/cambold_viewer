/* SPDX-License-Identifier: Apache-2.0 */
(function () {
    "use strict";

    const state = {
        media: null,
        bagRecording: false,
        refreshTimer: null,
        previewResizeObserver: null,
        previewRotated: false,
    };

    const $ = (id) => document.getElementById(id);

    function fitPreviewVideo() {
        const video = $("preview");
        const box = video && video.parentElement;
        if (!video || !box) return;

        const boxWidth = box.clientWidth;
        const boxHeight = box.clientHeight;
        if (boxWidth <= 0 || boxHeight <= 0) return;

        // Use the negotiated track dimensions when available.  Falling back
        // to the advertised UVC mode keeps the first layout pass correct,
        // before loadedmetadata has fired.
        const sourceWidth = video.naturalWidth || 2160;
        const sourceHeight = video.naturalHeight || 1280;
        const rotated = state.previewRotated;
        const scale = Math.min(
            boxWidth / (rotated ? sourceHeight : sourceWidth),
            boxHeight / (rotated ? sourceWidth : sourceHeight),
        );
        if (!Number.isFinite(scale) || scale <= 0) return;

        // Give the replaced element its exact contained size.  This avoids
        // relying on a browser's cover/contain sizing heuristics, which can
        // otherwise size the video from width alone and crop its bottom.
        video.style.width = Math.max(1, Math.floor(sourceWidth * scale)) + "px";
        video.style.height =
            Math.max(1, Math.floor(sourceHeight * scale)) + "px";
        video.style.objectFit = "contain";
        video.style.transform =
            "translate(-50%, -50%)" + (rotated ? " rotate(90deg)" : "");
    }

    function invoke(name, ...args) {
        try {
            if (typeof window[name] !== "function")
                return Promise.resolve(null);
            return Promise.resolve(window[name](...args));
        } catch (error) {
            report(error && error.message ? error.message : String(error));
            return Promise.resolve(null);
        }
    }

    function report(message) {
        const connection = $("connection");
        if (connection) connection.title = message || "";
        const previewEmpty = $("preview-empty");
        if (previewEmpty && message && !state.media)
            previewEmpty.textContent = message;
        if (message && typeof console !== "undefined") console.warn(message);
    }

    function applyTheme(theme) {
        const dark = theme === "dark";
        document.documentElement.dataset.theme = dark ? "dark" : "light";
        const button = $("theme-toggle");
        if (button) {
            button.textContent = dark ? "Light mode" : "Night mode";
            button.setAttribute("aria-pressed", dark ? "true" : "false");
            button.title = dark ? "Use the light theme" : "Use the night theme";
        }
        if (typeof window.setTerminalTheme === "function")
            window.setTerminalTheme(dark);
    }

    function loadTheme() {
        let saved = null;
        try {
            saved = window.localStorage.getItem("cambold-theme");
        } catch (_) {}
        if (saved === "dark" || saved === "light") return saved;
        return window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
    }

    function setConnection(stateName) {
        const element = $("connection");
        if (!element) return;
        const online = stateName === "online";
        const waiting =
            stateName === "waiting" ||
            stateName === "handshake" ||
            stateName === "reconnecting";
        element.className =
            "badge " + (online ? "online" : waiting ? "waiting" : "offline");
        element.textContent = online
            ? "online"
            : waiting
              ? stateName
              : "offline";
    }

    function setBagRecording(active, name) {
        state.bagRecording = !!active;
        const button = $("bag-action");
        if (!button) return;
        button.textContent = state.bagRecording
            ? "Stop recording"
            : "Record rosbag...";
        button.classList.toggle("danger", state.bagRecording);
        button.title = state.bagRecording
            ? "Recording " + (name || "capture.bag")
            : "Record a rosbag";
    }

    function openBagModal() {
        if (state.bagRecording) return;
        const modal = $("bag-modal");
        if (!modal) return;
        modal.hidden = false;
        const input = $("bag-name");
        input.focus();
        input.select();
    }

    function setBagError(message) {
        const element = $("bag-error");
        if (!element) return;
        element.textContent = message || "";
        element.hidden = !message;
    }

    function closeBagModal() {
        const modal = $("bag-modal");
        if (modal) modal.hidden = true;
        setBagError("");
    }

    async function refreshState() {
        const remote = await invoke("host_get_state");
        if (!remote) return;
        const rotated = Number(remote.stereo?.projection || 0) === 1;
        if (state.previewRotated !== rotated) {
            state.previewRotated = rotated;
            fitPreviewVideo();
        }
        if (window.updateStereoState) window.updateStereoState(remote);

        setConnection(
            remote.connection_state ||
                (remote.connected ? "online" : "offline"),
        );
        const deviceName =
            typeof remote.device_name === "string" && remote.device_name.trim()
                ? remote.device_name.trim()
                : "CamBold";
        $("device-name").textContent = deviceName;
        $("device-name").title = deviceName;
        document.title = deviceName;
        $("ports").textContent =
            (remote.control_port || "control bulk not found") +
            (remote.debug_port ? "  /  " + remote.debug_port : "");
        const valid = remote.connected ? Number(remote.settings_valid || 0) : 0;
        $("imu-output").disabled = !(valid & 2) || !!remote.imu_upload_blocked;
        $("imu-output").parentElement.title = remote.imu_upload_blocked
            ? "稠密重建运行中，IMU 仅供板端算法使用，禁止上传"
            : "";
        $("bag-imu").disabled = !!remote.imu_upload_blocked;
        if (remote.imu_upload_blocked) $("bag-imu").checked = false;
        $("imu-output").checked = !!(valid & 2) && !!remote.imu;
        $("antenna").disabled = !(valid & 4);
        $("antenna").value = valid & 4 ? (remote.antenna ? "1" : "0") : "";
        const rates =
            valid & 1 && Array.isArray(remote.frame_rates)
                ? remote.frame_rates.filter(
                      (rate) => Number.isInteger(rate) && rate > 0,
                  )
                : [];
        const optionsKey = rates.join(",");
        if (state.frameRateOptionsKey !== optionsKey) {
            $("fps").replaceChildren();
            if (!rates.length)
                $("fps").add(new Option("Waiting for board...", ""));
            for (const rate of rates)
                $("fps").add(new Option(rate + " fps", String(rate)));
            state.frameRateOptionsKey = optionsKey;
        }
        $("fps").disabled = !(valid & 1) || !rates.length;
        if (valid & 1) $("fps").value = String(remote.frame_rate);
        $("image-rate").textContent =
            Number(remote.image_fps || 0).toFixed(1) + " Hz";
        $("imu-rate").textContent =
            Number(remote.imu_fps || 0).toFixed(1) + " Hz";
        if (remote.last_error) report(remote.last_error);

        if (
            remote.connection_state === "online" &&
            typeof window.syncTerminalSize === "function"
        )
            window.syncTerminalSize();

        try {
            const metrics = JSON.parse(remote.metrics || "{}");
            const total = Number(metrics.mem_total_kb || 0);
            const used = Number(metrics.mem_used_kb || 0);
            $("cpu").textContent =
                Number(metrics.cpu_percent || 0).toFixed(1) + "%";
            $("memory").textContent =
                (total ? (100 * used) / total : 0).toFixed(1) + "%";
            $("temperature").textContent =
                (Number(metrics.temperature_millideg || 0) / 1000).toFixed(1) +
                " C";
        } catch (_) {
            $("cpu").textContent = "--";
            $("memory").textContent = "--";
            $("temperature").textContent = "--";
        }
    }

    async function togglePreview() {
        const button = $("preview-toggle");
        if (state.media) {
            await invoke("host_stop_uvc");
            state.media = null;
            $("preview").removeAttribute("src");
            $("preview").hidden = true;
            $("preview").style.width = "";
            $("preview").style.height = "";
            $("preview").style.objectFit = "";
            $("preview-empty").hidden = false;
            $("preview-empty").textContent =
                "Start preview to open the native UVC stream";
            button.textContent = "Start preview";
            return;
        }

        button.disabled = true;
        try {
            const url = await invoke("host_start_uvc");
            if (!url) {
                const diagnostic = await invoke("host_get_state");
                throw new Error(
                    (diagnostic && diagnostic.last_error) ||
                        "native UVC could not be opened",
                );
            }
            state.media = { native: true };
            $("preview").src = url + "?t=" + Date.now();
            $("preview").hidden = false;
            $("preview-empty").hidden = true;
            button.textContent = "Stop preview";
        } catch (error) {
            state.media = null;
            $("preview").hidden = true;
            report("UVC preview failed: " + error.message);
        } finally {
            button.disabled = false;
        }
    }

    async function toggleRosbag() {
        if (!state.bagRecording) {
            openBagModal();
            return;
        }
        const ok = await invoke("host_stop_bag");
        if (ok) setBagRecording(false);
        else report("Unable to stop rosbag recording");
    }

    async function startRosbag() {
        const name = $("bag-name").value.trim();
        const image = $("bag-image").checked ? 1 : 0;
        const imu = $("bag-imu").checked ? 1 : 0;
        if (!name) {
            setBagError("Enter a file name.");
            return;
        }
        if (!image && !imu) {
            setBagError("Select Images, IMU, or both.");
            return;
        }
        const ok = await invoke("host_start_bag", name, image, imu);
        if (ok) {
            setBagRecording(true, name);
            closeBagModal();
        } else setBagError("Unable to start rosbag recording.");
    }

    function bindTabs() {
        document.querySelectorAll("[data-tab]").forEach((button) => {
            button.addEventListener("click", () => {
                const target = button.dataset.tab;
                document.querySelectorAll("[data-tab]").forEach((tab) => {
                    const selected = tab.dataset.tab === target;
                    tab.classList.toggle("active", selected);
                    tab.setAttribute(
                        "aria-selected",
                        selected ? "true" : "false",
                    );
                });
                document.querySelectorAll(".tab-panel").forEach((panel) => {
                    const active = panel.id === target;
                    panel.classList.toggle("active", active);
                    panel.hidden = !active;
                });
                if (target === "tab-terminal") {
                    if (typeof window.initTerminal === "function")
                        window.initTerminal();
                    if (typeof window.fitTerminal === "function")
                        window.fitTerminal();
                    if (typeof window.syncTerminalSize === "function")
                        window.syncTerminalSize();
                    if (typeof window.focusTerminal === "function")
                        window.requestAnimationFrame(window.focusTerminal);
                }
            });
        });
    }

    function bindControls() {
        $("preview-toggle").addEventListener("click", togglePreview);
        $("theme-toggle").addEventListener("click", () => {
            const dark = document.documentElement.dataset.theme === "dark";
            const next = dark ? "light" : "dark";
            applyTheme(next);
            try {
                window.localStorage.setItem("cambold-theme", next);
            } catch (_) {}
        });
        $("antenna").addEventListener("change", () =>
            invoke("host_set_antenna", Number($("antenna").value)),
        );
        $("imu-output").addEventListener("change", () =>
            invoke("host_set_imu", $("imu-output").checked ? 1 : 0),
        );
        $("fps").addEventListener("change", () =>
            invoke("host_set_fps", Number($("fps").value)),
        );
        $("bag-action").addEventListener("click", toggleRosbag);
        $("bag-close").addEventListener("click", closeBagModal);
        $("bag-cancel").addEventListener("click", closeBagModal);
        $("bag-browse").addEventListener("click", async () => {
            const path = await invoke("host_choose_bag_path");
            if (path) $("bag-name").value = path;
        });
        $("bag-start").addEventListener("click", startRosbag);
        $("bag-modal").addEventListener("click", (event) => {
            if (event.target.id === "bag-modal") closeBagModal();
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") closeBagModal();
        });
    }

    document.addEventListener("DOMContentLoaded", async () => {
        applyTheme(loadTheme());
        bindTabs();
        bindControls();
        const preview = $("preview");
        if (preview) {
            preview.addEventListener("load", fitPreviewVideo);
            window.addEventListener("resize", fitPreviewVideo);
            if (window.ResizeObserver) {
                state.previewResizeObserver = new ResizeObserver(
                    fitPreviewVideo,
                );
                state.previewResizeObserver.observe(preview.parentElement);
            }
        }
        setBagRecording(false);
        await refreshState();
        state.refreshTimer = window.setInterval(refreshState, 1000);
    });
})();
