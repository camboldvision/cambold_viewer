/* SPDX-License-Identifier: Apache-2.0 */
#pragma once

#include "cb_sdk.h"

#include <cstdint>
#include <string>
#include <vector>

class HostRosbagWriter
{
  public:
    HostRosbagWriter();
    ~HostRosbagWriter();

    HostRosbagWriter(const HostRosbagWriter &) = delete;
    HostRosbagWriter &operator=(const HostRosbagWriter &) = delete;

    int start(const std::string &path, bool record_image, bool record_imu,
              unsigned int jpeg_quality, std::string *error);
    void stop();
    bool active() const;
    bool record_image() const;
    bool record_imu() const;

    void submit_frame(std::vector<uint8_t> jpeg, uint64_t sequence, uint64_t timestamp_ns);
    void submit_imu(const cb_imu_sample &sample);

  private:
    struct Impl;
    Impl *impl_ = nullptr;
};
