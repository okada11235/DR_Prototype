// sensors.js - 高精度判定（200ms平均＋σ=3＋キャリブ＋avg_g_logs＋8分類）
// ====================================================================

import {
  MOTION_FRAME_SKIP,
  AUDIO_COOLDOWN_MS,
  COOLDOWN_MS,
  GOOD_ACCEL_MIN_G,
  GOOD_ACCEL_MAX_G,
  GOOD_BRAKE_MIN_G,
  GOOD_BRAKE_MAX_G,
  GOOD_TURN_MIN_G,
  GOOD_TURN_MAX_G,
  SUDDEN_ACCEL_G_THRESHOLD,
  SUDDEN_BRAKE_G_THRESHOLD,
  SHARP_TURN_G_THRESHOLD
} from './config.js';
import { playRandomAudio } from './audio.js';
import { updateRealtimeScore } from './utils.js';

console.log('=== sensors.js (高精度8分類+avg_g_logs) LOADED ===');

// =======================
// 内部状態
// =======================
let motionInitialized = false;
let sampleCount = 0;

let isCalibrating = false;
let calibrationSamples = [];
let gravityOffset = { x: 0, y: 0, z: 0 };   // 3秒平均で決める重力ベクトル
let orientationMode = 'unknown';            // 姿勢（portrait/landscape/flat など）

let lastEventTime = 0;                      // 判定のクールダウン管理
let lastAudioTime = 0;

// 200ms移動平均 + σ=3 外れ値除去用バッファ
const gWindow = [];                         // {t, x, y, z}
const WINDOW_MS = 200;
const SIGMA = 3;
let smoothedG = { x: 0, y: 0, z: 0 };

// 速度 / 角速度の履歴（判定用）
const speedHistory = [];                    // {t, speed(km/h)}
const rotationHistory = [];                 // {t, rotZ}
const SPEED_WINDOW_MS = 1500;
const ROT_WINDOW_MS = 1500;

// Firestore バッファ（session.js が10秒ごとに送信）
if (!window.gLogBuffer) window.gLogBuffer = [];
if (!window.avgGLogBuffer) window.avgGLogBuffer = [];

// =======================
// キャリブレーション
// =======================

/** 起動時3秒の自動キャリブレーション開始 */
export function startAutoCalibration() {
  isCalibrating = true;
  calibrationSamples = [];
  console.log('📱 自動キャリブレーション開始（3秒間）');

  setTimeout(() => {
    if (calibrationSamples.length >= 15) {
      // 平均ベクトル＝重力ベクトルとみなす
      const avg = meanVector(calibrationSamples);
      gravityOffset = { ...avg };
      orientationMode = detectOrientation(avg).mode;
      console.log('✅ キャリブ完了: gravityOffset=', gravityOffset, ' / orientation=', orientationMode);
    } else {
      console.warn('⚠️ キャリブ失敗: サンプル不足');
      gravityOffset = { x: 0, y: 0, z: 0 };
      orientationMode = 'unknown';
    }
    isCalibrating = false;
  }, 3000);
}

/** サンプルの平均ベクトル */
function meanVector(samples) {
  const s = samples.reduce((a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }), { x: 0, y: 0, z: 0 });
  const n = samples.length || 1;
  return { x: s.x / n, y: s.y / n, z: s.z / n };
}

/** 端末の姿勢モード推定 */
function detectOrientation(avg) {
  const { x, y, z } = avg;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (az > ax && az > ay) return { mode: 'flat' };
  if (ax > ay && ax > az) return { mode: x > 0 ? 'landscape_left' : 'landscape_right' };
  if (ay > ax && ay > az) return { mode: y > 0 ? 'portrait_up' : 'portrait_down' };
  return { mode: 'unknown' };
}

/** 重力オフセット除去 ＋ 姿勢による軸の整列（前後=+Z、左右=+X を意識） */
function applyOrientationCorrection(gx, gy, gz) {
  // 1) 重力を引く（静止時に ~0 付近になる）
  gx -= gravityOffset.x;
  gy -= gravityOffset.y;
  gz -= gravityOffset.z;

  // 2) 端末姿勢に合わせて「左右G=+X」「前後G=+Z」を揃える（必要最小限）
  switch (orientationMode) {
    case 'landscape_left':   // 端末左が上
      return { gx: gz, gy, gz: -gx };
    case 'landscape_right':  // 端末右が上
      return { gx: -gz, gy, gz: gx };
    case 'portrait_up':      // 画面上が天井方向
      return { gx, gy: -gz, gz: gy };
    case 'portrait_down':    // 画面下が天井方向
      return { gx, gy: gz, gz: -gy };
    default:
      return { gx, gy, gz }; // flat/unknown → そのまま
  }
}

// =======================
// 平滑化（200ms移動平均＋σ=3）
// =======================
function updateSmoothedG(now) {
  const cutoff = now - WINDOW_MS;
  while (gWindow.length && gWindow[0].t < cutoff) gWindow.shift();
  if (gWindow.length < 2) return;

  const result = {};
  for (const axis of ['x', 'y', 'z']) {
    const vals = gWindow.map(d => d[axis]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / vals.length);
    const safe = Math.max(std, 0.0001);
    const filtered = vals.filter(v => Math.abs(v - mean) <= SIGMA * safe);
    result[axis] = (filtered.length ? filtered : vals).reduce((a, b) => a + b, 0) / (filtered.length ? filtered.length : vals.length);
  }
  smoothedG = result;
}

// =======================
// 変化量算出（速度・角速度）
// =======================
function calcDeltaSpeed() {
  if (speedHistory.length < 2) return 0;
  const a = speedHistory[0], b = speedHistory[speedHistory.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return 0;
  return (b.speed - a.speed) / dt; // km/h/s
}

function calcAvgRotZ() {
  if (rotationHistory.length < 1) return 0;
  const vals = rotationHistory.map(r => r.rotZ);
  return vals.reduce((A, B) => A + B, 0) / vals.length;
}

// =======================
// メイン: DeviceMotion
// =======================
export function handleDeviceMotion(event) {
  const now = Date.now();

  // 加速度（含む重力）
  const acc = event.accelerationIncludingGravity || {};
  let gx = acc.x || 0;
  let gy = acc.y || 0;
  let gz = acc.z || 0;

  // ✅ m/s² → G（1G ≈ 9.80665 m/s²）
  gx /= 9.80665;
  gy /= 9.80665;
  gz /= 9.80665;

  // ✅ 重力方向を低周波フィルタで追従（傾き補正）
  const alpha = 0.95; // 応答係数（0.9〜0.99推奨）
  gravityOffset.x = alpha * gravityOffset.x + (1 - alpha) * gx;
  gravityOffset.y = alpha * gravityOffset.y + (1 - alpha) * gy;
  gravityOffset.z = alpha * gravityOffset.z + (1 - alpha) * gz;

  // ✅ 重力を除去
  gx -= gravityOffset.x;
  gy -= gravityOffset.y;
  gz -= gravityOffset.z;

  // Z回りの角速度
  const rot = event.rotationRate || {};
  const rotZ = (rot.alpha ?? rot.z ?? 0); // iOS: alpha=Z、Android: z

  if (isCalibrating) {
    calibrationSamples.push({ x: gx, y: gy, z: gz });
    return;
  }

  if (!motionInitialized) {
    motionInitialized = true;
    console.log('DeviceMotion initialized');
  }

  if (++sampleCount % MOTION_FRAME_SKIP !== 0) return;

  // ✅ applyOrientationCorrection は削除またはコメントアウト
  // ({ gx, gy, gz } = applyOrientationCorrection(gx, gy, gz));

  // === 以下、平滑化処理・Firestoreバッファ処理はそのまま ===
  gWindow.push({ t: now, x: gx, y: gy, z: gz });
  updateSmoothedG(now);
  const gxs = smoothedG.x;
  const gys = smoothedG.y;
  const gzs = smoothedG.z;

  const speed = window.currentSpeed ?? 0;
  speedHistory.push({ t: now, speed });
  while (speedHistory.length && speedHistory[0].t < now - SPEED_WINDOW_MS) speedHistory.shift();

  rotationHistory.push({ t: now, rotZ });
  while (rotationHistory.length && rotationHistory[0].t < now - ROT_WINDOW_MS) rotationHistory.shift();

  const deltaSpeed = calcDeltaSpeed();
  const avgRotZ = calcAvgRotZ();

  const eventType = detectDrivingPattern(gxs, gys, gzs, speed, deltaSpeed, avgRotZ, now);

  window.gLogBuffer.push({ timestamp: now, g_x: gx, g_y: gy, g_z: gz, speed, event: eventType || 'normal' });
  window.avgGLogBuffer.push({ timestamp: now, g_x: gxs, g_y: gys, g_z: gzs, speed, event: eventType || 'normal' });

  const gxElem = document.getElementById('g-x');
  const gyElem = document.getElementById('g-y');
  const gzElem = document.getElementById('g-z');

  if (gxElem) gxElem.textContent = gxs.toFixed(2);
  if (gyElem) gyElem.textContent = gys.toFixed(2);
  if (gzElem) gzElem.textContent = gzs.toFixed(2);
}


// =======================
// 8分類（褒め/指摘）判定
// =======================
function detectDrivingPattern(gx, gy, gz, speed, deltaSpeed, rotZ, now) {
  const absSide = Math.abs(gx);
  const absFwd  = Math.abs(gz);
  let type = null;

  // 🚗 旋回（スムーズ／急）
  if (absSide >= GOOD_TURN_MIN_G && absSide <= GOOD_TURN_MAX_G && absFwd < 0.25 && speed >= 10) {
    type = 'smooth_turn';
  } else if (absSide > SHARP_TURN_G_THRESHOLD && speed >= 10) {
    type = 'sharp_turn';
  }

  // 🚀 加速（スムーズ／急発進）
  else if (gz <= -GOOD_ACCEL_MIN_G && gz >= -GOOD_ACCEL_MAX_G && absSide < 0.25 && speed >= 5) {
    type = 'smooth_accel';
  } else if (gz <= -SUDDEN_ACCEL_G_THRESHOLD && speed >= 5) {
    type = 'sudden_accel';
  }

  // 🛑 ブレーキ（スムーズ／急ブレーキ）
  else if (gz >= Math.abs(GOOD_BRAKE_MIN_G) && gz <= Math.abs(GOOD_BRAKE_MAX_G) && absSide < 0.25 && speed >= 10) {
    type = 'smooth_brake';
  } else if (gz >= Math.abs(SUDDEN_BRAKE_G_THRESHOLD) && speed >= 10) {
    type = 'sudden_brake';
  }

  // 🚘 安定走行（直進）
  else if (speed >= 20 && absFwd < 0.12 && absSide < 0.12 && Math.abs(rotZ) < 0.05) {
    type = 'stable_drive';
  }

  // === イベントなし ===
  if (!type) return null;

  // === クールダウン ===
  if (now - lastEventTime < COOLDOWN_MS) return null;
  lastEventTime = now;

  console.log(
    `🎯 ${type} | gx=${gx.toFixed(2)}, gz=${gz.toFixed(2)}, rotZ=${rotZ.toFixed(2)}`
  );

  updateRealtimeScore(type);

  // === 音声再生（重複防止） ===
  if (now - lastAudioTime > AUDIO_COOLDOWN_MS) {
    playRandomAudio(type);
    lastAudioTime = now;
  }

  // ✅ GPSログの末尾にもイベントを同期反映
  if (window.gpsLogBuffer && window.gpsLogBuffer.length > 0) {
    const lastGps = window.gpsLogBuffer[window.gpsLogBuffer.length - 1];
    lastGps.event = type;
  }

  return type;
}

// =======================
// ユーティリティ
// =======================
export function getCurrentG() {
  return smoothedG;
}

export function resetMotion() {
  motionInitialized = false;
  sampleCount = 0;

  gWindow.length = 0;
  smoothedG = { x: 0, y: 0, z: 0 };

  speedHistory.length = 0;
  rotationHistory.length = 0;

  isCalibrating = false;
  calibrationSamples = [];
  gravityOffset = { x: 0, y: 0, z: 0 };
  orientationMode = 'unknown';

  console.log('Motion reset');
}

// =======================
// 検出の開始/停止（既存互換）
// =======================
export function startMotionDetection() {
  if (window.isMotionDetectionActive) return;
  window.isMotionDetectionActive = true;

  // 起動時キャリブ（3秒）
  startAutoCalibration();

  window.addEventListener('devicemotion', handleDeviceMotion);
  console.log('▶️ startMotionDetection()');
}

export function stopMotionDetection() {
  if (!window.isMotionDetectionActive) return;
  window.removeEventListener('devicemotion', handleDeviceMotion);
  window.isMotionDetectionActive = false;
  console.log('⏹️ stopMotionDetection()');
}
