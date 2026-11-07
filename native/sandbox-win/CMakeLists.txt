cmake_minimum_required(VERSION 3.16)
project(agav_sandbox LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "agav-sandbox is a Windows-only helper.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(agav-sandbox main.cpp)
target_compile_definitions(agav-sandbox PRIVATE UNICODE _UNICODE _WIN32_WINNT=0x0A00)
target_link_libraries(agav-sandbox PRIVATE advapi32)

if(MSVC)
  target_compile_options(agav-sandbox PRIVATE /W4 /permissive- /utf-8)
else()
  target_link_options(agav-sandbox PRIVATE -municode -static)
endif()
