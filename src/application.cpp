/* SPDX-License-Identifier: Apache-2.0 */
#include "application.hpp"
#include "ui_embedded.hpp"
#if CB_VIEWER_VIDEO
#include "mjpeg_streamer.hpp"
#endif
#include <cerrno>
#include <cstdlib>
#include <utility>
#ifdef _WIN32
#include "resource.h"
#include <dwmapi.h>
#endif

namespace cambold::viewer
{
namespace
{

cb_ui::EmbeddedResource find_resource(const std::string &request_path)
{
    std::string path = request_path;
    /* WebView backends do not all pass the same form to fetchResource():
     * some use "/vendor/...", others pass the complete choc.localhost URL.
     * Normalize both forms before looking up the embedded asset. */
    const auto scheme = path.find("://");
    if (scheme != std::string::npos)
    {
        const auto slash = path.find('/', scheme + 3);
        path = slash == std::string::npos ? "/" : path.substr(slash);
    }
    const auto query = path.find('?');
    if (query != std::string::npos)
        path.resize(query);
    if (path.empty() || path.front() != '/')
        path.insert(path.begin(), '/');
    if (path == "/xterm.js")
        path = "/vendor/xterm/xterm.js";
    if (path == "/xterm.css")
        path = "/vendor/xterm/xterm.css";
    if (path.empty() || path == "/")
        path = "/index.html";
    for (std::size_t i = 0; i < cb_ui::resource_count; ++i)
        if (path == cb_ui::resources[i].path)
            return cb_ui::resources[i];
    return {};
}

} // namespace

ViewerApplication::ViewerApplication(std::string control, std::string debug)
    : control_port_(std::move(control)), debug_port_(std::move(debug))
{
    window_.setWindowTitle(window_title_);
    // macOS creates a fixed-size window unless resizing is explicitly enabled.
    window_.setResizable(true);
#ifdef _WIN32
    const auto module = GetModuleHandleW(nullptr);
    const auto window = static_cast<HWND>(window_.getWindowHandle());
    // Older Windows SDK headers omit this attribute; unsupported systems
    // simply retain their native title-bar appearance.
    constexpr DWORD use_immersive_dark_mode = 20;
    const BOOL dark_title_bar = TRUE;
    DwmSetWindowAttribute(window, use_immersive_dark_mode, &dark_title_bar,
                          sizeof(dark_title_bar));
    // Shared resource handles live for the process lifetime. Use both
    // sizes so the title bar and task switcher select the native icon.
    const auto large_icon =
        LoadImageW(module, MAKEINTRESOURCEW(IDI_CAMBOLD), IMAGE_ICON, GetSystemMetrics(SM_CXICON),
                   GetSystemMetrics(SM_CYICON), LR_SHARED);
    const auto small_icon =
        LoadImageW(module, MAKEINTRESOURCEW(IDI_CAMBOLD), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
                   GetSystemMetrics(SM_CYSMICON), LR_SHARED);
    if (large_icon)
        SendMessageW(window, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(large_icon));
    if (small_icon)
        SendMessageW(window, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(small_icon));
#endif
    window_.centreWithSize(1200, 800);
    window_.setMinimumSize(860, 620);
    window_.windowClosed = [] { choc::messageloop::stop(); };
#if CB_VIEWER_VIDEO
    streamer_ = std::make_unique<nadjieb::MJPEGStreamer>();
    cb_video_config uvc_config{};
    uvc_config.callback = &ViewerApplication::uvc_frame_callback;
    uvc_config.user = this;
    if (cb_video_open(&uvc_config, &uvc_) != 0)
        state_.last_error = "unable to create host SDK UVC session";
#endif
#if CB_VIEWER_ROSBAG
    state_.local_bag_writer = &local_bag_;
#endif
}

ViewerApplication::~ViewerApplication()
{
#if CB_VIEWER_ROSBAG
    local_bag_.stop();
#endif
#if CB_VIEWER_VIDEO
    if (uvc_)
        cb_video_close(uvc_);
    if (streamer_)
        streamer_->stop();
#endif
    if (state_.host)
        cb_close(state_.host);
}

void ViewerApplication::run()
{
    choc::ui::setWindowsDPIAwareness();
    choc::messageloop::initialise();
#if CB_VIEWER_VIDEO
    try
    {
        /* The preview is served locally so the WebView never opens the
         * UVC interface.  The first empty JPEG only creates the stream
         * topic; real frames replace it as soon as capture starts. */
        streamer_->start(17880, 1);
        streamer_->publish("/stream", std::string("\xff\xd8\xff\xd9", 4));
    }
    catch (const std::exception &error)
    {
        std::lock_guard<std::mutex> lock(state_.mutex);
        state_.last_error = std::string("local MJPEG server: ") + error.what();
    }
#endif
    setup_webview();
    window_.setVisible(true);
    window_.toFront();

    timer_ = std::make_unique<choc::messageloop::Timer>(
        250,
        [this, ticks = 0u]() mutable
        {
            ensure_host();
            update_port_snapshot();
            if (state_.host && cb_connected(state_.host) && (++ticks % 4u) == 0u)
            {
                (void)cb_request_metrics(state_.host, cb_next_request_id(state_.host));
                (void)cb_request_device_config(state_.host, cb_next_request_id(state_.host));
                (void)cb_request_stereo_status(state_.host, cb_next_request_id(state_.host));
            }
            return true;
        });
    choc::messageloop::run();
    timer_.reset();
}
void ViewerApplication::ensure_host()
{
    if (state_.host)
    {
        std::lock_guard<std::mutex> lock(state_.mutex);
        if (state_.connection != ConnectionState::Online)
            state_.connection = ConnectionState::Waiting;
        return;
    }

    cb_config config{};
    config.control_port = control_port_.empty() ? nullptr : control_port_.c_str();
    config.control_baudrate = 115200;
    config.callback = host_event;
    config.user = &state_;

    cb_t *candidate = nullptr;
    const int result = cb_open(&config, &candidate);
    if (result != 0)
    {
        std::lock_guard<std::mutex> lock(state_.mutex);
        state_.connection = ConnectionState::Offline;
        state_.last_error = "cannot create host transport: " + std::to_string(result);
        return;
    }

    state_.host = candidate;
    {
        std::lock_guard<std::mutex> lock(state_.mutex);
        state_.connection = ConnectionState::Waiting;
        state_.last_result = "searching for control bulk interface";
        state_.last_error.clear();
    }
    /* Opening is asynchronous inside the SDK.  This call only starts the
       debug-port worker and never performs serial I/O on the UI thread. */
    (void)cb_debug_open(candidate, debug_port_.empty() ? nullptr : debug_port_.c_str(), 115200);
}

void ViewerApplication::update_port_snapshot()
{
    if (!state_.host)
        return;
    char path[128]{};
    const int control_result = cb_get_control_port(state_.host, path, sizeof(path));
    const std::string control = control_result >= 0 ? path : std::string();
    path[0] = '\0';
    const int debug_result = cb_get_debug_port(state_.host, path, sizeof(path));
    const std::string debug = debug_result >= 0 ? path : std::string();
    char name[512]{};
    const int name_result = cb_get_device_name(state_.host, name, sizeof(name));
    const std::string device_name = name_result >= 0 ? name : std::string();
    {
        std::lock_guard<std::mutex> lock(state_.mutex);
        state_.control_port = control;
        state_.debug_port = debug;
        state_.device_name = device_name;
    }
    const std::string title = device_name.empty() ? "CamBold" : device_name;
    if (title != window_title_)
    {
        window_title_ = title;
        window_.setWindowTitle(window_title_);
    }
}

void ViewerApplication::setup_webview()
{
    choc::ui::WebView::Options options;
    options.enableDebugMode = false;
    options.webviewIsReady = [this](choc::ui::WebView &view)
    {
        bind(view);
#ifdef _WIN32
        view.navigate("https://choc.localhost/");
#else
        view.navigate("choc://cambold/");
#endif
    };
    options.fetchResource = [this](const std::string &path) -> choc::ui::WebView::Options::Resource
    {
        if (path.find("/disparity.frame") != std::string::npos)
        {
            std::shared_ptr<std::vector<uint8_t>> frame;
            {
                std::lock_guard<std::mutex> lock(state_.disparity_mutex);
                frame = state_.disparity_frame;
            }
            if (!frame)
                return {std::string(), "application/octet-stream"};
            const auto query = path.find("after=");
            if (query != std::string::npos)
            {
                const uint64_t after = strtoull(path.c_str() + query + 6, nullptr, 10);
                cb_disparity info{};
                if (cb_decode_disparity(frame->data(), frame->size(), &info, nullptr, nullptr) ==
                        0 &&
                    after == info.frame_id)
                    return {std::string(), "application/octet-stream"};
            }
            return {std::string(reinterpret_cast<const char *>(frame->data()), frame->size()),
                    "application/octet-stream"};
        }
        const auto resource = find_resource(path);
        if (!resource.data)
            return {};
        return {std::string(reinterpret_cast<const char *>(resource.data), resource.size),
                resource.mime};
    };
    webview_ = std::make_unique<choc::ui::WebView>(options);
    window_.setContent(webview_->getViewHandle());
}

#if CB_VIEWER_VIDEO
void ViewerApplication::uvc_frame_callback(const cb_video_frame *frame, void *user)
{
    auto *self = static_cast<ViewerApplication *>(user);
    if (self)
        self->on_native_frame(frame);
}

void ViewerApplication::on_native_frame(const cb_video_frame *frame)
{
    if (!frame || !frame->jpeg || frame->jpeg_size == 0)
        return;
    streamer_->publish("/stream",
                       std::string(reinterpret_cast<const char *>(frame->jpeg), frame->jpeg_size));
    {
        std::lock_guard<std::mutex> lock(state_.mutex);
        state_.rate_image_count++;
        state_.last_image_event = std::chrono::steady_clock::now();
    }
#if CB_VIEWER_ROSBAG
    if (local_bag_.active() && local_bag_.record_image())
        local_bag_.submit_frame(std::vector<uint8_t>(frame->jpeg, frame->jpeg + frame->jpeg_size),
                                frame->sequence, frame->timestamp_monotonic_ns);
#endif
}
#endif

#if CB_VIEWER_ROSBAG
int ViewerApplication::start_local_bag(const std::string &path, bool record_image, bool record_imu,
                                       std::string *error)
{
    if (record_imu)
    {
        if (!state_.host || !cb_connected(state_.host))
        {
            if (error)
                *error = "Cannot enable IMU: board is disconnected";
            return -ENOTCONN;
        }
        const uint64_t request = cb_next_request_id(state_.host);
        {
            std::lock_guard<std::mutex> lock(state_.mutex);
            state_.imu_enable_request = request;
            state_.imu_enable_completed = false;
            state_.imu_enable_result = 0;
        }
        int ret = cb_set_imu_output(state_.host, 1, request);
        if (ret == 0)
        {
            std::unique_lock<std::mutex> lock(state_.mutex);
            if (!state_.imu_condition.wait_for(lock, std::chrono::seconds(3),
                                               [this] { return state_.imu_enable_completed; }))
                ret = -ETIMEDOUT;
            else
                ret = state_.imu_enable_result;
        }
        {
            std::lock_guard<std::mutex> lock(state_.mutex);
            state_.imu_enable_request = 0;
        }
        if (ret != 0)
        {
            if (error)
                *error = "Board did not confirm IMU output enabled: " + std::to_string(ret);
            return ret;
        }
    }
    const int result = local_bag_.start(path, record_image, record_imu, 90, error);
    if (result != 0)
        return result;
#if CB_VIEWER_VIDEO
    if (record_image)
    {
        char uvc_error[512]{};
        if (!uvc_ || cb_video_start(uvc_, uvc_error, sizeof(uvc_error)) != 0)
        {
            if (error)
                *error = uvc_error;
            local_bag_.stop();
            return -EIO;
        }
        std::lock_guard<std::mutex> lock(state_.mutex);
        state_.native_uvc = true;
    }
#else
    if (record_image)
    {
        local_bag_.stop();
        return -ENOTSUP;
    }
#endif
    if (result == 0)
    {
        std::lock_guard<std::mutex> lock(state_.mutex);
        state_.local_bag_active = true;
    }
    return result;
}
#endif

} // namespace cambold::viewer
