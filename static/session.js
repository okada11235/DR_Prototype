// session.js - セッション管理機能

import { stopMotionDetection, startMotionDetection, startAutoCalibration, performInitialCalibration } from './sensors.js';
import { watchPosition, calculateDistance } from './maps.js';
import { startTimer, stopTimer, formatTime, calculateStability } from './utils.js';
import { unlockAudio, stopAudioSystem } from './audio.js'; // FIX: stopAudioSystemをimport
import { resetState } from './state.js';
import { stopGPSWatch } from './maps.js';


console.log('=== session.js LOADED [FIXED] ===');

// ✅ iOS用アンロックイベント（audio.jsのunlockAudioを使用）
document.addEventListener("touchstart", unlockAudio, { once: true });

// ✅ iOS & Android モーション許可リクエスト
async function requestMotionPermission(callback) {
  const preGranted = localStorage.getItem('perm_motion') === 'granted';
  if (preGranted) {
    console.log("✅ Motion permission already granted (from login)");
    return void callback();
  }

  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const response = await DeviceMotionEvent.requestPermission();
      if (response === 'granted') {
        localStorage.setItem('perm_motion', 'granted');
        console.log("✅ Motion permission granted (iOS)");
        callback();
      } else {
        localStorage.setItem('perm_motion', 'denied');
        alert('加速度センサーの使用が許可されませんでした。');
      }
    } catch (err) {
      console.error('Motion permission request error:', err);
      alert('加速度センサーの使用許可リクエストでエラーが発生しました。');
    }
  } else {
    console.log("✅ Motion permission not required (Android or Desktop)");
    callback();
  }
}

// 重点ポイント取得機能
function getFocusPoint() {
    const focusCheckboxes = document.querySelectorAll('input[name="focus"]:checked');
    if (focusCheckboxes.length > 0) {
        return focusCheckboxes[0].value;
    }
    return '';
}

// === GPS監視を開始する関数 ===
function startGPSWatch() {
    if (window.watchId) {
        navigator.geolocation.clearWatch(window.watchId);
    }

    if (!('geolocation' in navigator)) {
        console.warn('⚠️ この端末ではGPSが利用できません');
        return;
    }

    window.watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const { latitude, longitude, speed } = pos.coords;
            const timestamp = Date.now();
            const kmh = speed !== null ? speed * 3.6 : 0;

            const gxs = window.latestGX || 0;
            const gys = window.latestGY || 0;
            const gzs = window.latestGZ || 0;

            const log = {
                latitude,
                longitude,
                speed: kmh,
                timestamp: timestamp,
                g_x: gxs,
                g_y: gys,
                g_z: gzs,
                event: 'normal'
            };

            window.gpsLogBuffer = window.gpsLogBuffer || [];
            window.gpsLogBuffer.push(log);

            window.currentSpeed = kmh;

            console.log(`📍 GPS更新: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} (${kmh.toFixed(1)} km/h)`);
        },
        (err) => {
            console.error('⚠️ GPS取得エラー:', err);
        },
        {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 10000
        }
    );

    console.log('✅ GPS監視を開始しました');
}

// === 記録開始 ===
export async function startSession() {
    console.log('=== startSession (async) called ===');

    // 前回セッション情報をクリア
    localStorage.removeItem('activeSessionId');
    localStorage.removeItem('sessionStartTime');
    localStorage.removeItem('lastSessionData');
    window.sessionId = null;

    // 二重起動ガード
    if (window.isSessionStarting) {
        alert('セッション開始処理中です。しばらくお待ちください。');
        return null;
    }
    window.isSessionStarting = true;

    const startButton = document.getElementById('start-button');
    if (startButton) {
        startButton.disabled = true;
        startButton.textContent = '開始中...';
    }

    try {
        // ① 音声アンロック（iOS用・失敗しても致命的ではない）
        try {
            unlockAudio();
        } catch (e) {
            console.warn('unlockAudio failed:', e);
        }

        // ② モーション許可（iOS）
        await new Promise((resolve) => {
            requestMotionPermission(resolve);
        });
        console.log('Motion permission granted');

        performInitialCalibration(async () => {

            console.log('Sending session start request...');
            let data;

            try {
                const res = await fetch('/sessions/start', { method: 'POST' });
                if (!res.ok) throw new Error('サーバーエラー');
                data = await res.json();
            } catch (err) {
                alert('記録開始時にエラーが発生しました：' + err.message);
                window.isSessionStarting = false;
                if (startButton) {
                    startButton.disabled = false;
                    startButton.textContent = '記録開始';
                }
                return;
            }

            window.sessionId = data.session_id;
            window.startTime = Date.now();
            localStorage.setItem('activeSessionId', window.sessionId);
            localStorage.setItem('sessionStartTime', window.startTime.toString());

            resetState();
            window.gLogBuffer = [];
            window.gpsLogBuffer = [];
            window.avgGLogBuffer = [];
            window.path = [];

            startMotionDetection();
            startGPSWatch();

            window.isSessionStarting = false;
            window.location.href = '/recording/active';
        });
        console.log('Calibration finished');

        // ④ サーバーにセッション開始リクエスト
        console.log('Sending session start request...');
        const res = await fetch('/start', { method: 'POST' });
        if (!res.ok) throw new Error('サーバーエラー');
        const data = await res.json();

        // ⑤ セッションID保持
        window.sessionId = data.session_id;
        window.startTime = Date.now();
        localStorage.setItem('activeSessionId', window.sessionId);
        localStorage.setItem('sessionStartTime', window.startTime.toString());

        console.log('✅ session started, id =', window.sessionId);

        // ここでは画面遷移もセンサー起動もしない
        // => 呼び出し元（recording_start.html）でやる
        return window.sessionId;

    } catch (err) {
        console.error('startSession error:', err);
        alert('記録開始時にエラーが発生しました：' + err.message);
        return null;

    } finally {
        // フラグとボタン状態を戻す
        window.isSessionStarting = false;
        if (startButton) {
            startButton.disabled = false;
            startButton.textContent = '運転開始';
        }
    }
}

// === 記録終了 ===
export async function endSession() {

    console.log("=== endSession CALLED ===");

    if (window.isEndingSession) return;
    window.isEndingSession = true;

    stopMotionDetection();
    stopGPSWatch();
    stopTimer();

    await flushLogsNow();

    const sessionId = window.sessionId;
    if (!sessionId) {
        console.error("No sessionId at endSession");
        window.isEndingSession = false;
        return;
    }

    let data;
    try {
        const res = await fetch('/sessions/end', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId })
        });
        data = await res.json();
        console.log("END session response:", data);
    } catch (err) {
        alert("終了時にエラー発生: " + err.message);
        window.isEndingSession = false;
        return;
    }

    localStorage.removeItem('activeSessionId');
    localStorage.removeItem('sessionStartTime');

    window.sessionId = null;

    window.location.href = `/recording/completed?session_id=${data.session_id}`;
}

// === 定期ログフラッシュ ===
export function startLogFlush() {
    if (window.logFlushInterval) clearInterval(window.logFlushInterval);
    window.logFlushInterval = setInterval(() => {
        console.log(`Interval flush check: sessionId=${window.sessionId}, G buffer=${window.gLogBuffer.length}, AVG buffer=${window.avgGLogBuffer?.length || 0}, GPS buffer=${window.gpsLogBuffer.length}`);

        if (!window.sessionId) {
            console.log('No session ID available for log flush');
            return;
        }

        // Gログ
        if (window.gLogBuffer.length > 0) {
            const logsToSend = window.gLogBuffer.splice(0, window.gLogBuffer.length);
            fetch('/sessions/log_g_only', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: window.sessionId, g_logs: logsToSend })
            });
        }

        // AVG-G
        if (window.avgGLogBuffer && window.avgGLogBuffer.length > 0) {
            const avgToSend = window.avgGLogBuffer.splice(0, window.avgGLogBuffer.length);
            fetch('/sessions/log_avg_g_bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: window.sessionId, avg_g_logs: avgToSend })
            });
        }

        // GPSログ
        if (window.gpsLogBuffer.length > 0) {
            const logsToSend = window.gpsLogBuffer.splice(0, window.gpsLogBuffer.length);
            fetch('/sessions/log_gps_bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: window.sessionId, gps_logs: logsToSend })
            });
        }

    }, 60000);
}

// === 即時ログフラッシュ（終了時） ===
export async function flushLogsNow() {
    console.log("=== flushLogsNow CALLED ===");

    if (!window.sessionId) {
        console.warn("No sessionId, skip flush");
        return;
    }

    if (window.gLogBuffer.length > 0) {
        const logs = window.gLogBuffer.splice(0, window.gLogBuffer.length);
        await fetch('/sessions/log_g_only', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: window.sessionId, g_logs: logs })
        });
    }

    if (window.avgGLogBuffer?.length > 0) {
        const logs = window.avgGLogBuffer.splice(0, window.avgGLogBuffer.length);
        await fetch('/sessions/log_avg_g_bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: window.sessionId, avg_g_logs: logs })
        });
    }

    if (window.gpsLogBuffer.length > 0) {
        const logs = window.gpsLogBuffer.splice(0, window.gpsLogBuffer.length);
        await fetch('/sessions/log_gps_bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: window.sessionId, gps_logs: logs })
        });
    }

    console.log("=== flushLogsNow COMPLETED ===");
}

export function startPraiseCheck() {
    console.log("⏸️ 定期褒めチェックは無効化されています。");
}

// === 現在地に仮ピンを追加 ===
window.addVoicePin = async function(lat, lng) {
  console.log("📍 addVoicePin() 実行:", lat, lng);

  try {
    const res = await fetch("/api/add_drive_pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: lat,
        lng: lng,
        label: "", // 仮ピンなので未入力
      }),
    });

    const result = await res.json();
    if (result.status === "success") {
      console.log("✅ Firestoreに仮ピンを追加:", result.pin_id);

      // 🔊 ピン追加音
      const audio = new Audio("/static/audio/pin_set.wav");
      audio.volume = 0.8;
      audio.play().catch(() => console.warn("音声再生スキップ"));

      // 🔵 UI上でも地図に追加（録音中の地図がある場合）
      if (window.map && google?.maps) {
        new google.maps.Marker({
          position: { lat, lng },
          map: window.map,
          icon: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
        });
      }
    } else {
      console.warn("❌ Firestore保存失敗:", result.error);
    }
  } catch (err) {
    console.error("❌ addVoicePin エラー:", err);
  }
};

// === ピン設置ボタン処理 ===
document.addEventListener("DOMContentLoaded", () => {
  const pinBtn = document.getElementById("addPinBtn");
  if (!pinBtn) {
    console.warn("⚠️ addPinBtn が見つかりません。HTML読み込み順を確認してください。");
    return;
  }

  pinBtn.addEventListener("click", () => {
    console.log("📍 ピンボタンが押されました");

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          console.log(`✅ 現在地取得成功: ${latitude}, ${longitude}`);

          // 🔊 効果音
          try {
            const audio = new Audio("/static/audio/pin_set.wav");
            audio.play();
          } catch (e) {
            console.warn("🎵 効果音再生失敗:", e);
          }

          // 🔹 ピンを追加（maps.jsの関数利用）
          if (window.addVoicePin) {
            window.addVoicePin(latitude, longitude);
            console.log("📍 addVoicePin() 呼び出し完了");
          } else {
            console.warn("⚠️ addVoicePin 未定義です");
          }
        },
        (err) => {
          console.error("❌ 現在地取得失敗:", err);
          alert("位置情報の取得に失敗しました。許可設定を確認してください。");
        },
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
      );
    } else {
      alert("この端末では位置情報が利用できません。");
    }
  });
});

// === ピン付近読み上げ機能 ========================================

// 音声読み上げ有効/無効の切替（別途UIでON/OFF予定）
let speakEnabled = true;

// ピンデータキャッシュ
let pinsData = [];
let notifiedPins = new Set(); // 一度読み上げたピンを記録
// ユーザー別読み上げ設定キャッシュ（{ speak_levels: { '1':true, '2':true, '3':true } }）
window.userSpeakSettings = window.userSpeakSettings || null;

async function loadUserSpeakSettings() {
  try {
    const res = await fetch('/api/user_speak_settings');
    const data = await res.json();
    if (data.status === 'success') {
      window.userSpeakSettings = data.settings;
      console.log('✅ userSpeakSettings loaded:', window.userSpeakSettings);
    } else {
      console.warn('⚠️ userSpeakSettings取得失敗 (status!=success)');
    }
  } catch (e) {
    console.warn('⚠️ userSpeakSettings取得エラー:', e);
  }
}

// Firestoreからピン情報を取得
async function loadPinsFromFirestore() {
  try {
    const res = await fetch("/api/get_pins_all");
    const data = await res.json();
    if (data.status === "success") {
      pinsData = data.pins;
      console.log(`📍 ${pinsData.length} 個のピンを読み込み完了`);
    } else {
      console.warn("❌ ピンデータ取得失敗:", data.error);
    }
  } catch (err) {
    console.error("🔥 ピン取得エラー:", err);
  }
}

// 2点間の距離をメートル単位で計算（Haversine formula）
function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球半径（m）
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// レベル別半径（既定）
// 距離判定はレベルに関係なく固定30m
function getPinSpeakRadius(_pin) {
  return 30;
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function matchDay(days, dayIdx) {
  if (!Array.isArray(days) || days.length === 0) return true; // 指定なし→毎日
  return days.includes(dayIdx);
}

// 時間帯判定（空なら常に可）
function shouldSpeakNow(pin, now = new Date()) {
  const windows = Array.isArray(pin.speak_time_windows) ? pin.speak_time_windows : [];
  if (!windows.length) return true;
  const nowMin = minutesOfDay(now);
  const dayIdx = now.getDay(); // 0=Sun
  for (const w of windows) {
    const s = w?.start; const e = w?.end;
    if (typeof s !== 'string' || typeof e !== 'string' || s.length !== 5 || e.length !== 5) continue;
    const [sh, sm] = s.split(':').map((n) => parseInt(n, 10));
    const [eh, em] = e.split(':').map((n) => parseInt(n, 10));
    if ([sh, sm, eh, em].some((v) => Number.isNaN(v))) continue;
    if (!matchDay(w.days, dayIdx)) continue;
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin === endMin) return true; // 24h指定として扱う
    if (startMin < endMin) {
      if (nowMin >= startMin && nowMin < endMin) return true;
    } else {
      // 日跨ぎ 例: 22:00-02:00
      if (nowMin >= startMin || nowMin < endMin) return true;
    }
  }
  return false;
}

// === レベル別読み上げ文言生成 ===
function buildSpeakText(pin) {
  const label = (pin.label || '').trim();
  const lvl = Number(pin.priority_level || 1);
  if (label) {
    if (lvl === 3) return `重要地点、${label}`;
    if (lvl === 2) return `注意、${label}`;
    return `${label} 付近です`;
  }
  // ラベル未設定時は汎用フレーズ（不自然な「ピン地点です 付近です」を回避）
  if (lvl === 3) return `重要地点の付近です`;
  if (lvl === 2) return `注意ポイントの付近です`;
  return `ポイントの付近です`;
}

// === レベル別音声オプション適用 ===
function applyVoiceOptions(utter, pin) {
  const lvl = Number(pin.priority_level || 1);
  if (lvl === 3) { // 重要
    utter.rate = 0.95;
    utter.pitch = 1.0;
  } else if (lvl === 2) { // 注意
    utter.rate = 1.0;
    utter.pitch = 1.0;
  } else { // 付近 (軽め)
    utter.rate = 1.05;
    utter.pitch = 1.05;
  }
}

// ピンとの距離を監視してレベル別半径以内なら読み上げ
function monitorProximity() {
  if (!navigator.geolocation) {
    console.warn("⚠️ 位置情報が利用できません");
    return;
  }

  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      if (!pinsData.length) return;

      // 条件を満たす候補を収集し、ラベルありを優先して最短距離を1件だけ読み上げ
      const candidates = [];
      for (const pin of pinsData) {
        const distance = calcDistance(latitude, longitude, pin.lat, pin.lng);
        if (distance <= 30 && !notifiedPins.has(pin.id) && shouldSpeakNow(pin)) {
          candidates.push({ pin, distance, labelTrim: (pin.label || '').trim() });
        }
      }

      if (!candidates.length) return;

      // ユーザー設定・speak_enabled・coaching再生中などの条件を事前フィルタ
      const allowed = candidates.filter(({ pin }) => {
        if (!speakEnabled || !pin.speak_enabled || !("speechSynthesis" in window)) return false;
        if (window.isAudioPlaying) return false; // coaching優先
        const lvlKey = String(pin.priority_level || '1');
        const speakLevels = window.userSpeakSettings?.speak_levels;
        if (speakLevels && speakLevels[lvlKey] === false) return false;
        return true;
      });
      if (!allowed.length) return;

      // ラベルありを優先して最短距離を選ぶ
      const withLabel = allowed.filter(c => c.labelTrim.length > 0);
      const pool = withLabel.length ? withLabel : allowed; // ラベル無ししかなければそれで選ぶ
      pool.sort((a, b) => a.distance - b.distance);
      const { pin: chosen, distance: dist } = pool[0];

      console.log(`📢 ピンに接近: label="${(chosen.label||'').trim() || '（未入力）'}" 距離=${Math.round(dist)}m lvl=${chosen.priority_level||1}`);

      try {
        const text = buildSpeakText(chosen);
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = "ja-JP";
        applyVoiceOptions(utter, chosen);
        if (speechSynthesis.speaking) speechSynthesis.cancel();
        window.isPinSpeaking = true;
        utter.onend = () => { window.isPinSpeaking = false; };
        utter.onerror = () => { window.isPinSpeaking = false; };
        speechSynthesis.speak(utter);
        console.debug("🗣️ ピン読み上げ開始", { id: chosen.id, text });
      } catch (e) {
        window.isPinSpeaking = false;
        console.warn("⚠️ ピン読み上げ開始に失敗", e);
      }

      // 一定時間再読み上げしない
      notifiedPins.add(chosen.id);
      setTimeout(() => notifiedPins.delete(chosen.id), 60000);
    },
    (err) => console.error("❌ 位置監視エラー:", err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
}

// === ページ判定：recording_active.html のみで実行 ===
const isActive = document.body.dataset.page === "recording_active";
if (isActive) {
  console.log("🟡 このページではピン監視機能を無効化します:", window.location.pathname);
}

// 初期化
window.addEventListener("load", async () => {
  if (isActive) {
    console.log("✅ ピン監視・読み上げ機能を起動");
    await loadPinsFromFirestore();
    await loadUserSpeakSettings();
    monitorProximity();
  } else {
    console.log("🚫 recording_active 以外のページでは読み上げ機能をスキップ");
  }
});
