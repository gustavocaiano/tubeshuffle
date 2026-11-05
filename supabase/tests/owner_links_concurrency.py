#!/usr/bin/env python3
"""Local-only PostgreSQL 16 concurrency regression; requires Docker and postgres:16."""

import json
import os
import pathlib
import queue
import stat
import subprocess
import sys
import threading
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
OWNER = "11111111-1111-1111-1111-111111111111"
TIMEOUT = 30
DOCKER_HOST = 'unix:///var/run/docker.sock'
IMAGE = 'postgres:16'
LABEL = 'org.tubeshuffle.concurrency-run'


def docker_env():
    env = os.environ.copy()
    env.pop('DOCKER_CONTEXT', None)
    env.pop('DOCKER_HOST', None)
    return env


def docker(*args):
    return ['docker', '--host', DOCKER_HOST, *args]


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError('phase deadline exceeded')
    return value


def run(*args, input=None, timeout=TIMEOUT):
    return subprocess.run(args, input=input, text=True, capture_output=True,
                          timeout=timeout, check=True, env=docker_env()).stdout.strip()


def verify_local_socket():
    # A socket can forward to a remote daemon: the operator must trust its owner.
    if os.environ.get('TUBESHUFFLE_TRUST_LOCAL_DOCKER') != '1':
        raise RuntimeError('set TUBESHUFFLE_TRUST_LOCAL_DOCKER=1 only if the standard Docker socket is trusted and local')
    path = pathlib.Path('/var/run/docker.sock')
    if path.resolve() != pathlib.Path('/run/docker.sock') or not stat.S_ISSOCK(path.stat().st_mode):
        raise RuntimeError('standard Docker socket is not available at /var/run/docker.sock')


def cleanup(name, token):
    # Inspect by unpredictable name, then remove only the immutable ID after all
    # three ownership checks. Never remove by a name alone.
    deadline = time.monotonic() + TIMEOUT
    while True:
        try:
            raw = run(*docker('inspect', '--type', 'container', name), timeout=remaining(deadline))
        except subprocess.CalledProcessError as exc:
            if 'No such object' not in (exc.stderr or '') and 'No such container' not in (exc.stderr or ''):
                raise
            # A create whose response was lost can still be completing server-side.
            delay = deadline - time.monotonic()
            if delay <= 0:
                raise RuntimeError(f'cleanup could not confirm container {name}; a delayed create may require manual cleanup')
            time.sleep(min(0.1, delay))
            continue
        items = json.loads(raw)
        if len(items) != 1:
            raise RuntimeError('unexpected Docker inspect response; refusing cleanup')
        item = items[0]
        config = item.get('Config') or {}
        if (item.get('Name') != '/' + name or config.get('Image') != IMAGE
                or (config.get('Labels') or {}).get(LABEL) != token):
            raise RuntimeError('container ownership mismatch; refusing cleanup')
        run(*docker('rm', '-f', item['Id']), timeout=remaining(deadline))
        return


class Database:
    def __init__(self, container):
        self.container = container
        self.sessions = []

    def command(self):
        return docker("exec", "-i", self.container, "psql", "-X", "-qAt",
                      "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres")

    def sql(self, sql, timeout=TIMEOUT):
        return run(*self.command(), input=sql, timeout=timeout)

    def session(self, name):
        session = Session(self, name)
        self.sessions.append(session)
        return session

    def wait_blocked(self, names):
        # Observe actual PostgreSQL lock waits, not timing-dependent sleeps.
        deadline = time.monotonic() + TIMEOUT
        names_sql = ",".join("'" + name + "'" for name in names)
        while time.monotonic() < deadline:
            count = self.sql("select count(*) from pg_stat_activity where "
                             f"application_name in ({names_sql}) and wait_event_type = 'Lock' "
                             "and wait_event = 'advisory';", timeout=remaining(deadline))
            if int(count) == len(names):
                return
            # This is only a bounded polling interval; the lock observation is the barrier.
            time.sleep(min(0.05, remaining(deadline)))
        raise AssertionError(f"sessions did not reach advisory lock barrier: {names}")

    def close(self):
        errors = []
        for session in self.sessions:
            try:
                session.close()
            except Exception as exc:
                errors.append(exc)
        if errors:
            raise RuntimeError(f'{len(errors)} session(s) failed to close') from errors[0]


class Session:
    def __init__(self, db, name):
        self.process = subprocess.Popen(db.command(), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, bufsize=1, env=docker_env())
        try:
            self.lines = queue.Queue()
            self.thread = threading.Thread(target=self._read, daemon=True)
            self.thread.start()
            self.send(f"set application_name = '{name}'; select 'READY';")
            self.expect("READY")
        except BaseException:
            try:
                self.close()
            except Exception:
                self.process.kill()
                self.process.wait(timeout=5)
            raise

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(line.strip())
        self.lines.put(None)

    def send(self, sql):
        self.process.stdin.write(sql + "\n")
        self.process.stdin.flush()

    def line(self):
        try:
            line = self.lines.get(timeout=TIMEOUT)
        except queue.Empty as exc:
            raise AssertionError("timed out waiting for psql") from exc
        if line is None:
            raise AssertionError("psql exited unexpectedly")
        return line

    def expect(self, expected):
        actual = self.line()
        if actual != expected:
            raise AssertionError(f"expected {expected!r}, got {actual!r}")

    def result(self):
        return json.loads(self.line())

    def close(self):
        try:
            if self.process.poll() is None:
                try:
                    self.process.stdin.close()
                    self.process.wait(timeout=5)
                finally:
                    if self.process.poll() is None:
                        self.process.kill()
                        self.process.wait(timeout=5)
        finally:
            self.process.stdout.close()


def begin_save(session, playlist_id):
    session.send("begin; set local role authenticated; "
                 f"set local request.jwt.claim.sub = '{OWNER}'; "
                 "set local request.jwt.claims = ''; "
                 "select row_to_json(r) from public.save_playlist_link("
                 f"'{playlist_id}') r;")


def seed(db):
    db.sql("truncate public.playlist_links; "
           "insert into public.playlist_links(user_id, youtube_playlist_id) "
           f"select '{OWNER}', 'seed_' || lpad(n::text, 10, '0') "
           "from generate_series(1, 4999) n;")


def count(db):
    return int(db.sql("select count(*) from public.playlist_links;"))


def pair(db, label, first_id, second_id):
    seed(db)
    gate = db.session(label + '_gate')
    gate.send("begin; select pg_advisory_xact_lock(1414745171, 1); select 'LOCKED';")
    gate.expect("")  # void result
    gate.expect("LOCKED")
    a, b = db.session(label + '_a'), db.session(label + '_b')
    begin_save(a, first_id)
    begin_save(b, second_id)
    db.wait_blocked([label + '_a', label + '_b'])
    gate.send("commit; select 'RELEASED';")
    gate.expect('RELEASED')
    # Each client must commit independently, otherwise the other remains blocked.
    # Send both commits before reading either result.
    a.send("commit; select 'COMMITTED';")
    b.send("commit; select 'COMMITTED';")
    results = [a.result(), b.result()]
    a.expect('COMMITTED')
    b.expect('COMMITTED')
    assert count(db) == 5000, (label, results)
    assert sum(r['created'] is True for r in results) == 1, results
    for r in results:
        if r['created']:
            assert not r['limit_reached'] and r['created_at'] and r['youtube_playlist_id'] in (first_id, second_id), results
    if first_id == second_id:
        assert all(not r['limit_reached'] and r['youtube_playlist_id'] == first_id for r in results), results
        assert results[0]['created_at'] == results[1]['created_at'], results
    else:
        rejected = next(r for r in results if not r['created'])
        assert rejected['limit_reached'] and rejected['youtube_playlist_id'] is None and rejected['created_at'] is None, results
    created = next(r for r in results if r['created'])
    stored = json.loads(db.sql("select row_to_json(r) from (select youtube_playlist_id, created_at "
                               "from public.playlist_links where youtube_playlist_id = "
                               f"'{created['youtube_playlist_id']}') r;"))
    assert stored['created_at'] == created['created_at'], (stored, created)
    print(f"PASS {label}: one creation, count 5000, expected duplicate/cap response")


def rollback_retry(db):
    seed(db)
    a, b = db.session('rollback_a'), db.session('rollback_b')
    begin_save(a, 'rollback_first')
    first = a.result()
    assert first['created'] and not first['limit_reached'], first
    begin_save(b, 'rollback_first')
    db.wait_blocked(['rollback_b'])
    a.send("rollback; select 'ROLLED_BACK';")
    a.expect('ROLLED_BACK')
    b.send("commit; select 'COMMITTED';")
    second = b.result()
    b.expect('COMMITTED')
    assert second['created'] and not second['limit_reached'] and second['youtube_playlist_id'] == 'rollback_first', second
    assert count(db) == 5000
    assert db.sql("select count(*) from public.playlist_links where youtube_playlist_id = 'rollback_first';") == '1'
    print('PASS rollback/retry: blocked same-ID retry succeeds after rollback, exactly one row')


def main():
    verify_local_socket()
    token = uuid.uuid4().hex
    name = 'tubeshuffle-concurrency-' + token
    container = None
    db = None
    create_attempted = False
    try:
        create_attempted = True
        container = run(*docker('create', '--pull=never', '--name', name, '--label', f'{LABEL}={token}', '--network', 'none',
                        '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
                        IMAGE))
        run(*docker('start', container))
        db = Database(container)
        deadline = time.monotonic() + TIMEOUT
        while True:
            try:
                logs = subprocess.run(docker('logs', container), text=True, env=docker_env(),
                                      capture_output=True, timeout=remaining(deadline), check=True)
                if ('PostgreSQL init process complete; ready for start up.' in logs.stdout
                        and db.sql('select 1;', timeout=remaining(deadline)) == '1'):
                    break
            except subprocess.CalledProcessError:
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError('PostgreSQL did not start')
            time.sleep(min(0.1, remaining(deadline)))
        for path in ['supabase/tests/owner_links_auth_fixture.sql',
                     'supabase/migrations/20261029131212_owner_playlist_links.sql',
                     'supabase/migrations/20261029170816_owner_link_claims.sql']:
            db.sql('begin;\n' + (ROOT / path).read_text() + '\ncommit;')
        db.sql(f"insert into private.approved_owner(user_id) values ('{OWNER}');")
        pair(db, 'same_id', 'concurrent_same', 'concurrent_same')
        pair(db, 'different_id', 'concurrent_first', 'concurrent_second')
        rollback_retry(db)
    finally:
        try:
            if db:
                db.close()
        finally:
            if create_attempted:
                cleanup(name, token)


if __name__ == '__main__':
    try:
        if not __debug__:
            raise RuntimeError('run without Python optimization so assertions remain enabled')
        main()
    except (AssertionError, OSError, RuntimeError, subprocess.SubprocessError, TimeoutError) as exc:
        print(f'FAIL: {exc}', file=sys.stderr)
        if isinstance(exc, subprocess.CalledProcessError):
            print(exc.stderr, file=sys.stderr)
        sys.exit(1)
