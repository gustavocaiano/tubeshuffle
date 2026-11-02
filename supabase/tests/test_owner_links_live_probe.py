"""Offline only: fake responses and a loopback-only fake opener."""
import contextlib
import io
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock
from urllib.request import urlopen

import owner_links_live_probe as probe

KEY = 'sb_publishable_abcdefghijklmnop'


def response(code, message=''):
    return json.dumps({'code': code, 'message': message}).encode()


class ProbeTests(unittest.TestCase):
    def test_classification_is_narrow(self):
        classify = probe.classify
        self.assertEqual(classify('anonymous links', (403, response('42501'))), 'permission denied response (observation; inconclusive)')
        self.assertEqual(classify('private schema', (406, response('PGRST106'))), 'schema exposure error response (observation; inconclusive)')
        self.assertEqual(classify('invalid bearer', (401, response('PGRST301', 'JWT signature verification failed'))), 'invalid signature rejection response (observation; inconclusive)')
        self.assertEqual(classify('invalid bearer', (401, response('PGRST301', 'JWT expired'))), 'expired token (inconclusive)')
        for status in (301, 404, 405, 429, 500):
            for case in ('anonymous links', 'private schema', 'invalid bearer'):
                self.assertEqual(classify(case, (status, response('42501'))), 'inconclusive')
        self.assertEqual(classify('invalid bearer', (401, response('PGRST301', 'other'))), 'inconclusive')
        self.assertEqual(classify('anonymous links', (200, b'[{"secret":"row"}]')), 'unexpected success')
        self.assertEqual(classify('private schema', (200, b'[]')), 'unexpected success')

    def test_closed_input_and_exact_origin(self):
        sender = mock.Mock(side_effect=AssertionError('must not send'))
        for key in ('sb_secret_abcdefghijklmnop', 'eyJ.eyJ.signature', '', KEY + '\n'):
            self.assertEqual(probe.run(key, sender), [('input', 'inconclusive')])
        self.assertEqual(probe.run(KEY, sender, probe.ORIGIN + '.evil'), [('input', 'inconclusive')])
        self.assertIsNone(probe.transport(probe.ORIGIN + '/', 'links', {}))
        self.assertIsNone(probe.transport(probe.ORIGIN, 'other', {}))
        sender.assert_not_called()

    def test_requests_and_output_do_not_leak(self):
        seen = []
        def fake(origin, route, headers):
            seen.append((origin, route, headers))
            return (403, response('42501', 'sensitive response body ' + KEY))
        results = probe.run(KEY, fake)
        self.assertEqual([s[1] for s in seen], ['links', 'links', 'private'])
        self.assertEqual(seen[0][2], {'apikey': KEY})
        self.assertTrue(seen[1][2]['Authorization'].startswith('Bearer '))
        self.assertEqual(seen[2][2]['Accept-Profile'], 'private')
        self.assertNotIn(KEY, str(results))
        self.assertNotIn(probe.ORIGIN, str(results))
        self.assertNotIn('sensitive', str(results))
        self.assertNotIn(probe.INVALID, str(results))
        self.assertEqual(probe.run(KEY, lambda *args: (_ for _ in ()).throw(OSError(KEY)))[0][1], 'inconclusive')

    def test_transport_only_get_no_redirect_no_proxy(self):
        class FakeResponse:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b'[]'
        opener = mock.Mock()
        opener.open.return_value = FakeResponse()
        with mock.patch.object(probe.urllib.request, 'build_opener', return_value=opener) as build:
            self.assertEqual(probe.transport(probe.ORIGIN, 'links', {'apikey': KEY}), (200, b'[]'))
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), 'GET')
        self.assertIsNone(request.data)
        handlers = build.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], probe.NoRedirect)
        self.assertIsNone(handlers[1].redirect_request(None, None, 302, None, None, None))

    def test_noninteractive_and_exception_output_safe(self):
        output = io.StringIO()
        with mock.patch.object(probe.sys, 'argv', ['probe', KEY]), contextlib.redirect_stdout(output):
            self.assertEqual(probe.main(), 2)
        self.assertNotIn(KEY, output.getvalue())

    def test_wrong_key_route_and_unrelated_permission_never_pass(self):
        probe_run = probe.run
        cases = [
            (401, response('invalid_api_key', 'Invalid API key')),
            (404, response('PGRST205', 'route not found')),
            (403, response('42501', 'permission denied for unrelated relation')),
        ]
        for response_value in cases:
            with self.subTest(response=response_value[0]), \
                 mock.patch.dict(probe.os.environ, {}, clear=True), \
                 mock.patch.object(probe.sys, 'argv', ['probe']), \
                 mock.patch.object(probe.sys.stdin, 'isatty', return_value=True), \
                 mock.patch.object(probe.sys.stderr, 'isatty', return_value=True), \
                 mock.patch.object(probe.getpass, 'getpass', return_value=KEY):
                # run's default sender is bound at definition, so inject explicitly.
                with mock.patch.object(probe, 'run', side_effect=lambda key: probe_run(key, lambda *args: response_value)):
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        self.assertNotEqual(probe.main(), 0)
                    self.assertIn('inconclusive', output.getvalue().lower())
                    self.assertNotIn(KEY, output.getvalue())

    def test_matching_responses_are_still_inconclusive(self):
        responses = iter([(403, response('42501')), (401, response('PGRST301', 'JWT signature verification failed')),
                          (406, response('PGRST106'))])
        results = probe.run(KEY, lambda *args: next(responses))
        self.assertTrue(all('inconclusive' in result for _, result in results))
        output = io.StringIO()
        with mock.patch.dict(probe.os.environ, {}, clear=True), \
             mock.patch.object(probe.sys, 'argv', ['probe']), \
             mock.patch.object(probe.sys.stdin, 'isatty', return_value=True), \
             mock.patch.object(probe.sys.stderr, 'isatty', return_value=True), \
             mock.patch.object(probe.getpass, 'getpass', return_value=KEY), \
             mock.patch.object(probe, 'run', return_value=results), contextlib.redirect_stdout(output):
            self.assertEqual(probe.main(), 1)
        self.assertIn('Overall: inconclusive', output.getvalue())

    def test_sslkeylogfile_blocks_before_opener_or_prompt(self):
        for value in ('', '/tmp/secret-key-log'):
            with self.subTest(value=value), mock.patch.dict(probe.os.environ, {'SSLKEYLOGFILE': value}), \
                 mock.patch.object(probe.urllib.request, 'build_opener') as opener, \
                 mock.patch.object(probe.getpass, 'getpass') as prompt:
                sender = mock.Mock()
                self.assertEqual(probe.run(KEY, sender), [('TLS key logging environment', 'inconclusive')])
                self.assertIsNone(probe.transport(probe.ORIGIN, 'links', {'apikey': KEY}))
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(probe.main(), 2)
                if value:
                    self.assertNotIn(value, output.getvalue())
                opener.assert_not_called()
                prompt.assert_not_called()
                sender.assert_not_called()

    def test_synthetic_loopback_with_fake_transport(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.command, self.path))
                self.send_response(429)
                self.end_headers()
                self.wfile.write(response('42501', KEY))
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def loopback(origin, route, headers):
            # Test transport discards all production arguments and credentials.
            self.assertEqual(origin, probe.ORIGIN)
            try:
                urlopen('http://127.0.0.1:%d/test' % server.server_port, timeout=2)
            except probe.urllib.error.HTTPError as error:
                with error:
                    return error.code, error.read()
        try:
            results = probe.run(KEY, loopback)
            self.assertTrue(all(result == 'inconclusive' for _, result in results))
            self.assertEqual(requests, [('GET', '/test')] * 3)
            self.assertNotIn(KEY, str(results))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
