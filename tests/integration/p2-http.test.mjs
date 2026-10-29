import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '../..');
const owner = '11111111-1111-1111-1111-111111111111';
const other = '44444444-4444-4444-4444-444444444444';
const sessionId = '22222222-2222-2222-2222-222222222222';
const apiKey = 'synthetic-youtube-secret';
const providerSecret = 'synthetic-provider-error-secret';
const playlistId = 'PLabcdefghij';
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
const token = (subject, issuer, expiry = Math.floor(Date.now() / 1000) + 3600, overrides = {}) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: subject, iss: `${issuer}/auth/v1`, aud: 'authenticated', session_id: sessionId, exp: expiry, ...overrides })}.c2ln`;
const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };

test('real HTTP routes with isolated simulated provider and SDK', { timeout: 120000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tubeshuffle-p2-'));
  let child;
  let childEnded;
  const provider = createServer();
  t.after(async () => {
    let stopped = !child;
    try {
      if (child) {
        const waitForEnd = async (ms) => {
          let timer;
          try { return await Promise.race([childEnded.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
          finally { clearTimeout(timer); }
        };
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
        }
        stopped = await waitForEnd(5000);
        if (!stopped && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
          stopped = await waitForEnd(5000);
        }
      }
    } finally {
      if (provider.listening) {
        provider.closeAllConnections();
        let timer;
        await Promise.race([new Promise(resolve => provider.close(resolve)), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
        clearTimeout(timer);
      }
      if (stopped) await rm(dir, { recursive: true, force: true });
    }
    assert.ok(stopped, `Next did not exit after shutdown; preserved temporary directory: ${dir}`);
  });
  const port = await listen(provider);
  const issuer = `http://127.0.0.1:${port}`;
  const good = token(owner, issuer), nonowner = token(other, issuer), expired = token(owner, issuer, 1);
  const badClaims = [
    { iss: 'http://invalid.local/auth/v1' }, { aud: 'other' }, { sub: other }, { session_id: 'invalid' },
  ].map(claims => token(owner, issuer, undefined, { ...claims, synthetic_fixture: 'claim-test' }));
  let youtube = 0, auth = 0, refreshes = 0, logouts = 0, pin = true, failDatabase = false, failYoutube = false, links = [];
  const violations = [];
  provider.on('request', async (req, res) => {
    const url = new URL(req.url, issuer);
    let body = ''; for await (const chunk of req) body += chunk;
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const check = (condition, description) => { if (!condition) throw new Error(description); };
    const params = (expected) => {
      check([...url.searchParams.keys()].length === Object.keys(expected).length, `unexpected query keys: ${url.pathname}`);
      for (const [key, value] of Object.entries(expected)) check(url.searchParams.getAll(key).length === 1 && (value === null ? !!url.searchParams.get(key) : url.searchParams.get(key) === value), `bad query ${url.pathname} ${key}`);
    };
    try {
      if (url.pathname.startsWith('/youtube/v3/')) {
        youtube++;
        check(req.method === 'GET' && !body, 'YouTube method/body');
        if (url.pathname.endsWith('/playlists')) {
          params({ part: 'snippet,contentDetails', id: null, maxResults: '1', key: apiKey });
          check([playlistId, 'PLerrorsecret'].includes(url.searchParams.get('id')), 'playlist id');
          if (url.searchParams.get('id') === 'PLerrorsecret') return reply(403, { error: { code: 403, message: providerSecret + apiKey } });
          return reply(200, { items: [{ snippet: { title: 'Synthetic playlist' }, contentDetails: { itemCount: 0 } }] });
        }
        if (url.pathname.endsWith('/playlistItems')) { params({ part: 'snippet,contentDetails', playlistId, maxResults: '50', key: apiKey }); return reply(200, { items: [] }); }
        if (url.pathname.endsWith('/search')) {
          params({ part: 'snippet', q: null, type: 'video', maxResults: '25', videoEmbeddable: 'true', videoCategoryId: '10', safeSearch: 'moderate', order: 'relevance', key: apiKey });
          if (failYoutube) return reply(500, { error: { code: 500, message: providerSecret + apiKey } });
          return reply(200, { items: [{ id: { videoId: 'synthetic01' }, snippet: { title: 'Synthetic song', channelTitle: 'Synthetic artist' } }, { id: { videoId: 'excluded001' }, snippet: { title: 'Excluded', channelTitle: 'Synthetic artist' } }] });
        }
        if (url.pathname.endsWith('/videos')) { params({ part: 'snippet,contentDetails,statistics', id: 'synthetic01', key: apiKey }); return reply(200, { items: [{ id: 'synthetic01', contentDetails: { duration: 'PT3M' }, statistics: { viewCount: '42' } }] }); }
        throw new Error('unexpected YouTube endpoint');
      }
      check(req.headers.apikey === 'synthetic-publishable', 'provider API key');
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (url.pathname === '/auth/v1/user') {
        check(req.method === 'GET' && !body && !url.search, 'user request'); auth++;
        if ([good, nonowner, ...badClaims].includes(bearer)) return reply(200, { id: bearer === nonowner ? other : owner, aud: 'authenticated', role: 'authenticated' });
        return reply(401, { code: bearer === expired ? 'session_expired' : 'bad_jwt', message: providerSecret });
      }
      if (url.pathname === '/auth/v1/token') {
        check(req.method === 'POST' && bearer === 'synthetic-publishable', 'refresh method/bearer'); params({ grant_type: 'refresh_token' });
        check(JSON.stringify(JSON.parse(body)) === JSON.stringify({ refresh_token: 'synthetic-refresh' }), 'refresh body');
        refreshes++;
        return reply(200, { access_token: good, refresh_token: 'synthetic-refreshed', expires_at: Math.floor(Date.now()/1000)+3600, expires_in: 3600, token_type: 'bearer', user: { id: owner, aud: 'authenticated', role: 'authenticated' } });
      }
      if (url.pathname === '/auth/v1/logout') { check(req.method === 'POST' && bearer === good && !body, 'logout method/bearer/body'); params({ scope: 'local' }); logouts++; res.writeHead(204); return res.end(); }
      check(bearer === good, 'database bearer');
      if (url.pathname === '/rest/v1/rpc/is_approved_owner') { check(req.method === 'POST' && body === '{}' && !url.search, 'owner RPC'); return reply(200, pin); }
      if (url.pathname === '/rest/v1/rpc/save_playlist_link') {
        check(req.method === 'POST' && !url.search, 'save RPC method/query');
        const parsed = JSON.parse(body); check(Object.keys(parsed).length === 1 && [playlistId, 'PLsecondvalid'].includes(parsed.id), 'save RPC body');
        if (failDatabase) return reply(500, { message: providerSecret });
        const id = parsed.id, created = !links.includes(id); if (created) links.push(id);
        return reply(200, [{ youtube_playlist_id: id, created_at: '2025-01-01T00:00:00Z', created, limit_reached: false }]);
      }
      if (url.pathname === '/rest/v1/playlist_links') {
        if (req.method === 'DELETE') { params({ youtube_playlist_id: `eq.${playlistId}` }); check(!body, 'delete body'); links = links.filter(id => id !== playlistId); res.writeHead(204); return res.end(); }
        check(req.method === 'GET' && !body, 'list method/body');
        const cursor = url.searchParams.get('or');
        params({ select: 'youtube_playlist_id,created_at', order: 'created_at.asc,youtube_playlist_id.asc', limit: '1000', ...(cursor ? { or: `(created_at.gt.2025-01-01T00:00:00Z,and(created_at.eq.2025-01-01T00:00:00Z,youtube_playlist_id.gt.${[...links].sort().at(-1)}))` } : {}) });
        return reply(200, cursor ? [] : [...links].sort().map(id => ({ youtube_playlist_id: id, created_at: '2025-01-01T00:00:00Z' })));
      }
      throw new Error(`unexpected synthetic endpoint ${url.pathname}`);
    } catch (error) { violations.push(error.message); return reply(400, { message: 'synthetic provider request rejected' }); }
  });
  t.after(() => assert.deepEqual(violations, [], 'synthetic provider rejected requests'));
  // Next's build/cache stays in a disposable copy rather than the user's checkout.
  for (const item of ['src', 'public', 'package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs']) {
    await cp(join(root, item), join(dir, item), { recursive: true });
  }
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const reservation = createServer(); const appPort = await listen(reservation); await new Promise(r => reservation.close(r));
  const base = `http://127.0.0.1:${appPort}`;
  child = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '-H', '127.0.0.1', '-p', String(appPort)], {
    cwd: dir, detached: true, env: { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--require=${join(root, 'tests/integration/network-guard.cjs')}`, TEST_PROVIDER_PORT: String(port), NEXT_PUBLIC_SUPABASE_URL: issuer, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', OWNER_USER_ID: owner, APP_ORIGIN: base, CSRF_HMAC_SECRET: 'ab'.repeat(32), YOUTUBE_API_KEY: apiKey }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Register immediately so fast exits and spawn failures cannot be missed during cleanup.
  childEnded = new Promise(resolve => { child.once('exit', resolve); child.on('error', () => { if (!child.pid) resolve(); }); });
  let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  let ready = false;
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) break; try { await fetch(base + '/api/auth/start', { redirect: 'manual', signal: AbortSignal.timeout(1000) }); ready = true; break; } catch { await new Promise(r => setTimeout(r, 200)); } }
  assert.ok(ready, `Next failed to start: ${output}`);
  const makeCookie = (access_token, expires_at) => `sb-127-auth-token=base64-${Buffer.from(JSON.stringify({ access_token, refresh_token: 'synthetic-refresh', expires_at, expires_in: 3600, token_type: 'bearer', user: { id: owner } })).toString('base64url')}`;
  const cookie = makeCookie(good, Math.floor(Date.now()/1000)+3600);
  const call = async (path, options = {}) => {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(10000), ...options }); const text = await res.text();
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.ok(!text.includes(apiKey) && !text.includes(providerSecret) && !text.includes(good));
    if (res.status >= 400) for (const [, value] of res.headers) assert.ok(!value.includes(apiKey) && !value.includes(providerSecret) && !value.includes(good));
    return { status: res.status, text, headers: res.headers };
  };
  const playlist = '/api/youtube/playlist?playlistId=' + playlistId;
  const suggestions = '/api/youtube/suggestions';
  const forged = good.replace(/\.c2ln$/, '.Zm9yZ2Vk');
  for (const [header, status] of [[undefined, 401], ['Basic bad', 401], [`Bearer ${forged}`, 401], [`Bearer ${expired}`, 401], [`Bearer ${nonowner}`, 403]]) {
    for (const [path, method] of [[playlist, 'GET'], [suggestions, 'POST']]) {
      const before = youtube, beforeAuth = auth;
      const response = await call(path, { method, headers: { ...(header ? { authorization: header } : {}), ...(header === 'Basic bad' ? { cookie } : {}) } });
      assert.equal(response.status, status, `${header} ${path}`); assert.equal(youtube, before);
      if (header === 'Basic bad') assert.equal(auth, beforeAuth, 'malformed bearer must not fall back to cookie');
    }
  }
  pin = false;
  for (const [path, method] of [[playlist, 'GET'], [suggestions, 'POST']]) { const before = youtube; assert.equal((await call(path, { method, headers: { authorization: `Bearer ${good}` } })).status, 503); assert.equal(youtube, before); }
  pin = true;
  for (const headers of [{ authorization: `Bearer ${good}` }, { cookie, 'x-tubeshuffle-intent': 'playlist' }]) {
    const before = youtube; const result = await call(playlist, { headers }); assert.equal(result.status, 200, result.text); assert.equal(JSON.parse(result.text).title, 'Synthetic playlist'); assert.ok(youtube > before);
  }
  const before = youtube;
  assert.equal((await call(suggestions, { method: 'POST', headers: { cookie, origin: 'http://evil.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await call('/api/playlist-links', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ playlistId }) })).status, 403);
  assert.equal(youtube, before);
  for (const invalid of badClaims) await t.test(`reject cookie claim ${['iss', 'aud', 'sub', 'session_id'][badClaims.indexOf(invalid)]}`, async () => {
    const result = await call('/api/auth/csrf', { headers: { cookie: makeCookie(invalid, Math.floor(Date.now()/1000)+3600) } });
    assert.equal(result.status, 403, `invalid cookie claims rejected: ${Buffer.from(invalid.split('.')[1], 'base64url').toString()}`);
  });
  const csrf = await call('/api/auth/csrf', { headers: { cookie } }); assert.equal(csrf.status, 200, csrf.text);
  const csrfToken = JSON.parse(csrf.text).csrfToken;
  const mutationHeaders = { cookie, origin: base, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
  assert.equal((await call('/api/playlist-links', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ playlistId }) })).status, 201);
  assert.equal((await call('/api/playlist-links', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ playlistId: 'PLsecondvalid' }) })).status, 201);
  assert.equal((await call('/api/playlist-links', { headers: { authorization: `Bearer ${good}` } })).status, 200);
  assert.equal((await call('/api/playlist-links/' + playlistId, { method: 'DELETE', headers: { authorization: `Bearer ${good}` } })).status, 204);
  const remaining = await call('/api/playlist-links', { headers: { authorization: `Bearer ${good}` } });
  assert.deepEqual(JSON.parse(remaining.text).links.map(x => x.youtubePlaylistId), ['PLsecondvalid']);
  failDatabase = true;
  assert.equal((await call('/api/playlist-links', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ playlistId }) })).status, 500);
  assert.equal(youtube, before);
  assert.equal((await call('/api/youtube/playlist?playlistId=PLerrorsecret', { headers: { authorization: `Bearer ${good}` } })).status, 502);
  const suggestionBody = { playlistId, dateKey: '2025-01-01', seeds: [{ title: 'Synthetic song', channelTitle: 'Synthetic artist' }], excludeVideoIds: ['excluded001'] };
  const suggestionOptions = { method: 'POST', headers: { authorization: `Bearer ${good}`, 'content-type': 'application/json' }, body: JSON.stringify(suggestionBody) };
  const successful = await call(suggestions, suggestionOptions);
  assert.equal(successful.status, 200, successful.text);
  assert.deepEqual(JSON.parse(successful.text).suggestions.map(x => x.youtubeId), ['synthetic01']);
  failYoutube = true;
  await t.test('non-403 upstream errors do not expose synthetic secrets', async () => {
    const regression = await call(suggestions, { ...suggestionOptions, body: JSON.stringify({ ...suggestionBody, dateKey: '2025-01-02' }) });
    assert.equal(regression.status, 502, regression.text);
  });
  assert.ok(auth > 0, 'actual auth SDK contacted synthetic provider');
  const refreshed = await call(playlist, { headers: { cookie: makeCookie(expired, 1), 'x-tubeshuffle-intent': 'playlist' } });
  assert.equal(refreshed.status, 200, refreshed.text); assert.ok(refreshes > 0); const refreshedSetCookie = refreshed.headers.get('set-cookie') || '';
  assert.match(refreshedSetCookie, /sb-127-auth-token=/);
  const replayCookie = refreshedSetCookie.split(';')[0];
  const refreshCount = refreshes;
  assert.equal((await call(playlist, { headers: { cookie: replayCookie, 'x-tubeshuffle-intent': 'playlist' } })).status, 200);
  assert.equal(refreshes, refreshCount, 'refreshed cookie replay must not refresh again');
  const logout = await call('/api/auth/logout', { method: 'POST', headers: { cookie, origin: base, 'x-csrf-token': csrfToken } });
  assert.equal(logout.status, 204, logout.text); assert.ok(logouts > 0); const cleared = logout.headers.get('set-cookie') || '';
  assert.match(cleared, /sb-127-auth-token=;/);
  assert.match(cleared, /(?:max-age=0|expires=Thu, 01 Jan 1970)/i);
  assert.match(cleared, /path=\//i);
  assert.match(cleared, /httponly/i);
  assert.match(cleared, /samesite=lax/i);
});
