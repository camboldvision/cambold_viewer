# CamBold Viewer

CamBold Viewer 是相机桌面应用，提供图像预览、参数配置、视差与彩色点云、SLAM、
调试终端和本地 bag 录制。设备型号从 USB 产品名称读取，显示在窗口标题和界面中。

## 源码结构

```text
cambold_viewer/
  src/           程序运行、设备状态、界面绑定与 bag 录制
  ui/            相机、深度、点云与终端页面
    slam/        SLAM 地图控制与三维显示
  resources/     应用图标和 Windows 资源
  third_party/   界面所需依赖
  CMakeLists.txt 构建配置与网页资源嵌入
cambold_sdk/     独立的公共 SDK，位于同级目录
```

本程序通过 `CamBold::SDK` 调用公共 `cb_*` C API。SDK 的源码、公共头文件、
传输实现和第三方 USB 库由独立的 [cambold_sdk](../cambold_sdk/README.md) 管理。
开发者可单独分发 SDK，不需要携带 Viewer。

`src/main.cpp` 处理启动参数；`application.*` 管理窗口、连接和图像预览；
`camera_state.*` 处理 SDK 事件与共享状态；`ui_bindings.cpp` 提供网页调用；
`cb_rosbag.*` 管理本地录制。CHOC 仅保留窗口、WebView、消息循环及其传递依赖，
包含 Windows、Linux 和 macOS 分支所需的头文件。

## 构建与运行

```sh
cmake -S cambold_viewer -B build/viewer -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build/viewer --target cambold_viewer
cmake --install build/viewer --prefix ./cambold_viewer
```

Windows 使用 MinGW-w64；Linux 需要 GTK3 和 WebKit2GTK；macOS 使用系统 WebKit。
`CB_VIEWER_ROSBAG=OFF` 可关闭本地 bag 录制，默认开启。

Windows 构建并安装后运行：

```powershell
.\cambold_viewer\bin\cambold_viewer.exe
```

程序自动发现相机的 SDK bulk 接口。调试和控制分别使用 `gser.0` 与 `gser.1`，
用户 ACM 保留给用户应用。需要手动选择逻辑接口时，可传入
`--control-port gser.1 --debug-port gser.0`。不要同时启动两个电脑端程序争用同一
USB 接口。板端应用可以通过 LOCAL SDK 与 Viewer 同时订阅相机数据。

## 主要功能

- 相机页面显示原始双目预览，读取板端当前帧率、IMU、天线状态和可选配置。
- 深度区域并排显示同帧整流左目颜色和 FP16 视差，下方常驻彩色点云窗口。
  尺寸和投影参数取自设备，支持水平针孔与垂直圆柱模式。
- SLAM 页面提供地图命名、加载、新建、续图和纯定位，显示实时位姿、关键帧
  视锥及增量地图。实时位姿采用绿色加粗线条。
- 稀疏 SLAM 与独立深度预览互不干扰。开启稠密重建后，上位机 SDK 关闭本连接的
  IMU 上传，板端 SDK 的 IMU 订阅和算法内部 IMU 保持工作。停止稠密重建后，用户
  可重新开启 IMU 上传。两端 SDK 均接收 200 Hz 位姿，界面按屏幕刷新率绘制。
- 终端通过独立调试 bulk 通道提供 shell、窗口尺寸同步和常用终端控制。
- 本地 bag 录制在电脑上执行。勾选 IMU 时，先开启 IMU 上传并等待设备确认。

标定或模型缺失时，界面显示板端错误并禁止开启深度。相机其他功能仍可使用。
参数设置为异步操作，界面根据设备返回的结果更新状态。

## 内嵌资源

相机页面、SLAM 页面、Three.js、终端资源和 CamBold 蓝色 CB 相机 Logo 均编译进
可执行文件。Windows 程序内嵌同款应用图标，运行时不需要外部网页、图标或网络 CDN。
所有网页资源统一从 `ui/` 嵌入。修改页面或图标后，重新构建即可更新程序。

## 使用与开发文档

- [产品 Wiki](../docs/wiki/README.md)：零基础上手、连接和功能操作。
- [SDK 接口与两端共用示例](../cambold_sdk/README.md)：源码集成、线程和数据约定。
- [SLAM 使用指南](../docs/wiki/guides/slam.md)：地图与运行模式。
- [Windows 连接](../docs/wiki/start/windows.md)：接口与连接方式。

## 许可

CamBold Viewer 的第一方代码使用 [Apache License 2.0](LICENSE)，版权归
CamBold contributors 所有。SDK 的许可见 [cambold_sdk/LICENSE](../cambold_sdk/LICENSE)。

第三方代码保留各自的许可与版权声明：

| 组件 | 许可文本 |
|---|---|
| CHOC | ISC；`third_party/choc-src/LICENSE.md` |
| stb | MIT 或公有领域；`third_party/stb/stb_image.h`、`stb_image_write.h` 末尾 |
| xterm.js | MIT；`ui/vendor/xterm/LICENSE` |
| Three.js | MIT；`ui/slam/vendor/three/LICENSE` |
| cpp-mjpeg-streamer | MIT；`../cross_compile/third_party/nadjieb/mjpeg_streamer.hpp` 开头 |
| MiniROS 及录制依赖 | `../cross_compile/third_party/miniroscpp/LICENSE.txt` 和各组件随附许可 |
| SDK 的 USB 与 JSON 依赖 | [SDK 第三方说明](../cambold_sdk/THIRD_PARTY.md) |
