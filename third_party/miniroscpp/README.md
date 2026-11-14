# MiniROS bag storage subset

Derived from MiniROS 0.7.2. This directory contains the dependency closure
used by CamBold Viewer's local ROS1 bag recorder:

- Bag storage, connection metadata, chunk indexes and uncompressed file I/O.
- ROS time/duration and message serialization.
- `sensor_msgs/CompressedImage`, `sensor_msgs/Imu`, `std_msgs/Header`,
  `geometry_msgs/Quaternion` and `geometry_msgs/Vector3`.

ROS nodes, master discovery, XMLRPC, networking, launchers, command-line tools,
playback, unrelated message types, compression/encryption libraries, examples,
tests and upstream Git metadata are excluded. The bag storage implementation
retains its shared read/index internals; the Viewer only opens bags for writing.
JPEG images remain compressed inside uncompressed bag chunks, as before.

Local changes remove unused dependencies and replace the ROS logging framework
with warning/error output to stderr. CMake builds only the static `bag_storage`
target, without downloads or additional third-party libraries.

See `LICENSE.txt` and copyright notices in individual source files.
