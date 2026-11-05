// Preloaded into Node children: intercepts global fetch and net.Socket.connect.
// This is not an OS sandbox; native code, other network APIs and redirects may bypass it.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node preloads this guard as CommonJS.
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' ? first : { port: first, host: args[1] };
  if (!options.path && !['127.0.0.1', '::1', 'localhost'].includes(options.host)) {
    throw new Error('integration network guard blocked non-loopback connection');
  }
  return original.apply(this, args);
};
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin === 'https://www.googleapis.com') {
    url.protocol = 'http:';
    url.host = `127.0.0.1:${process.env.TEST_PROVIDER_PORT}`;
    return realFetch(url, init);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('integration network guard blocked fetch');
  return realFetch(input, init);
};
