/* Vexillamania native Windows launcher. Ordinary C/Win32, with no embedded scripts. */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
// clang-format off
#include <winsock2.h>
#include <windows.h>
#include <winhttp.h>
#include <shellapi.h>
#include <shlobj.h>
#include <bcrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <stdint.h>
#include <string.h>
// clang-format on

#define CAP 4096
#define WM_LOG (WM_APP + 1)
#define WM_DONE (WM_APP + 2)
#define ID_LAUNCH 101
#define ID_STOP 102
#define NODE_VERSION L"v24.14.0"
static HWND window, repoField, branchField, hostField, logField, launchButton,
    stopButton;
static HANDLE job, worker;
static volatile LONG stopping;
static wchar_t root[CAP], repository[200], branch[240];
static BOOL hostGame;
static HINTERNET internet;
static wchar_t failure[512];

static void path(wchar_t *out, const wchar_t *a, const wchar_t *b) {
  swprintf(out, CAP, L"%ls\\%ls", a, b);
}
static void logLine(const wchar_t *text) {
  size_t n = wcslen(text) + 3;
  wchar_t *copy = (wchar_t *)malloc(n * sizeof(wchar_t));
  if (copy) {
    swprintf(copy, n, L"%ls\r\n", text);
    if (!PostMessageW(window, WM_LOG, 0, (LPARAM)copy))
      free(copy);
  }
}
static BOOL error(const wchar_t *text) {
  wcsncpy(failure, text, 511);
  failure[511] = 0;
  return FALSE;
}
static BOOL isStopped(void) {
  return InterlockedCompareExchange(&stopping, 0, 0) != 0;
}
static BOOL exists(const wchar_t *p) {
  return GetFileAttributesW(p) != INVALID_FILE_ATTRIBUTES;
}
static BOOL directory(const wchar_t *p) {
  return CreateDirectoryW(p, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}
static BOOL saveText(const wchar_t *p, const char *text) {
  HANDLE f = CreateFileW(p, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL, NULL);
  DWORD n;
  if (f == INVALID_HANDLE_VALUE)
    return FALSE;
  BOOL ok =
      WriteFile(f, text, (DWORD)strlen(text), &n, NULL) && n == strlen(text);
  CloseHandle(f);
  return ok;
}
static void removeTemporary(const wchar_t *p) {
  wchar_t names[CAP];
  size_t n = wcslen(p);
  if (n + 2 >= CAP)
    return;
  memcpy(names, p, (n + 1) * sizeof(wchar_t));
  names[n + 1] = 0;
  SHFILEOPSTRUCTW op = {0};
  op.wFunc = FO_DELETE;
  op.pFrom = names;
  op.fFlags = FOF_NO_UI | FOF_NOCONFIRMATION | FOF_SILENT;
  SHFileOperationW(&op);
}
static BOOL validRepo(const wchar_t *s) {
  int slashes = 0, part = 0;
  size_t n = wcslen(s);
  if (n < 3 || n > 150)
    return FALSE;
  for (size_t i = 0; i < n; i++) {
    wchar_t c = s[i];
    if (c == L'/') {
      if (!part || ++slashes > 1)
        return FALSE;
      part = 0;
    } else {
      if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
            (c >= L'0' && c <= L'9') || c == L'-' || c == L'_' || c == L'.'))
        return FALSE;
      part++;
    }
  }
  return slashes == 1 && part > 0;
}
static void trim(wchar_t *s) {
  size_t n = wcslen(s);
  while (n && (s[n - 1] == L' ' || s[n - 1] == L'\t'))
    s[--n] = 0;
  size_t i = 0;
  while (s[i] == L' ' || s[i] == L'\t')
    i++;
  if (i)
    memmove(s, s + i, (n - i + 1) * sizeof(wchar_t));
}
static void encodeRef(wchar_t *out, const wchar_t *ref) {
  char utf8[1024];
  WideCharToMultiByte(CP_UTF8, 0, ref, -1, utf8, sizeof(utf8), NULL, NULL);
  size_t j = 0;
  for (size_t i = 0; utf8[i] && j + 4 < CAP; i++) {
    unsigned char c = (unsigned char)utf8[i];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~')
      out[j++] = c;
    else {
      static const wchar_t hex[] = L"0123456789ABCDEF";
      out[j++] = L'%';
      out[j++] = hex[c >> 4];
      out[j++] = hex[c & 15];
    }
  }
  out[j] = 0;
}
/* Read only string fields at the root of a JSON object, skipping nested objects
 * and escaped strings. */
static BOOL jsonString(const char *json, const char *key, char *out,
                       size_t capacity) {
  int depth = 0;
  const char *p = json;
  while (*p) {
    if (*p == '{' || *p == '[') {
      depth++;
      p++;
      continue;
    }
    if (*p == '}' || *p == ']') {
      depth--;
      p++;
      continue;
    }
    if (*p != '"') {
      p++;
      continue;
    }
    const char *start = ++p;
    while (*p && (*p != '"' || (p > start && p[-1] == '\\'))) {
      if (*p == '\\' && p[1])
        p++;
      p++;
    }
    if (!*p)
      return FALSE;
    size_t n = (size_t)(p - start);
    p++;
    if (depth != 1 || n != strlen(key) || strncmp(start, key, n))
      continue;
    while (*p == ' ' || *p == '\r' || *p == '\n' || *p == '\t')
      p++;
    if (*p++ != ':')
      return FALSE;
    while (*p == ' ' || *p == '\r' || *p == '\n' || *p == '\t')
      p++;
    if (*p++ != '"')
      return FALSE;
    size_t j = 0;
    while (*p && *p != '"') {
      char c = *p++;
      if (c == '\\') {
        c = *p++;
        if (c != '"' && c != '\\' && c != '/')
          return FALSE;
      }
      if (j + 1 >= capacity)
        return FALSE;
      out[j++] = c;
    }
    out[j] = 0;
    return *p == '"';
  }
  return FALSE;
}
/* HTTPS downloads use WinHTTP's normal certificate verification; no TLS
 * exceptions. */
static BOOL download(const wchar_t *url, const wchar_t *destination,
                     char **memory) {
  URL_COMPONENTS parts = {0};
  wchar_t hostname[512], resource[CAP];
  parts.dwStructSize = sizeof(parts);
  parts.lpszHostName = hostname;
  parts.dwHostNameLength = 512;
  parts.lpszUrlPath = resource;
  parts.dwUrlPathLength = CAP;
  if (!WinHttpCrackUrl(url, 0, 0, &parts) ||
      parts.nScheme != INTERNET_SCHEME_HTTPS)
    return error(L"Invalid HTTPS download address.");
  HINTERNET connection = WinHttpConnect(internet, hostname, parts.nPort, 0);
  if (!connection)
    return error(L"Unable to connect to the download server.");
  HINTERNET request =
      WinHttpOpenRequest(connection, L"GET", resource, NULL, WINHTTP_NO_REFERER,
                         WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
  if (!request) {
    WinHttpCloseHandle(connection);
    return error(L"Unable to open the download request.");
  }
  WinHttpSetTimeouts(request, 15000, 15000, 30000, 30000);
  DWORD status = 0, length = sizeof(status);
  BOOL ok =
      WinHttpSendRequest(request, L"Accept: application/vnd.github+json\r\n",
                         (DWORD)-1L, NULL, 0, 0, 0) &&
      WinHttpReceiveResponse(request, NULL) &&
      WinHttpQueryHeaders(request,
                          WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                          WINHTTP_HEADER_NAME_BY_INDEX, &status, &length,
                          WINHTTP_NO_HEADER_INDEX);
  if (!ok || status != 200) {
    wchar_t msg[512];
    swprintf(
        msg, 512,
        L"Download failed (HTTP %lu). Check the repository, branch and "
        L"Internet connection. GitHub API rate limits may require waiting.",
        status);
    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    return error(msg);
  }
  HANDLE file = INVALID_HANDLE_VALUE;
  char *data = NULL;
  size_t used = 0;
  if (destination) {
    file = CreateFileW(destination, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                       FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE)
      ok = FALSE;
  }
  if (memory) {
    data = (char *)malloc(1);
    if (data)
      data[0] = 0;
    else
      ok = FALSE;
  }
  char buffer[32768];
  DWORD got = 0;
  while (ok && !isStopped()) {
    if (!WinHttpReadData(request, buffer, sizeof(buffer), &got)) {
      ok = FALSE;
      break;
    }
    if (!got)
      break;
    if (destination) {
      DWORD wrote = 0;
      if (!WriteFile(file, buffer, got, &wrote, NULL) || wrote != got) {
        ok = FALSE;
        break;
      }
    }
    if (memory) {
      if (used + got > 2 * 1024 * 1024) {
        ok = FALSE;
        break;
      }
      char *next = (char *)realloc(data, used + got + 1);
      if (!next) {
        ok = FALSE;
        break;
      }
      data = next;
      memcpy(data + used, buffer, got);
      used += got;
      data[used] = 0;
    }
  }
  if (isStopped())
    ok = FALSE;
  if (file != INVALID_HANDLE_VALUE)
    CloseHandle(file);
  WinHttpCloseHandle(request);
  WinHttpCloseHandle(connection);
  if (memory && ok)
    *memory = data;
  else
    free(data);
  return ok ? TRUE : error(L"Download was interrupted or could not be saved.");
}
static BOOL fileHash(const wchar_t *filename, char *hex) {
  BCRYPT_ALG_HANDLE alg = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  DWORD objLen = 0, received = 0;
  BYTE *object = NULL, digest[32];
  BOOL ok = FALSE;
  HANDLE f = CreateFileW(filename, GENERIC_READ, FILE_SHARE_READ, NULL,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (f == INVALID_HANDLE_VALUE)
    return FALSE;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0)
    goto done;
  if (BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, (BYTE *)&objLen,
                        sizeof(objLen), &received, 0) < 0)
    goto done;
  object = (BYTE *)malloc(objLen);
  if (!object || BCryptCreateHash(alg, &hash, object, objLen, NULL, 0, 0) < 0)
    goto done;
  BYTE buffer[32768];
  DWORD n;
  for (;;) {
    if (!ReadFile(f, buffer, sizeof(buffer), &n, NULL))
      goto done;
    if (!n)
      break;
    if (BCryptHashData(hash, buffer, n, 0) < 0)
      goto done;
  }
  if (BCryptFinishHash(hash, digest, 32, 0) < 0)
    goto done;
  for (int i = 0; i < 32; i++)
    sprintf(hex + i * 2, "%02x", digest[i]);
  hex[64] = 0;
  ok = TRUE;
done:
  if (hash)
    BCryptDestroyHash(hash);
  if (alg)
    BCryptCloseAlgorithmProvider(alg, 0);
  free(object);
  CloseHandle(f);
  return ok;
}
static void output(HANDLE pipe) {
  DWORD available = 0, n;
  char bytes[4096];
  wchar_t wide[4096];
  while (PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL) && available) {
    if (!ReadFile(pipe, bytes, sizeof(bytes) - 1, &n, NULL) || !n)
      break;
    bytes[n] = 0;
    int count = MultiByteToWideChar(CP_UTF8, 0, bytes, n, wide, 4095);
    if (!count)
      count = MultiByteToWideChar(CP_ACP, 0, bytes, n, wide, 4095);
    wide[count] = 0;
    logLine(wide);
  }
}
static BOOL spawn(const wchar_t *executable, const wchar_t *arguments,
                  const wchar_t *cwd, PROCESS_INFORMATION *proc,
                  HANDLE *reader) {
  SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE};
  HANDLE writePipe;
  if (!CreatePipe(reader, &writePipe, &sa, 0))
    return error(L"Could not create the build output pipe.");
  SetHandleInformation(*reader, HANDLE_FLAG_INHERIT, 0);
  wchar_t command[CAP * 2];
  swprintf(command, CAP * 2, L"\"%ls\" %ls", executable, arguments);
  STARTUPINFOW startup = {0};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdOutput = writePipe;
  startup.hStdError = writePipe;
  HANDLE input =
      CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  startup.hStdInput = input;
  /* Child code never inherits the launcher job handle or credentials. */
  BOOL ok = CreateProcessW(executable, command, NULL, NULL, TRUE,
                           CREATE_NO_WINDOW | CREATE_SUSPENDED, NULL, cwd,
                           &startup, proc);
  CloseHandle(writePipe);
  if (input != INVALID_HANDLE_VALUE)
    CloseHandle(input);
  if (!ok) {
    CloseHandle(*reader);
    return error(L"Could not start Node.js or the Windows archive extractor.");
  }
  if (!AssignProcessToJobObject(job, proc->hProcess)) {
    TerminateProcess(proc->hProcess, 1);
    CloseHandle(proc->hThread);
    CloseHandle(proc->hProcess);
    CloseHandle(*reader);
    return error(L"Could not manage the child process safely.");
  }
  ResumeThread(proc->hThread);
  CloseHandle(proc->hThread);
  return TRUE;
}
static BOOL run(const wchar_t *exe, const wchar_t *args, const wchar_t *cwd) {
  PROCESS_INFORMATION proc = {0};
  HANDLE reader;
  logLine(args);
  if (!spawn(exe, args, cwd, &proc, &reader))
    return FALSE;
  while (WaitForSingleObject(proc.hProcess, 40) == WAIT_TIMEOUT) {
    output(reader);
    if (isStopped())
      TerminateProcess(proc.hProcess, 1);
  }
  output(reader);
  DWORD code = 1;
  GetExitCodeProcess(proc.hProcess, &code);
  CloseHandle(reader);
  CloseHandle(proc.hProcess);
  return code == 0 && !isStopped()
             ? TRUE
             : error(L"The download extraction or game build failed. See the "
                     L"output above.");
}
static BOOL unpack(const wchar_t *zip, const wchar_t *where) {
  wchar_t system[CAP], tar[CAP], args[CAP * 2];
  GetSystemDirectoryW(system, CAP);
  path(tar, system, L"tar.exe");
  if (!exists(tar))
    return error(L"This launcher requires Windows 10/11's built-in tar.exe "
                 L"archive extractor.");
  swprintf(args, CAP * 2, L"-xf \"%ls\" -C \"%ls\"", zip, where);
  return directory(where) && run(tar, args, root);
}
static BOOL startServer(const wchar_t *node, const wchar_t *web) {
  WSADATA wsa;
  SOCKET s = INVALID_SOCKET;
  BOOL freePort = FALSE;
  int port = hostGame ? 8787 : 5173;
  if (WSAStartup(MAKEWORD(2, 2), &wsa))
    return error(L"Windows networking could not initialize.");
  s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((u_short)port);
  BOOL exclusive = TRUE;
  setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&exclusive,
             sizeof(exclusive));
  freePort = bind(s, (const struct sockaddr *)&address, sizeof(address)) == 0;
  if (s != INVALID_SOCKET)
    closesocket(s);
  WSACleanup();
  if (!freePort)
    return error(L"The game's port is already in use. Close your other "
                 L"game/host and try again.");
  wchar_t args[CAP];
  if (hostGame)
    wcscpy(args, L"dist-server/main.js --bind 127.0.0.1");
  else
    wcscpy(args, L"node_modules/vite/bin/vite.js preview --host 127.0.0.1 "
                 L"--port 5173 --strictPort");
  PROCESS_INFORMATION proc = {0};
  HANDLE reader;
  if (!spawn(node, args, web, &proc, &reader))
    return FALSE;
  BOOL ready = FALSE;
  wchar_t url[128];
  swprintf(url, 128, L"http://127.0.0.1:%d/", port);
  for (int i = 0; i < 100 && !isStopped(); i++) {
    output(reader);
    if (WaitForSingleObject(proc.hProcess, 0) != WAIT_TIMEOUT)
      break;
    HINTERNET connection =
        WinHttpConnect(internet, L"127.0.0.1", (INTERNET_PORT)port, 0);
    HINTERNET req = connection ? WinHttpOpenRequest(connection, L"GET", L"/",
                                                    NULL, NULL, NULL, 0)
                               : NULL;
    if (req) {
      WinHttpSetTimeouts(req, 500, 500, 500, 500);
      DWORD status = 0, size = sizeof(status);
      ready = WinHttpSendRequest(req, NULL, 0, NULL, 0, 0, 0) &&
              WinHttpReceiveResponse(req, NULL) &&
              WinHttpQueryHeaders(
                  req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                  NULL, &status, &size, NULL) &&
              status == 200;
      WinHttpCloseHandle(req);
    }
    if (connection)
      WinHttpCloseHandle(connection);
    if (ready)
      break;
    Sleep(200);
  }
  if (ready) {
    logLine(L"Game ready. Your browser is opening. Keep this launcher open "
            L"while playing.");
    ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
  } else {
    TerminateProcess(proc.hProcess, 1);
    error(L"The game server did not become ready.");
  }
  while (WaitForSingleObject(proc.hProcess, 40) == WAIT_TIMEOUT) {
    output(reader);
    if (isStopped())
      TerminateProcess(proc.hProcess, 0);
  }
  output(reader);
  DWORD code = 1;
  GetExitCodeProcess(proc.hProcess, &code);
  CloseHandle(reader);
  CloseHandle(proc.hProcess);
  return ready && (code == 0 || isStopped());
}
static BOOL launch(void) {
  wchar_t url[CAP], encoded[CAP], cacheName[256], cache[CAP], web[CAP],
      readyFile[CAP], nodeName[128], nodeDir[CAP], node[CAP], npm[CAP],
      args[CAP * 2], zip[CAP], stage[CAP];
  char *response = NULL, sha[64];
  wchar_t shaWide[41];
  BOOL ok = FALSE;
  if (!directory(root))
    return error(L"Cannot create the launcher cache directory.");
  internet = WinHttpOpen(L"Vexillamania-Launcher/2.0",
                         WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                         WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!internet)
    return error(L"Windows HTTPS networking could not initialize.");
  stage[0] = 0;
  if (!branch[0]) {
    swprintf(url, CAP, L"https://api.github.com/repos/%ls", repository);
    if (!download(url, NULL, &response))
      goto done;
    char name[1024];
    if (!jsonString(response, "default_branch", name, sizeof(name))) {
      error(L"GitHub did not return a default branch.");
      goto done;
    }
    MultiByteToWideChar(CP_UTF8, 0, name, -1, branch, 240);
    free(response);
    response = NULL;
  }
  encodeRef(encoded, branch);
  swprintf(url, CAP, L"https://api.github.com/repos/%ls/commits/%ls",
           repository, encoded);
  logLine(L"Checking the chosen GitHub repository and branch...");
  if (!download(url, NULL, &response))
    goto done;
  if (!jsonString(response, "sha", sha, sizeof(sha)) || strlen(sha) != 40) {
    error(L"GitHub did not return a valid commit.");
    goto done;
  }
  for (int i = 0; i < 40; i++)
    if (!((sha[i] >= '0' && sha[i] <= '9') ||
          (sha[i] >= 'a' && sha[i] <= 'f'))) {
      error(L"GitHub returned an invalid commit hash.");
      goto done;
    }
  MultiByteToWideChar(CP_UTF8, 0, sha, -1, shaWide, 41);
  free(response);
  response = NULL;
  swprintf(cacheName, 256, L"%ls_%ls", repository, shaWide);
  for (wchar_t *p = cacheName; *p; p++)
    if (*p == L'/')
      *p = L'_';
  path(cache, root, cacheName);
  path(web, cache, L"web");
  path(readyFile, cache, L".ready");
  /* A standard x64 portable Node build also runs on Windows ARM64 through its
   * x64 compatibility layer. */
  swprintf(nodeName, 128, L"node-%ls-win-x64", NODE_VERSION);
  path(nodeDir, root, nodeName);
  path(node, nodeDir, L"node.exe");
  path(npm, nodeDir, L"node_modules\\npm\\bin\\npm-cli.js");
  if (!exists(node) || !exists(npm)) {
    path(zip, root, L"node-download.zip");
    swprintf(url, CAP, L"https://nodejs.org/dist/%ls/%ls.zip", NODE_VERSION,
             nodeName);
    logLine(L"Downloading portable Node.js from nodejs.org...");
    if (!download(url, zip, NULL))
      goto done;
    swprintf(url, CAP, L"https://nodejs.org/dist/%ls/SHASUMS256.txt",
             NODE_VERSION);
    if (!download(url, NULL, &response))
      goto done;
    char hash[65], filename[200];
    sprintf(filename, "node-v24.14.0-win-x64.zip");
    char *match = strstr(response, filename), *line = match;
    if (line)
      while (line > response && line[-1] != '\n')
        line--;
    if (!line || match - line != 66 || !fileHash(zip, hash) ||
        strncmp(hash, line, 64)) {
      error(L"Node.js SHA-256 checksum verification failed.");
      goto done;
    }
    free(response);
    response = NULL;
    if (!unpack(zip, root))
      goto done;
    DeleteFileW(zip);
  }
  DWORD count = GetEnvironmentVariableW(L"PATH", NULL, 0);
  wchar_t *old = (wchar_t *)calloc(count + 1, sizeof(wchar_t)),
          *updated =
              (wchar_t *)calloc(count + wcslen(nodeDir) + 3, sizeof(wchar_t));
  if (!old || !updated) {
    free(old);
    free(updated);
    error(L"Not enough memory for the Node.js environment.");
    goto done;
  }
  GetEnvironmentVariableW(L"PATH", old, count + 1);
  swprintf(updated, count + wcslen(nodeDir) + 3, L"%ls;%ls", nodeDir, old);
  SetEnvironmentVariableW(L"PATH", updated);
  free(old);
  free(updated);
  if (!exists(readyFile)) {
    swprintf(stage, CAP, L"%ls\\download-%lu-%llu", root, GetCurrentProcessId(),
             (unsigned long long)GetTickCount64());
    if (!directory(stage)) {
      error(L"Cannot create the download staging directory.");
      goto done;
    }
    path(zip, stage, L"source.zip");
    swprintf(url, CAP, L"https://api.github.com/repos/%ls/zipball/%ls",
             repository, shaWide);
    logLine(L"Downloading the selected source revision...");
    if (!download(url, zip, NULL))
      goto done;
    wchar_t extracted[CAP], glob[CAP], source[CAP], sourceWeb[CAP], lock[CAP];
    path(extracted, stage, L"source");
    if (!unpack(zip, extracted))
      goto done;
    path(glob, extracted, L"*");
    WIN32_FIND_DATAW info;
    HANDLE search = FindFirstFileW(glob, &info);
    source[0] = 0;
    if (search != INVALID_HANDLE_VALUE) {
      do {
        if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
            wcscmp(info.cFileName, L".") && wcscmp(info.cFileName, L"..")) {
          path(source, extracted, info.cFileName);
          break;
        }
      } while (FindNextFileW(search, &info));
      FindClose(search);
    }
    path(sourceWeb, source, L"web");
    path(lock, sourceWeb, L"package-lock.json");
    if (!source[0] || !exists(lock)) {
      error(L"This repository has no supported Flaghack web project.");
      goto done;
    }
    logLine(L"Installing locked dependencies and building the game...");
    swprintf(args, CAP * 2, L"\"%ls\" ci --no-audit --no-fund", npm);
    if (!run(node, args, sourceWeb))
      goto done;
    swprintf(args, CAP * 2, L"\"%ls\" run build", npm);
    if (!run(node, args, sourceWeb))
      goto done;
    swprintf(args, CAP * 2, L"\"%ls\" run build:server", npm);
    if (!run(node, args, sourceWeb))
      goto done;
    wchar_t marker[CAP];
    path(marker, source, L".ready");
    if (!saveText(marker, sha)) {
      error(L"Could not mark the build ready.");
      goto done;
    }
    if (exists(cache)) {
      error(L"An unfinished cache already exists for this revision. Remove "
            L"that cache folder and retry.");
      goto done;
    }
    if (!MoveFileW(source, cache)) {
      error(L"Could not save the completed build. Another launcher may already "
            L"be building this revision.");
      goto done;
    }
  } else
    logLine(L"The latest revision is already downloaded and built.");
  if (!isStopped())
    ok = startServer(node, web);
done:
  free(response);
  if (stage[0])
    removeTemporary(stage);
  WinHttpCloseHandle(internet);
  internet = NULL;
  return ok;
}
static DWORD WINAPI threadMain(void *unused) {
  (void)unused;
  failure[0] = 0;
  BOOL ok = launch();
  if (!ok && !isStopped()) {
    logLine(failure[0] ? failure
                       : L"The launcher could not complete the operation.");
  } else
    logLine(L"Game stopped.");
  PostMessageW(window, WM_DONE, ok, 0);
  return 0;
}
static HWND control(const wchar_t *kind, const wchar_t *text, DWORD style,
                    int x, int y, int width, int height, int id) {
  HWND h =
      CreateWindowExW(wcscmp(kind, L"EDIT") == 0 ? WS_EX_CLIENTEDGE : 0, kind,
                      text, WS_CHILD | WS_VISIBLE | style, x, y, width, height,
                      window, (HMENU)(INT_PTR)id, GetModuleHandleW(NULL), NULL);
  SendMessageW(h, WM_SETFONT, (WPARAM)GetStockObject(DEFAULT_GUI_FONT), TRUE);
  return h;
}
static void config(BOOL save) {
  wchar_t filename[CAP];
  path(filename, root, L"native-launcher.txt");
  if (save) {
    char utf8[2048];
    wchar_t text[500];
    swprintf(text, 500, L"%ls\n%ls", repository, branch);
    WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, sizeof(utf8), NULL, NULL);
    saveText(filename, utf8);
  } else {
    HANDLE f = CreateFileW(filename, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE)
      return;
    char bytes[2048];
    DWORD n = 0;
    ReadFile(f, bytes, 2047, &n, NULL);
    bytes[n] = 0;
    CloseHandle(f);
    wchar_t text[2048];
    MultiByteToWideChar(CP_UTF8, 0, bytes, -1, text, 2048);
    wchar_t *end = wcschr(text, L'\n');
    if (end) {
      *end++ = 0;
      if (validRepo(text) && wcslen(end) < 240) {
        SetWindowTextW(repoField, text);
        SetWindowTextW(branchField, end);
      }
    }
  }
}
static LRESULT CALLBACK procedure(HWND hwnd, UINT message, WPARAM wp,
                                  LPARAM lp) {
  if (message == WM_CREATE) {
    window = hwnd;
    control(L"STATIC", L"Vexillamania 3D — Windows launcher", 0, 18, 14, 610,
            26, 0);
    control(L"STATIC", L"GitHub repository (owner/repository or URL)", 0, 18,
            46, 610, 20, 0);
    repoField = control(L"EDIT", L"elmorei/flaghack-infinity-3d",
                        ES_AUTOHSCROLL | WS_TABSTOP, 18, 68, 610, 26, 0);
    SendMessageW(repoField, EM_SETLIMITTEXT, 190, 0);
    control(L"STATIC", L"Branch (leave blank for the repository default)", 0,
            18, 104, 610, 20, 0);
    branchField = control(L"EDIT", L"iteration", ES_AUTOHSCROLL | WS_TABSTOP,
                          18, 126, 610, 26, 0);
    SendMessageW(branchField, EM_SETLIMITTEXT, 230, 0);
    hostField = control(
        L"BUTTON", L"Run a local multiplayer host (password appears below)",
        BS_AUTOCHECKBOX | WS_TABSTOP, 18, 164, 610, 24, 0);
    launchButton =
        control(L"BUTTON", L"Check for updates and launch",
                BS_DEFPUSHBUTTON | WS_TABSTOP, 18, 199, 280, 34, ID_LAUNCH);
    stopButton = control(L"BUTTON", L"Stop game", WS_TABSTOP, 310, 199, 120, 34,
                         ID_STOP);
    EnableWindow(stopButton, FALSE);
    logField =
        control(L"EDIT",
                L"Choose a repository and branch, then launch.\r\nDownloads "
                L"and build progress will appear here.\r\n",
                ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL, 18,
                246, 610, 244, 0);
    SendMessageW(logField, EM_SETLIMITTEXT, 400000, 0);
    wchar_t local[CAP];
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL,
                                   SHGFP_TYPE_CURRENT, local))) {
      path(root, local, L"VexillamaniaLauncher");
      directory(root);
      config(FALSE);
    } else
      wcscpy(root, L".");
    return 0;
  }
  if (message == WM_COMMAND && LOWORD(wp) == ID_LAUNCH) {
    GetWindowTextW(repoField, repository, 200);
    GetWindowTextW(branchField, branch, 240);
    trim(repository);
    trim(branch);
    const wchar_t *prefix = L"https://github.com/";
    if (!_wcsnicmp(repository, prefix, wcslen(prefix)))
      memmove(repository, repository + wcslen(prefix),
              (wcslen(repository) - wcslen(prefix) + 1) * sizeof(wchar_t));
    size_t n = wcslen(repository);
    while (n && repository[n - 1] == L'/')
      repository[--n] = 0;
    if (n > 4 && !wcscmp(repository + n - 4, L".git"))
      repository[n - 4] = 0;
    if (!validRepo(repository)) {
      MessageBoxW(
          hwnd,
          L"Enter a public GitHub repository as owner/repository or its URL.",
          L"Repository required", MB_OK | MB_ICONINFORMATION);
      return 0;
    }
    if (worker)
      return 0;
    config(TRUE);
    hostGame = SendMessageW(hostField, BM_GETCHECK, 0, 0) == BST_CHECKED;
    InterlockedExchange(&stopping, 0);
    job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit = {0};
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                         &limit, sizeof(limit))) {
      if (job)
        CloseHandle(job);
      job = NULL;
      MessageBoxW(hwnd, L"Windows could not create the process group.",
                  L"Launch failed", MB_OK | MB_ICONERROR);
      return 0;
    }
    EnableWindow(launchButton, FALSE);
    EnableWindow(repoField, FALSE);
    EnableWindow(branchField, FALSE);
    EnableWindow(hostField, FALSE);
    EnableWindow(stopButton, TRUE);
    SetWindowTextW(logField, L"");
    worker = CreateThread(NULL, 0, threadMain, NULL, 0, NULL);
    if (!worker) {
      CloseHandle(job);
      job = NULL;
      PostMessageW(hwnd, WM_DONE, FALSE, 0);
    }
    return 0;
  }
  if (message == WM_COMMAND && LOWORD(wp) == ID_STOP) {
    InterlockedExchange(&stopping, 1);
    if (job)
      TerminateJobObject(job, 0);
    logLine(L"Stopping...");
    return 0;
  }
  if (message == WM_LOG) {
    wchar_t *text = (wchar_t *)lp;
    int len = GetWindowTextLengthW(logField);
    if (len > 300000)
      SetWindowTextW(logField, L"Earlier output cleared.\r\n");
    SendMessageW(logField, EM_SETSEL, (WPARAM)-1, (LPARAM)-1);
    SendMessageW(logField, EM_REPLACESEL, FALSE, (LPARAM)text);
    free(text);
    return 0;
  }
  if (message == WM_DONE) {
    if (worker) {
      CloseHandle(worker);
      worker = NULL;
    }
    if (job) {
      CloseHandle(job);
      job = NULL;
    }
    EnableWindow(launchButton, TRUE);
    EnableWindow(repoField, TRUE);
    EnableWindow(branchField, TRUE);
    EnableWindow(hostField, TRUE);
    EnableWindow(stopButton, FALSE);
    return 0;
  }
  if (message == WM_CLOSE) {
    InterlockedExchange(&stopping, 1);
    if (job)
      TerminateJobObject(job, 0);
    DestroyWindow(hwnd);
    return 0;
  }
  if (message == WM_DESTROY) {
    if (job) {
      CloseHandle(job);
      job = NULL;
    }
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(hwnd, message, wp, lp);
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command,
                    int show) {
  (void)previous;
  (void)command;
  WNDCLASSW cls = {0};
  cls.lpfnWndProc = procedure;
  cls.hInstance = instance;
  cls.lpszClassName = L"VexillamaniaNativeLauncher";
  cls.hCursor = LoadCursorW(NULL, IDC_ARROW);
  cls.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
  if (!RegisterClassW(&cls))
    return 1;
  HWND hwnd = CreateWindowExW(
      0, cls.lpszClassName, L"Vexillamania 3D Launcher",
      WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, CW_USEDEFAULT,
      CW_USEDEFAULT, 664, 545, NULL, NULL, instance, NULL);
  if (!hwnd)
    return 1;
  ShowWindow(hwnd, show);
  UpdateWindow(hwnd);
  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    if (!IsDialogMessageW(hwnd, &msg)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
  }
  return 0;
}
