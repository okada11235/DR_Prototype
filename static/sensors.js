// sensors.js - 高精度判定（200ms平均＋σ=3＋キャリブ＋avg_g_logs＋8分類）
// ====================================================================

import {
  MOTION_FRAME_SKIP,
  AUDIO_COOLDOWN_MS,
  COOLDOWN_MS,
  // 褒め条件は継続判定の内部で行うため、一旦閾値はそのまま参照
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

console.log('=== sensors.js (高精度8分類+avg_g_logs) LOADED [FIXED: 継続時間判定] ===');

// =======================
// 内部状態
// =======================
let motionInitialized = false;
let sampleCount = 0;

let isCalibrating = false;
let calibrationSamples = [];
let gravityOffset = { x: 0, y: 0, z: 0 };   // 3秒平均で決める重力ベクトル (FIX: 静的に使用)
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

// FIX: 継続時間判定のためのステート
let drivingState = {
    turnStart: 0,
    accelStart: 0,
    brakeStart: 0,
    straightStart: 0,
    lastDetectedType: null
};

// Firestore バッファ（session.js が10秒ごとに送信）
if (!window.gLogBuffer) window.gLogBuffer = [];
if (!window.avgGLogBuffer) window.avgGLogBuffer = [];

// =======================
// キャリブレーション (FIX: 静的オフセットとして機能させる)
// =======================

/** 起動時3秒の自動キャリブレーション開始 */
export function startAutoCalibration() {
  isCalibrating = true;
  calibrationSamples = [];
  console.log('📱 自動キャリブレーション開始（3秒間）');
  
  // FIX: 重力オフセットを初期値に戻す（動的追従を削除するため）
  gravityOffset = { x: 0, y: 0, z: 0 }; 

  setTimeout(() => {
    if (calibrationSamples.length >= 15) {
      // 平均ベクトル＝重力ベクトルとみなす
      const avg = meanVector(calibrationSamples);
      gravityOffset = { ...avg };
      orientationMode = detectOrientation(avg).mode;
      console.log('✅ キャリブ完了: gravityOffset=', gravityOffset, ' / orientation=', orientationMode);
    } else {
      console.warn('⚠️ キャリブ失敗: サンプル不足。重力補正が無効です。');
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
  
  // FIX: 重力加速度が最も大きい軸を検出
  if (az > ax && az > ay) return { mode: 'flat' };
  if (ax > ay && ax > az) return { mode: x > 0 ? 'landscape_right' : 'landscape_left' }; // 重力ベクトルがX+なら右、X-なら左
  if (ay > ax && ay > az) return { mode: y > 0 ? 'portrait_up' : 'portrait_down' }; // 重力ベクトルがY+なら上、Y-なら下
  return { mode: 'unknown' };
}

/** FIX: 重力オフセット除去 ＋ 姿勢による軸の整列（左右G=+X、前後G=+Z を意識） */
function applyOrientationCorrection(gx, gy, gz) {
  // 1) 重力オフセットを引く（静止時に ~0 付近になる）
  gx -= gravityOffset.x;
  gy -= gravityOffset.y;
  gz -= gravityOffset.z;

  let finalGx, finalGy, finalGz;
  
  // 2) 端末姿勢に合わせて「左右G=X」「前後G=Z」を揃える
  switch (orientationMode) {
    case 'landscape_left':   // 端末左側が上 (X軸が重力方向)
      finalGx = -gy; // 横G
      finalGy = gz;  // 上下G
      finalGz = -gx; // 前後G
      break;
    case 'landscape_right':  // 端末右側が上 (X軸が重力方向)
      finalGx = gy;  // 横G
      finalGy = gz;  // 上下G
      finalGz = gx;  // 前後G
      break;
    case 'portrait_up':      // 端末上が上 (Y軸が重力方向)
      finalGx = gx;  // 横G
      finalGy = gz;  // 上下G
      finalGz = -gy; // 前後G
      break;
    case 'portrait_down':    // 端末下が上 (Y軸が重力方向)
      finalGx = -gx; // 横G
      finalGy = gz;  // 上下G
      finalGz = gy;  // 前後G
      break;
    case 'flat':             // 画面が上 (Z軸が重力方向)
    default:
      finalGx = gx;
      finalGy = gy;
      finalGz = gz;
      break;
  }
  // finalGx: 左右G (旋回G), finalGz: 前後G (加減速G)
  return { gx: finalGx, gy: finalGy, gz: finalGz }; 
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

  // FIX: 連続的な重力追従ロジックを削除し、キャリブレーション時のみサンプリング
  if (isCalibrating) {
    calibrationSamples.push({ x: gx, y: gy, z: gz });
    return;
  }
  
  if (!motionInitialized) {
    motionInitialized = true;
    console.log('DeviceMotion initialized');
  }

  if (++sampleCount % MOTION_FRAME_SKIP !== 0) return;

  // FIX: キャリブレーション値に基づき、重力除去と軸補正を適用
  ({ gx, gy, gz } = applyOrientationCorrection(gx, gy, gz));

  // === 以下、平滑化処理・Firestoreバッファ処理はそのまま ===
  gWindow.push({ t: now, x: gx, y: gy, z: gz });
  updateSmoothedG(now);
  // FIX: 軸補正後のG値を参照
  const gxs = smoothedG.x; // 左右G (Lateral)
  const gys = smoothedG.y; // 上下G (Vertical)
  const gzs = smoothedG.z; // 前後G (Longitudinal)

  window.latestGX = gxs;
  window.latestGY = gys;
  window.latestGZ = gzs;
  
  const speed = window.currentSpeed ?? 0;
  speedHistory.push({ t: now, speed });
  while (speedHistory.length && speedHistory[0].t < now - SPEED_WINDOW_MS) speedHistory.shift();

  const rot = event.rotationRate || {};
  const rotZ = (rot.alpha ?? rot.z ?? 0); // iOS: alpha=Z、Android: z
  
  rotationHistory.push({ t: now, rotZ });
  while (rotationHistory.length && rotationHistory[0].t < now - ROT_WINDOW_MS) rotationHistory.shift();

  const deltaSpeed = calcDeltaSpeed();
  const avgRotZ = calcAvgRotZ();

  const eventType = detectDrivingPattern(gxs, gys, gzs, speed, deltaSpeed, avgRotZ, now);

  // FIX: Gログは生のG値を使用 (軸補正後だが平滑化前)
  window.gLogBuffer.push({ timestamp: now, g_x: gx, g_y: gy, g_z: gz, speed, event: eventType || 'normal' });
  // FIX: AVG Gログは平滑化後のG値を使用 (軸補正後かつ平滑化後)
  window.avgGLogBuffer.push({ timestamp: now, g_x: gxs, g_y: gys, g_z: gzs, speed, event: eventType || 'normal' });

  const gxElem = document.getElementById('g-x');
  const gyElem = document.getElementById('g-y');
  const gzElem = document.getElementById('g-z');

  if (gxElem) gxElem.textContent = gxs.toFixed(2);
  if (gyElem) gyElem.textContent = gys.toFixed(2);
  if (gzElem) gzElem.textContent = gzs.toFixed(2);
}


// =======================
// FIX: 継続時間判定ロジック
// =======================

/**
 * 継続時間による運転パターン判定。
 * @param {number} gx - 横G (左右)
 * @param {number} gy - 上下G
 * @param {number} gz - 前後G (加減速)
 * @param {number} speed - 速度 (km/h)
 * @param {number} deltaSpeed - 速度変化 (km/h/s)
 * @param {number} rotZ - Z軸角速度 (deg/s)
 * @param {number} now - 現在時刻 (ms)
 * @returns {string|null} 検出されたイベントタイプ ('smooth_turn', 'sharp_turn', 'stable_drive'など)
 */
function detectDrivingPattern(gx, gy, gz, speed, deltaSpeed, rotZ, now) {
  const absSide = Math.abs(gx); 
  const absFwd = Math.abs(gz);
  
  let currentCondition = null;
  const isBraking = gz <= -0.13;
  const isAccelerating = gz >= 0.13;
  const isTurning = absSide >= 0.18;
  const isStable = speed >= 30 && absFwd < 0.15 && absSide < 0.15 && Math.abs(rotZ) < 2;

  // 1. 条件判定とステート更新
  if (isTurning && absFwd < 0.2 && speed >= 15) {
      // 旋回条件が満たされている
      if (drivingState.turnStart === 0) drivingState.turnStart = now;
      currentCondition = 'turn';
      
  } else if (isAccelerating && deltaSpeed > 5 && absSide < 0.2 && speed >= 5) {
      // 加速条件が満たされている
      if (drivingState.accelStart === 0) drivingState.accelStart = now;
      currentCondition = 'accel';

  } else if (isBraking && deltaSpeed < -5 && absSide < 0.2 && speed >= 10) {
      // 減速条件が満たされている
      if (drivingState.brakeStart === 0) drivingState.brakeStart = now;
      currentCondition = 'brake';

  } else if (isStable) {
      // 直進条件が満たされている
      if (drivingState.straightStart === 0) drivingState.straightStart = now;
      currentCondition = 'straight';

  } else {
      // どの継続条件も満たされていない場合は、すべての継続タイマーをリセット
      drivingState.turnStart = 0;
      drivingState.accelStart = 0;
      drivingState.brakeStart = 0;
      drivingState.straightStart = 0;
  }
  
  // 2. 継続時間チェックとイベント発火
  let type = null;
  let duration = 0;

  // 旋回判定
  if (currentCondition !== 'turn') drivingState.turnStart = 0; // 他のイベントが検知されたらリセット
  if (drivingState.turnStart > 0) {
      duration = now - drivingState.turnStart;
      if (duration >= 750) { // 0.75秒継続
          // G値の大きさでスムーズ/シャープを判定
          if (absSide >= SHARP_TURN_G_THRESHOLD) {
             type = 'sharp_turn';
             window.sharpTurns++;
          } else {
             type = 'smooth_turn';
             window.sharpTurns = Math.max(0, window.sharpTurns - 1); // 褒めはスコアを減らす（スコアシステムに合わせて）
          }
          drivingState.turnStart = 0;
      }
  }
  
  // 加速判定
  if (currentCondition !== 'accel') drivingState.accelStart = 0;
  if (drivingState.accelStart > 0) {
      duration = now - drivingState.accelStart;
      if (duration >= 500) { 
          if (absFwd < SUDDEN_ACCEL_G_THRESHOLD) { // 緩やかなG（褒め）
             type = 'smooth_accel';
             window.suddenAccels = Math.max(0, window.suddenAccels - 1);
          } else {
             type = 'sudden_accel';
             window.suddenAccels++;
          }
          drivingState.accelStart = 0;
      }
  }

  // 減速判定
  if (currentCondition !== 'brake') drivingState.brakeStart = 0;
  if (drivingState.brakeStart > 0) {
      duration = now - drivingState.brakeStart;
      if (duration >= 500) { // 0.5秒継続
          if (absFwd <= Math.abs(SUDDEN_BRAKE_G_THRESHOLD)) { // 緩やかなG（褒め）
             type = 'smooth_brake';
             window.suddenBrakes = Math.max(0, window.suddenBrakes - 1);
          } else {
             type = 'sudden_brake';
             window.suddenBrakes++;
          }
          drivingState.brakeStart = 0;
      }
  }
  
  // 直進判定
  if (currentCondition !== 'straight') drivingState.straightStart = 0;
  if (drivingState.straightStart > 0) {
      duration = now - drivingState.straightStart;
      if (duration >= 5000) { // 5秒継続
          // 直進は褒めイベントのみ
          type = 'stable_drive';
          drivingState.straightStart = 0;
      }
  }


  // 3. イベントの発火とクールダウン
  if (!type) return null;

  // === クールダウン ===
  if (now - lastEventTime < COOLDOWN_MS) return null;
  lastEventTime = now;
  drivingState.lastDetectedType = type;

  console.log(
    `🎯 ${type} (Duration: ${duration}ms) | gx=${gx.toFixed(2)}, gz=${gz.toFixed(2)}, rotZ=${rotZ.toFixed(2)}`
  );

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
  
  // FIX: 継続時間判定ステートをリセット
  drivingState = {
      turnStart: 0,
      accelStart: 0,
      brakeStart: 0,
      straightStart: 0,
      lastDetectedType: null
  };


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