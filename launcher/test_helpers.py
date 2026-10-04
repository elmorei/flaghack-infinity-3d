"""Compile and test the actual portable parsing helpers from native.c (requires gcc)."""
from pathlib import Path
import subprocess
import tempfile
source = Path(__file__).with_name('native.c').read_text()
def section(start, end):
    return source[source.index(start):source.index(end)]
helpers = section('static BOOL validRepo', 'static void encodeRef') + section('static BOOL jsonString', '/* HTTPS downloads')
harness = r'''
#include <assert.h>
#include <wchar.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#define BOOL int
#define TRUE 1
#define FALSE 0
'''+helpers+r'''
int main(void) {
  assert(validRepo(L"elmorei/flaghack-infinity-3d"));
  assert(!validRepo(L"owner")); assert(!validRepo(L"/repo"));
  assert(!validRepo(L"owner/")); assert(!validRepo(L"owner/repo/other"));
  assert(!validRepo(L"owner/repo & command")); assert(!validRepo(L"owner/repo\\file"));
  wchar_t name[]=L"  owner/repo\t ";trim(name);assert(!wcscmp(name,L"owner/repo"));
  char out[128];
  assert(jsonString("{\"sha\":\"abcdef\",\"nested\":{\"sha\":\"wrong\"}}","sha",out,sizeof(out)));
  assert(!strcmp(out,"abcdef"));
  assert(jsonString("{\"nested\":{\"sha\":\"wrong\"},\"sha\":\"right\"}","sha",out,sizeof(out)));
  assert(!strcmp(out,"right"));
  assert(jsonString("{\"default_branch\":\"feat\\/survey-flags-prototype\"}","default_branch",out,sizeof(out)));
  assert(!strcmp(out,"feat/survey-flags-prototype"));
  assert(jsonString("{ \"sha\" : \"right\" }","sha",out,sizeof(out)));
  assert(!jsonString("{\"nested\":{\"sha\":\"wrong\"}}","sha",out,sizeof(out)));
  assert(!jsonString("{\"sha\":null}","sha",out,sizeof(out)));
  assert(!jsonString("{\"sha\":\"unterminated}","sha",out,sizeof(out)));
  assert(!jsonString("{\"sha\":\"long\"}","sha",out,3));
  puts("Native repository validation, trimming and JSON parser checks passed.");
}
'''
with tempfile.TemporaryDirectory() as temporary:
    path=Path(temporary);(path/'test.c').write_text(harness)
    subprocess.run(['gcc','-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',str(path/'test.c'),'-o',str(path/'test')],check=True)
    subprocess.run([str(path/'test')],check=True)
