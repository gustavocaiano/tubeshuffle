"""Docker-free safety regressions for the concurrency harness."""
import json
import subprocess
import unittest
from unittest import mock

import owner_links_concurrency as harness


class SafetyTests(unittest.TestCase):
    def container(self, name='test-name', token='test-token', image=harness.IMAGE):
        return json.dumps([{'Name': '/' + name, 'Id': 'immutable-id',
                            'Config': {'Image': image, 'Labels': {harness.LABEL: token}}}])

    def test_cleanup_rejects_foreign_resources(self):
        for response in (self.container(name='foreign'), self.container(token='foreign'),
                         self.container(image='foreign')):
            with self.subTest(response=response), mock.patch.object(harness, 'run', return_value=response) as run:
                with self.assertRaisesRegex(RuntimeError, 'ownership mismatch'):
                    harness.cleanup('test-name', 'test-token')
                self.assertEqual(run.call_count, 1)
                self.assertIn('inspect', run.call_args.args)

    def test_cleanup_finds_create_after_lost_response(self):
        missing = subprocess.CalledProcessError(1, 'docker', stderr='No such object')
        with mock.patch.object(harness, 'run', side_effect=[missing, self.container(), '']) as run, \
             mock.patch.object(harness.time, 'sleep'):
            harness.cleanup('test-name', 'test-token')
            self.assertEqual(run.call_count, 3)
            self.assertEqual(run.call_args.args, tuple(harness.docker('rm', '-f', 'immutable-id')))

    def test_cleanup_missing_container_times_out(self):
        missing = subprocess.CalledProcessError(1, 'docker', stderr='No such object')
        with mock.patch.object(harness, 'run', side_effect=missing) as run, \
             mock.patch.object(harness.time, 'monotonic', side_effect=[0, 0, 31]), \
             mock.patch.object(harness.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'delayed create may require manual cleanup'):
                harness.cleanup('test-name', 'test-token')
            self.assertEqual(run.call_count, 1)

    def test_start_failure_attempts_scoped_cleanup(self):
        failure = subprocess.CalledProcessError(1, 'docker start')
        with mock.patch.object(harness, 'verify_local_socket'), \
             mock.patch.object(harness, 'run', side_effect=['container-id', failure]), \
             mock.patch.object(harness, 'cleanup') as cleanup, \
             mock.patch.object(harness.uuid, 'uuid4') as uuid4:
            uuid4.return_value.hex = 'test-token'
            with self.assertRaises(subprocess.CalledProcessError):
                harness.main()
            cleanup.assert_called_once_with('tubeshuffle-concurrency-test-token', 'test-token')

    def test_setup_failure_closes_database_and_attempts_cleanup(self):
        db = mock.Mock()
        db.sql.side_effect = ['1', RuntimeError('fixture failed')]
        logs = mock.Mock(stdout='PostgreSQL init process complete; ready for start up.')
        with mock.patch.object(harness, 'verify_local_socket'), \
             mock.patch.object(harness, 'run', side_effect=['container-id', '']), \
             mock.patch.object(harness, 'Database', return_value=db), \
             mock.patch.object(harness.subprocess, 'run', return_value=logs), \
             mock.patch.object(harness, 'cleanup') as cleanup, \
             mock.patch.object(harness.uuid, 'uuid4') as uuid4:
            uuid4.return_value.hex = 'test-token'
            with self.assertRaisesRegex(RuntimeError, 'fixture failed'):
                harness.main()
            db.close.assert_called_once_with()
            cleanup.assert_called_once_with('tubeshuffle-concurrency-test-token', 'test-token')

    def test_create_timeout_still_attempts_scoped_cleanup(self):
        with mock.patch.object(harness, 'verify_local_socket'), \
             mock.patch.object(harness, 'run', side_effect=subprocess.TimeoutExpired('docker', 30)), \
             mock.patch.object(harness, 'cleanup') as cleanup, \
             mock.patch.object(harness.uuid, 'uuid4') as uuid4:
            uuid4.return_value.hex = 'test-token'
            with self.assertRaises(subprocess.TimeoutExpired):
                harness.main()
            cleanup.assert_called_once_with('tubeshuffle-concurrency-test-token', 'test-token')

    def test_cleanup_removes_only_inspected_id(self):
        with mock.patch.object(harness, 'run', side_effect=[self.container(), '']) as run:
            harness.cleanup('test-name', 'test-token')
            self.assertEqual(run.call_args.args, tuple(harness.docker('rm', '-f', 'immutable-id')))

    def test_docker_endpoint_and_context_are_explicit(self):
        with mock.patch.dict(harness.os.environ, {'DOCKER_CONTEXT': 'remote', 'DOCKER_HOST': 'tcp://remote'}):
            self.assertNotIn('DOCKER_CONTEXT', harness.docker_env())
            self.assertNotIn('DOCKER_HOST', harness.docker_env())
            self.assertEqual(harness.Database('id').command()[:3],
                             ['docker', '--host', 'unix:///var/run/docker.sock'])

    def test_session_init_failure_reaps_process(self):
        process = mock.MagicMock()
        process.poll.side_effect = [None, None]
        with mock.patch.object(harness.subprocess, 'Popen', return_value=process), \
             mock.patch.object(harness.threading.Thread, 'start'), \
             mock.patch.object(harness.Session, 'expect', side_effect=AssertionError('failure')):
            with self.assertRaises(AssertionError):
                harness.Session(harness.Database('id'), 'test')
        process.kill.assert_called_once()
        self.assertGreaterEqual(process.wait.call_count, 1)

    def test_database_close_attempts_all_sessions(self):
        db = harness.Database('id')
        first, second = mock.Mock(), mock.Mock()
        first.close.side_effect = RuntimeError('failure')
        db.sessions = [first, second]
        with self.assertRaises(RuntimeError):
            db.close()
        second.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
