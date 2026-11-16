cmake_minimum_required(VERSION 3.22)
project(linkord_voice C)

# libopus, pinned to the release tarball and its hash (fetched once into the build folder, nothing vendored).
# Opus is always optimized, debug builds too (it says it's "very slow" otherwise, and calls would stutter).
string(APPEND CMAKE_C_FLAGS " -O2")
include(FetchContent)
set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
FetchContent_Declare(opus
    URL https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz
    URL_HASH SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(opus)

add_library(linkord_voice SHARED opus_jni.c)
target_link_libraries(linkord_voice PRIVATE opus log)
target_compile_options(linkord_voice PRIVATE -O2 -Wall)
# 16 KB pages (Android 15+ devices may use them).
target_link_options(linkord_voice PRIVATE "-Wl,-z,max-page-size=16384")
