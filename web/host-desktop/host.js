'use strict';
const $ = id => document.getElementById(id);
let latest, feedbackTimer, qrInvite = null;
function feedback(text) { clearTimeout(feedbackTimer); $('feedback').textContent = text; feedbackTimer = setTimeout(() => { $('feedback').textContent = ''; }, 3500); }
function displayQr(state) {
  const invite = state.status === 'running' ? state.invite : null;
  if (invite === qrInvite) return;
  qrInvite = invite;
  const canvas = $('qr-canvas');
  $('invite-qr').hidden = true;
  $('qr-error').hidden = true;
  canvas.width = canvas.height = 0; // Erase the previous room's password on stop/restart.
  if (!invite) return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(invite);
    qr.make();
    const count = qr.getModuleCount(), quiet = 4;
    const scale = Math.max(3, Math.ceil(280 / (count + quiet * 2)));
    canvas.width = canvas.height = (count + quiet * 2) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
    $('invite-qr').hidden = false;
  } catch {
    $('qr-error').hidden = false;
  }
}
function display(state) {
  latest = state;
  displayQr(state);
  const active = ['starting', 'running', 'stopping'].includes(state.status);
  $('settings').disabled = active;
  $('start').disabled = active;
  $('stop').disabled = !['starting', 'running'].includes(state.status);
  $('start').textContent = state.status === 'starting' ? 'Starting…' : 'Start hosting';
  $('stop').textContent = state.status === 'starting' ? 'Cancel start' : 'Stop match';
  $('status').textContent = state.stage;
  $('badge').textContent = state.status === 'running' ? 'ONLINE' : state.status.toUpperCase();
  $('badge').classList.toggle('online', state.status === 'running');
  $('error').textContent = state.error || '';
  $('error').hidden = !state.error;
  $('online').hidden = state.status !== 'running';
  $('public-origin').value = state.endpoint || '';
  $('password').value = state.password || '';
  if (state.status !== 'running') { $('password').type = 'password'; $('reveal').textContent = 'Show'; $('feedback').textContent = ''; }
  $('phase').textContent = (state.info?.phase || 'lobby').toUpperCase();
  $('players').textContent = state.info?.players ?? 0;
  $('seated').textContent = state.info?.seated ?? 0;
  $('logs').textContent = state.logs.join('\n') || 'No events yet.';
  if (state.info) $('build').textContent = `Host build ${state.info.build} · protocol ${state.info.protocol}. If the Pages game reports a mismatch, download the matching latest host app and reload the page.`;
}
function formMode() { const quick = $('mode').value === 'quick'; $('quick-note').hidden = !quick; $('existing-fields').hidden = quick; $('endpoint').required = !quick; }
function showError(error) { $('error').textContent = error?.message || 'That action did not complete. Please try again.'; $('error').hidden = false; }
$('setup').addEventListener('submit', async event => {
  event.preventDefault();
  if (latest && ['starting', 'running', 'stopping'].includes(latest.status)) return;
  $('start').disabled = true;
  try { display(await window.matchHost.start({ serverName: $('name').value, port: Number($('port').value), mode: $('mode').value, endpoint: $('endpoint').value.trim(), pagesUrl: $('pages').value.trim() })); } catch (error) { showError(error); $('start').disabled = false; }
});
$('stop').addEventListener('click', async () => { try { display(await window.matchHost.stop()); } catch (error) { showError(error); } });
$('copy').addEventListener('click', async () => { try { await window.matchHost.copyInvite(); feedback('Invite copied'); } catch (error) { showError(error); } });
$('copy-password').addEventListener('click', async () => { try { await window.matchHost.copyPassword(); feedback('Password copied'); } catch (error) { showError(error); } });
$('open').addEventListener('click', async () => { try { await window.matchHost.openGame(); } catch (error) { showError(error); } });
$('reveal').addEventListener('click', () => { const showing = $('password').type === 'password'; $('password').type = showing ? 'text' : 'password'; $('reveal').textContent = showing ? 'Hide' : 'Show'; });
$('mode').addEventListener('change', formMode);
$('port').addEventListener('input', () => { $('local-target').textContent = `Local forwarding target: http://127.0.0.1:${$('port').value}`; });
window.matchHost.onState(display);
window.matchHost.get().then(state => { $('version').textContent = `v${state.version}`; display(state); }).catch(showError);
formMode();

