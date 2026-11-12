/* SPDX-License-Identifier: Apache-2.0 */
(function () {
    "use strict";

    let terminal = null;
    let fitAddon = null;
    let drainTimer = null;
    let draining = false;
    let pendingSize = null;

    function terminalTheme(dark) {
        // The terminal is intentionally dark in both application themes.  A
        // console keeps one stable ANSI palette, while the surrounding
        // Camera/Terminal chrome can switch between Light and Night mode.
        return {
            background: "#0b1016",
            foreground: "#edf3fb",
            cursor: "#94f2ce",
            selectionBackground: "#28516e",
        };
    }

    window.setTerminalTheme = function (dark) {
        if (terminal) terminal.options.theme = terminalTheme(!!dark);
    };

    function decodeBase64(value) {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function send(data) {
        if (typeof window.host_debug_write !== "function") return;
        window.host_debug_write(data);
    }

    function copySelection() {
        if (!terminal || !terminal.hasSelection()) return false;
        const text = terminal.getSelection();
        if (!text) return false;

        // Clipboard API is available in the newer WebView builds.  Keep the
        // textarea fallback for the older native WebView used by this app.
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () {
                copySelectionFallback(text);
            });
        } else {
            copySelectionFallback(text);
        }
        return true;
    }

    function copySelectionFallback(text) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-10000px";
        textarea.style.top = "-10000px";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand("copy");
        } catch (_) {}
        textarea.remove();
        if (terminal) terminal.focus();
    }

    function pasteFromClipboardFallback() {
        const textarea = document.createElement("textarea");
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-10000px";
        textarea.style.top = "-10000px";
        document.body.appendChild(textarea);
        const cleanup = function () {
            textarea.remove();
            if (terminal) terminal.focus();
        };
        textarea.addEventListener(
            "paste",
            function (event) {
                event.preventDefault();
                const text = event.clipboardData
                    ? event.clipboardData.getData("text/plain")
                    : "";
                if (terminal && text) terminal.paste(text);
                cleanup();
            },
            { once: true },
        );
        textarea.focus();
        try {
            document.execCommand("paste");
        } catch (_) {}
        window.setTimeout(cleanup, 100);
    }

    function pasteFromClipboard() {
        if (!terminal) return;
        if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard
                .readText()
                .then(function (text) {
                    if (text) terminal.paste(text);
                    terminal.focus();
                })
                .catch(pasteFromClipboardFallback);
        } else {
            pasteFromClipboardFallback();
        }
    }

    async function drain() {
        if (
            draining ||
            !terminal ||
            typeof window.host_debug_drain !== "function"
        )
            return;
        draining = true;
        try {
            const encoded = await window.host_debug_drain();
            if (encoded) terminal.write(decodeBase64(encoded));
        } finally {
            draining = false;
        }
    }

    window.syncTerminalSize = function () {
        if (!terminal || typeof window.host_set_terminal_size !== "function")
            return;
        const size = pendingSize || {
            cols: terminal.cols,
            rows: terminal.rows,
        };
        // The request is asynchronous. Retry while the control bulk channel is online
        // so a resize made before the board-side capture service is ready is
        // not lost.
        window.host_set_terminal_size(size.cols, size.rows);
    };

    window.focusTerminal = function () {
        if (terminal) terminal.focus();
    };

    window.fitTerminal = function () {
        if (!terminal || !fitAddon) return;
        const container = document.getElementById("terminal");
        if (
            !container ||
            container.offsetWidth === 0 ||
            container.offsetHeight === 0
        )
            return;
        fitAddon.fit();
        window.syncTerminalSize();
    };

    function installAccurateFit() {
        if (!terminal || !fitAddon) return;

        // The bundled fit addon uses the CSS `height`/`width` values and a
        // fixed 14 px overview-ruler allowance.  Our terminal has a visible
        // scrollbar and a border, so that approximation can count a column
        // too many and a partial row.  Use the actual content box and the
        // rendered xterm scrollbar instead.
        fitAddon.proposeDimensions = function () {
            const element = terminal.element;
            const renderDimensions =
                terminal._core &&
                terminal._core._renderService &&
                terminal._core._renderService.dimensions;
            if (
                !element ||
                !renderDimensions ||
                !renderDimensions.css ||
                !renderDimensions.css.cell ||
                renderDimensions.css.cell.width <= 0 ||
                renderDimensions.css.cell.height <= 0
            )
                return undefined;

            const style = window.getComputedStyle(element);
            const paddingX =
                parseFloat(style.paddingLeft || "0") +
                parseFloat(style.paddingRight || "0");
            const paddingY =
                parseFloat(style.paddingTop || "0") +
                parseFloat(style.paddingBottom || "0");
            const scrollbar = element.querySelector(
                ".xterm-scrollable-element > .scrollbar",
            );
            const measuredScrollbar = scrollbar
                ? Math.ceil(scrollbar.getBoundingClientRect().width)
                : 0;
            const scrollbarWidth =
                measuredScrollbar > 0 ? measuredScrollbar : 14;

            // clientWidth/clientHeight exclude the terminal border.  The
            // old addon used computed width/height and therefore included
            // that border in the row/column budget.
            const width = Math.max(
                0,
                element.clientWidth - paddingX - scrollbarWidth,
            );
            const height = Math.max(0, element.clientHeight - paddingY);
            return {
                cols: Math.max(
                    2,
                    Math.floor(width / renderDimensions.css.cell.width),
                ),
                rows: Math.max(
                    1,
                    Math.floor(height / renderDimensions.css.cell.height),
                ),
            };
        };
    }

    window.initTerminal = function () {
        if (terminal) {
            window.fitTerminal();
            return;
        }

        const container = document.getElementById("terminal");
        terminal = new window.Terminal({
            cols: 80,
            rows: 24,
            scrollback: 10000,
            cursorBlink: true,
            disableStdin: false,
            convertEol: true,
            fontFamily: "Cascadia Mono, Consolas, monospace",
            fontSize: 13,
            // Let the board's `resize` utility query the actual xterm.js
            // geometry (CSI 18 t) and update stty rows/cols on ttyGS0.
            // Serial links have no SSH-style window-size negotiation.
            windowOptions: {
                getWinSizeChars: true,
            },
            theme: terminalTheme(
                document.documentElement.dataset.theme === "dark",
            ),
        });

        fitAddon = new window.FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(container);
        installAccurateFit();
        window.fitTerminal();

        terminal.attachCustomKeyEventHandler(function (event) {
            if (event.type !== "keydown") return true;
            const control = event.ctrlKey && !event.altKey && !event.metaKey;
            if (!control) return true;

            const key = String(event.key || "").toLowerCase();
            if (key === "c" && terminal.hasSelection()) {
                event.preventDefault();
                copySelection();
                return false;
            }
            if (key === "v") {
                event.preventDefault();
                pasteFromClipboard();
                return false;
            }
            return true;
        });

        terminal.onData(send);
        terminal.onBinary(send);
        // xterm owns the hidden textarea used for keyboard input.  Keep the
        // focus hand-off explicit because the terminal lives in a tab that is
        // initially hidden; without this, a click can land on the wrapper
        // while the textarea remains unfocused and no key data is emitted.
        const focusTerminal = function () {
            terminal.focus();
        };
        container.addEventListener("mousedown", focusTerminal);
        container.addEventListener("click", focusTerminal);
        container.addEventListener("touchstart", focusTerminal, {
            passive: true,
        });
        terminal.onResize(function (size) {
            pendingSize = { cols: size.cols, rows: size.rows };
            window.syncTerminalSize();
        });

        // Keep polling independent of xterm's render cadence.  The old
        // 10-ms interval compounded with the native bulk-read timeout and
        // made held-key input arrive in visible batches.  Schedule the next
        // poll only after the current bridge call completes so there is no
        // overlapping drain request, and use a short idle interval to avoid a
        // busy loop when the terminal is quiet.
        const scheduleDrain = function () {
            if (drainTimer !== null) return;
            drainTimer = window.setTimeout(async function () {
                drainTimer = null;
                try {
                    await drain();
                } catch (_) {
                    // A transient disconnect must not permanently stop the
                    // terminal polling loop; the native SDK will reconnect.
                } finally {
                    scheduleDrain();
                }
            }, 2);
        };
        scheduleDrain();
        window.addEventListener("resize", window.fitTerminal);
        terminal.focus();
        window.setTimeout(focusTerminal, 0);
    };
})();
