"""Advance one approved iteration desktop feed; never move tags or clobber payloads.

Only the job-scoped GITHUB_TOKEN is used. The approval JSON must be committed
with verified immutable build IDs/checksums before the exact-message push.
No release creation, tag mutation, stable feed mutation, or generic --clobber.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = 'elmorei/flaghack-infinity-3d'
TAG = 'desktop-iteration'
RELEASE_ID = 409874213
TAG_SOURCE = '8909d36160d1c381a669b5761c70fc7a03dbbce3'
PREVIOUS_VERSION = '0.1.2-iteration.1'
VERSION = '0.1.3-iteration.1'
TITLE = f'Iteration desktop {VERSION}'
MARKER = 'Publish verified iteration desktop 0.1.3-iteration.1 [release:20261102]'
INSTALLER = f'Flaghack-Setup-{VERSION}-x64.exe'
MANIFEST = 'iteration.yml'
NAMES = (INSTALLER, INSTALLER + '.blockmap', MANIFEST)
PREVIOUS_BODY_SHA256 = 'f5fbdb758417a3e4dd5b4b3809aa1844d90d74843bc8436347453da670b71de5'
PREVIOUS_ASSETS = {
    f'Flaghack-Setup-{PREVIOUS_VERSION}-x64.exe': {
        'id': 632542815, 'size': 121672452,
        'sha256': '23fb7bb0215c8ed58e3d1533113cc03ccbcb3c3ddb3afde79544f69601ca9618',
    },
    f'Flaghack-Setup-{PREVIOUS_VERSION}-x64.exe.blockmap': {
        'id': 632543135, 'size': 128358,
        'sha256': '3e6fdb2baa0873c75cfeca07db99e78b20fbab0854eae88767da68419a0e69e5',
    },
    MANIFEST: {
        'id': 632543390, 'size': 389,
        'sha256': 'f650bb1eb58bcf3e4f1d67967bfcc8d2608cdf3fa69c7f24d06b5d43f116ca89',
    },
}
DEFAULT_APPROVAL = Path(__file__).resolve().parents[1] / 'iteration-desktop-approval.json'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path, algorithm):
    with path.open('rb') as source:
        return hashlib.file_digest(source, algorithm)


def file_spec(path):
    return {'size': path.stat().st_size,
            'sha256': digest(path, 'sha256').hexdigest(),
            'sha512': base64.b64encode(digest(path, 'sha512').digest()).decode('ascii')}


def check_file(path, expected):
    require(path.stat().st_size == expected['size'], f'Wrong size: {path.name}')
    require(digest(path, 'sha256').hexdigest() == expected['sha256'], f'Wrong SHA-256: {path.name}')
    if 'sha512' in expected:
        require(base64.b64encode(digest(path, 'sha512').digest()).decode('ascii') == expected['sha512'],
                f'Wrong SHA-512: {path.name}')


def load_approval(path):
    # No placeholder values or runtime "latest artifact" lookup is allowed.
    approval = json.loads(path.read_text(encoding='utf-8'))
    require(set(approval) == {'schema', 'repository', 'version', 'source', 'run_id', 'run_attempt',
                             'workflow_id', 'artifact_id', 'artifact_name', 'zip', 'assets',
                             'launcher_tests', 'game_tests'}, 'Unexpected approval fields')
    require(approval['schema'] == 1 and approval['repository'] == REPOSITORY and
            approval['version'] == VERSION, 'Approval is for another publication')
    require(re.fullmatch(r'[a-f0-9]{40}', approval['source']) is not None and
            approval['source'] != TAG_SOURCE, 'Approval must identify the new source commit')
    for name in ('run_id', 'run_attempt', 'workflow_id', 'artifact_id', 'launcher_tests', 'game_tests'):
        require(type(approval[name]) is int and approval[name] > 0, f'Missing verified {name}')
    require(approval['artifact_name'] == f'flaghack-windows-iteration-{VERSION}', 'Wrong artifact name')
    require(set(approval['assets']) == set(NAMES), 'Approval must contain the exact three outputs')
    for name, spec in [('ZIP', approval['zip']), *approval['assets'].items()]:
        require(set(spec) == {'size', 'sha256', 'sha512'}, f'Incomplete checksums for {name}')
        require(type(spec['size']) is int and 0 < spec['size'] <= 1024 ** 3, f'Invalid size for {name}')
        require(re.fullmatch('[a-f0-9]{64}', spec['sha256']) is not None, f'Invalid SHA-256 for {name}')
        require(re.fullmatch('[A-Za-z0-9+/]{86}==', spec['sha512']) is not None and
                len(base64.b64decode(spec['sha512'], validate=True)) == 64, f'Invalid SHA-512 for {name}')
    return approval


def notes(approval):
    return f'''Windows x64 iteration build {VERSION}.

Source commit: {approval['source']}
Verified build: https://github.com/{REPOSITORY}/actions/runs/{approval['run_id']}
Immutable Actions artifact: {approval['artifact_id']}

The Windows build passed {approval['launcher_tests']:,} launcher tests and {approval['game_tests']:,} game tests.
The installer, blockmap, and iteration update manifest are the original verified
Windows build outputs. Game content follows the selected main or iteration branch;
launcher-runtime updates remain separate and require explicit player actions.

This installer is unsigned. Actual Windows installation and gameplay have not
been manually verified. This release updates the iteration binary feed only.
Previous versioned installers and blockmaps remain available.

The existing {TAG} channel tag remains at {TAG_SOURCE};
the new installer source is the source commit recorded above.

Installer SHA-256: {approval['assets'][INSTALLER]['sha256']}
Installer SHA-512: {approval['assets'][INSTALLER]['sha512']}
'''


def verify_manifest(path, approval):
    installer = re.escape(INSTALLER)
    sha512 = re.escape(approval['assets'][INSTALLER]['sha512'])
    size = approval['assets'][INSTALLER]['size']
    # Deliberately narrow electron-builder YAML subset, with no aliases, duplicate
    # keys, external URLs, extra files, or release metadata affecting execution.
    pattern = (rf'version: {re.escape(VERSION)}\nfiles:\n'
               rf'  - url: {installer}\n    sha512: {sha512}\n    size: {size}\n'
               rf'path: {installer}\nsha512: {sha512}\n'
               r"releaseDate: '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z'\n")
    require(re.fullmatch(pattern, path.read_text(encoding='utf-8')) is not None,
            'Manifest does not name the exact approved installer/version/hash/size')


def verify_bundle(archive, directory, approval):
    check_file(archive, approval['zip'])
    with zipfile.ZipFile(archive) as bundle:
        require(len(bundle.infolist()) == len(NAMES) and set(bundle.namelist()) == set(NAMES),
                'Unexpected, duplicate, or missing ZIP files')
        for name in NAMES:
            info = bundle.getinfo(name)
            mode = info.external_attr >> 16
            require(not info.is_dir() and not stat.S_ISLNK(mode) and
                    stat.S_IFMT(mode) in (0, stat.S_IFREG) and not info.flag_bits & 1,
                    f'ZIP entry is not an unencrypted regular file: {name}')
            require(info.file_size == approval['assets'][name]['size'], f'Wrong ZIP entry size: {name}')
            with bundle.open(info) as source, (directory / name).open('wb') as output:
                count = 0
                while chunk := source.read(1024 * 1024):
                    count += len(chunk)
                    require(count <= approval['assets'][name]['size'], f'Oversized ZIP entry: {name}')
                    output.write(chunk)
            check_file(directory / name, approval['assets'][name])
    verify_manifest(directory / MANIFEST, approval)


def gh(*args):
    return subprocess.run(['gh', *args], check=True, capture_output=True, text=True).stdout


def api(path, optional=False):
    result = subprocess.run(['gh', 'api', f'repos/{REPOSITORY}/{path}'], capture_output=True, text=True)
    if optional and result.returncode and '(HTTP 404)' in result.stderr:
        return None
    result.check_returncode()
    return json.loads(result.stdout)


def download_api(path, destination):
    accept = 'application/octet-stream' if path.startswith('releases/assets/') else 'application/vnd.github+json'
    with destination.open('wb') as output:
        subprocess.run(['gh', 'api', '-H', f'Accept: {accept}', f'repos/{REPOSITORY}/{path}'],
                       stdout=output, check=True)


def require_github_https(url):
    parsed = urllib.parse.urlparse(url)
    require(parsed.scheme == 'https' and not parsed.username and not parsed.password and
            parsed.port in (None, 443) and parsed.hostname in
            {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'},
            'Public asset redirect left the approved HTTPS GitHub hosts')


class GitHubHTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        require_github_https(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download_public(name, destination, expected):
    url = f'https://github.com/{REPOSITORY}/releases/download/{TAG}/{name}'
    require_github_https(url)
    opener = urllib.request.build_opener(GitHubHTTPSRedirect())
    for attempt in range(4):
        try:
            # No token or authorization headers are sent on public verification.
            request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
            with opener.open(request, timeout=120) as response, destination.open('wb') as output:
                require_github_https(response.url)
                require(response.status == 200, 'Unsuccessful public asset response')
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    require(count <= expected['size'], f'Oversized public asset: {name}')
                    output.write(chunk)
            check_file(destination, expected)
            return
        except urllib.error.HTTPError as error:
            if error.code not in (404, 429, 502, 503) or attempt == 3:
                raise
            time.sleep((3, 10, 20)[attempt])
        except RuntimeError:
            # The stable channel URL can briefly serve the exact known previous
            # manifest from a CDN cache. Never tolerate any unknown corrupt bytes.
            if name != MANIFEST or attempt == 3 or not destination.exists():
                raise
            try:
                check_file(destination, PREVIOUS_ASSETS[MANIFEST])
            except RuntimeError:
                raise
            time.sleep((3, 10, 20)[attempt])
    raise RuntimeError(f'Public asset unavailable: {name}')


def asset_identity(asset):
    return {key: asset.get(key) for key in ('id', 'name', 'size', 'state', 'digest',
                                          'content_type', 'label', 'created_at', 'updated_at')}


def snapshot(release):
    # download_count is intentionally omitted: readers must not cause a race failure.
    return {'release': {key: release.get(key) for key in
                        ('id', 'tag_name', 'target_commitish', 'name', 'body', 'draft', 'prerelease')},
            'assets': {asset['name']: asset_identity(asset) for asset in release['assets']}}


def asset_map(release):
    assets = release['assets']
    require(len(assets) == len({asset['name'] for asset in assets}), 'Duplicate release asset names')
    return {asset['name']: asset for asset in assets}


def validate_asset(asset, expected):
    require(asset['state'] == 'uploaded' and asset['size'] == expected['size'],
            f'Incomplete or wrong-sized asset: {asset["name"]}')
    require(asset.get('digest') == f'sha256:{expected["sha256"]}',
            f'Wrong remote digest: {asset["name"]}')
    if 'id' in expected:
        require(asset['id'] == expected['id'], f'Unexpected previous asset identity: {asset["name"]}')


def validate_tag():
    tag = api(f'git/ref/tags/{TAG}')
    require(tag['ref'] == f'refs/tags/{TAG}' and tag['object']['type'] == 'commit' and
            tag['object']['sha'] == TAG_SOURCE, 'Existing channel tag changed; refusing to move it')


def read_release(approval, allow_missing_manifest=False):
    release = api(f'releases/{RELEASE_ID}')
    require(release['id'] == RELEASE_ID and release['tag_name'] == TAG and
            release['target_commitish'] == TAG_SOURCE and release['prerelease'] is True and
            release['draft'] is False and not release.get('immutable'), 'Unexpected release identity/type')
    body = release['body'].replace('\r\n', '\n')
    old_metadata = (release['name'] == f'Iteration desktop {PREVIOUS_VERSION}' and
                    hashlib.sha256(body.encode()).hexdigest() == PREVIOUS_BODY_SHA256)
    new_metadata = release['name'] == TITLE and body == notes(approval)
    require(old_metadata or new_metadata, 'Release title/notes are neither the approved previous nor new state')
    assets = asset_map(release)
    for name, expected in PREVIOUS_ASSETS.items():
        if name != MANIFEST:
            require(name in assets, f'Previous immutable asset missing: {name}')
            validate_asset(assets[name], expected)
    for name in NAMES[:2]:
        if name in assets:
            validate_asset(assets[name], approval['assets'][name])
    require(MANIFEST in assets or allow_missing_manifest, 'Manifest missing; do not blindly repair an unknown state')
    feed = 'missing'
    if MANIFEST in assets:
        manifest = assets[MANIFEST]
        if manifest['id'] == PREVIOUS_ASSETS[MANIFEST]['id']:
            validate_asset(manifest, PREVIOUS_ASSETS[MANIFEST])
            feed = 'previous'
        else:
            validate_asset(manifest, approval['assets'][MANIFEST])
            require(all(name in assets for name in NAMES) and new_metadata,
                    'New manifest exists without the exact complete new publication')
            feed = 'new'
    return release, feed


def stable_state():
    # Read-only guard; no mutation ever uses these IDs, tags, or endpoints.
    latest = api('releases/latest', optional=True)
    stable = api('releases/tags/desktop-stable', optional=True)
    return {'latest': snapshot(latest) if latest else None, 'stable': snapshot(stable) if stable else None}


def verify_remote_asset(asset, expected, directory):
    validate_asset(asset, expected)
    destination = directory / f'remote-{asset["id"]}'
    download_api(f'releases/assets/{asset["id"]}', destination)
    check_file(destination, expected)


def assert_unchanged(previous, approval, stable, allow_missing_manifest=False):
    validate_tag()
    current, feed = read_release(approval, allow_missing_manifest)
    require(snapshot(current) == snapshot(previous), 'Release changed concurrently; refusing to continue')
    require(stable_state() == stable, 'Stable/latest release changed concurrently; refusing to continue')
    return current, feed


def validate_provenance_metadata(approval, run, artifact):
    require(run['id'] == approval['run_id'] and run['head_sha'] == approval['source'] and
            run['head_branch'] == 'iteration' and run['status'] == 'completed' and
            run['conclusion'] == 'success' and run['run_attempt'] == approval['run_attempt'] and
            run['workflow_id'] == approval['workflow_id'] and run['path'] == '.github/workflows/desktop-build.yml' and
            run['repository']['full_name'] == REPOSITORY and run['head_repository']['full_name'] == REPOSITORY,
            'Build is not the approved successful Windows workflow/source/attempt')
    require(artifact['id'] == approval['artifact_id'] and artifact['name'] == approval['artifact_name'] and
            not artifact['expired'] and artifact['size_in_bytes'] == approval['zip']['size'],
            'Wrong, expired, or resized artifact')
    require(artifact['workflow_run']['id'] == approval['run_id'] and
            artifact['workflow_run']['head_sha'] == approval['source'] and
            artifact['workflow_run']['head_branch'] == 'iteration', 'Artifact source mismatch')
    require(artifact.get('digest') == f'sha256:{approval["zip"]["sha256"]}', 'Artifact digest mismatch')


def verify_provenance(approval):
    validate_provenance_metadata(approval, api(f'actions/runs/{approval["run_id"]}'),
                                 api(f'actions/artifacts/{approval["artifact_id"]}'))


def require_publish_context():
    require(bool(os.environ.get('GH_TOKEN')) and os.environ.get('GITHUB_ACTIONS') == 'true',
            'Publish only in GitHub Actions with the job-scoped GitHub token')
    require(os.environ.get('GITHUB_REPOSITORY') == REPOSITORY and
            os.environ.get('GITHUB_REF') == 'refs/heads/iteration' and
            os.environ.get('GITHUB_EVENT_NAME') == 'push', 'Publication requires the approved iteration push')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text(encoding='utf-8'))
    require(event.get('head_commit', {}).get('message') == MARKER and
            event.get('after') == os.environ.get('GITHUB_SHA') and not event.get('deleted') and
            event.get('repository', {}).get('full_name') == REPOSITORY,
            'Push does not have the exact approved publication marker/source')


def publish(approval):
    require_publish_context()
    verify_provenance(approval)
    validate_tag()
    stable = stable_state()
    release, feed = read_release(approval)
    original = snapshot(release)
    preserved = {name: identity for name, identity in original['assets'].items() if name not in NAMES}
    with tempfile.TemporaryDirectory(prefix='flaghack-approved-update-') as temporary:
        directory = Path(temporary)
        archive = directory / 'artifact.zip'
        download_api(f'actions/artifacts/{approval["artifact_id"]}/zip', archive)
        verify_bundle(archive, directory, approval)
        # Verify the current feed bytes, not only GitHub metadata, before mutating.
        expected_feed = PREVIOUS_ASSETS[MANIFEST] if feed == 'previous' else approval['assets'][MANIFEST]
        verify_remote_asset(asset_map(release)[MANIFEST], expected_feed, directory)
        assert_unchanged(release, approval, stable)

        for name in NAMES[:2]:
            assets = asset_map(release)
            if name not in assets:
                before = snapshot(release)
                assert_unchanged(release, approval, stable)
                gh('release', 'upload', TAG, str(directory / name), '--repo', REPOSITORY)
                release, feed = read_release(approval)
                after = snapshot(release)
                require(after['release'] == before['release'] and
                        {key: value for key, value in after['assets'].items() if key != name} == before['assets'] and
                        name in after['assets'], 'Unexpected state after immutable upload')
            verify_remote_asset(asset_map(release)[name], approval['assets'][name], directory)
            download_public(name, directory / ('public-' + name), approval['assets'][name])
            assert_unchanged(release, approval, stable)

        # Title/notes change is explicit and cannot move the existing channel tag.
        # Do this before the feed, so the feed is the last state-changing operation.
        if release['name'] != TITLE or release['body'].replace('\r\n', '\n') != notes(approval):
            assert_unchanged(release, approval, stable)
            before = snapshot(release)
            body_file = directory / 'release-notes.txt'
            body_file.write_text(notes(approval), encoding='utf-8')
            gh('release', 'edit', TAG, '--repo', REPOSITORY, '--title', TITLE,
               '--notes-file', str(body_file), '--prerelease', '--latest=false')
            release, feed = read_release(approval)
            after = snapshot(release)
            require(after['assets'] == before['assets'] and
                    {key: value for key, value in after['release'].items() if key not in ('name', 'body')} ==
                    {key: value for key, value in before['release'].items() if key not in ('name', 'body')},
                    'Unexpected state after release notes edit')

        if feed == 'previous':
            assert_unchanged(release, approval, stable)
            # Delete by the pinned old ID, never by an unconstrained asset name.
            # GitHub has no atomic asset replace. A failed upload may leave a gap;
            # clients retain their installed version. Unknown gaps require review.
            before = snapshot(release)
            old_manifest_id = asset_map(release)[MANIFEST]['id']
            require(old_manifest_id == PREVIOUS_ASSETS[MANIFEST]['id'], 'Old manifest ID changed')
            gh('api', '--method', 'DELETE', f'repos/{REPOSITORY}/releases/assets/{old_manifest_id}')
            release, missing = read_release(approval, allow_missing_manifest=True)
            after = snapshot(release)
            require(missing == 'missing' and after['release'] == before['release'] and
                    after['assets'] == {key: value for key, value in before['assets'].items() if key != MANIFEST},
                    'Unexpected state after deleting only the old manifest')
            assert_unchanged(release, approval, stable, allow_missing_manifest=True)
            gh('release', 'upload', TAG, str(directory / MANIFEST), '--repo', REPOSITORY)
            release, feed = read_release(approval)
            require(feed == 'new' and snapshot(release)['release'] == after['release'] and
                    {key: value for key, value in snapshot(release)['assets'].items() if key != MANIFEST} == after['assets'],
                    'Unexpected state after new manifest upload')

        require(feed == 'new', 'Feed was not advanced')
        require({name: identity for name, identity in snapshot(release)['assets'].items() if name not in NAMES} == preserved,
                'Prior or unrelated assets changed')
        for name in NAMES:
            verify_remote_asset(asset_map(release)[name], approval['assets'][name], directory)
            download_public(name, directory / ('public-final-' + name), approval['assets'][name])
        assert_unchanged(release, approval, stable)
        print(json.dumps({'release': release['html_url'], 'release_id': RELEASE_ID,
                          'installer': f'https://github.com/{REPOSITORY}/releases/download/{TAG}/{INSTALLER}',
                          'source': approval['source'], 'version': VERSION,
                          'run_id': approval['run_id'], 'artifact_id': approval['artifact_id'],
                          'assets': {name: asset_identity(asset_map(release)[name]) for name in NAMES},
                          'checksums_verified': True, 'public_https_verified': True,
                          'previous_assets_preserved': True, 'channel_tag_preserved': True,
                          'stable_and_latest_unchanged': True}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approval', type=Path, default=DEFAULT_APPROVAL)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--publish', action='store_true')
    mode.add_argument('--verify-only', type=Path)
    args = parser.parse_args()
    approved = load_approval(args.approval)
    if args.verify_only:
        with tempfile.TemporaryDirectory(prefix='flaghack-verify-') as temporary:
            verify_bundle(args.verify_only, Path(temporary), approved)
        print('Approved artifact verified; no remote changes.')
    else:
        publish(approved)
