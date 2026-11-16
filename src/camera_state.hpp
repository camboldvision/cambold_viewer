/* SPDX-License-Identifier: Apache-2.0 */
#pragma once

#include "cb_sdk.h"
#if CB_VIEWER_ROSBAG
#include "cb_rosbag.hpp"
#endif
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include <deque>
#include <utility>

namespace cambold::viewer
{

enum class ConnectionState
{
    Offline = 0,
    Waiting = 1,
    Online = 2,
    Reconnecting = 3
};

struct UiState
{
    std::mutex mutex;
    cb_t *host = nullptr;
    ConnectionState connection = ConnectionState::Offline;
    bool antenna_wired = false;
    bool imu_enabled = false;
    cb_device_config device_config{};
    cb_stereo_status stereo_status{};
    std::mutex disparity_mutex;
    std::shared_ptr<std::vector<uint8_t>> disparity_frame;
    std::condition_variable imu_condition;
    uint64_t imu_enable_request = 0;
    bool imu_enable_completed = false;
    int imu_enable_result = 0;
    double image_fps = 0.0;
    double imu_fps = 0.0;
    uint64_t rate_image_count = 0;
    uint64_t rate_imu_count = 0;
    std::chrono::steady_clock::time_point rate_window_start{};
    std::chrono::steady_clock::time_point last_image_event{};
    std::chrono::steady_clock::time_point last_imu_event{};
    std::string control_port;
    std::string debug_port;
    std::string device_name;
    std::string metrics = "{}";
    std::deque<std::pair<uint64_t, std::string>> calibration_replies;
    std::string last_result = "waiting for camera";
    std::string last_error;
    bool native_uvc = false;
    bool local_bag_active = false;
#if CB_VIEWER_ROSBAG
    HostRosbagWriter *local_bag_writer = nullptr;
#endif
};

// Called with UiState::mutex held; the SDK callback can run concurrently with the UI.
void update_rates_locked(UiState *state, std::chrono::steady_clock::time_point now);
void host_event(const cb_event *event, void *user);
const char *connection_name(ConnectionState state);

} // namespace cambold::viewer
