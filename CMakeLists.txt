# SPDX-License-Identifier: Apache-2.0
cmake_minimum_required(VERSION 3.16)

# Invoked with -P by the resource generation command below.
if(CMAKE_SCRIPT_MODE_FILE)
    if(NOT DEFINED UI_ROOT OR NOT DEFINED OUTPUT)
        message(FATAL_ERROR "UI_ROOT and OUTPUT are required")
    endif()
    if(NOT DEFINED RESOURCE_NAMESPACE)
        set(RESOURCE_NAMESPACE cb_ui)
    endif()

    file(GLOB_RECURSE UI_FILES RELATIVE "${UI_ROOT}" "${UI_ROOT}/*")
    list(SORT UI_FILES)
    get_filename_component(OUTPUT_DIR "${OUTPUT}" DIRECTORY)
    file(MAKE_DIRECTORY "${OUTPUT_DIR}")
    file(WRITE "${OUTPUT}" "#pragma once\n#include <cstddef>\n\nnamespace ${RESOURCE_NAMESPACE} {\n\nstruct EmbeddedResource {\n    const char* path;\n    const unsigned char* data;\n    std::size_t size;\n    const char* mime;\n};\n\n")

    set(RESOURCE_ROWS "")
    foreach(RELATIVE_FILE IN LISTS UI_FILES)
        if(IS_DIRECTORY "${UI_ROOT}/${RELATIVE_FILE}")
            continue()
        endif()
        file(READ "${UI_ROOT}/${RELATIVE_FILE}" HEX_DATA HEX)
        string(MAKE_C_IDENTIFIER "${RELATIVE_FILE}" SYMBOL)
        string(REGEX REPLACE "([0-9A-Fa-f][0-9A-Fa-f])" "0x\\1," ARRAY_TEXT "${HEX_DATA}")
        file(APPEND "${OUTPUT}" "static const unsigned char data_${SYMBOL}[] = {${ARRAY_TEXT}};\n")

        if(RELATIVE_FILE MATCHES "\\.html$")
            set(MIME "text/html; charset=utf-8")
        elseif(RELATIVE_FILE MATCHES "\\.css$")
            set(MIME "text/css; charset=utf-8")
        elseif(RELATIVE_FILE MATCHES "\\.js$")
            set(MIME "text/javascript; charset=utf-8")
        elseif(RELATIVE_FILE MATCHES "\\.json$")
            set(MIME "application/json")
        elseif(RELATIVE_FILE MATCHES "\\.svg$")
            set(MIME "image/svg+xml")
        else()
            set(MIME "application/octet-stream")
        endif()
        string(REPLACE "\\" "/" URL_PATH "${RELATIVE_FILE}")
        string(APPEND RESOURCE_ROWS "    {\"/${URL_PATH}\", data_${SYMBOL}, sizeof(data_${SYMBOL}), \"${MIME}\"},\n")
    endforeach()

    file(APPEND "${OUTPUT}" "\nstatic const EmbeddedResource resources[] = {\n${RESOURCE_ROWS}};\n")
    file(APPEND "${OUTPUT}" "static constexpr std::size_t resource_count = sizeof(resources) / sizeof(resources[0]);\n\n} // namespace ${RESOURCE_NAMESPACE}\n")
    return()
endif()

project(cambold_viewer VERSION 1.0.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
option(CB_BUILD_VIEWER "Build the CamBold desktop application" ON)
option(CB_VIEWER_STATIC_MINGW "Statically link MinGW runtimes" ON)
option(CB_VIEWER_ROSBAG "Enable local ROS1 bag recording" ON)
if(NOT TARGET CamBold::SDK)
    add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../cambold_sdk" "${CMAKE_CURRENT_BINARY_DIR}/sdk" EXCLUDE_FROM_ALL)
endif()
if(CB_BUILD_VIEWER)
    if(CB_VIEWER_ROSBAG)
        set(MINIROS_SOURCE_DIR
            ${CMAKE_CURRENT_SOURCE_DIR}/../cross_compile/third_party/miniroscpp)
        if(NOT EXISTS "${MINIROS_SOURCE_DIR}/CMakeLists.txt")
            message(FATAL_ERROR "MiniROS source not found: ${MINIROS_SOURCE_DIR}")
        endif()
        set(MINIROS_BUILD_SHARED OFF CACHE BOOL "" FORCE)
        set(MINIROS_BUILD_TESTS OFF CACHE BOOL "" FORCE)
        set(MINIROS_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(MINIROS_PORTABLE_TOOLS ON CACHE BOOL "" FORCE)
        set(MINIROS_ROSBAG_USE_GPGME_ENCRYPTION OFF CACHE BOOL "" FORCE)
        set(MINIROS_ROSBAG_USE_OPENSSL_ENCRYPTION OFF CACHE BOOL "" FORCE)
        set(MINIROS_USE_NETLINK OFF CACHE BOOL "" FORCE)
        set(MINIROS_USE_SYSTEM_BZIP2 OFF CACHE BOOL "" FORCE)
        set(MINIROS_USE_SYSTEM_LZ4 OFF CACHE BOOL "" FORCE)
        set(MINIROS_USE_SYSTEM_PROGRAM_OPTIONS OFF CACHE BOOL "" FORCE)
        add_subdirectory("${MINIROS_SOURCE_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/host-miniroscpp"
                         EXCLUDE_FROM_ALL)
        if(TARGET roscxx)
            target_compile_options(roscxx PRIVATE
                -Wno-format -Wno-format-extra-args
                -Wno-error=format -Wno-error=format-extra-args)
        endif()
        if(TARGET bag_storage)
            target_compile_options(bag_storage PRIVATE
                -Wno-format -Wno-format-extra-args
                -Wno-error=format -Wno-error=format-extra-args)
        endif()
    endif()

    set(UI_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/ui)
    file(GLOB_RECURSE UI_ASSETS CONFIGURE_DEPENDS ${UI_ROOT}/*)
    set(UI_EMBEDDED ${CMAKE_CURRENT_BINARY_DIR}/generated/ui_embedded.hpp)
    add_custom_command(
        OUTPUT ${UI_EMBEDDED}
        COMMAND ${CMAKE_COMMAND}
            -DUI_ROOT=${UI_ROOT}
            -DOUTPUT=${UI_EMBEDDED}
            -P ${CMAKE_CURRENT_SOURCE_DIR}/CMakeLists.txt
        DEPENDS ${UI_ASSETS} ${CMAKE_CURRENT_SOURCE_DIR}/CMakeLists.txt
        VERBATIM)
    add_custom_target(ui_embed DEPENDS ${UI_EMBEDDED})
    set(CB_VIEWER_SOURCES
        src/main.cpp
        src/application.cpp
        src/ui_bindings.cpp
        src/camera_state.cpp)
    if(CB_VIEWER_ROSBAG)
        list(APPEND CB_VIEWER_SOURCES src/cb_rosbag.cpp)
    endif()
    if(WIN32)
        enable_language(RC)
        list(APPEND CB_VIEWER_SOURCES resources/cambold.rc)
        set_source_files_properties(resources/cambold.rc PROPERTIES OBJECT_DEPENDS
            "${CMAKE_CURRENT_SOURCE_DIR}/resources/cambold.ico;${CMAKE_CURRENT_SOURCE_DIR}/resources/resource.h")
    endif()
    add_executable(cambold_viewer WIN32 ${CB_VIEWER_SOURCES} ${UI_EMBEDDED})
    add_dependencies(cambold_viewer ui_embed)
    target_include_directories(cambold_viewer PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/resources
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/choc-src
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/stb
        ${CMAKE_CURRENT_SOURCE_DIR}/../cross_compile/third_party/nadjieb
        ${CMAKE_CURRENT_BINARY_DIR}/generated)
    target_link_libraries(cambold_viewer PRIVATE CamBold::SDK nlohmann_json::nlohmann_json)
    target_compile_definitions(cambold_viewer PRIVATE CB_VIEWER_VIDEO=1)
    if(CB_VIEWER_ROSBAG)
        target_link_libraries(cambold_viewer PRIVATE bag_storage)
        target_compile_definitions(cambold_viewer PRIVATE CB_VIEWER_ROSBAG=1)
    else()
        target_compile_definitions(cambold_viewer PRIVATE CB_VIEWER_ROSBAG=0)
    endif()
    if(WIN32)
        target_link_libraries(cambold_viewer PRIVATE
            ole32 shlwapi user32 comdlg32 version dwmapi advapi32 ws2_32)
        if(MINGW AND CB_VIEWER_STATIC_MINGW)
            target_link_options(cambold_viewer PRIVATE
                -static -static-libgcc -static-libstdc++)
        endif()
    elseif(APPLE)
        target_link_libraries(cambold_viewer PRIVATE
            "-framework WebKit" "-framework Cocoa")
    elseif(UNIX)
        find_package(PkgConfig QUIET)
        if(PkgConfig_FOUND)
            pkg_check_modules(GTK3 QUIET gtk+-3.0)
            pkg_check_modules(WEBKIT2 QUIET webkit2gtk-4.1)
            if(NOT WEBKIT2_FOUND)
                pkg_check_modules(WEBKIT2 QUIET webkit2gtk-4.0)
            endif()
        endif()
        if(GTK3_FOUND AND WEBKIT2_FOUND)
            target_include_directories(cambold_viewer PRIVATE
                ${GTK3_INCLUDE_DIRS} ${WEBKIT2_INCLUDE_DIRS})
            target_compile_options(cambold_viewer PRIVATE
                ${GTK3_CFLAGS_OTHER} ${WEBKIT2_CFLAGS_OTHER})
            target_link_libraries(cambold_viewer PRIVATE
                ${GTK3_LIBRARIES} ${WEBKIT2_LIBRARIES})
        else()
            message(WARNING "GTK3/WebKit2GTK not found; disabling cambold_viewer")
            set_target_properties(cambold_viewer PROPERTIES EXCLUDE_FROM_ALL TRUE)
        endif()
    endif()
endif()


if(TARGET cambold_viewer)
    install(TARGETS cambold_viewer RUNTIME DESTINATION bin)
    install(FILES README.md LICENSE DESTINATION share/cambold-viewer)
    install(FILES third_party/choc-src/LICENSE.md
        DESTINATION share/cambold-viewer/licenses RENAME choc-LICENSE.md)
    install(FILES ui/vendor/xterm/LICENSE
        DESTINATION share/cambold-viewer/licenses RENAME xterm-LICENSE)
    install(FILES ui/slam/vendor/three/LICENSE
        DESTINATION share/cambold-viewer/licenses RENAME three-LICENSE)
endif()
