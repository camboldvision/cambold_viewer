/* SPDX-License-Identifier: Apache-2.0 */

#define STBI_NO_STDIO
#define STB_IMAGE_IMPLEMENTATION
#include "../third_party/stb/stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "../third_party/stb/stb_image_write.h"

#include "cb_rosbag.hpp"

#include <algorithm>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>

#include <minibag/bag.h>
#include <sensor_msgs/CompressedImage.hxx>
#include <sensor_msgs/Imu.hxx>

namespace
{

struct EncodedJpeg
{
    std::vector<unsigned char> bytes;
};

void jpeg_writer(void *context, void *data, int size)
{
    if (!context || !data || size <= 0)
        return;
    auto *output = static_cast<EncodedJpeg *>(context);
    const auto *begin = static_cast<const unsigned char *>(data);
    output->bytes.insert(output->bytes.end(), begin, begin + size);
}

miniros::Time ros_time(uint64_t timestamp_ns)
{
    miniros::Time result;
    result.fromNSec(timestamp_ns);
    return result;
}

} // namespace

struct HostRosbagWriter::Impl
{
    struct Frame
    {
        std::vector<uint8_t> jpeg;
        uint64_t sequence = 0;
        uint64_t timestamp_ns = 0;
    };

    struct Imu
    {
        cb_imu_sample sample{};
    };

    mutable std::mutex mutex;
    std::condition_variable condition;
    std::deque<Frame> frames;
    std::deque<Imu> imu;
    std::thread worker;
    minibag::Bag bag;
    bool bag_open = false;
    bool stopping = false;
    bool active_value = false;
    bool record_image_value = false;
    bool record_imu_value = false;
    unsigned int quality = 90;
    uint32_t imu_sequence = 0;
    std::string error;

    static constexpr size_t frame_capacity = 4;
    static constexpr size_t imu_capacity = 4096;

    bool encode_crop(const uint8_t *jpeg, size_t jpeg_size, std::vector<unsigned char> *left,
                     std::vector<unsigned char> *right, unsigned int quality_value)
    {
        int width = 0, height = 0, channels = 0;
        stbi_uc *rgb =
            stbi_load_from_memory(jpeg, static_cast<int>(jpeg_size), &width, &height, &channels, 3);
        if (!rgb || width != 2160 || height != 1280)
        {
            if (rgb)
                stbi_image_free(rgb);
            return false;
        }

        const int half_width = width / 2;
        std::vector<uint8_t> left_rgb(static_cast<size_t>(half_width) * height * 3U);
        std::vector<uint8_t> right_rgb(left_rgb.size());
        for (int y = 0; y < height; ++y)
        {
            const auto *src = rgb + static_cast<size_t>(y) * width * 3U;
            auto *left_row = left_rgb.data() + static_cast<size_t>(y) * half_width * 3U;
            auto *right_row = right_rgb.data() + static_cast<size_t>(y) * half_width * 3U;
            std::memcpy(left_row, src, static_cast<size_t>(half_width) * 3U);
            std::memcpy(right_row, src + static_cast<size_t>(half_width) * 3U,
                        static_cast<size_t>(half_width) * 3U);
        }
        stbi_image_free(rgb);

        EncodedJpeg left_output;
        EncodedJpeg right_output;
        const int quality_int = static_cast<int>(std::clamp(quality_value, 1U, 100U));
        const bool left_ok = stbi_write_jpg_to_func(jpeg_writer, &left_output, half_width, height,
                                                    3, left_rgb.data(), quality_int) != 0;
        const bool right_ok = stbi_write_jpg_to_func(jpeg_writer, &right_output, half_width, height,
                                                     3, right_rgb.data(), quality_int) != 0;
        if (!left_ok || !right_ok)
            return false;
        *left = std::move(left_output.bytes);
        *right = std::move(right_output.bytes);
        return true;
    }

    bool write_frame(const Frame &frame)
    {
        std::vector<unsigned char> left_jpeg;
        std::vector<unsigned char> right_jpeg;
        if (!encode_crop(frame.jpeg.data(), frame.jpeg.size(), &left_jpeg, &right_jpeg, quality))
            return false;

        const miniros::Time stamp = ros_time(frame.timestamp_ns);
        sensor_msgs::CompressedImage left;
        left.header.seq = static_cast<uint32_t>(frame.sequence);
        left.header.stamp = stamp;
        left.header.frame_id = "camera_left_optical";
        left.format = "jpeg";
        left.data.assign(left_jpeg.begin(), left_jpeg.end());

        sensor_msgs::CompressedImage right;
        right.header.seq = static_cast<uint32_t>(frame.sequence);
        right.header.stamp = stamp;
        right.header.frame_id = "camera_right_optical";
        right.format = "jpeg";
        right.data.assign(right_jpeg.begin(), right_jpeg.end());

        bag.write("/camera/left/image/compressed", stamp, left);
        bag.write("/camera/right/image/compressed", stamp, right);
        return true;
    }

    bool write_imu(const Imu &item)
    {
        const auto &sample = item.sample;
        const miniros::Time stamp = ros_time(sample.timestamp_monotonic_ns);
        sensor_msgs::Imu message;
        message.header.seq = imu_sequence++;
        message.header.stamp = stamp;
        message.header.frame_id = "imu_link";
        message.orientation_covariance[0] = -1.0;
        message.angular_velocity.x = sample.gyro[0];
        message.angular_velocity.y = sample.gyro[1];
        message.angular_velocity.z = sample.gyro[2];
        message.linear_acceleration.x = sample.accel[0];
        message.linear_acceleration.y = sample.accel[1];
        message.linear_acceleration.z = sample.accel[2];
        bag.write("/imu/data", stamp, message);
        return true;
    }

    void loop()
    {
        for (;;)
        {
            Frame frame;
            Imu imu_item;
            bool have_frame = false;
            {
                std::unique_lock<std::mutex> lock(mutex);
                condition.wait(lock,
                               [this] { return stopping || !frames.empty() || !imu.empty(); });
                if (frames.empty() && imu.empty() && stopping)
                    break;

                const bool choose_frame =
                    !frames.empty() &&
                    (imu.empty() ||
                     frames.front().timestamp_ns <= imu.front().sample.timestamp_monotonic_ns);
                if (choose_frame)
                {
                    frame = std::move(frames.front());
                    frames.pop_front();
                    have_frame = true;
                }
                else
                {
                    imu_item = imu.front();
                    imu.pop_front();
                }
            }
            try
            {
                if (have_frame)
                    write_frame(frame);
                else
                    write_imu(imu_item);
            }
            catch (...)
            {
                std::lock_guard<std::mutex> lock(mutex);
                error = "exception while writing rosbag";
            }
        }
        if (bag_open)
        {
            try
            {
                bag.close();
            }
            catch (...)
            {
            }
            bag_open = false;
        }
    }

    int start(const std::string &path, bool record_image, bool record_imu,
              unsigned int quality_value, std::string *error_out)
    {
        if (path.empty() || (!record_image && !record_imu))
            return -EINVAL;
        if (active_value)
            return 0;
        quality = std::clamp(quality_value, 1U, 100U);
        record_image_value = record_image;
        record_imu_value = record_imu;
        try
        {
            bag.open(path, minibag::bagmode::Write);
            bag.setCompression(minibag::compression::Uncompressed);
            bag.setChunkThreshold(4U * 1024U * 1024U);
            bag_open = true;
            stopping = false;
            active_value = true;
            worker = std::thread(&Impl::loop, this);
            return 0;
        }
        catch (const std::exception &exception)
        {
            if (error_out)
                *error_out = exception.what();
            if (bag_open)
            {
                try
                {
                    bag.close();
                }
                catch (...)
                {
                }
                bag_open = false;
            }
            return -EIO;
        }
    }

    void stop()
    {
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (!active_value && !worker.joinable())
                return;
            stopping = true;
        }
        condition.notify_all();
        if (worker.joinable())
            worker.join();
        std::lock_guard<std::mutex> lock(mutex);
        frames.clear();
        imu.clear();
        active_value = false;
        record_image_value = false;
        record_imu_value = false;
    }
};

HostRosbagWriter::HostRosbagWriter() : impl_(new Impl) {}
HostRosbagWriter::~HostRosbagWriter()
{
    if (impl_)
    {
        impl_->stop();
        delete impl_;
    }
}

int HostRosbagWriter::start(const std::string &path, bool record_image, bool record_imu,
                            unsigned int quality, std::string *error)
{
    return impl_->start(path, record_image, record_imu, quality, error);
}

void HostRosbagWriter::stop()
{
    impl_->stop();
}
bool HostRosbagWriter::active() const
{
    return impl_->active_value;
}
bool HostRosbagWriter::record_image() const
{
    return impl_->record_image_value;
}
bool HostRosbagWriter::record_imu() const
{
    return impl_->record_imu_value;
}

void HostRosbagWriter::submit_frame(std::vector<uint8_t> jpeg, uint64_t sequence,
                                    uint64_t timestamp_ns)
{
    if (!impl_->active_value || !impl_->record_image_value || jpeg.empty() || sequence == 0 ||
        timestamp_ns == 0)
        return;
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->stopping || impl_->frames.size() >= Impl::frame_capacity)
        return;
    impl_->frames.push_back({std::move(jpeg), sequence, timestamp_ns});
    impl_->condition.notify_one();
}

void HostRosbagWriter::submit_imu(const cb_imu_sample &sample)
{
    if (!impl_->active_value || !impl_->record_imu_value || sample.timestamp_monotonic_ns == 0)
        return;
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->stopping || impl_->imu.size() >= Impl::imu_capacity)
        return;
    impl_->imu.push_back({sample});
    impl_->condition.notify_one();
}
