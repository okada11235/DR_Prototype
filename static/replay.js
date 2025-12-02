// replay.js - recording_active_re.html用
// 再生機能、運転判定ロジックのシミュレーション、およびピン読み上げシミュレーションを担当します。
import { playRandomAudio } from './audio.js';
// ★ 修正：resetMotion をインポートに追加
import { detectDrivingPattern, resetMotion } from './sensors.js'; 

let logs = [];
let gpsLogs = []; // GPSログも格納
let playing = true;
let paused = false;
let timer = null;
let idx = 0;
let t0 = 0, t1 = 0, startReal = 0;

/**
 * サーバーから再生に必要なavg_g_logsとgps_logsを取得
 */
async function fetchLogs(sessionId, start, end) {
  const res = await fetch(`/api/replay_data/${sessionId}?start=${start}&end=${end}`);
  const json = await res.json();
  return {
    // avg_g_logsにはrot_zが含まれていることを期待
    avg: (json.avg_g_logs || []).sort((a,b)=>a.timestamp_ms - b.timestamp_ms),
    gps: (json.gps_logs || []).sort((a,b)=>a.timestamp - b.timestamp)
  };
}

/**
 * ミリ秒を MM:SS 形式にフォーマット
 */
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  // マイナス時間にならないようにMath.max
  const totalSeconds = Math.max(0, s); 
  return `${String(Math.floor(totalSeconds/60)).padStart(2,'0')}:${String(totalSeconds%60).padStart(2,'0')}`;
}

/**
 * UIのG値と速度を更新
 */
function updateUI(log) {
  document.getElementById('speed').textContent = (log.speed || 0).toFixed(1);
  document.getElementById('g-x').textContent = (log.g_x || 0).toFixed(2);
  document.getElementById('g-z').textContent = (log.g_z || 0).toFixed(2);
  document.getElementById('g-y').textContent = (log.g_y || 0).toFixed(2);
}

/**
 * 再生ループのメインステップ
 */
function step() {
  if (!playing || paused) return;

  const now = Date.now();
  // 仮想時刻: ログの開始時刻(t0) + (実時間経過)
  const virtualT = t0 + (now - startReal);
  
  // UIのタイマーを更新
  document.getElementById('timer').textContent = fmt(virtualT - t0); 

  let prevLog = idx > 0 ? logs[idx - 1] : null;

  while (idx < logs.length && logs[idx].timestamp_ms <= virtualT) {
    const log = logs[idx];
    updateUI(log);

    // --- ★ 判定ロジックを動かす ★ ---
    const gx = log.g_x;
    const gy = log.g_y;
    const gz = log.g_z;
    const speed = log.speed;
    const rotZ = log.rot_z || 0; // avg_g_logsに保存されている平均角速度を使用

    const deltaSpeed = log.delta_speed ?? 0; // Firestoreに保存したdeltaSpeedを使う（最新版）

    // 保存されてるデータから計算し直して判定する（旧）
    // let deltaSpeed = 0;
    // if (prevLog) {
    //     const dt = (log.timestamp_ms - prevLog.timestamp_ms) / 1000; // 秒
    //     if (dt > 0) {
    //         // deltaSpeed は km/h/s (加速度)
    //         deltaSpeed = (speed - prevLog.speed) / dt; 
    //     }
    // }

    // ★ 修正点2: 直近のログをスライスして渡す (100ms間隔で30サンプル=3秒 + 現在ログ)
    const recentLogs = logs.slice(Math.max(0, idx - 30), idx + 1);
    
    // sensors.jsの判定関数を実行。8番目の引数に過去ログを渡す。
    const event = detectDrivingPattern(gx, gy, gz, speed, deltaSpeed, rotZ, virtualT, recentLogs); 

    if (event && event !== 'normal') {
      console.log("判定イベント:", event);
      // ★ 修正箇所: playRandomAudio のコメントアウトを解除
      playRandomAudio(event); 
    }

    // --- ★ ピン読み上げも追加 ---
    const gps = getNearestGps(log.timestamp_ms);
    // GPSデータが利用可能であれば、ピンの通知をシミュレーション
    if (gps) checkPinSpeech(gps.latitude, gps.longitude);

    idx++;
    prevLog = log;
  }

  // 終了条件 (ログの末尾に達した、または指定の終了時刻を超えた)
  if (idx >= logs.length || virtualT >= t1) {
    // 終了ボタンの処理を再利用してリダイレクト
    stopAndRedirect();
  }
}

/**
 * 再生開始処理
 */
function start(sessionId, startMs, endMs) {
  // ★ 修正点3: 再生開始前に sensors.js の状態をリセット
  if (typeof resetMotion === 'function') {
      resetMotion();
      console.log('✅ Motion state reset for replay.');
  }
  
  t0 = startMs; t1 = endMs; idx = 0; playing = true; paused = false;
  startReal = Date.now();
  timer = setInterval(step, 100);
}

/**
 * 再生停止処理（リダイレクトなし）
 */
function stop() {
  playing = false;
  paused = false;
  if (timer) clearInterval(timer);
  // UI IDを 'timer' に修正（HTMLに合わせる）
  document.getElementById('timer').textContent = '00:00'; 
}

/**
 * 停止ボタン押下時、または自動再生終了時の停止＆リダイレクト処理
 */
function stopAndRedirect() {
    stop(); // まず再生を停止

    const sessionId = window.replaySessionId;
    const startMs = parseInt(window.replayStart);
    const endMs = parseInt(window.replayEnd);

    // 正しいリザルトページ（/result/{sessionId}/replay）にリダイレクト
    window.location.href = `/result/${sessionId}/replay?start=${startMs}&end=${endMs}`;
}

// function pause() { ... } はHTMLで使われていないため省略

// ===================================
// DOMContentLoaded: 初期化とイベント設定
// ===================================
window.addEventListener('DOMContentLoaded', async () => {
  const sessionId = window.replaySessionId;
  const startMs = parseInt(window.replayStart);
  const endMs = parseInt(window.replayEnd);
  // window.replaySessionStart は step()内で使用

  await loadPins();

  const data = await fetchLogs(sessionId, startMs, endMs);
  logs = data.avg;
  gpsLogs = data.gps;

  // alert()の代わりにconsole.errorを使用
  if (logs.length === 0) {
    console.error("この範囲にはデータがありません。");
    // UIを初期状態のままにする
    return;
  }

  // 終了ボタンのID 'StopBtn' にイベントを割り当て
  const stopButton = document.getElementById('StopBtn');
  if (stopButton) {
      stopButton.onclick = () => {
          // alert/confirmは使えませんが、カスタムモーダルUIが必要です。ここでは確認なしで進めます。
          // if (!confirm("再生を終了して結果画面に戻りますか？")) {
          //     return;
          // }
          stopAndRedirect();
      };
  } else {
      console.warn("⚠️ StopBtn (記録を終了するボタン) が見つかりません。");
  }

  // データがあれば再生開始
  start(sessionId, startMs, endMs);
});


// --- ピン読み上げ関連（session.js から移植） ---
let pins = [];
let notifiedPins = new Set();

async function loadPins() {
  const res = await fetch("/api/get_pins_all");
  const json = await res.json();
  pins = json.pins || [];
}

/** 2点間の距離をメートルで計算 (ヒュベニの公式簡略版) */
function distance(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const lat1 = aLat * Math.PI / 180;
  const lat2 = bLat * Math.PI / 180;

  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1)*Math.cos(lat2) *
            Math.sin(dLng/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/** TTSによる読み上げ (シミュレーション用) */
function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    speechSynthesis.speak(u);
  } catch(e) {
    console.warn("TTS failed in replay mode:", e);
  }
}

/** 現在地に基づいてピンの読み上げをチェック */
function checkPinSpeech(lat, lng) {
  for (const p of pins) {
    // 半径20m以内
    const d = distance(lat, lng, p.lat, p.lng);
    if (d < 20 && !notifiedPins.has(p.id)) {
      notifiedPins.add(p.id);
      console.log("📢 ピン読み上げシミュレーション:", p.label);
      speak(p.label);
    }
  }
}

/** 仮想時刻に最も近いGPSログを取得 */
function getNearestGps(timestamp) {
  if (!gpsLogs || gpsLogs.length === 0) return null;

  let best = null;
  let minDiff = Infinity;

  for (const g of gpsLogs) {
    const diff = Math.abs((g.timestamp || 0) - timestamp);
    if (diff < minDiff) {
      minDiff = diff;
      best = g;
    }
  }
  
  // 5秒以上離れていたら無視
  if (minDiff > 5000) { 
      return null;
  }
  
  return best;
}