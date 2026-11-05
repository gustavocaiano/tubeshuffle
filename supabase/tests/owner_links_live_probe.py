#!/usr/bin/env python3
"""Narrow, opt-in read-only observations; never prints remote response data."""
import base64
import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.request
import warnings

ORIGIN = "https://rkgbxjwmnlsmguhctguf.supabase.co"
ROUTES = {"links": "/rest/v1/playlist_links?select=user_id&limit=1",
          "private": "/rest/v1/approved_owner?select=singleton&limit=1"}
KEY = re.compile(r"sb_publishable_[A-Za-z0-9_-]{10,200}\Z")


def _part(value):
    return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=').decode()


# An intentionally invalid signature and a future expiry: no real credentials.
INVALID = _part({'alg': 'HS256', 'typ': 'JWT'}) + '.' + _part({
    'role': 'authenticated', 'sub': '00000000-0000-0000-0000-000000000001',
    'exp': 4102444800}) + '.' + base64.urlsafe_b64encode(b'\0' * 32).rstrip(b'=').decode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def transport(origin, route, headers):
    # Validate before opening a connection. No user-supplied URL, method or path.
    if 'SSLKEYLOGFILE' in os.environ or origin != ORIGIN or route not in ROUTES:
        return None
    request = urllib.request.Request(ORIGIN + ROUTES[route], headers=headers, method='GET')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        try:
            response = opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            # Bounded data is used only to classify specific errors, never displayed.
            body = response.read(8193)
            return response.status, body if len(body) <= 8192 else b''
    except Exception:
        return None


def classify(case, response):
    if response is None:
        return 'inconclusive'
    status, body = response
    if 200 <= status < 300:
        return 'unexpected success'
    if status in (404, 405, 429) or 300 <= status < 400 or status >= 500:
        return 'inconclusive'
    try:
        data = json.loads(body)
        if not isinstance(data, dict):
            return 'inconclusive'
    except (ValueError, UnicodeError, TypeError):
        return 'inconclusive'
    code, message = data.get('code'), data.get('message')
    if case == 'invalid bearer' and status == 401:
        if code == 'PGRST301' and message == 'JWT expired':
            return 'expired token (inconclusive)'
        if code == 'PGRST301' and message == 'JWT signature verification failed':
            return 'invalid signature rejection response (observation; inconclusive)'
    if case == 'anonymous links' and status in (401, 403) and code == '42501':
        return 'permission denied response (observation; inconclusive)'
    if case == 'private schema' and status in (400, 406) and code == 'PGRST106':
        return 'schema exposure error response (observation; inconclusive)'
    return 'inconclusive'


def run(key, send=transport, origin=ORIGIN):
    if 'SSLKEYLOGFILE' in os.environ:
        return [('TLS key logging environment', 'inconclusive')]
    if origin != ORIGIN or not isinstance(key, str) or not KEY.fullmatch(key):
        return [('input', 'inconclusive')]
    checks = [('anonymous links', 'links', {}),
              ('invalid bearer', 'links', {'Authorization': 'Bearer ' + INVALID}),
              ('private schema', 'private', {'Accept-Profile': 'private'})]
    results = []
    for label, route, extra in checks:
        try:
            result = send(origin, route, {'apikey': key, **extra})
            results.append((label, classify(label, result)))
        except Exception:
            results.append((label, 'inconclusive'))
    return results


def main():
    if 'SSLKEYLOGFILE' in os.environ:
        print('SSLKEYLOGFILE is set; no requests made. Inconclusive.')
        return 2
    if len(sys.argv) != 1 or not sys.stdin.isatty() or not sys.stderr.isatty():
        print('Interactive terminal required; arguments are not accepted.')
        return 2
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            key = getpass.getpass('Public publishable key: ')
        results = run(key)
    except (KeyboardInterrupt, Exception):
        print('Input unavailable; inconclusive.')
        return 2
    for label, result in results:
        print(f'{label}: {result}')
    # No positive control independently verifies the key, route and target project.
    print('Overall: inconclusive; observations do not verify the key, route, or project.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
