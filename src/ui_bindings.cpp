/* SPDX-License-Identifier: Apache-2.0 */
#include "application.hpp"
#include "choc/text/choc_JSON.h"
#include <nlohmann/json.hpp>
#include <cwchar>
#include <algorithm>
#include <stdexcept>
#ifdef _WIN32
#include <commdlg.h>
#endif

namespace cambold::viewer
{
namespace
{

std::string base64_encode(const uint8_t *data, size_t size)
{
    static constexpr char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((size + 2) / 3) * 4);
    for (size_t i = 0; i < size; i += 3)
    {
        const uint32_t a = data[i];
        const uint32_t b = (i + 1 < size) ? data[i + 1] : 0;
        const uint32_t c = (i + 2 < size) ? data[i + 2] : 0;
        const uint32_t v = (a << 16) | (b << 8) | c;
        out.push_back(alphabet[(v >> 18) & 0x3f]);
        out.push_back(alphabet[(v >> 12) & 0x3f]);
        out.push_back(i + 1 < size ? alphabet[(v >> 6) & 0x3f] : '=');
        out.push_back(i + 2 < size ? alphabet[v & 0x3f] : '=');
    }
    return out;
}

} // namespace

void ViewerApplication::bind(choc::ui::WebView &view)
{
    view.bind("host_calibration", [this](const choc::value::ValueView &values) {
        try {
            if (!state_.host || !cb_connected(state_.host))
                throw std::runtime_error("Camera is offline");
            const auto request = nlohmann::json::parse(choc::json::toString(values[0]));
            const std::string action = request.at("action");
            nlohmann::json result = {{"ok", true}};
            if (action == "preflight") {
                {
                    std::lock_guard<std::mutex> lock(state_.mutex);
                    result["recording"] = state_.local_bag_active;
                }
                char *json = nullptr;
                if (!cb_slam_get_json(state_.host, &json)) {
                    auto slam = nlohmann::json::parse(json, nullptr, false);
                    cb_slam_free_json(json);
                    const auto state =
                        slam.value("state", nlohmann::json::object()).value("state", std::string());
                    result["slam_running"] = state == "RUNNING" || state == "INITIALIZING" ||
                                             state == "STARTING" || state == "CONFIGURING_CAMERA" ||
                                             state == "STOPPING";
                }
            } else if (action == "report") {
                const std::string kind = request.at("kind");
                static const std::vector<std::string> names = {"current", "joint", "imu"};
                const auto found = std::find(names.begin(), names.end(), kind);
                if (found == names.end()) throw std::runtime_error("Unknown calibration report");
                const auto id = cb_next_request_id(state_.host);
                const int rc = cb_request_calibration_report(state_.host,
                    static_cast<cb_calibration_report_kind>(found - names.begin()),
                    request.value("revision", uint32_t(0)), request.value("offset", uint32_t(0)), id);
                if (rc) throw std::runtime_error("Report request failed: " + std::to_string(rc));
                result["request_id"] = id;
            } else if (action == "poll") {
                char json[32768];
                int rc = cb_get_calibration_status(state_.host, json, sizeof(json));
                if (!rc)
                    result["status"] = nlohmann::json::parse(json);
                {
                    std::lock_guard<std::mutex> lock(state_.mutex);
                    result["replies"] = nlohmann::json::array();
                    for (const auto &reply : state_.calibration_replies)
                        result["replies"].push_back(
                            {{"request_id", reply.first},
                             {"data", nlohmann::json::parse(reply.second, nullptr, false)}});
                    state_.calibration_replies.clear();
                }
                if (request.value("preview", true)) {
                    cb_calibration_preview info{};
                    std::vector<uint8_t> jpeg(256 * 1024);
                    size_t size = jpeg.size();
                    rc =
                        cb_get_calibration_preview(state_.host, request.value("after", uint64_t(0)),
                                                   &info, jpeg.data(), &size);
                    if (!rc) {
                        result["jpeg"] = base64_encode(jpeg.data(), size);
                        result["sequence"] = info.sequence;
                        result["width"] = info.width;
                        result["height"] = info.height;
                    }
                }
            } else {
                static const std::vector<std::string> names = {
                    "status", "enter", "start_imu", "start_camera", "solve", "cancel", "leave"};
                auto found = std::find(names.begin(), names.end(), action);
                if (found == names.end())
                    throw std::runtime_error("Unknown calibration action");
                {
                    std::lock_guard<std::mutex> lock(state_.mutex);
                    if (action == "enter" && state_.local_bag_active)
                        throw std::runtime_error("Stop recording before calibration");
                }
                cb_calibration_options options{};
                if (action == "start_camera") {
                    options.tag_rows = request.at("rows");
                    options.tag_cols = request.at("cols");
                    options.tag_size_metres = request.at("tag_size_m");
                    options.tag_spacing = request.at("spacing");
                }
                const auto id = cb_next_request_id(state_.host);
                result["request_id"] = id;
                int rc = cb_calibration_command(
                    state_.host, static_cast<cb_calibration_action>(found - names.begin()),
                    &options, id);
                if (rc)
                    throw std::runtime_error("Calibration request failed: " + std::to_string(rc));
            }
            return choc::value::Value(result.dump());
        } catch (const std::exception &e) {
            return choc::value::Value(nlohmann::json({{"ok", false}, {"error", e.what()}}).dump());
        }
    });
    view.bind("viewer",
              [this](const choc::value::ValueView &values) {
                  try {
                      if (!state_.host)
                          throw std::runtime_error("SDK connection unavailable");
                      const auto request = nlohmann::json::parse(choc::json::toString(values[0]));
                      const auto action = request.at("action").get<std::string>();
                      nlohmann::json result = {{"ok", true}};
                      int status = 0;
                      if (action == "poll")
                      {
                          char *data = nullptr;
                          status = cb_slam_poll_json(state_.host, &data);
                          if (!status)
                          {
                              try
                              {
                                  result["data"] = nlohmann::json::parse(data);
                              }
                              catch (...)
                              {
                                  cb_slam_free_json(data);
                                  throw;
                              }
                              cb_slam_free_json(data);
                          }
                      }
                      else if (action == "maps")
                          status = cb_slam_refresh_maps(state_.host);
                      else if (action == "subscribe")
                          status = cb_slam_subscribe(state_.host, request.value("images", false),
                                                     request.value("dense", true));
                      else if (action == "clear")
                          status = cb_slam_clear_view(state_.host);
                      else if (action == "ports")
                          result["ports"] = nlohmann::json::array();
                      else if (action == "connect")
                          status = cb_refresh_connection(state_.host);
                      else if (action == "disconnect")
                          status = cb_slam_subscribe(state_.host, 0, 0);
                      else if (action == "command")
                      {
                          const auto command = request.at("command").get<std::string>();
                          if (command == "STOP")
                              status = cb_slam_stop(state_.host);
                          else if (command == "START")
                          {
                              const auto args = request.value("args", nlohmann::json::object());
                              const auto name = args.at("map_name").get<std::string>(),
                                         mode = args.value("map_mode", std::string("new"));
                              if (mode != "new" && mode != "resume" && mode != "localization")
                                  throw std::runtime_error("Invalid map mode");
                              const bool dense = args.value("dense_reconstruction", true);
#if CB_VIEWER_ROSBAG
                              if (dense && local_bag_.active() && local_bag_.record_imu())
                                  throw std::runtime_error(
                                      "请先停止包含 IMU 的录制，再启动稠密重建。");
#endif
                              cb_slam_options options{name.c_str(),
                                                      mode == "new"      ? 0u
                                                      : mode == "resume" ? 1u
                                                                         : 2u,
                                                      dense ? 1 : 0};
                              status = cb_slam_start(state_.host, &options);
                          }
                          else
                              throw std::runtime_error("Unknown SLAM command");
                      }
                      else
                          throw std::runtime_error("Unknown SLAM action");
                      if (status)
                          throw std::runtime_error("SDK request failed: " + std::to_string(status));
                      return choc::value::Value(result.dump());
                  } catch (const std::exception &e) {
                      return choc::value::Value(
                          nlohmann::json({{"ok", false}, {"error", e.what()}}).dump());
                  }
              });
    view.bind("host_get_state",
              [this](const choc::value::ValueView &)
              {
                  std::lock_guard<std::mutex> lock(state_.mutex);
                  auto result = choc::value::createObject("state");
                  update_rates_locked(&state_, std::chrono::steady_clock::now());
                  result.setMember("connected", state_.connection == ConnectionState::Online);
                  result.setMember("connection_state", connection_name(state_.connection));
                  result.setMember("control_port", state_.control_port);
                  result.setMember("debug_port", state_.debug_port);
                  result.setMember("device_name", state_.device_name);
                  result.setMember("antenna", state_.antenna_wired);
                  result.setMember("imu", state_.imu_enabled);
                  result.setMember("imu_upload_blocked",
                                   state_.host && cb_slam_imu_upload_blocked(state_.host) > 0);
                  result.setMember("settings_valid", (int)state_.device_config.valid_flags);
                  result.setMember("frame_rate", (int)state_.device_config.frame_rate);
                  auto frame_rates = choc::value::createArray(
                      state_.device_config.frame_rate_count,
                      [this](uint32_t i) { return (int)state_.device_config.frame_rates[i]; });
                  result.setMember("frame_rates", frame_rates);
                  auto stereo = choc::value::createObject("stereo");
                  stereo.setMember("flags", (int)state_.stereo_status.flags);
                  stereo.setMember("error", state_.stereo_status.error);
                  stereo.setMember("message", std::string(state_.stereo_status.message));
                  stereo.setMember("mode", (int)state_.stereo_status.mode_id);
                  stereo.setMember("focal", state_.stereo_status.focal_px);
                  stereo.setMember("projection", (int)state_.stereo_status.projection);
                  stereo.setMember("vertical_fov", state_.stereo_status.vertical_fov_deg);
                  stereo.setMember(
                      "modes",
                      choc::value::createArray(state_.stereo_status.mode_count,
                                               [this](uint32_t i)
                                               {
                                                   const auto &m = state_.stereo_status.modes[i];
                                                   auto value = choc::value::createObject("mode");
                                                   value.setMember("id", (int)m.id);
                                                   value.setMember("width", (int)m.width);
                                                   value.setMember("height", (int)m.height);
                                                   value.setMember("max_fps", (int)m.max_fps);
                                                   value.setMember("projection", (int)m.projection);
                                                   return value;
                                               }));
                  result.setMember("stereo", stereo);
                  result.setMember("image_fps", state_.image_fps);
                  result.setMember("imu_fps", state_.imu_fps);
                  result.setMember("metrics", state_.metrics);
                  result.setMember("last_result", state_.last_result);
                  result.setMember("last_error", state_.last_error);
                  result.setMember("native_uvc", state_.native_uvc);
                  result.setMember("local_bag", state_.local_bag_active);
#if CB_VIEWER_VIDEO
                  result.setMember("uvc_url", std::string("http://127.0.0.1:17880/stream"));
#else
        result.setMember("uvc_url", std::string());
#endif
                  return result;
              });

    view.bind("host_set_stereo",
              [this](const choc::value::ValueView &args)
              {
                  if (!state_.host || args.size() < 1)
                      return choc::value::Value(false);
                  return choc::value::Value(
                      cb_set_disparity_enabled(state_.host, args[0].getWithDefault<int>(0),
                                               cb_next_request_id(state_.host)) == 0);
              });
    view.bind("host_configure_stereo",
              [this](const choc::value::ValueView &args)
              {
                  if (!state_.host || args.size() < 2)
                      return choc::value::Value(false);
                  return choc::value::Value(
                      cb_set_disparity_config_ex(
                          state_.host, uint32_t(args[0].getWithDefault<int>(0)),
                          float(args[1].getWithDefault<double>(0)),
                          args.size() > 2 ? uint32_t(args[2].getWithDefault<int>(0)) : 0,
                          args.size() > 3 ? float(args[3].getWithDefault<double>(180)) : 180,
                          cb_next_request_id(state_.host)) == 0);
              });
    view.bind("host_start_uvc",
              [this](const choc::value::ValueView &)
              {
#if CB_VIEWER_VIDEO
                  std::string error;
                  char error_buffer[512]{};
                  if (!uvc_ || cb_video_start(uvc_, error_buffer, sizeof(error_buffer)) != 0)
                  {
                      error = error_buffer;
                      std::lock_guard<std::mutex> lock(state_.mutex);
                      state_.last_error = error.empty() ? "unable to start native UVC" : error;
                      return choc::value::Value(std::string());
                  }
                  {
                      std::lock_guard<std::mutex> lock(state_.mutex);
                      state_.native_uvc = true;
                      state_.last_error.clear();
                  }
                  preview_requested_ = true;
                  return choc::value::Value(std::string("http://127.0.0.1:17880/stream"));
#else
        return choc::value::Value(std::string());
#endif
              });
    view.bind("host_stop_uvc",
              [this](const choc::value::ValueView &)
              {
#if CB_VIEWER_VIDEO
                  preview_requested_ = false;
                  bool keep = false;
#if CB_VIEWER_ROSBAG
                  keep = local_bag_.active() && local_bag_.record_image();
#endif
                  if (!keep && uvc_)
                      cb_video_stop(uvc_);
                  std::lock_guard<std::mutex> lock(state_.mutex);
                  state_.native_uvc = keep;
                  return choc::value::Value(true);
#else
        return choc::value::Value(false);
#endif
              });

    view.bind("host_refresh_metrics",
              [this](const choc::value::ValueView &)
              {
                  if (!state_.host || !cb_connected(state_.host))
                      return choc::value::Value(false);
                  return choc::value::Value(
                      cb_request_metrics(state_.host, cb_next_request_id(state_.host)) == 0);
              });
    view.bind("host_set_antenna",
              [this](const choc::value::ValueView &args)
              {
                  if (!state_.host || args.size() < 1)
                      return choc::value::Value(false);
                  return choc::value::Value(cb_set_antenna(state_.host,
                                                           args[0].getWithDefault<int>(0),
                                                           cb_next_request_id(state_.host)) == 0);
              });
    view.bind("host_set_imu",
              [this](const choc::value::ValueView &args)
              {
                  if (!state_.host || args.size() < 1)
                      return choc::value::Value(false);
                  return choc::value::Value(
                      cb_set_imu_output(state_.host, args[0].getWithDefault<int>(0),
                                        cb_next_request_id(state_.host)) == 0);
              });
    view.bind("host_set_fps",
              [this](const choc::value::ValueView &args)
              {
                  if (!state_.host || args.size() < 1)
                      return choc::value::Value(false);
                  return choc::value::Value(
                      cb_set_frame_rate(state_.host, (uint32_t)args[0].getWithDefault<int>(0),
                                        cb_next_request_id(state_.host)) == 0);
              });
    view.bind("host_set_terminal_size",
              [this](const choc::value::ValueView &args)
              {
                  if (!state_.host || args.size() < 2)
                      return choc::value::Value(-ENODEV);
                  const int cols = args[0].getWithDefault<int>(80);
                  const int rows = args[1].getWithDefault<int>(24);
                  if (cols < 2 || cols > 500 || rows < 1 || rows > 200)
                      return choc::value::Value(-EINVAL);
                  return choc::value::Value(cb_set_terminal_size(state_.host, (uint16_t)cols,
                                                                 (uint16_t)rows,
                                                                 cb_next_request_id(state_.host)));
              });
    view.bind("host_start_bag",
              [this](const choc::value::ValueView &args)
              {
                  if (args.size() < 3)
                      return choc::value::Value(false);
                  const auto name = args[0].getWithDefault<std::string>("capture.bag");
#if CB_VIEWER_ROSBAG
                  const bool record_image = args[1].getWithDefault<int>(1) != 0;
                  const bool record_imu = args[2].getWithDefault<int>(1) != 0;
                  if (record_imu && cb_slam_imu_upload_blocked(state_.host) > 0)
                  {
                      std::lock_guard<std::mutex> lock(state_.mutex);
                      state_.last_error =
                          "稠密重建正在运行，禁止 IMU 上传；可取消 IMU 录制或停止 SLAM。";
                      return choc::value::Value(false);
                  }
                  std::string path = name;
                  if (path.find('.') == std::string::npos)
                      path += ".bag";
                  std::string error;
                  const int result = start_local_bag(path, record_image, record_imu, &error);
                  if (result != 0)
                  {
                      std::lock_guard<std::mutex> lock(state_.mutex);
                      state_.last_error = error.empty() ? "unable to start local rosbag" : error;
                  }
                  return choc::value::Value(result == 0);
#else
        return choc::value::Value(false);
#endif
              });
    view.bind("host_stop_bag",
              [this](const choc::value::ValueView &)
              {
#if CB_VIEWER_ROSBAG
                  local_bag_.stop();
                  {
                      std::lock_guard<std::mutex> lock(state_.mutex);
                      state_.local_bag_active = false;
                  }
#if CB_VIEWER_VIDEO
                  if (uvc_ && !preview_requested_)
                  {
                      cb_video_stop(uvc_);
                      std::lock_guard<std::mutex> lock(state_.mutex);
                      state_.native_uvc = false;
                  }
#endif
                  return choc::value::Value(true);
#else
        return choc::value::Value(false);
#endif
              });
    view.bind("host_choose_bag_path",
              [this](const choc::value::ValueView &)
              {
#ifdef _WIN32
                  wchar_t file_name[MAX_PATH]{};
                  std::wstring default_name = L"capture.bag";
                  std::wcsncpy(file_name, default_name.c_str(), MAX_PATH - 1);
                  OPENFILENAMEW dialog{};
                  dialog.lStructSize = sizeof(dialog);
                  dialog.hwndOwner = static_cast<HWND>(window_.getWindowHandle());
                  dialog.lpstrFilter = L"ROS bag (*.bag)\0*.bag\0All files (*.*)\0*.*\0";
                  dialog.lpstrFile = file_name;
                  dialog.nMaxFile = MAX_PATH;
                  dialog.lpstrDefExt = L"bag";
                  dialog.Flags = OFN_PATHMUSTEXIST | OFN_OVERWRITEPROMPT;
                  if (!GetSaveFileNameW(&dialog))
                      return choc::value::Value(std::string());
                  const int size =
                      WideCharToMultiByte(CP_UTF8, 0, file_name, -1, nullptr, 0, nullptr, nullptr);
                  if (size <= 1)
                      return choc::value::Value(std::string());
                  std::string utf8(static_cast<size_t>(size - 1), '\0');
                  WideCharToMultiByte(CP_UTF8, 0, file_name, -1, utf8.data(), size, nullptr,
                                      nullptr);
                  return choc::value::Value(utf8);
#else
        return choc::value::Value(std::string());
#endif
              });
    view.bind("host_debug_write",
              [this](const choc::value::ValueView &args)
              {
                  if (!state_.host || args.size() < 1)
                      return choc::value::Value(false);
                  const auto text = args[0].getWithDefault<std::string>("");
                  return choc::value::Value(
                      cb_debug_write(state_.host, reinterpret_cast<const uint8_t *>(text.data()),
                                     text.size()) == 0);
              });
    view.bind("host_debug_drain",
              [this](const choc::value::ValueView &)
              {
                  if (!state_.host)
                      return choc::value::Value(std::string());
                  uint8_t data[8192];
                  const int count = cb_debug_read(state_.host, data, sizeof(data), 0);
                  if (count <= 0)
                      return choc::value::Value(std::string());
                  // Keep the serial stream byte-exact across the C++/WebView bridge.
                  // ESC/CSI/DEL bytes must not pass through text conversion before
                  // xterm.js parses them.
                  return choc::value::Value(base64_encode(data, (size_t)count));
              });
}

} // namespace cambold::viewer
