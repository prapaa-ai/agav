cmake_minimum_required(VERSION 3.24)
# Apply modern policy compatibility to the pinned upstream CMake dependency.
set(CMAKE_POLICY_VERSION_MINIMUM 3.10)
project(agav_voice VERSION 1.0.0 LANGUAGES C CXX)
include(FetchContent)
include(CTest)
find_package(Threads REQUIRED)
if(MINGW)
    # libstdc++'s threading implementation can pull in winpthread even when
    # libgcc/libstdc++ are static. Use static archive selection for all MinGW
    # runtimes (including transitive pthread links), not just those two.
    # Keep this in CMake so direct builds and both x64 variants share it.
    add_link_options(-static -static-libgcc -static-libstdc++)
endif()
option(AGAV_VOICE_METAL "Enable Apple's optional Metal inference backend" ${APPLE})
if(AGAV_VOICE_METAL AND NOT APPLE)
    message(FATAL_ERROR "AGAV_VOICE_METAL requires macOS")
endif()
set(AGAV_VOICE_TARGET_PROCESSOR "${CMAKE_SYSTEM_PROCESSOR}")
if(APPLE AND CMAKE_OSX_ARCHITECTURES)
    set(AGAV_VOICE_TARGET_PROCESSOR "${CMAKE_OSX_ARCHITECTURES}")
endif()
option(AGAV_VOICE_AVX2 "Build a separately gated x64 AVX2/FMA/F16C helper" OFF)
if(AGAV_VOICE_AVX2 AND NOT AGAV_VOICE_TARGET_PROCESSOR MATCHES "^(x86_64|AMD64|amd64)$")
    message(FATAL_ERROR "AGAV_VOICE_AVX2 requires x64")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "Static vendored libraries" FORCE)
# v1.7.6 ggml/src/CMakeLists.txt requires BACKEND_DL (and shared libs)
# for CPU_ALL_VARIANTS. CPU variants export identical symbols, so a static
# registry would require upstream source changes, not just CMake configuration.
# Keep one safe baseline rather than globally enabling AVX/AVX2 on older or
# hybrid CPUs. No host-specific instructions or separately installed runtimes.
foreach(feature NATIVE SSE42 AVX AVX2 AVX_VNNI BMI2 AVX512 AVX512_VBMI AVX512_VNNI AVX512_BF16 FMA F16C AMX_TILE AMX_INT8 AMX_BF16 OPENMP BLAS CUDA VULKAN KOMPUTE SYCL RPC OPENCL CCACHE BACKEND_DL CPU_ALL_VARIANTS CPU_REPACK LASX LSX RVV RV_ZFH XTHEADVECTOR VXE LLAMAFILE)
    set(GGML_${feature} OFF CACHE BOOL "Portable CPU baseline" FORCE)
endforeach()
# Bun's x64 release baseline is Nehalem (SSE4.2), not AVX. ARM uses the
# compiler's portable platform baseline, never the runner's -mcpu=native.
if(AGAV_VOICE_TARGET_PROCESSOR MATCHES "^(x86_64|AMD64|amd64)$")
    set(GGML_SSE42 ON CACHE BOOL "Bun-compatible x64 baseline" FORCE)
endif()
if(AGAV_VOICE_AVX2)
    foreach(feature AVX AVX2 FMA F16C)
        set(GGML_${feature} ON CACHE BOOL "Separately gated x64 helper" FORCE)
    endforeach()
endif()
set(GGML_ACCELERATE ${APPLE} CACHE BOOL "Apple CPU acceleration" FORCE)
set(GGML_METAL ${AGAV_VOICE_METAL} CACHE BOOL "Optional Metal" FORCE)
set(GGML_METAL_EMBED_LIBRARY ${AGAV_VOICE_METAL} CACHE BOOL "Embed Metal shaders" FORCE)
foreach(feature BUILD_TESTS BUILD_EXAMPLES BUILD_SERVER CURL SDL2 FFMPEG COREML OPENVINO)
    set(WHISPER_${feature} OFF CACHE BOOL "Library only" FORCE)
endforeach()
# Archive builds have fixed provenance, not a local Git checkout.
set(GGML_BUILD_NUMBER 0)
set(GGML_BUILD_COMMIT "v1.7.6")
FetchContent_Declare(whisper
    URL https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.7.6
    URL_HASH SHA256=166140e9a6d8a36f787a2bd77f8f44dd64874f12dd8359ff7c1f4f9acb86202e
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    PATCH_COMMAND ${CMAKE_COMMAND} -DSOURCE_DIR=<SOURCE_DIR> -P ${CMAKE_CURRENT_SOURCE_DIR}/patch-whisper.cmake)
FetchContent_Declare(miniaudio
    URL https://codeload.github.com/mackron/miniaudio/tar.gz/refs/tags/0.11.22
    URL_HASH SHA256=bcb07bfb27e6fa94d34da73ba2d5642d4940b208ec2a660dbf4e52e6b7cd492f
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    SOURCE_SUBDIR agav-do-not-build-upstream-examples)
FetchContent_MakeAvailable(whisper miniaudio)
if(TARGET ggml-metal)
    # v1.7.6 logs Common GPU families via MTLGPUFamilyCommon1, deprecated by
    # the macOS 27 SDK. Preserve the older deployment-compatible enum; limit
    # the diagnostic exception to the vendored Metal implementation only.
    # Upstream compiles ggml-metal.m as C (Clang infers ObjC from .m).
    target_compile_options(ggml-metal PRIVATE "$<$<COMPILE_LANGUAGE:C>:-Wno-deprecated-declarations>")
endif()
add_library(agav_audio STATIC audio.c)
target_include_directories(agav_audio PUBLIC ${miniaudio_SOURCE_DIR})
target_compile_definitions(agav_audio PUBLIC MA_NO_FLAC MA_NO_MP3 MA_NO_ENCODING MA_NO_RESOURCE_MANAGER MA_NO_NODE_GRAPH MA_NO_ENGINE MA_NO_GENERATION)
target_link_libraries(agav_audio PUBLIC Threads::Threads ${CMAKE_DL_LIBS})
if(APPLE)
    target_link_libraries(agav_audio PUBLIC "-framework CoreFoundation" "-framework CoreAudio" "-framework AudioToolbox")
elseif(UNIX)
    target_link_libraries(agav_audio PUBLIC m)
elseif(WIN32)
    target_link_libraries(agav_audio PUBLIC ole32 uuid winmm psapi)
endif()
add_executable(agav-voice main.cpp)
target_link_libraries(agav-voice PRIVATE whisper agav_audio)
if(WIN32)
    target_link_libraries(agav-voice PRIVATE shell32)
endif()
target_compile_definitions(agav-voice PRIVATE AGAV_VOICE_USE_METAL=$<BOOL:${AGAV_VOICE_METAL}>)
if(APPLE)
    target_link_options(agav-voice PRIVATE "LINKER:-sectcreate,__TEXT,__info_plist,${CMAKE_CURRENT_SOURCE_DIR}/Info.plist")
endif()
if(MSVC)
    target_compile_options(agav-voice PRIVATE /W4 /utf-8)
else()
    target_compile_options(agav-voice PRIVATE -Wall -Wextra -Wpedantic)
endif()
install(TARGETS agav-voice RUNTIME DESTINATION bin)
install(FILES LICENSE.whisper.cpp LICENSE.miniaudio DESTINATION share/agav-voice)
if(BUILD_TESTING)
    add_executable(voice-cpu-features-test test/cpu-features.cpp)
    add_test(NAME voice-cpu-features COMMAND voice-cpu-features-test)
    add_test(NAME voice-protocol-version COMMAND agav-voice --protocol-version)
    set_tests_properties(voice-protocol-version PROPERTIES PASS_REGULAR_EXPRESSION "1" TIMEOUT 10)
    add_test(NAME voice-self-test COMMAND agav-voice --self-test)
    set_tests_properties(voice-self-test PROPERTIES TIMEOUT 30)
    find_package(Python3 COMPONENTS Interpreter)
    if(Python3_Interpreter_FOUND)
        add_test(NAME voice-protocol COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test/protocol.py $<TARGET_FILE:agav-voice>)
    endif()
endif()
