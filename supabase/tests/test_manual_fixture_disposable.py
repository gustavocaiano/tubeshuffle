"""Run only against a new network-isolated postgres:16 container; no live calls."""
import hashlib
import os
import pathlib
import subprocess
import tempfile
import unittest
import uuid
from unittest import mock

import manual_fixture_generator as generator
import owner_links_concurrency as harness

ROOT = pathlib.Path(__file__).resolve().parent
OWNER = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'
FIXTURE = 'tsfixture_0123456789abcdef0123456789abcdef'
FINGERPRINT = hashlib.sha256(OWNER.encode()).hexdigest()


class DisposableFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        harness.verify_local_socket()
        cls.name = 'tubeshuffle-fixture-test-' + uuid.uuid4().hex
        cls.token = uuid.uuid4().hex
        # A lost run response may still create the container: cleanup by scoped identity.
        try:
            harness.run(*harness.docker('run', '-d', '--network', 'none', '--pull', 'never',
                         '--name', cls.name, '--label', f'{harness.LABEL}={cls.token}',
                         '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', harness.IMAGE))
            harness.run(*harness.docker('exec', cls.name, 'sh', '-c',
                        'for i in $(seq 1 60); do pg_isready -q && exit 0; sleep 1; done; exit 1'), timeout=70)
            cls.sql((ROOT / 'owner_links_auth_fixture.sql').read_text())
            for name in ('20261029131212_owner_playlist_links.sql', '20261029170816_owner_link_claims.sql'):
                cls.sql((ROOT.parent / 'migrations' / name).read_text())
        except BaseException:
            harness.cleanup(cls.name, cls.token)
            raise

    @classmethod
    def tearDownClass(cls):
        harness.cleanup(cls.name, cls.token)

    @classmethod
    def sql(cls, statement, success=True):
        result = subprocess.run(harness.docker('exec', '-i', cls.name, 'psql', '-X', '-q',
                                 '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'),
                                input=statement, text=True, capture_output=True, env=harness.docker_env(), timeout=30)
        if (result.returncode == 0) != success:
            raise AssertionError('unexpected SQL outcome: ' + result.stderr)
        return result.stdout

    def setUp(self):
        self.sql(f"truncate public.playlist_links, private.approved_owner; insert into private.approved_owner values (true, '{OWNER}');")

    def script(self, operation, fingerprint=FINGERPRINT):
        return generator.render(operation, FIXTURE, fingerprint, generator.PROJECT, generator.PROJECT)

    def assert_count(self, expected):
        self.sql(f"do $$ begin if (select count(*) from public.playlist_links) <> {expected} then raise exception 'count mismatch'; end if; end $$;")

    def test_create_cleanup(self):
        self.sql(self.script('create'))
        self.assert_count(1)
        self.sql(self.script('delete'))
        self.assert_count(0)
        self.sql(self.script('delete'), success=False)

    def test_existing_owner_or_global_id_blocks_create(self):
        for owner, ident in [(OWNER, 'unrelated_fixture'), (OTHER, FIXTURE)]:
            with self.subTest(owner=owner):
                self.sql('truncate public.playlist_links;')
                self.sql(f"insert into public.playlist_links values ('{owner}', '{ident}', now());")
                self.sql(self.script('create'), success=False)
                self.assert_count(1)

    def test_changed_missing_pin_and_wrong_fingerprint(self):
        self.sql(self.script('create'))
        self.sql(f"update private.approved_owner set user_id = '{OTHER}';")
        self.sql(self.script('delete'), success=False)
        self.assert_count(1)
        self.sql('truncate private.approved_owner;')
        self.sql(self.script('delete'), success=False)
        self.sql(f"insert into private.approved_owner values (true, '{OWNER}');")
        self.sql(self.script('delete', '0' * 64), success=False)
        self.assert_count(1)

    def test_altered_rows_block_cleanup(self):
        self.sql(self.script('create'))
        self.sql("update public.playlist_links set created_at = now();")
        self.sql(self.script('delete'), success=False)
        self.assert_count(1)
        self.sql("update public.playlist_links set created_at = '2000-01-01 00:00:00+00';")
        self.sql(f"insert into public.playlist_links values ('{OTHER}', '{FIXTURE}', now());")
        self.sql(self.script('delete'), success=False)
        self.assert_count(2)

    def test_transaction_rollback(self):
        self.sql('begin;\n' + self.script('create') + '\nrollback;')
        self.assert_count(0)
        self.sql(self.script('create'))
        self.sql('begin;\n' + self.script('delete') + '\nrollback;')
        self.assert_count(1)


class GeneratorSafetyTest(unittest.TestCase):
    def test_invalid_inputs_never_render(self):
        bad = ["x'); drop table public.playlist_links; --", 'tsfixture_' + 'a' * 19,
               'tsfixture_' + 'é' * 20, FIXTURE + '\n', '', None]
        for operation in ('create', 'delete'):
            for ident in bad:
                with self.subTest(operation=operation, ident=ident), self.assertRaises(ValueError):
                    generator.render(operation, ident, FINGERPRINT, generator.PROJECT, generator.PROJECT)
            for fingerprint in ("' OR true --", 'A' * 64, 'a' * 63, 'a' * 64 + '\n', None):
                with self.subTest(operation=operation, fingerprint=fingerprint), self.assertRaises(ValueError):
                    generator.render(operation, FIXTURE, fingerprint, generator.PROJECT, generator.PROJECT)
            for intended, current in (('wrong', generator.PROJECT), (generator.PROJECT, 'wrong')):
                with self.assertRaises(ValueError):
                    generator.render(operation, FIXTURE, FINGERPRINT, intended, current)

    def test_no_clobber_even_if_directory_exists(self):
        with tempfile.TemporaryDirectory() as parent:
            directory = pathlib.Path(parent) / 'private'
            directory.mkdir(mode=0o700)
            (directory / 'id').write_text('do not overwrite')
            with self.assertRaises(FileExistsError):
                generator.create_reference(directory)
            self.assertEqual((directory / 'id').read_text(), 'do not overwrite')
            with mock.patch.object(generator.os, 'mkdir', side_effect=PermissionError):
                with self.assertRaises(PermissionError):
                    generator.create_reference(directory)
            self.assertEqual((directory / 'id').read_text(), 'do not overwrite')

    def test_reference_only_id_and_private(self):
        with tempfile.TemporaryDirectory() as parent:
            directory = pathlib.Path(parent) / 'private'
            generator.create_reference(directory)
            self.assertRegex(generator.read_reference(directory), generator.ID)
            self.assertEqual(os.stat(directory).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(directory / 'id').st_mode & 0o777, 0o600)

    def test_lost_container_create_response_scoped_cleanup(self):
        with mock.patch.object(harness, 'verify_local_socket'), \
             mock.patch.object(harness, 'run', side_effect=subprocess.TimeoutExpired('docker', 1)), \
             mock.patch.object(harness, 'cleanup') as cleanup:
            with self.assertRaises(subprocess.TimeoutExpired):
                DisposableFixtureTest.setUpClass()
            cleanup.assert_called_once_with(DisposableFixtureTest.name, DisposableFixtureTest.token)


if __name__ == '__main__':
    unittest.main(verbosity=2)
