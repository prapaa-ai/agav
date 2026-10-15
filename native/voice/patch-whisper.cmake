# Version-pinned source archives have no .git metadata. Avoid misleading Git
# errors while retaining upstream provenance probing for actual checkouts.
set(path "${SOURCE_DIR}/cmake/build-info.cmake")
file(READ "${path}" content)
string(REPLACE "if(Git_FOUND)\n    execute_process(" "if(Git_FOUND AND EXISTS \"\${CMAKE_CURRENT_SOURCE_DIR}/.git\")\n    execute_process(" content "${content}")
file(WRITE "${path}" "${content}")
