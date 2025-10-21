// replay.js - recording_active_re.html用
import { playRandomAudio, autoUnlockAudio } from './audio.js';
autoUnlockAudio();

let logs = [];
let playing = true;
let paused = false;
let timer = null;
let idx = 0;
let t0 = 0, t1 = 0, startReal = 0;

async function fetchLogs(sessionId, start, end) {
  const res = await fetch(`/api/replay_data/${sessionId}?start=${start}&end=${end}`);
  const json = await res.json();
  return (json.avg_g_logs || []).sort((a,b)=>a.timestamp_ms-b.timestamp_ms);
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function updateUI(log) {
  document.getElementById('speed').textContent = (log.speed || 0).toFixed(1);
  document.getElementById('g-x').textContent = (log.g_x || 0).toFixed(2);
  document.getElementById('g-z').textContent = (log.g_z || 0).toFixed(2);
  document.getElementById('g-y').textContent = (log.g_y || 0).toFixed(2);
}

function step() {
  if (!playing || paused) return;

  const now = Date.now();
  const virtualT = t0 + (now - startReal);
  document.getElementById('uiClock').textContent = fmt(virtualT - t0);

  while (idx < logs.length && logs[idx].timestamp_ms <= virtualT) {
    const log = logs[idx];
    updateUI(log);

    if (log.event && log.event !== 'normal') {
      playRandomAudio(log.event, false);
    }
    idx++;
  }

  if (idx >= logs.length || virtualT >= t1) stop();
}

function start(sessionId, startMs, endMs) {
  t0 = startMs; t1 = endMs; idx = 0; playing = true; paused = false;
  startReal = Date.now();
  timer = setInterval(step, 100);
}

function stop() {
  playing = false;
  if (timer) clearInterval(timer);
  document.getElementById('uiClock').textContent = '00:00';
}

function pause() {
  paused = !paused;
  if (paused && timer) clearInterval(timer);
  else if (!paused) startReal = Date.now() - ((Date.now() - startReal) % (t1 - t0));
}

window.addEventListener('DOMContentLoaded', async () => {
  const sessionId = window.replaySessionId;
  const startMs = parseInt(window.replayStart);
  const endMs = parseInt(window.replayEnd);

  logs = await fetchLogs(sessionId, startMs, endMs);
  if (logs.length === 0) {
    alert('指定範囲にデータがありません。');
    return;
  }
  start(sessionId, startMs, endMs);
  document.getElementById('btnPause').onclick = pause;
  document.getElementById('btnStop').onclick = stop;
});
