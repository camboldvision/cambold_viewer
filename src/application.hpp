/* SPDX-License-Identifier: Apache-2.0 */
#pragma once

#include "camera_state.hpp"
#if defined(__linux__)
// CHOC's Linux window implementation requires GTK declarations first.
#include <gtk/gtk.h>
#endif
#include "choc/gui/choc_DesktopWindow.h"
#include "choc/gui/choc_MessageLoop.h"
#include "choc/gui/choc_WebView.h"

#if CB_VIEWER_VIDEO
namespace nadjieb
{
class MJPEGStreamer;
}
#endif

namespace cambold::viewer
{

class ViewerApplication final
{
  public:
    ViewerApplication(std::string control, std::string debug);
    ~ViewerApplication();
    ViewerApplication(const ViewerApplication &) = delete;
    ViewerApplication &operator=(const ViewerApplication &) = delete;
    void run();

  private:
    void ensure_host();
    void update_port_snapshot();
    void setup_webview();
    void bind(choc::ui::WebView &view);
#if CB_VIEWER_VIDEO
    static void uvc_frame_callback(const cb_video_frame *frame, void *user);
    void on_native_frame(const cb_video_frame *frame);
#endif
#if CB_VIEWER_ROSBAG
    int start_local_bag(const std::string &path, bool record_image, bool record_imu,
                        std::string *error);
#endif

    UiState state_;
    std::string control_port_;
    std::string debug_port_;
    std::string window_title_ = "CamBold";
    choc::ui::DesktopWindow window_{{100, 100, 1200, 800}};
    std::unique_ptr<choc::ui::WebView> webview_;
    std::unique_ptr<choc::messageloop::Timer> timer_;
#if CB_VIEWER_VIDEO
    cb_video_t *uvc_ = nullptr;
    std::unique_ptr<nadjieb::MJPEGStreamer> streamer_;
    bool preview_requested_ = false;
#endif
#if CB_VIEWER_ROSBAG
    HostRosbagWriter local_bag_;
#endif
};

} // namespace cambold::viewer
