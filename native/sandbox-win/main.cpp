// agav-sandbox: Windows command sandbox helper for Agav.
//
// Runs one command under a WRITE_RESTRICTED token inside a kill-on-close Job
// Object. Reads are unchanged (the normal user check); every WRITE must also
// pass a second access check against the restricting SIDs {Agav sandbox SID,
// Everyone, logon SID}. Agav grants the sandbox SID modify rights on the
// workspace and sandbox temp directory, and denies it write/delete on
// protected workspace configuration. Locations that grant Everyone write
// access remain writable; that is a documented limitation of this backend.
// Network access is NOT confined; Agav refuses sandboxNetwork=deny before
// launching this helper.
//
// Usage:
//   agav-sandbox --version
//   agav-sandbox exec <policy-file>
//   agav-sandbox revoke <path>
//
// Policy file: UTF-8 lines "<key> <hex(UTF-8 value)>". Keys:
//   cwd, cmdline, app (optional; empty = search), grant, deny-file, deny-dir,
//   deny-delete. Hex encoding avoids every quoting/escaping ambiguity.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr const wchar_t* kVersion = L"agav-sandbox 1";
constexpr int kHelperError = 126;
// Resource-manager SID used only in ACEs Agav adds. No account carries it.
constexpr const wchar_t* kSandboxSid = L"S-1-9-3816436473-1446516585-2387212101-1016720224";

// "Modify" without FILE_DELETE_CHILD: deleting or renaming an entry requires
// DELETE on that entry itself, so per-entry denies cannot be bypassed via the
// parent directory.
constexpr DWORD kGrantMask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
constexpr DWORD kDenyFileMask = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
                                FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER;
constexpr DWORD kDenyDirMask = kDenyFileMask | FILE_DELETE_CHILD;
constexpr DWORD kDenyDeleteMask = DELETE;
constexpr BYTE kInheritFlags = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
constexpr BYTE kInheritMaskAll = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | NO_PROPAGATE_INHERIT_ACE | INHERIT_ONLY_ACE;

void writeStderr(const std::wstring& text) {
  int bytes = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return;
  std::string utf8(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), utf8.data(), bytes, nullptr, nullptr);
  DWORD written = 0;
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (err && err != INVALID_HANDLE_VALUE) WriteFile(err, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
}

std::wstring errorText(DWORD code) {
  wchar_t* buffer = nullptr;
  DWORD length = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                                nullptr, code, 0, reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
  std::wstring text = length && buffer ? std::wstring(buffer, length) : L"unknown error";
  if (buffer) LocalFree(buffer);
  while (!text.empty() && (text.back() == L'\r' || text.back() == L'\n' || text.back() == L' ')) text.pop_back();
  return text;
}

[[noreturn]] void fail(const std::wstring& what, DWORD code) {
  writeStderr(L"agav-sandbox: " + what + L" (error " + std::to_wstring(code) + L": " + errorText(code) + L")\n");
  ExitProcess(kHelperError);
}

[[noreturn]] void failMessage(const std::wstring& what) {
  writeStderr(L"agav-sandbox: " + what + L"\n");
  ExitProcess(kHelperError);
}

struct LocalGuard {
  HLOCAL value = nullptr;
  ~LocalGuard() { if (value) LocalFree(value); }
};

struct HandleGuard {
  HANDLE value = nullptr;
  ~HandleGuard() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};

int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

std::wstring decodeHexUtf8(const std::string& hex) {
  if (hex.size() % 2 != 0) failMessage(L"invalid policy value encoding");
  std::string bytes;
  bytes.reserve(hex.size() / 2);
  for (size_t i = 0; i < hex.size(); i += 2) {
    int high = hexValue(hex[i]);
    int low = hexValue(hex[i + 1]);
    if (high < 0 || low < 0) failMessage(L"invalid policy value encoding");
    bytes.push_back(static_cast<char>((high << 4) | low));
  }
  if (bytes.empty()) return std::wstring();
  int chars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
  if (chars <= 0) failMessage(L"policy value is not valid UTF-8");
  std::wstring wide(static_cast<size_t>(chars), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()), wide.data(), chars);
  if (wide.find(L'\0') != std::wstring::npos) failMessage(L"policy value contains NUL");
  return wide;
}

struct Policy {
  std::wstring cwd;
  std::wstring app;
  std::wstring cmdline;
  bool hasCmdline = false;
  std::vector<std::wstring> grants;
  std::vector<std::wstring> denyFiles;
  std::vector<std::wstring> denyDirs;
  std::vector<std::wstring> denyDeletes;
};

Policy readPolicy(const std::wstring& path) {
  HandleGuard file{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  if (file.value == INVALID_HANDLE_VALUE) fail(L"cannot open policy file", GetLastError());
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.value, &size)) fail(L"cannot size policy file", GetLastError());
  if (size.QuadPart <= 0 || size.QuadPart > 16 * 1024 * 1024) failMessage(L"policy file is empty or too large");
  std::string text(static_cast<size_t>(size.QuadPart), '\0');
  DWORD read = 0;
  if (!ReadFile(file.value, text.data(), static_cast<DWORD>(text.size()), &read, nullptr) || read != text.size()) {
    fail(L"cannot read policy file", GetLastError());
  }
  Policy policy;
  size_t start = 0;
  while (start < text.size()) {
    size_t end = text.find('\n', start);
    if (end == std::string::npos) end = text.size();
    std::string line = text.substr(start, end - start);
    start = end + 1;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    size_t space = line.find(' ');
    if (space == std::string::npos) failMessage(L"malformed policy line");
    std::string key = line.substr(0, space);
    std::wstring value = decodeHexUtf8(line.substr(space + 1));
    if (key == "cwd") policy.cwd = value;
    else if (key == "app") policy.app = value;
    else if (key == "cmdline") { policy.cmdline = value; policy.hasCmdline = true; }
    else if (key == "grant") policy.grants.push_back(value);
    else if (key == "deny-file") policy.denyFiles.push_back(value);
    else if (key == "deny-dir") policy.denyDirs.push_back(value);
    else if (key == "deny-delete") policy.denyDeletes.push_back(value);
    else failMessage(L"unknown policy key");
  }
  if (policy.cwd.empty() || !policy.hasCmdline || policy.cmdline.empty() || policy.grants.empty()) {
    failMessage(L"policy requires cwd, cmdline and at least one grant");
  }
  return policy;
}

PSID sandboxSid() {
  static PSID sid = nullptr;
  if (!sid && !ConvertStringSidToSidW(kSandboxSid, &sid)) fail(L"cannot create sandbox SID", GetLastError());
  return sid;
}

bool isDriveRoot(const std::wstring& path) {
  std::wstring p = path;
  while (p.size() > 3 && (p.back() == L'\\' || p.back() == L'/')) p.pop_back();
  return (p.size() <= 3 && p.size() >= 2 && p[1] == L':') || p == L"\\" || p == L"/";
}

bool hasExplicitAce(PACL acl, PSID sid, BYTE type, DWORD mask, BYTE inheritFlags) {
  if (!acl) return false;
  ACL_SIZE_INFORMATION info{};
  if (!GetAclInformation(acl, &info, sizeof(info), AclSizeInformation)) return false;
  for (DWORD i = 0; i < info.AceCount; ++i) {
    void* raw = nullptr;
    if (!GetAce(acl, i, &raw)) continue;
    auto* header = static_cast<ACE_HEADER*>(raw);
    if (header->AceType != type || (header->AceFlags & INHERITED_ACE)) continue;
    if ((header->AceFlags & kInheritMaskAll) != inheritFlags) continue;
    // ACCESS_ALLOWED_ACE and ACCESS_DENIED_ACE share the same layout.
    auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
    if ((ace->Mask & mask) != mask) continue;
    if (EqualSid(reinterpret_cast<PSID>(&ace->SidStart), sid)) return true;
  }
  return false;
}

// Adds one explicit ACE for the sandbox SID, preserving every existing entry.
// Named (path-based) updates propagate inheritable ACEs to existing children.
void applyAce(const std::wstring& path, ACCESS_MODE mode, DWORD mask, bool inherit) {
  PSID sid = sandboxSid();
  PACL dacl = nullptr;
  LocalGuard descriptor;
  DWORD rc = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                   nullptr, nullptr, &dacl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
  if (rc != ERROR_SUCCESS) fail(L"cannot read permissions for " + path, rc);
  // A NULL DACL grants everyone full access. Replacing it with a single entry
  // would lock everyone else out, so refuse rather than alter it.
  if (!dacl) failMessage(L"refusing to modify a NULL DACL: " + path);
  BYTE aceType = mode == DENY_ACCESS ? ACCESS_DENIED_ACE_TYPE : ACCESS_ALLOWED_ACE_TYPE;
  BYTE flags = inherit ? kInheritFlags : 0;
  if (hasExplicitAce(dacl, sid, aceType, mask, flags)) return;
  EXPLICIT_ACCESS_W entry{};
  entry.grfAccessPermissions = mask;
  entry.grfAccessMode = mode;
  entry.grfInheritance = inherit ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  PACL updated = nullptr;
  rc = SetEntriesInAclW(1, &entry, dacl, &updated);
  if (rc != ERROR_SUCCESS) fail(L"cannot build permissions for " + path, rc);
  LocalGuard updatedGuard{updated};
  rc = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                             nullptr, nullptr, updated, nullptr);
  if (rc != ERROR_SUCCESS) fail(L"cannot update permissions for " + path, rc);
}

// Adds a non-inheritable deny ACE to a reparse point itself (not its target),
// so the link cannot be deleted or replaced.
void applyAceToLink(const std::wstring& path, DWORD mask) {
  HandleGuard handle{CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                 nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr)};
  if (handle.value == INVALID_HANDLE_VALUE) fail(L"cannot open link " + path, GetLastError());
  PSID sid = sandboxSid();
  PACL dacl = nullptr;
  LocalGuard descriptor;
  DWORD rc = GetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &dacl, nullptr,
                             reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
  if (rc != ERROR_SUCCESS) fail(L"cannot read link permissions for " + path, rc);
  if (!dacl) failMessage(L"refusing to modify a NULL DACL: " + path);
  if (hasExplicitAce(dacl, sid, ACCESS_DENIED_ACE_TYPE, mask, 0)) return;
  EXPLICIT_ACCESS_W entry{};
  entry.grfAccessPermissions = mask;
  entry.grfAccessMode = DENY_ACCESS;
  entry.grfInheritance = NO_INHERITANCE;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  PACL updated = nullptr;
  rc = SetEntriesInAclW(1, &entry, dacl, &updated);
  if (rc != ERROR_SUCCESS) fail(L"cannot build link permissions for " + path, rc);
  LocalGuard updatedGuard{updated};
  rc = SetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, updated, nullptr);
  if (rc != ERROR_SUCCESS) fail(L"cannot update link permissions for " + path, rc);
}

void grantRoot(const std::wstring& path) {
  if (isDriveRoot(path)) failMessage(L"refusing to grant sandbox write access to a drive root: " + path);
  DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) fail(L"writable root does not exist: " + path, GetLastError());
  if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) failMessage(L"writable root is not a directory: " + path);
  if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) failMessage(L"writable root must not be a link or junction: " + path);
  applyAce(path, GRANT_ACCESS, kGrantMask, true);
}

// Protected paths that do not exist cannot carry an ACE; they are skipped.
void protect(const std::wstring& path, DWORD mask, bool directory) {
  DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    DWORD code = GetLastError();
    if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) return;
    fail(L"cannot inspect protected path " + path, code);
  }
  if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) { applyAceToLink(path, mask); return; }
  applyAce(path, DENY_ACCESS, mask, directory && (attributes & FILE_ATTRIBUTE_DIRECTORY));
}

HANDLE createRestrictedToken() {
  HandleGuard self;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &self.value)) {
    fail(L"cannot open process token", GetLastError());
  }
  DWORD length = 0;
  GetTokenInformation(self.value, TokenGroups, nullptr, 0, &length);
  std::vector<BYTE> groupsBuffer(length ? length : 1);
  if (!GetTokenInformation(self.value, TokenGroups, groupsBuffer.data(), length, &length)) fail(L"cannot read token groups", GetLastError());
  auto* groups = reinterpret_cast<TOKEN_GROUPS*>(groupsBuffer.data());
  PSID logonSid = nullptr;
  for (DWORD i = 0; i < groups->GroupCount; ++i) {
    if ((groups->Groups[i].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) { logonSid = groups->Groups[i].Sid; break; }
  }

  length = 0;
  GetTokenInformation(self.value, TokenUser, nullptr, 0, &length);
  std::vector<BYTE> userBuffer(length ? length : 1);
  if (!GetTokenInformation(self.value, TokenUser, userBuffer.data(), length, &length)) fail(L"cannot read token user", GetLastError());
  PSID userSid = reinterpret_cast<TOKEN_USER*>(userBuffer.data())->User.Sid;

  BYTE everyoneBuffer[SECURITY_MAX_SID_SIZE];
  DWORD everyoneSize = sizeof(everyoneBuffer);
  if (!CreateWellKnownSid(WinWorldSid, nullptr, everyoneBuffer, &everyoneSize)) fail(L"cannot create Everyone SID", GetLastError());
  BYTE systemBuffer[SECURITY_MAX_SID_SIZE];
  DWORD systemSize = sizeof(systemBuffer);
  if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, systemBuffer, &systemSize)) fail(L"cannot create SYSTEM SID", GetLastError());

  SID_AND_ATTRIBUTES restricting[3]{};
  DWORD restrictingCount = 0;
  restricting[restrictingCount++].Sid = sandboxSid();
  restricting[restrictingCount++].Sid = everyoneBuffer;
  if (logonSid) restricting[restrictingCount++].Sid = logonSid;

  HANDLE restricted = nullptr;
  if (!CreateRestrictedToken(self.value, DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED, 0, nullptr, 0, nullptr,
                             restrictingCount, restricting, &restricted)) {
    fail(L"cannot create restricted token", GetLastError());
  }

  // Objects the child creates without inheritable ACEs (pipes, events, its own
  // process) use the default DACL. Include the restricting SIDs so the child
  // can still open its own objects for write under the second access check.
  EXPLICIT_ACCESS_W entries[4]{};
  PSID principals[4] = {userSid, systemBuffer, sandboxSid(), logonSid};
  DWORD entryCount = 0;
  for (PSID principal : principals) {
    if (!principal) continue;
    EXPLICIT_ACCESS_W& entry = entries[entryCount++];
    entry.grfAccessPermissions = GENERIC_ALL;
    entry.grfAccessMode = SET_ACCESS;
    entry.grfInheritance = NO_INHERITANCE;
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entry.Trustee.ptstrName = static_cast<LPWSTR>(principal);
  }
  PACL defaultDacl = nullptr;
  DWORD rc = SetEntriesInAclW(entryCount, entries, nullptr, &defaultDacl);
  if (rc != ERROR_SUCCESS) { CloseHandle(restricted); fail(L"cannot build default DACL", rc); }
  LocalGuard defaultGuard{defaultDacl};
  TOKEN_DEFAULT_DACL tokenDacl{defaultDacl};
  if (!SetTokenInformation(restricted, TokenDefaultDacl, &tokenDacl, sizeof(tokenDacl))) {
    DWORD code = GetLastError();
    CloseHandle(restricted);
    fail(L"cannot set default DACL", code);
  }
  return restricted;
}

int runExec(const std::wstring& policyPath) {
  Policy policy = readPolicy(policyPath);
  // Grant first: propagating the inheritable grant leaves explicit denies intact.
  for (const auto& root : policy.grants) grantRoot(root);
  for (const auto& path : policy.denyDeletes) protect(path, kDenyDeleteMask, false);
  for (const auto& path : policy.denyFiles) protect(path, kDenyFileMask, false);
  for (const auto& path : policy.denyDirs) protect(path, kDenyDirMask, true);

  HandleGuard token{createRestrictedToken()};

  HandleGuard job{CreateJobObjectW(nullptr, nullptr)};
  if (!job.value) fail(L"cannot create job object", GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    fail(L"cannot configure job object", GetLastError());
  }

  // Pass only the standard handles to the child.
  HandleGuard nulInput;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (!input || input == INVALID_HANDLE_VALUE) {
    SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    nulInput.value = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, 0, nullptr);
    input = nulInput.value;
  }
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
  std::vector<HANDLE> inherited;
  for (HANDLE handle : {input, output, error}) {
    if (!handle || handle == INVALID_HANDLE_VALUE) continue;
    if (std::find(inherited.begin(), inherited.end(), handle) != inherited.end()) continue;
    if (SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) inherited.push_back(handle);
  }

  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
  std::vector<BYTE> attributeBuffer(attributeSize ? attributeSize : 1);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeBuffer.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributeSize)) fail(L"cannot initialize process attributes", GetLastError());
  if (!inherited.empty() &&
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(),
                                 inherited.size() * sizeof(HANDLE), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    fail(L"cannot restrict inherited handles", GetLastError());
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input;
  startup.StartupInfo.hStdOutput = output;
  startup.StartupInfo.hStdError = error;
  startup.lpAttributeList = attributes;

  std::vector<wchar_t> commandLine(policy.cmdline.begin(), policy.cmdline.end());
  commandLine.push_back(L'\0');
  PROCESS_INFORMATION process{};
  BOOL created = CreateProcessAsUserW(token.value, policy.app.empty() ? nullptr : policy.app.c_str(), commandLine.data(),
                                      nullptr, nullptr, inherited.empty() ? FALSE : TRUE,
                                      CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, nullptr, policy.cwd.c_str(),
                                      &startup.StartupInfo, &process);
  DWORD createError = created ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(attributes);
  if (!created) fail(L"cannot start sandboxed process", createError);
  HandleGuard processHandle{process.hProcess};
  HandleGuard threadHandle{process.hThread};

  if (!AssignProcessToJobObject(job.value, process.hProcess)) {
    DWORD code = GetLastError();
    TerminateProcess(process.hProcess, kHelperError);
    fail(L"cannot assign sandboxed process to job object", code);
  }
  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    DWORD code = GetLastError();
    TerminateProcess(process.hProcess, kHelperError);
    fail(L"cannot resume sandboxed process", code);
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = kHelperError;
  if (!GetExitCodeProcess(process.hProcess, &exitCode)) exitCode = kHelperError;
  // Closing the last job handle terminates any remaining descendants.
  CloseHandle(job.value);
  job.value = nullptr;
  ExitProcess(exitCode);
}

// Removes every explicit ACE for the sandbox SID from one path.
int runRevoke(const std::wstring& path) {
  PSID sid = sandboxSid();
  PACL dacl = nullptr;
  LocalGuard descriptor;
  DWORD rc = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                   nullptr, nullptr, &dacl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value));
  if (rc == ERROR_FILE_NOT_FOUND || rc == ERROR_PATH_NOT_FOUND) return 0;
  if (rc != ERROR_SUCCESS) fail(L"cannot read permissions for " + path, rc);
  if (!dacl) return 0;
  ACL_SIZE_INFORMATION info{};
  if (!GetAclInformation(dacl, &info, sizeof(info), AclSizeInformation)) fail(L"cannot inspect permissions", GetLastError());
  DWORD size = static_cast<DWORD>(sizeof(ACL)) + info.AclBytesInUse;
  LocalGuard rebuilt{LocalAlloc(LPTR, size)};
  if (!rebuilt.value) fail(L"cannot allocate permissions", GetLastError());
  auto* updated = static_cast<PACL>(rebuilt.value);
  if (!InitializeAcl(updated, size, dacl->AclRevision)) fail(L"cannot initialize permissions", GetLastError());
  bool removed = false;
  for (DWORD i = 0; i < info.AceCount; ++i) {
    void* raw = nullptr;
    if (!GetAce(dacl, i, &raw)) fail(L"cannot read permission entry", GetLastError());
    auto* header = static_cast<ACE_HEADER*>(raw);
    bool ours = !(header->AceFlags & INHERITED_ACE) &&
                (header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE) &&
                EqualSid(reinterpret_cast<PSID>(&static_cast<ACCESS_ALLOWED_ACE*>(raw)->SidStart), sid);
    if (ours) { removed = true; continue; }
    if (!AddAce(updated, dacl->AclRevision, MAXDWORD, raw, header->AceSize)) fail(L"cannot copy permission entry", GetLastError());
  }
  if (!removed) return 0;
  rc = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                             nullptr, nullptr, updated, nullptr);
  if (rc != ERROR_SUCCESS) fail(L"cannot update permissions for " + path, rc);
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--version") {
    DWORD written = 0;
    const char* version = "agav-sandbox 1\n";
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), version, static_cast<DWORD>(strlen(version)), &written, nullptr);
    return 0;
  }
  if (argc == 3 && std::wstring(argv[1]) == L"exec") return runExec(argv[2]);
  if (argc == 3 && std::wstring(argv[1]) == L"revoke") return runRevoke(argv[2]);
  failMessage(std::wstring(L"usage: agav-sandbox --version | exec <policy-file> | revoke <path> (") + kVersion + L")");
}
