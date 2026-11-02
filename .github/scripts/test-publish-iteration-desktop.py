"""Offline publisher integration tests: fake gh CLI, local ZIP, no credentials/network."""
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock
import urllib.error
import zipfile

SPEC = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-iteration-desktop.py'))
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


def byte_spec(data):
    return {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'sha512': base64.b64encode(hashlib.sha512(data).digest()).decode()}


class Fixture:
    def __init__(self, directory):
        self.directory = directory
        self.payloads = {publisher.INSTALLER: b'MZ\\verified installer fixture\\' * 257,
                         publisher.INSTALLER + '.blockmap': b'blockmap fixture' * 29}
        exe = byte_spec(self.payloads[publisher.INSTALLER])
        self.payloads[publisher.MANIFEST] = (
            f'version: {publisher.VERSION}\nfiles:\n  - url: {publisher.INSTALLER}\n'
            f'    sha512: {exe["sha512"]}\n    size: {exe["size"]}\n'
            f'path: {publisher.INSTALLER}\nsha512: {exe["sha512"]}\n'
            "releaseDate: '2026-10-12T03:00:00.000Z'\n").encode()
        self.archive = directory / 'artifact.zip'
        self.approval = {
            'schema': 1, 'repository': publisher.REPOSITORY, 'version': publisher.VERSION,
            'source': 'a' * 40, 'run_id': 123456, 'run_attempt': 1, 'workflow_id': 234567,
            'artifact_id': 345678, 'artifact_name': f'flaghack-windows-iteration-{publisher.VERSION}',
            'launcher_tests': 100, 'game_tests': 1111, 'zip': {}, 'assets': {},
        }
        self.rebuild_zip()
        self.old_body = 'Previously approved fixture release notes.\n'
        self.old_payloads = {name: (f'previous:{name}\n').encode() for name in publisher.PREVIOUS_ASSETS}
        self.previous = {name: {**byte_spec(data), 'id': publisher.PREVIOUS_ASSETS[name]['id']}
                         for name, data in self.old_payloads.items()}
        self.release = {'id': publisher.RELEASE_ID, 'tag_name': publisher.TAG,
                        'target_commitish': publisher.TAG_SOURCE,
                        'name': f'Iteration desktop {publisher.PREVIOUS_VERSION}',
                        'body': self.old_body, 'draft': False, 'prerelease': True, 'immutable': False,
                        'html_url': f'https://github.com/{publisher.REPOSITORY}/releases/tag/{publisher.TAG}',
                        'assets': [self.asset(name, spec['id'], spec) for name, spec in self.previous.items()]}
        # Unknown unrelated assets must also survive, not just the hard-pinned old version.
        self.unrelated = self.asset('legacy-release-notes.txt', 7000, byte_spec(b'keep me'))
        self.release['assets'].append(self.unrelated)
        self.bytes = {spec['id']: self.old_payloads[name] for name, spec in self.previous.items()}
        self.bytes[7000] = b'keep me'
        self.run = {'id': self.approval['run_id'], 'head_sha': self.approval['source'],
                    'head_branch': 'iteration', 'status': 'completed', 'conclusion': 'success',
                    'run_attempt': 1, 'workflow_id': self.approval['workflow_id'],
                    'path': '.github/workflows/desktop-build.yml',
                    'repository': {'full_name': publisher.REPOSITORY},
                    'head_repository': {'full_name': publisher.REPOSITORY}}
        self.artifact = {'id': self.approval['artifact_id'], 'name': self.approval['artifact_name'],
                         'expired': False, 'size_in_bytes': self.approval['zip']['size'],
                         'digest': 'sha256:' + self.approval['zip']['sha256'],
                         'workflow_run': {'id': self.approval['run_id'], 'head_sha': self.approval['source'],
                                          'head_branch': 'iteration'}}
        self.calls = []
        self.mutations = []
        self.events = []
        self.tag_source = publisher.TAG_SOURCE
        self.latest = None
        self.stable = None
        self.next_id = 8000
        self.public_hook = None
        self.before_delete = None
        self.fail_upload = None
        self.after_delete = None
        self.event = directory / 'push-event.json'
        self.event.write_text(json.dumps({'after': 'b' * 40, 'deleted': False,
                                         'head_commit': {'message': publisher.MARKER},
                                         'repository': {'full_name': publisher.REPOSITORY}}))

    @staticmethod
    def asset(name, identity, spec):
        return {'id': identity, 'name': name, 'size': spec['size'], 'state': 'uploaded',
                'digest': 'sha256:' + spec['sha256'], 'content_type': 'application/octet-stream',
                'label': '', 'created_at': '2026-10-12T03:00:00Z', 'updated_at': '2026-10-12T03:00:00Z'}

    def rebuild_zip(self, extras=None, duplicate=None, symlink=None):
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_STORED) as archive:
            for name, data in self.payloads.items():
                if name == symlink:
                    info = zipfile.ZipInfo(name)
                    info.create_system = 3
                    info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(info, data)
                else:
                    archive.writestr(name, data)
            for name, data in (extras or {}).items():
                archive.writestr(name, data)
            if duplicate:
                archive.writestr(duplicate, self.payloads[duplicate])
        self.approval['zip'] = publisher.file_spec(self.archive)
        self.approval['assets'] = {name: byte_spec(data) for name, data in self.payloads.items()}

    def respond(self, args, value, kwargs):
        if isinstance(value, bytes):
            kwargs['stdout'].write(value)
            return subprocess.CompletedProcess(args, 0)
        return subprocess.CompletedProcess(args, 0, json.dumps(copy.deepcopy(value)), '')

    def fake_gh(self, args, **kwargs):
        # Exercise the production argument construction, refusing all unknown commands.
        self.calls.append(args)
        assert args[0] == 'gh'
        if args[1] == 'api':
            path = args[-1]
            prefix = f'repos/{publisher.REPOSITORY}/'
            assert path.startswith(prefix), path
            path = path[len(prefix):]
            if '--method' in args:
                assert args[args.index('--method') + 1] == 'DELETE'
                allowed = f'releases/assets/{self.previous[publisher.MANIFEST]["id"]}'
                assert path == allowed, (path, allowed)
                if self.before_delete:
                    self.before_delete()
                target = self.previous[publisher.MANIFEST]['id']
                if target not in [asset['id'] for asset in self.release['assets']]:
                    raise subprocess.CalledProcessError(1, args, stderr='HTTP 404')
                self.release['assets'] = [asset for asset in self.release['assets'] if asset['id'] != target]
                self.mutations.append(('delete', publisher.MANIFEST, target))
                self.events.append(('delete', publisher.MANIFEST))
                if self.after_delete:
                    self.after_delete()
                return subprocess.CompletedProcess(args, 0, '', '')
            if path == f'actions/runs/{self.approval["run_id"]}':
                value = self.run
            elif path == f'actions/artifacts/{self.approval["artifact_id"]}':
                value = self.artifact
            elif path == f'actions/artifacts/{self.approval["artifact_id"]}/zip':
                assert args[args.index('-H') + 1] == 'Accept: application/vnd.github+json'
                value = self.archive.read_bytes()
            elif path == f'git/ref/tags/{publisher.TAG}':
                value = {'ref': f'refs/tags/{publisher.TAG}',
                         'object': {'type': 'commit', 'sha': self.tag_source}}
            elif path == f'releases/{publisher.RELEASE_ID}':
                value = self.release
            elif path.startswith('releases/assets/'):
                assert args[args.index('-H') + 1] == 'Accept: application/octet-stream'
                value = self.bytes[int(path.rsplit('/', 1)[-1])]
            elif path in ('releases/latest', 'releases/tags/desktop-stable'):
                value = self.latest if path == 'releases/latest' else self.stable
                if value is None:
                    return subprocess.CompletedProcess(args, 1, '', '(HTTP 404)')
            else:
                raise AssertionError(f'Unexpected API: {args}')
            return self.respond(args, value, kwargs)
        assert args[1] == 'release' and args[3] == publisher.TAG
        assert '--repo' in args and args[args.index('--repo') + 1] == publisher.REPOSITORY
        assert '--clobber' not in args and '--target' not in args
        if args[2] == 'upload':
            path = Path(args[4])
            name = path.name
            assert name in publisher.NAMES
            assert name not in [asset['name'] for asset in self.release['assets']]
            if self.fail_upload == name:
                raise subprocess.CalledProcessError(1, args, stderr='Simulated upload failure')
            data = path.read_bytes()
            self.next_id += 1
            self.release['assets'].append(self.asset(name, self.next_id, byte_spec(data)))
            self.bytes[self.next_id] = data
            self.mutations.append(('upload', name))
            self.events.append(('upload', name))
        elif args[2] == 'edit':
            assert '--latest=false' in args and '--prerelease' in args
            self.release['name'] = args[args.index('--title') + 1]
            self.release['body'] = Path(args[args.index('--notes-file') + 1]).read_text()
            self.mutations.append(('edit', publisher.TAG))
            self.events.append(('edit', publisher.TAG))
        else:
            raise AssertionError(f'Unexpected mutation: {args}')
        return subprocess.CompletedProcess(args, 0, '', '')

    def public_download(self, name, destination, expected):
        self.events.append(('public', name))
        asset = next(asset for asset in self.release['assets'] if asset['name'] == name)
        destination.write_bytes(self.bytes[asset['id']])
        publisher.check_file(destination, expected)
        if self.public_hook:
            self.public_hook(name)

    @contextlib.contextmanager
    def installed(self):
        env = {'GH_TOKEN': 'offline-fixture-only', 'GITHUB_ACTIONS': 'true',
               'GITHUB_REPOSITORY': publisher.REPOSITORY, 'GITHUB_REF': 'refs/heads/iteration',
               'GITHUB_EVENT_NAME': 'push', 'GITHUB_SHA': 'b' * 40, 'GITHUB_EVENT_PATH': str(self.event)}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(publisher, 'PREVIOUS_ASSETS', self.previous), \
                mock.patch.object(publisher, 'PREVIOUS_BODY_SHA256', hashlib.sha256(self.old_body.encode()).hexdigest()), \
                mock.patch.object(publisher.subprocess, 'run', self.fake_gh), \
                mock.patch.object(publisher, 'download_public', self.public_download), \
                mock.patch.object(publisher.urllib.request, 'build_opener', side_effect=AssertionError('Network forbidden')):
            yield

    def publish(self):
        with self.installed(), contextlib.redirect_stdout(io.StringIO()) as output:
            publisher.publish(self.approval)
        return json.loads(output.getvalue())


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='offline-publisher-test-')
        self.directory = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.fixture = Fixture(self.directory)

    def test_happy_path_preserves_old_and_unrelated_assets_and_tag(self):
        before = {asset['name']: publisher.asset_identity(asset) for asset in self.fixture.release['assets']
                  if asset['name'] != publisher.MANIFEST}
        receipt = self.fixture.publish()
        self.assertTrue(receipt['stable_and_latest_unchanged'])
        self.assertTrue(receipt['checksums_verified'])
        after = {asset['name']: publisher.asset_identity(asset) for asset in self.fixture.release['assets']
                 if asset['name'] not in publisher.NAMES}
        self.assertEqual(before, after)
        self.assertEqual(self.fixture.tag_source, publisher.TAG_SOURCE)
        self.assertEqual(self.fixture.mutations,
                         [('upload', publisher.INSTALLER), ('upload', publisher.INSTALLER + '.blockmap'),
                          ('edit', publisher.TAG), ('delete', publisher.MANIFEST, publisher.PREVIOUS_ASSETS[publisher.MANIFEST]['id']),
                          ('upload', publisher.MANIFEST)])
        first_delete = self.fixture.events.index(('delete', publisher.MANIFEST))
        for name in publisher.NAMES[:2]:
            self.assertLess(self.fixture.events.index(('public', name)), first_delete)

    def test_completed_publication_is_idempotent_with_no_mutations(self):
        self.fixture.publish()
        self.fixture.mutations.clear()
        self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_partial_immutable_upload_resumes_without_overwriting(self):
        self.fixture.fail_upload = publisher.INSTALLER + '.blockmap'
        with self.assertRaises(subprocess.CalledProcessError):
            self.fixture.publish()
        first_id = next(asset['id'] for asset in self.fixture.release['assets'] if asset['name'] == publisher.INSTALLER)
        self.fixture.fail_upload = None
        self.fixture.publish()
        self.assertEqual(first_id, next(asset['id'] for asset in self.fixture.release['assets']
                                       if asset['name'] == publisher.INSTALLER))
        self.assertEqual(sum(mutation == ('upload', publisher.INSTALLER) for mutation in self.fixture.mutations), 1)

    def test_unknown_missing_manifest_requires_review(self):
        self.fixture.release['assets'] = [asset for asset in self.fixture.release['assets']
                                         if asset['name'] != publisher.MANIFEST]
        with self.assertRaisesRegex(RuntimeError, 'Manifest missing'):
            self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_feed_upload_failure_is_not_blindly_retried(self):
        self.fixture.fail_upload = publisher.MANIFEST
        with self.assertRaises(subprocess.CalledProcessError):
            self.fixture.publish()
        mutations = copy.deepcopy(self.fixture.mutations)
        self.fixture.fail_upload = None
        with self.assertRaisesRegex(RuntimeError, 'Manifest missing'):
            self.fixture.publish()
        self.assertEqual(mutations, self.fixture.mutations)

    def test_unknown_previous_feed_identity_blocks_all_writes(self):
        self.fixture.release['assets'][2]['id'] += 1
        with self.assertRaises(RuntimeError):
            self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_previous_manifest_byte_corruption_blocks_all_writes(self):
        self.fixture.bytes[publisher.PREVIOUS_ASSETS[publisher.MANIFEST]['id']] = b'x' * self.fixture.previous[publisher.MANIFEST]['size']
        with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
            self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_unknown_release_notes_block_all_writes(self):
        self.fixture.release['body'] = 'Someone changed this release.'
        with self.assertRaisesRegex(RuntimeError, 'title/notes'):
            self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_tag_drift_blocks_all_writes(self):
        self.fixture.tag_source = 'c' * 40
        with self.assertRaisesRegex(RuntimeError, 'tag changed'):
            self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_missing_previous_installer_blocks_all_writes(self):
        self.fixture.release['assets'].pop(0)
        with self.assertRaisesRegex(RuntimeError, 'Previous immutable asset missing'):
            self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_duplicate_release_names_block_all_writes(self):
        self.fixture.release['assets'].append(copy.deepcopy(self.fixture.release['assets'][0]))
        with self.assertRaisesRegex(RuntimeError, 'Duplicate release asset'):
            self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_corrupt_existing_new_payload_is_never_clobbered(self):
        bad = self.fixture.asset(publisher.INSTALLER, 9001, byte_spec(b'bad'))
        self.fixture.release['assets'].append(bad)
        with self.assertRaises(RuntimeError):
            self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_new_manifest_requires_exact_complete_new_state(self):
        self.fixture.release['assets'][2] = self.fixture.asset(publisher.MANIFEST, 9001,
                                                              self.fixture.approval['assets'][publisher.MANIFEST])
        with self.assertRaisesRegex(RuntimeError, 'exact complete new publication'):
            self.fixture.publish()
        self.assertEqual(self.fixture.mutations, [])

    def test_public_payload_failure_never_deletes_old_feed(self):
        def fail(name):
            raise RuntimeError('Public download failed')
        self.fixture.public_hook = fail
        with self.assertRaisesRegex(RuntimeError, 'Public download failed'):
            self.fixture.publish()
        self.assertFalse(any(mutation[0] == 'delete' for mutation in self.fixture.mutations))

    def test_concurrent_unrelated_asset_change_blocks_feed_replacement(self):
        def race(name):
            self.fixture.unrelated['label'] = 'Concurrent writer'
        self.fixture.public_hook = race
        with self.assertRaisesRegex(RuntimeError, 'changed concurrently'):
            self.fixture.publish()
        self.assertFalse(any(mutation[0] == 'delete' for mutation in self.fixture.mutations))

    def test_concurrent_stable_release_change_blocks_feed_replacement(self):
        def race(name):
            self.fixture.stable = {**copy.deepcopy(self.fixture.release), 'id': 800, 'tag_name': 'desktop-stable'}
        self.fixture.public_hook = race
        with self.assertRaisesRegex(RuntimeError, 'Stable/latest release changed'):
            self.fixture.publish()
        self.assertFalse(any(mutation[0] == 'delete' for mutation in self.fixture.mutations))

    def test_delete_by_exact_id_cannot_remove_racing_replacement(self):
        def race():
            asset = next(asset for asset in self.fixture.release['assets'] if asset['name'] == publisher.MANIFEST)
            asset['id'] = 91234
        self.fixture.before_delete = race
        with self.assertRaises(subprocess.CalledProcessError):
            self.fixture.publish()
        self.assertTrue(any(asset['id'] == 91234 for asset in self.fixture.release['assets']))
        self.assertFalse(any(mutation[0] == 'delete' for mutation in self.fixture.mutations))

    def test_race_after_delete_never_clobbers_competing_manifest(self):
        def race():
            self.fixture.release['assets'].append(self.fixture.asset(publisher.MANIFEST, 91234, byte_spec(b'other')))
        self.fixture.after_delete = race
        with self.assertRaises(RuntimeError):
            self.fixture.publish()
        self.assertTrue(any(asset['id'] == 91234 for asset in self.fixture.release['assets']))
        self.assertFalse(('upload', publisher.MANIFEST) in self.fixture.mutations)

    def test_wrong_build_run_fields_block_all_writes(self):
        cases = {'id': 1, 'head_sha': 'c' * 40, 'head_branch': 'main', 'status': 'in_progress',
                 'conclusion': 'failure', 'run_attempt': 2, 'workflow_id': 2,
                 'path': '.github/workflows/other.yml', 'repository': {'full_name': 'other/repo'},
                 'head_repository': {'full_name': 'fork/repo'}}
        original = copy.deepcopy(self.fixture.run)
        for name, value in cases.items():
            with self.subTest(name=name):
                self.fixture.run = {**original, name: value}
                with self.assertRaisesRegex(RuntimeError, 'approved successful Windows'):
                    self.fixture.publish()
                self.assertEqual(self.fixture.mutations, [])

    def test_wrong_artifact_fields_block_all_writes(self):
        cases = {'id': 1, 'name': 'other', 'expired': True, 'size_in_bytes': 1, 'digest': 'sha256:bad',
                 'workflow_run': {'id': 1, 'head_sha': 'c' * 40, 'head_branch': 'main'}}
        original = copy.deepcopy(self.fixture.artifact)
        for name, value in cases.items():
            with self.subTest(name=name):
                self.fixture.artifact = {**original, name: value}
                with self.assertRaises(RuntimeError):
                    self.fixture.publish()
                self.assertEqual(self.fixture.mutations, [])

    def test_publish_rejects_missing_actions_context_and_nonexact_marker(self):
        with self.fixture.installed():
            for key, value in {'GH_TOKEN': '', 'GITHUB_ACTIONS': 'false', 'GITHUB_REF': 'refs/heads/main',
                               'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': 'other/repo'}.items():
                with self.subTest(key=key), mock.patch.dict(os.environ, {key: value}):
                    with self.assertRaises(RuntimeError):
                        publisher.publish(self.fixture.approval)
            event = json.loads(self.fixture.event.read_text())
            event['head_commit']['message'] += '\nextra words'
            self.fixture.event.write_text(json.dumps(event))
            with self.assertRaisesRegex(RuntimeError, 'exact approved publication'):
                publisher.publish(self.fixture.approval)
        self.assertEqual(self.fixture.calls, [])

    def test_approval_requires_all_verified_fields(self):
        path = self.directory / 'approval.json'
        path.write_text(json.dumps(self.fixture.approval))
        self.assertEqual(publisher.load_approval(path), self.fixture.approval)
        for name, value in {'source': 'PENDING', 'version': '0.2.0', 'run_id': None,
                            'artifact_id': 0, 'launcher_tests': False}.items():
            with self.subTest(name=name):
                path.write_text(json.dumps({**self.fixture.approval, name: value}))
                with self.assertRaises((RuntimeError, TypeError)):
                    publisher.load_approval(path)

    def test_bundle_checks_all_hashes_sizes_and_manifest(self):
        target = self.directory / 'extracted'
        target.mkdir()
        publisher.verify_bundle(self.fixture.archive, target, self.fixture.approval)
        self.assertEqual(set(path.name for path in target.iterdir()), set(publisher.NAMES))
        for field in ('size', 'sha256', 'sha512'):
            approval = copy.deepcopy(self.fixture.approval)
            approval['assets'][publisher.INSTALLER][field] = 1 if field == 'size' else 'wrong'
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                publisher.verify_bundle(self.fixture.archive, target, approval)

    def test_extra_duplicate_and_symlink_zip_entries_rejected(self):
        target = self.directory / 'extracted'
        target.mkdir()
        for kwargs in ({'extras': {'../evil': b'evil'}}, {'duplicate': publisher.INSTALLER},
                       {'symlink': publisher.INSTALLER}):
            with self.subTest(kwargs=kwargs):
                with mock.patch('warnings.warn'):
                    self.fixture.rebuild_zip(**kwargs)
                with self.assertRaises(RuntimeError):
                    publisher.verify_bundle(self.fixture.archive, target, self.fixture.approval)

    def test_manifest_cannot_redirect_to_another_installer(self):
        self.fixture.payloads[publisher.MANIFEST] = self.fixture.payloads[publisher.MANIFEST].replace(
            publisher.INSTALLER.encode(), b'https://attacker.example/installer.exe')
        self.fixture.rebuild_zip()
        with self.assertRaisesRegex(RuntimeError, 'Manifest does not name'):
            publisher.verify_bundle(self.fixture.archive, self.directory, self.fixture.approval)

    def test_public_https_redirects_allow_only_github_hosts(self):
        for url in ('https://github.com/owner/repo', 'https://release-assets.githubusercontent.com/payload',
                    'https://objects.githubusercontent.com/payload'):
            publisher.require_github_https(url)
        for url in ('http://github.com/x', 'https://attacker.example/x', 'https://github.com.evil/x',
                    'https://token@github.com/x', 'https://github.com:444/x'):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                publisher.require_github_https(url)
        redirect = publisher.GitHubHTTPSRedirect()
        with self.assertRaises(RuntimeError):
            redirect.redirect_request(None, None, 302, '', {}, 'http://github.com/x')

    def test_public_download_checks_bytes_without_auth_headers(self):
        payload = self.fixture.payloads[publisher.INSTALLER]
        class Response(io.BytesIO):
            status = 200
            url = 'https://release-assets.githubusercontent.com/payload'
        opener = mock.Mock()
        opener.open.return_value = Response(payload)
        target = self.directory / 'public.exe'
        with mock.patch.object(publisher.urllib.request, 'build_opener', return_value=opener):
            publisher.download_public(publisher.INSTALLER, target,
                                      self.fixture.approval['assets'][publisher.INSTALLER])
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url,
                         f'https://github.com/{publisher.REPOSITORY}/releases/download/{publisher.TAG}/{publisher.INSTALLER}')
        self.assertNotIn('Authorization', request.headers)
        self.assertEqual(target.read_bytes(), payload)

    def test_public_manifest_retries_only_exact_known_previous_cached_bytes(self):
        class Response(io.BytesIO):
            status = 200
            url = 'https://release-assets.githubusercontent.com/manifest'
        opener = mock.Mock()
        opener.open.side_effect = [Response(self.fixture.old_payloads[publisher.MANIFEST]),
                                   Response(self.fixture.payloads[publisher.MANIFEST])]
        target = self.directory / 'public-manifest'
        with mock.patch.object(publisher.urllib.request, 'build_opener', return_value=opener), \
                mock.patch.object(publisher, 'PREVIOUS_ASSETS', self.fixture.previous), \
                mock.patch.object(publisher.time, 'sleep') as sleep:
            publisher.download_public(publisher.MANIFEST, target,
                                      self.fixture.approval['assets'][publisher.MANIFEST])
            sleep.assert_called_once_with(3)
        self.assertEqual(target.read_bytes(), self.fixture.payloads[publisher.MANIFEST])
        opener.open.side_effect = [Response(b'unknown corrupt manifest')]
        with mock.patch.object(publisher.urllib.request, 'build_opener', return_value=opener), \
                mock.patch.object(publisher, 'PREVIOUS_ASSETS', self.fixture.previous), \
                mock.patch.object(publisher.time, 'sleep') as sleep:
            with self.assertRaises(RuntimeError):
                publisher.download_public(publisher.MANIFEST, target,
                                          self.fixture.approval['assets'][publisher.MANIFEST])
            sleep.assert_not_called()

    def test_local_approval_generator_reproduces_verified_record(self):
        spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare-iteration-desktop-approval.py'))
        prepare = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(prepare)
        with mock.patch.object(prepare.publisher.subprocess, 'run', side_effect=AssertionError('No gh calls allowed')):
            actual = prepare.prepare(self.fixture.run, self.fixture.artifact, self.fixture.archive, 100, 1111)
        self.assertEqual(actual, self.fixture.approval)
        self.fixture.artifact['digest'] = 'sha256:wrong'
        with self.assertRaisesRegex(RuntimeError, 'Artifact digest mismatch'):
            prepare.prepare(self.fixture.run, self.fixture.artifact, self.fixture.archive, 100, 1111)

    def test_workflow_only_exact_push_and_pinned_action(self):
        workflow = Path(__file__).parents[1] / 'workflows' / 'desktop-publish.yml'
        text = workflow.read_text()
        self.assertEqual(text.count(publisher.MARKER), 1)
        self.assertNotIn('workflow_dispatch:', text)
        self.assertIn("github.event_name == 'push'", text)
        self.assertIn('persist-credentials: false', text)
        self.assertIn('group: publish-desktop-iteration\n', text)
        self.assertIn('GH_TOKEN: ${{ github.token }}', text)
        self.assertNotIn('secrets.', text)
        self.assertRegex(text, r'uses: actions/checkout@[a-f0-9]{40}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
