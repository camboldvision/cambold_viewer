/* SPDX-License-Identifier: Apache-2.0 */

export function logMessage(entry) {
    const text = String(entry?.text ?? "");
    let event;
    try {
        event = JSON.parse(text);
    } catch {
        return text;
    }
    if (!event || typeof event !== "object") return "";
    const operation =
        { START: "启动", STOP: "停止", RESET: "重置" }[event.command] ||
        "设备操作";
    const status = {
        accepted: "已受理",
        pending: "等待中",
        running: "进行中",
        completed: "已完成",
        succeeded: "已完成",
        failed: "失败",
    }[event.status];
    const message =
        typeof event.message === "string" ? event.message : "";
    return [status ? `${operation}${status}` : "", message]
        .filter(Boolean)
        .join("：");
}
