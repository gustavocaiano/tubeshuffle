#!/usr/bin/env python3
"""Offline fixture generator. Never connects to a database."""
import getpass
import os
import pathlib
import re
import secrets
import stat
import sys
import warnings

ROOT = pathlib.Path(__file__).resolve().parent
PROJECT = 'rkgbxjwmnlsmguhctguf'
ID = re.compile(r'tsfixture_[A-Za-z0-9_-]{20,70}', re.ASCII)
HASH = re.compile(r'[0-9a-f]{64}', re.ASCII)


def create_reference(directory):
    # mkdir is the ownership boundary: never write inside a pre-existing directory.
    os.mkdir(directory, 0o700)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        out = os.open('id', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(out, 'w', encoding='ascii') as f:
            f.write('tsfixture_' + secrets.token_hex(16) + '\n')
    finally:
        os.close(fd)


def render(operation, ident, fingerprint, project, confirmed_project):
    if (operation not in ('create', 'delete') or project != PROJECT or confirmed_project != PROJECT
            or not isinstance(ident, str) or not ID.fullmatch(ident)
            or not isinstance(fingerprint, str) or not HASH.fullmatch(fingerprint)):
        raise ValueError('invalid input; stop')
    template = (ROOT / ('manual_fixture_' + operation + '.sql')).read_text(encoding='utf-8')
    if template.count('REPLACE_WITH_SYNTHETIC_ID') != 1 or template.count('REPLACE_WITH_SHA256_FINGERPRINT') != 1:
        raise ValueError('invalid template; stop')
    return template.replace('REPLACE_WITH_SYNTHETIC_ID', ident).replace('REPLACE_WITH_SHA256_FINGERPRINT', fingerprint)


def read_reference(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('invalid reference; stop')
        ref = os.open('id', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(ref)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
                raise ValueError('invalid reference; stop')
            data = os.read(ref, 256).decode('ascii')
            if not data.endswith('\n') or not ID.fullmatch(data[:-1]):
                raise ValueError('invalid reference; stop')
            return data[:-1]
        finally:
            os.close(ref)
    finally:
        os.close(fd)


def main():
    try:
        if len(sys.argv) != 3 or sys.argv[1] not in ('init', 'create', 'delete'):
            raise ValueError()
        operation, directory = sys.argv[1:]
        if operation == 'init':
            create_reference(directory)
            print('Reference created.')
            return 0
        if not sys.stdin.isatty() or not sys.stdout.isatty() or not sys.stderr.isatty():
            raise ValueError()
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            project = getpass.getpass('Independently verified intended project reference: ')
            current = getpass.getpass('Independently verified current SQL Editor project reference: ')
            fingerprint = getpass.getpass('Original private owner fingerprint: ')
        print(render(operation, read_reference(directory), fingerprint, project, current))
        return 0
    except (Exception, KeyboardInterrupt):
        print('Unable to proceed; stop and investigate.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
