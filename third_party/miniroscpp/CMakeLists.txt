# MiniROS 0.7.2 subset: local, uncompressed ROS1 bag storage only.
cmake_minimum_required(VERSION 3.16)
project(miniros VERSION 0.7.2 LANGUAGES CXX)
find_package(Threads REQUIRED)

# Generate the original version header for static linking.
set(MINIROS_BUILD_SHARED_LIBS OFF)
configure_file(include/miniros/version.h.in
    "${CMAKE_CURRENT_BINARY_DIR}/include/miniros/version.h" @ONLY)

add_library(bag_storage STATIC
    src/header.cpp
    src/serialization.cpp
    src/rostime/time.cpp
    src/rostime/duration.cpp
    src/rosbag_storage/bag.cpp
    src/rosbag_storage/buffer.cpp
    src/rosbag_storage/chunked_file.cpp
    src/rosbag_storage/stream.cpp
    src/rosbag_storage/uncompressed_stream.cpp
    src/rosbag_storage/no_encryptor.cpp
)
target_compile_features(bag_storage PUBLIC cxx_std_17)
target_link_libraries(bag_storage PUBLIC Threads::Threads)
target_include_directories(bag_storage PUBLIC
    "${CMAKE_CURRENT_BINARY_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/generated")
