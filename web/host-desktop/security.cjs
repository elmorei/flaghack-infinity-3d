'use strict';
const { randomBytes } = require('node:crypto');
const { isIP } = require('node:net');
const DEFAULT_PAGES_URL = 'https://elmorei.github.io/flaghack-infinity-3d/';
function httpsUrl(value, label) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) throw new Error(`${label} must be an HTTPS URL.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTPS URL.`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || host.endsWith('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isIP(host) || host.startsWith('[')) throw new Error(`${label} must use a public HTTPS hostname, without credentials.`);
  return url;
}
function pagesUrl(value = DEFAULT_PAGES_URL) {
  const url = httpsUrl(value, 'Game page');
  if (url.search || url.hash) throw new Error('Game page must not contain a query or fragment.');
  return url.href;
}
function publicOrigin(value) {
  const url = httpsUrl(value, 'Host endpoint');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Host endpoint must be an HTTPS origin, without a path, query or fragment.');
  return url.origin;
}
function settings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Host settings are required.');
  const name = typeof value.serverName === 'string' ? value.serverName.trim() : '';
  if (!name || name.length > 48 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Choose a host name with 1–48 printable characters.');
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port from 1024 to 65535.');
  if (value.mode !== 'quick' && value.mode !== 'existing') throw new Error('Choose a tunnel mode.');
  return { serverName: name, port, mode: value.mode, pagesUrl: pagesUrl(value.pagesUrl), endpoint: value.mode === 'existing' ? publicOrigin(value.endpoint) : null };
}
function password() { return randomBytes(24).toString('base64url'); }
function invite(client, endpoint, secret) { return `${pagesUrl(client)}#host=${encodeURIComponent(publicOrigin(endpoint))}&pw=${encodeURIComponent(secret)}`; }
function cleanLog(value, secret) {
  let line = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (secret) line = line.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
  return line.replace(/([#?&](?:pw|password|token)=)[^\s&]*/gi, '$1[redacted]').slice(0, 500);
}
function hostInfo(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.protocol) || typeof value.build !== 'string' || !value.build || value.build.length > 128 || typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 128 || !['lobby', 'playing', 'ended'].includes(value.phase) || !Number.isInteger(value.players) || value.players < 0 || value.players > 16 || !Number.isInteger(value.seated) || value.seated < 0 || value.seated > 4) throw new Error('Endpoint did not return a compatible FLAGHACK host.');
  return { protocol: value.protocol, build: value.build, instanceId: value.instanceId, phase: value.phase, players: value.players, seated: value.seated };
}
module.exports = { DEFAULT_PAGES_URL, pagesUrl, publicOrigin, settings, password, invite, cleanLog, hostInfo };
