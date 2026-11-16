/* SPDX-License-Identifier: Apache-2.0 */
#include "camera_state.hpp"
#include <cerrno>

namespace cambold::viewer
{

void update_rates_locked(UiState *state, std::chrono::steady_clock::time_point now)
{
    if (state->rate_window_start.time_since_epoch().count() == 0)
        state->rate_window_start = now;
    const auto elapsed = now - state->rate_window_start;
    if (elapsed >= std::chrono::milliseconds(500))
    {
        const double seconds = std::chrono::duration<double>(elapsed).count();
        state->image_fps = state->rate_image_count / seconds;
        state->imu_fps = state->rate_imu_count / seconds;
        state->rate_image_count = 0;
        state->rate_imu_count = 0;
        state->rate_window_start = now;
    }
    if (state->last_image_event.time_since_epoch().count() == 0 ||
        now - state->last_image_event > std::chrono::seconds(1))
        state->image_fps = 0.0;
    if (state->last_imu_event.time_since_epoch().count() == 0 ||
        now - state->last_imu_event > std::chrono::seconds(1))
        state->imu_fps = 0.0;
}

void host_event(const cb_event *event, void *user)
{
    auto *state = static_cast<UiState *>(user);
    if (!state || !event)
        return;
    if (event->type == CB_EVENT_DISPARITY)
    {
        auto frame = std::make_shared<std::vector<uint8_t>>(event->payload,
                                                            event->payload + event->payload_size);
        std::lock_guard<std::mutex> lock(state->disparity_mutex);
        state->disparity_frame = std::move(frame);
        return;
    }
    std::lock_guard<std::mutex> lock(state->mutex);
    const auto now = std::chrono::steady_clock::now();
    update_rates_locked(state, now);
    switch (event->type)
    {
    case CB_EVENT_CALIBRATION_STATUS:
        if (event->request_id && event->text)
        {
            if (state->calibration_replies.size() >= 32)
                state->calibration_replies.pop_front();
            state->calibration_replies.emplace_back(event->request_id, event->text);
        }
        break;
    case CB_EVENT_CONNECTED:
        state->connection = ConnectionState::Online;
        state->last_result = "control protocol online";
        state->last_error.clear();
        break;
    case CB_EVENT_DISCONNECTED:
        state->connection = ConnectionState::Reconnecting;
        state->device_name.clear();
        state->last_result = "control protocol disconnected; reconnecting";
        state->device_config = {};
        state->stereo_status = {};
        {
            std::lock_guard<std::mutex> frame_lock(state->disparity_mutex);
            state->disparity_frame.reset();
        }
        state->imu_enable_result = -ENOTCONN;
        state->imu_enable_completed = true;
        state->imu_condition.notify_all();
        break;
    case CB_EVENT_RESULT:
        state->last_result = "request result: " + std::to_string(event->result);
        if (event->text && event->text[0])
            state->last_result += " " + std::string(event->text);
        if (state->imu_enable_request != 0 && event->request_id == state->imu_enable_request &&
            event->result != 0)
        {
            state->imu_enable_result = event->result;
            state->imu_enable_completed = true;
            state->imu_condition.notify_all();
        }
        break;
    case CB_EVENT_METRICS:
        if (event->text)
            state->metrics = event->text;
        break;
    case CB_EVENT_ANTENNA:
        state->antenna_wired = event->antenna_wired != 0;
        break;
    case CB_EVENT_IMU_STATUS:
        state->imu_enabled = event->enabled != 0;
        if (state->imu_enable_request != 0 && event->request_id == state->imu_enable_request &&
            !state->imu_enable_completed)
        {
            state->imu_enable_result = event->enabled ? 0 : -EIO;
            state->imu_enable_completed = true;
            state->imu_condition.notify_all();
        }
        break;
    case CB_EVENT_DEVICE_CONFIG:
    {
        cb_device_config config{};
        if (event->result == 0 &&
            cb_decode_device_config(event->payload, event->payload_size, &config) == 0)
        {
            state->device_config = config;
            if (config.valid_flags & CB_CONFIG_IMU_VALID)
                state->imu_enabled = config.imu_output_enabled != 0;
            if (config.valid_flags & CB_CONFIG_ANTENNA_VALID)
                state->antenna_wired = config.antenna_wired != 0;
        }
        break;
    }
    case CB_EVENT_STEREO_STATUS:
        if (event->result == 0)
        {
            cb_stereo_status info{};
            if (cb_decode_stereo_status(event->payload, event->payload_size, &info) == 0)
            {
                state->stereo_status = info;
                if (!(info.flags & CB_STEREO_ENABLED))
                {
                    std::lock_guard<std::mutex> frame_lock(state->disparity_mutex);
                    state->disparity_frame.reset();
                }
            }
        }
        break;
    case CB_EVENT_SENSOR_STATUS:
        if (event->text && event->text[0])
        {
            const std::string status(event->text);
            state->last_error =
                status.find("\"error_code\":0") != std::string::npos ? std::string() : status;
        }
        break;
    case CB_EVENT_IMU_BATCH:
    {
        size_t count = 0;
        if (cb_decode_imu_batch(event->payload, event->payload_size, nullptr, &count) == -ENOSPC)
        {
            state->rate_imu_count += count;
            state->last_imu_event = now;
#if CB_VIEWER_ROSBAG
            /* The local recorder is owned by the desktop executable.  The C
             * SDK only decodes the transport event; it does not know that a
             * rosbag exists. */
            if (state->local_bag_writer && state->local_bag_writer->active() &&
                state->local_bag_writer->record_imu())
            {
                std::vector<cb_imu_sample> samples(count);
                size_t capacity = samples.size();
                if (cb_decode_imu_batch(event->payload, event->payload_size, samples.data(),
                                        &capacity) == 0)
                {
                    for (size_t i = 0; i < capacity; ++i)
                        state->local_bag_writer->submit_imu(samples[i]);
                }
            }
#endif
        }
        break;
    }
    case CB_EVENT_FRAME_META:
    {
        /* FRAME_META describes the same camera frame that arrives through the
         * native UVC SDK callback.  Image-rate accounting is deliberately
         * performed only in on_native_frame(); counting both event streams
         * would report exactly twice the physical frame rate. */
        break;
    }
    case CB_EVENT_ERROR:
        if (event->text)
            state->last_error = event->text;
        break;
    default:
        break;
    }
}

const char *connection_name(ConnectionState state)
{
    switch (state)
    {
    case ConnectionState::Online:
        return "online";
    case ConnectionState::Waiting:
        return "waiting";
    case ConnectionState::Reconnecting:
        return "reconnecting";
    default:
        return "offline";
    }
}

} // namespace cambold::viewer
