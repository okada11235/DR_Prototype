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

// ============================
// ボール描画用スムーズG
// ============================
window.smoothBallGX = 0;
window.smoothBallGZ = 0;


// =======================
// 内部状態
// =======================
let motionInitialized = false;
let sampleCount = 0;

let isCalibrating = false;
let isCalibrated = false;
let speedZeroStart = 0;   // 速度0が始まった時刻
let stopCalibrated = false;
const CALIBRATION_DELAY_MS = 1000; // 1秒間停車を待つ（3秒→1秒に短縮）
const CALIBRATION_DURATION_MS = 2000; // 2秒間サンプリング
let calibrationSamples = [];
let gravityOffset = { x: 0, y: 0, z: 0 };   // 3秒平均で決める重力ベクトル (FIX: 静的に使用)
let orientationMode = 'unknown';            // 姿勢（portrait/landscape/flat など）

let lastEventTime = 0;                      // 判定のクールダウン管理
let lastAudioTime = 0;
let lastTurnTime = 0;                       // 旋回専用クールダウン
let lastBrakeTime = 0;                      // ブレーキ専用クールダウン
let lastAccelTime = 0;                      // 加速専用クールダウン

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

const ACCEL_COOLDOWN_MS = 3000; // 3秒（音声フィードバックと統一）

// Firestore バッファ（session.js が10秒ごとに送信）
if (!window.gLogBuffer) window.gLogBuffer = [];
if (!window.avgGLogBuffer) window.avgGLogBuffer = [];

// =======================
// 未補正データ記録（キャリブレーション中）
// =======================

/** キャリブレーション中でも基本データを記録する関数 */
function recordRawDataDuringCalibration(gx, gy, gz, now) {
  const speed = window.currentSpeed ?? 0;
  
  // 生Gログ（未補正）- 品質レベル 'raw' を付与
  window.gLogBuffer.push({
    timestamp: now,
    g_x: gx, g_y: gy, g_z: gz,
    speed,
    event: 'normal',
    quality: 'raw' // 品質レベル情報を追加
  });

  // AVG Gログも同様に記録（平滑化なしの生データ）
  window.avgGLogBuffer.push({
    timestamp: now,
    g_x: gx,
    g_y: gy,
    g_z: gz,
    rot_z: 0, // 回転データは無効
    speed,
    event: 'normal',
    quality: 'raw'
  });

  // UI更新（未補正でも表示）
  const gxElem = document.getElementById('g-x');
  const gyElem = document.getElementById('g-y');
  const gzElem = document.getElementById('g-z');

  if (gxElem) gxElem.textContent = gx.toFixed(2);
  if (gyElem) gyElem.textContent = gy.toFixed(2);
  if (gzElem) gzElem.textContent = gz.toFixed(2);
  
  console.log(`📊 Raw data recorded (calibrating): G(${gx.toFixed(2)}, ${gy.toFixed(2)}, ${gz.toFixed(2)}) speed=${speed.toFixed(1)}km/h`);
}

/** 既存の未補正データの品質レベルを更新 */
function updateExistingDataQuality(newQuality) {
  // gLogBufferの品質レベルを更新
  if (window.gLogBuffer) {
    window.gLogBuffer.forEach(log => {
      if (log.quality === 'raw') {
        log.quality = newQuality;
      }
    });
  }
  
  // avgGLogBufferの品質レベルを更新
  if (window.avgGLogBuffer) {
    window.avgGLogBuffer.forEach(log => {
      if (log.quality === 'raw') {
        log.quality = newQuality;
      }
    });
  }
  
  console.log(`🔄 既存データの品質レベルを '${newQuality}' に更新`);
}

// =======================
// キャリブレーション (FIX: 静的オフセットとして機能させる)
// =======================

/** 記録開始時の強制初期キャリブレーション（静止時前提） */
export function performInitialCalibration(callback) {
  if (isCalibrating || isCalibrated) {
    console.log('📱 キャリブレーション既に完了済み or 実行中');
    if (callback) callback();
    return;
  }

  isCalibrating = true;
  calibrationSamples = [];
  console.log('📱 初期キャリブレーション開始（3秒間・静止時前提）');
  
  // 重力オフセットを初期値に戻す
  gravityOffset = { x: 0, y: 0, z: 0 }; 

  setTimeout(() => {
    if (calibrationSamples.length >= 15) {
      // 平均ベクトル＝重力ベクトルとみなす
      const avg = meanVector(calibrationSamples);
      gravityOffset = { ...avg };
      orientationMode = detectOrientation(avg).mode;
      isCalibrated = true; // 初期キャリブレーション完了
      console.log('✅ 初期キャリブ完了: gravityOffset=', gravityOffset, ' / orientation=', orientationMode);
      
      // 既存の未補正データの品質レベルを更新
      updateExistingDataQuality('initial');
    } else {
      console.warn('⚠️ 初期キャリブ失敗: サンプル不足。簡易補正を適用します。');
      // サンプル不足でも最低限の補正を適用
      gravityOffset = { x: 0, y: 0, z: -9.8 }; // 標準重力を仮定
      orientationMode = 'flat';
      isCalibrated = true;
      updateExistingDataQuality('basic');
    }
    
    isCalibrating = false;
    if (callback) callback();
  }, 3000);
}

/** 起動時3秒の自動キャリブレーション開始 現在使用してない*/
export function startAutoCalibration() {
  // 後方互換性のため残す（performInitialCalibrationを推奨）
  performInitialCalibration();
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
  // ★ 仮定: iOS判定フラグがグローバルスコープにあるとする (例: window.isIOS)
  const isIOS = window.isIOS || false;

  // 1) 重力オフセットを引く（静止時に ~0 付近になる）
  gx -= gravityOffset.x;
  gy -= gravityOffset.y;
  gz -= gravityOffset.z;

  // ----------------------------------------------------
  // ★ iOS/Android 符号の統一処理
  // ----------------------------------------------------
  if (isIOS) {
    // iOSはAndroidと全ての軸の符号が逆と仮定し、反転させてAndroid基準に統一する
    gz = -gz;
  }
  // ----------------------------------------------------

  let finalGx, finalGy, finalGz;

  // 2) 端末姿勢に合わせて「左右G=X」「前後G=Z」を揃える
  switch (orientationMode) {

    // ===========================
    // 縦ホルダー（通常）・背面が前
    // ===========================
    case 'portrait_up':
      finalGx = -gx;   // 左右
      finalGy = -gy;   // 上下（重力軸）
      finalGz = -gz;   // 前後（進行方向）
      break;

    // 縦だが上下逆さま（画面が前・背面が後）に挿した場合
    case 'portrait_down':
      finalGx =  gx; 
      finalGy =  gy; 
      finalGz = -gz;  // 前後は向きそのまま
      break;

    // ===========================
    // 横向き（車載想定外だが対応する）
    // ===========================
    case 'landscape_left':
      // 左側が上 → 端末は -90°回転 → 逆回転(+90°)で補正
      finalGx = -gy;   // 左右
      finalGy =  gx;   // 上下
      finalGz = -gz;   // 前後は不変
      break;

    case 'landscape_right':
      // 右側が上 → 端末は +90°回転 → 逆回転(-90°)
      finalGx = -gy;
      finalGy =  gx;
      finalGz = -gz;
      break;

    // ===========================
    // flat（机に置く）
    // ===========================
    case 'flat':
      if (isIOS) {
        // iOSはAndroidと全ての軸の符号が逆と仮定し、反転させてAndroid基準に統一する
        gy = -gy;
        gx = -gx;
        gz = -gz;
      }
    default:
      // 机に置くと重力は Z 軸に乗る
      // しかし「車の上下」は Y 軸と決めているので、
      // Y と Z を入れ替えて車座標に合わせる
      finalGx = -gx;   // 左右はそのまま
      finalGy =  gz;   // 重力軸(Z)を上下Gyとして扱う
      finalGz =  gy;   // 前後はYにする（水平でも前後Gが取れる）
      break;
  }

  // finalGx: 左右G (旋回G), finalGz: 前後G (加減速G)
  return { gx: finalGx, gy: finalGy, gz: finalGz };
}

/** 停車中だけ実行される安全な再キャリブラッパー */
function startStopReCalibration() {
    if (isCalibrating) return;

    console.log("📱 再キャリブ開始");

    isCalibrating = true;
    isCalibrated = false;
    calibrationSamples = [];

    // ① 2秒間サンプリング
    setTimeout(() => {

        if (calibrationSamples.length >= 15) {
            const avg = meanVector(calibrationSamples);

            // ---- 姿勢補正を適用 ----
            const corrected = applyOrientationCorrection(avg.x, avg.y, avg.z);

            // ---- 補正後の座標で重力オフセットを保存 ----
            gravityOffset = {
                x: corrected.gx,
                y: corrected.gy,
                z: 0   // ★ Z軸は0G基準に固定する（最もズレやすいため）
            };

            orientationMode = detectOrientation(avg).mode;

            console.log("✨ 再キャリブ成功:", gravityOffset, orientationMode);
        } else {
            console.warn("⚠️ 再キャリブ失敗 → 標準値");
            gravityOffset = { x: 0, y: 0, z: 0 };
            orientationMode = "flat";
        }

        isCalibrating = false;

        // ---- ③ キャリブ完了として扱う ----
        isCalibrated = true;
        stopCalibrated = false;

    }, 2000);
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

  // m/s² → G（1G ≈ 9.80665 m/s²）
  gx /= 9.80665;
  gy /= 9.80665;
  gz /= 9.80665;

  // キャリブレーション中はサンプルを貯めるだけ
  if (isCalibrating) {
    calibrationSamples.push({ x: gx, y: gy, z: gz });
    return;
  }

  if (!motionInitialized) {
    motionInitialized = true;
    console.log('DeviceMotion initialized');
  }

  if (++sampleCount % MOTION_FRAME_SKIP !== 0) return;

  // --- 修正箇所 1/3: 重力補正（キャリブ済みのときのみ） ---
  if (isCalibrated) {
    ({ gx, gy, gz } = applyOrientationCorrection(gx, gy, gz));
  }
  // 未キャリブ時は生の値

  // --- 修正箇所 2/3: 停車検出によるキャリブレーション起動 ---
  const currentSpeed = window.currentSpeed ?? 0;

  // --- 停車判定 ---
  if (currentSpeed < 1.0) {

      if (speedZeroStart === 0) {
          speedZeroStart = now;
          stopCalibrated = false;
      }

      const stoppedMs = now - speedZeroStart;

      if (stoppedMs >= 2000 && !isCalibrating && !stopCalibrated) {
          console.log("🔧 停車2秒 → 再キャリブ許可");
          stopCalibrated = true;
      }

  } else {
      speedZeroStart = 0;
      stopCalibrated = false;
  }

  // --- 再キャリブ開始条件 ---
  // 動き出しておらず、isCalibrated=false に戻された時だけ発動
  if (!isCalibrated && !isCalibrating) {
    // 💡 修正点: isCalibrating=true の設定と return; を削除
    // startStopReCalibration() は自身で isCalibrating を true/false に設定する。
    // ここで return せず、下の !isCalibrated ブロックに進み、
    // 未補正データ (raw) を記録・表示することでUIの固まりを防ぐ。
    console.log("📱 停車2秒 → 初回キャリブと同じ処理で再キャリブ開始");
    startStopReCalibration();
  }


  // --- 修正箇所 3/3: キャリブ未完了でも基本データは記録 ---
  if (!isCalibrated) {
    // 未補正データとして記録（品質レベル='raw'）
    recordRawDataDuringCalibration(gx, gy, gz, now);
    return; // 評価処理はスキップ
  }

  // === 平滑化処理 & Firestoreバッファ ===
  gWindow.push({ t: now, x: gx, y: gy, z: gz });
  updateSmoothedG(now);

  const gxs = smoothedG.x;
  const gys = smoothedG.y;
  const gzs = smoothedG.z;

  window.latestGX = gxs;
  window.latestGY = gys;
  window.latestGZ = gzs;

  // === ボール専用のスムースG（滑らかにする） ===
  const SMOOTH_FACTOR = 0.90; // 0.85〜0.93 が最適

  window.smoothBallGX = window.smoothBallGX * SMOOTH_FACTOR + gxs * (1 - SMOOTH_FACTOR);
  window.smoothBallGZ = window.smoothBallGZ * SMOOTH_FACTOR + gzs * (1 - SMOOTH_FACTOR);

  const speed = window.currentSpeed ?? 0;

  speedHistory.push({ t: now, speed });
  while (speedHistory.length && speedHistory[0].t < now - SPEED_WINDOW_MS) {
    speedHistory.shift();
  }

  const rot = event.rotationRate || {};
  const rotZ = (rot.alpha ?? rot.z ?? 0);

  rotationHistory.push({ t: now, rotZ });
  while (rotationHistory.length && rotationHistory[0].t < now - ROT_WINDOW_MS) {
    rotationHistory.shift();
  }

  const deltaSpeed = calcDeltaSpeed();
  const avgRotZ = calcAvgRotZ();

  // ライブモード: recentLogs は渡さない
  const eventType = detectDrivingPattern(
    gxs, gys, gzs, speed, deltaSpeed, avgRotZ, now
  );

  // 生Gログ（補正あり / 平滑化なし）
  window.gLogBuffer.push({
    timestamp: now,
    g_x: gx, g_y: gy, g_z: gz,
    speed,
    event: eventType || 'normal',
    quality: 'calibrated' // 完全キャリブレーション済み
  });

  // AVG Gログ（補正＋平滑化済み）
  window.avgGLogBuffer.push({
    timestamp: now,
    g_x: smoothedG.x,
    g_y: smoothedG.y,
    g_z: smoothedG.z,
    rot_z: avgRotZ,
    speed,
    delta_speed: deltaSpeed,
    event: eventType || 'normal',
    quality: 'calibrated' // 完全キャリブレーション済み
  });

  // UI更新
  const gxElem = document.getElementById('g-x');
  const gyElem = document.getElementById('g-y');
  const gzElem = document.getElementById('g-z');

  if (gxElem) {
    gxElem.textContent = gxs.toFixed(2);
    applyGColor(gxElem, gxs);
  }
  if (gyElem) {
    gyElem.textContent = gys.toFixed(2);
    applyGColor(gyElem, gys);
  }
  if (gzElem) {
    gzElem.textContent = gzs.toFixed(2);
    applyGColor(gzElem, gzs);
  }

  if (gxElem) gxElem.textContent = gxs.toFixed(2);
  if (gyElem) gyElem.textContent = gys.toFixed(2);
  if (gzElem) gzElem.textContent = gzs.toFixed(2);

  window.liveG = {
      gx: gx,   // 左右
      gy: gy,   // 上下（不要）
      gz: gz    // 前後
  };
}

function applyGColor(elem, g) {
  const absG = Math.abs(g);

  let color = "#00c853";   // とても良い（緑）

  if (absG >= 0.15) {
    color = "#ff5252";     // 悪い（赤）
  } else if (absG >= 0.08) {
    color = "#ffca28";     // 良い（黄）
  }

  elem.style.color = color;
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
 * @param {Array<Object>} [recentLogs] - (再生時のみ使用) 直近のログデータ配列 ★オプション引数として追加★
 * @returns {string|null} 検出されたイベントタイプ ('smooth_turn', 'sharp_turn', 'stable_drive'など)
 */
function detectDrivingPattern(gx, gy, gz, speed, deltaSpeed, rotZ, now, recentLogs) {
  const absSide = Math.abs(gx);
  const absFwd = Math.abs(gz);
  const absRot = Math.abs(rotZ);
  
  let currentCondition = null;
  const isBraking = gz <= -0.13;
  const accelDurationMs = 250;
  // ---- 加速入り口判定（軽い発進でも入るように緩める）----
  let isAcceleratingNew = false;

  // ★ 加速クールダウン中は判定しない
  if (now - lastAccelTime >= ACCEL_COOLDOWN_MS) {
      isAcceleratingNew =
          gz >= 0.06 && 
          absSide < 0.2 && 
          speed >= 1;
  }
  const isTurning =
    speed >= 3 &&             // 最低速度3km/h
    absSide >= 0.10;          // 横G閾値を0.10に設定（誤判定防止）

/*const isStable =
    speed >= 20 &&
    absFwd < 0.12 &&
    absSide < 0.18 &&
    Math.abs(rotZ) < 3;*/

  // 1. 条件判定とステート更新
  if (isTurning) {

      // ---- 旋回判定（右左折開始） ----
      if (drivingState.turnStart === 0) drivingState.turnStart = now;
      currentCondition = 'turn';

  } else if (isAcceleratingNew) {
    
      if (drivingState.accelStart === 0) drivingState.accelStart = now;
      currentCondition = 'accel';

  } else if (isBraking && deltaSpeed < -3 && absSide < 0.2 && speed >= 10) {

      // ---- 減速 ----
      if (drivingState.brakeStart === 0) drivingState.brakeStart = now;
      currentCondition = 'brake';

  } /*else if (isStable) {

      // ---- 直進 ----
      if (drivingState.straightStart === 0) drivingState.straightStart = now;
      currentCondition = 'straight';

  }*/
  
  // 2. 継続時間チェックとイベント発火
  let type = null;
  let duration = 0;

  // --- ★ stable_drive の継続時間処理  直進判定---
/*if (currentCondition === 'straight') {

      // すでに straightStart がセット済みなら継続時間を計算
      const straightDuration = now - drivingState.straightStart;

      if (straightDuration >= 1500) {  // 1.5秒以上
          type = "stable_drive";

          drivingState.straightStart = 0;  // 直進フラグをリセット
          lastEventTime = now;
          drivingState.lastDetectedType = type;

          console.log(
            `🎯 stable_drive (Duration: ${straightDuration}ms) | gx=${gx.toFixed(2)}, rotZ=${rotZ.toFixed(2)}`
          );

          return type;  // 他イベントより優先
      }
  }*/

  //------------------------------------------------------
  // 旋回継続時間チェック（250ms以上で判定 + 横G維持確認）
  // rotZ は sharp のみで使う方式
  //------------------------------------------------------
  if (drivingState.turnStart > 0) {

      const duration = now - drivingState.turnStart;

      if (duration >= 350) {  // 350ms継続で判定（直進時の揺れを最大限除外）

          let type = null;

          // ★ 判定時点での横Gで4段階分類（バランス調整済み）
          if (absSide >= 0.30) {
              type = "sharp_turn";        // 0.30G以上: 急旋回
          }
          else if (absSide >= 0.20) {
              type = "normal_turn";       // 0.20〜0.29G: 通常旋回
          }
          else if (absSide >= 0.13) {
              type = "smooth_turn";       // 0.13〜0.19G: 滑らか旋回
          }
          else if (absSide >= 0.10) {
              type = "excellent_turn";    // 0.10〜0.12G: 非常に滑らか
          }

          // 判定実行後は必ずリセット
          drivingState.turnStart = 0;

          if (type) {
              // 旋回専用クールダウンチェック（2秒）
              if (now - lastTurnTime >= 2000) {
                  lastEventTime = now;
                  lastTurnTime = now;
                  drivingState.lastDetectedType = type;

                  console.log(`🎯 ${type} | gx=${gx.toFixed(2)}, rotZ=${rotZ.toFixed(2)}`);
                  
                  // 音声再生処理（音声が再生される時だけバッファに追加）
                  if (now - lastAudioTime > AUDIO_COOLDOWN_MS) {
                      
                      // ✅ 音声再生される場合のみバッファに追加
                      if (window.lastKnownPosition) {
                          const logData = {
                              timestamp: now,
                              latitude: window.lastKnownPosition.latitude,
                              longitude: window.lastKnownPosition.longitude,
                              speed: window.lastKnownPosition.speed || 0,
                              g_x: window.latestGX || 0,
                              g_y: window.latestGY || 0,
                              g_z: window.latestGZ || 0,
                              event: type
                          };
                          window.gLogBuffer.push(logData);
                          window.avgGLogBuffer.push(logData);
                          window.gpsLogBuffer.push(logData);
                          console.log(`🎯 ${type} | 音声再生＆3バッファに追加`);
                      }
                      // TTS停止
                      try {
                          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                              if (speechSynthesis.speaking) {
                                  speechSynthesis.cancel();
                              }
                          }
                          if (window.isPinSpeaking) window.isPinSpeaking = false;
                      } catch (e) { console.warn('⚠️ TTS cancel failed', e); }
                      
                      // iOS segment または Android 音声再生
                      if (window.isIOS && window.playEventAudioSegment) {
                          const segments = {
                              "excellent_turn":[5.431, 2.72],
                              "smooth_turn":[23.234, 3.275],
                              "normal_turn":[10.724, 2.485],
                              "sharp_turn":[15.283, 2.869]
                          };
                          const seg = segments[type];
                          if (seg) {
                              console.log("🎵 iOS 旋回音声:", type, seg);
                              window.playEventAudioSegment(seg[0], seg[1]);
                          }
                      } else {
                          playRandomAudio(type);
                      }
                      lastAudioTime = now;
                  }
                  
                  return type;
              }
          }
      }
  }
  
  // 旋回条件を満たさない場合のみリセット（横G < 0.09 または 速度 < 2km/h で完全リセット）
  if (absSide < 0.09 || speed < 2) {
      drivingState.turnStart = 0;
  }

  // 加速・減速のリセット処理
  if (!isAcceleratingNew) drivingState.accelStart = 0;
  if (!(isBraking && deltaSpeed < -3 && absSide < 0.2 && speed >= 10)) drivingState.brakeStart = 0;
  
  // ===============================
  // 🚗 加速判定
  // ===============================
  // ================================================
  // 🚀 新ロジック：速度変化をトリガーにした加速判定
  // ================================================
  {
      // ΔSpeed が 1.0 km/h/s 以上 → 明確な加速とみなす
      const SPEED_TRIGGER = 1.0;

      if (deltaSpeed > SPEED_TRIGGER && speed >= 5) {

          // クールダウン中なら無視
          if (now - lastAccelTime < ACCEL_COOLDOWN_MS) {
              // nothing
          } else {

              // 直近700msの gz を取得
              const windowMs = 700;
              const recent = window.avgGLogBuffer.filter(
                  d => now - d.timestamp <= windowMs
              );

              if (recent.length > 3) {

                  const avgG = recent.reduce((a, b) => a + Math.abs(b.g_z), 0) / recent.length;
                  let accelType = null;

                  if (avgG < 0.03) {
                      accelType = "excellent_accel";
                  } else if (avgG < 0.07) {
                      accelType = "smooth_accel";
                  } else if (avgG < 0.15) {
                      accelType = "normal_accel";
                  } else {
                      accelType = "sudden_accel";
                  }

                  // 連続発生を防ぐ
                  lastAccelTime = now;
                  drivingState.accelStart = 0;

                  lastEventTime = now;
                  drivingState.lastDetectedType = accelType;

                  console.log(`⚡ 速度トリガー加速判定 → ${accelType} | avgG=${avgG.toFixed(3)} Δv=${deltaSpeed.toFixed(2)}`);
                  
                  // ✅ 音声再生チェック（音声が鳴る時だけバッファに追加）
                  if (now - lastAudioTime > AUDIO_COOLDOWN_MS) {
                      // TTS停止
                      try {
                          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                              if (speechSynthesis.speaking) {
                                  speechSynthesis.cancel();
                              }
                          }
                          if (window.isPinSpeaking) window.isPinSpeaking = false;
                      } catch (e) { console.warn('⚠️ TTS cancel failed', e); }
                      
                      // 音声再生
                      if (window.isIOS && window.playEventAudioSegment) {
                          const segments = {
                              "excellent_accel":[0, 2.837],
                              "smooth_accel":[18.152, 2.635],
                              "normal_accel":[8.152, 2.571],
                              "sudden_accel":[28.578, 2.464]
                          };
                          const seg = segments[accelType];
                          if (seg) {
                              console.log("🎵 iOS 加速音声:", accelType, seg);
                              window.playEventAudioSegment(seg[0], seg[1]);
                          }
                      } else {
                          playRandomAudio(accelType);
                      }
                      
                      // 音声再生後にバッファに追加
                      if (window.lastKnownPosition) {
                          const logData = {
                              timestamp: now,
                              latitude: window.lastKnownPosition.latitude,
                              longitude: window.lastKnownPosition.longitude,
                              speed: window.lastKnownPosition.speed || 0,
                              g_x: window.latestGX || 0,
                              g_y: window.latestGY || 0,
                              g_z: window.latestGZ || 0,
                              event: accelType
                          };
                          window.gLogBuffer.push(logData);
                          window.avgGLogBuffer.push(logData);
                          window.gpsLogBuffer.push(logData);
                          console.log(`⚡ ${accelType} | 音声再生＆3バッファに追加`);
                      }
                      
                      lastAudioTime = now;
                  }

                  return accelType;
              }
          }
      }
  }
/*
  // 継続時間からの減速判定
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
*/
  // ===============================
  // 🚗 停止直前ブレーキ評価ロジック（4段階 + iOS対応版）
  // ===============================
  const isReplayMode = Array.isArray(recentLogs); 

  let currentSpeed = speed;
  if (isReplayMode) {
      currentSpeed = speed; 
  } else {
      currentSpeed = window.currentSpeed ?? 0;
  }

  // ★ ブレーキ評価トリガー（12km/h以下）
  if (!drivingState.brakeEvaluated && currentSpeed <= 12) {

      const windowMs = 3000; // 直前3秒

      let recentData = [];
      if (isReplayMode) {
          recentData = recentLogs;
      } else {
          recentData = window.gLogBuffer.filter(
              g => now - (g.timestamp || 0) <= windowMs
          );
      }

      if (recentData.length > 2) {

          // -----------------------------
          // 前後G値の統計を算出
          // -----------------------------
          const avgG = recentData.reduce(
              (sum, d) => sum + (d.g_z || 0),
              0
          ) / recentData.length;

          const maxAbsG = Math.max(
              ...recentData.map(d => Math.abs(d.g_z || 0))
          );

          const absAvgG = Math.abs(avgG);

          // -----------------------------
          // ★ ブレーキ4段階ロジック（前後Gのみで判定）
          // -----------------------------
          let brakeType = null;

          if (maxAbsG >= 0.30) {
              brakeType = "sudden_brake";         // 急ブレーキ
          }
          else if (absAvgG < 0.13 && maxAbsG < 0.20) {
              brakeType = "excellent_brake";      // 非常に滑らか
          }
          else if (absAvgG < 0.18 && maxAbsG < 0.25) {
              brakeType = "smooth_brake";         // スムーズ
          }
          else if (absAvgG < 0.25 && maxAbsG < 0.30) {
              brakeType = "normal_brake";         // 通常
          }
          else {
              brakeType = "sudden_brake";         // fallback（上記に該当しない場合）
          }

          // ===============================
          // 🟦 再生モード（replay）はここで終了
          // ===============================
          if (isReplayMode) {
              drivingState.brakeEvaluated = true;
              return brakeType;
          }

          // ===============================
          // 🔥 ライブモード：iOS/Android の音声再生
          // ===============================
          // ブレーキ専用クールダウンチェック（2秒）
          if (now - lastBrakeTime > 2000) {

              lastEventTime = now;
              lastBrakeTime = now;

              console.log(
                  `🚗 ブレーキ判定 → ${brakeType} (avgG=${absAvgG.toFixed(3)}, maxG=${maxAbsG.toFixed(3)})`
              );

              // --- TTSキャンセル（ピン読み上げ衝突防止） ---
              try {
                  if (typeof window !== "undefined" && speechSynthesis.speaking) {
                      speechSynthesis.cancel();
                  }
                  if (window.isPinSpeaking) window.isPinSpeaking = false;
              } catch (e) {
                  console.warn("⚠️ TTS cancel failed before audio playback", e);
              }

              // ---------------------------------------------------
              // 🔊 iOS の segment 音源再生（playEventAudioSegment）
              // ---------------------------------------------------
              const segments = {
                "excellent_brake":[2.838, 2.592],   // ← 新しく excellent_brake として smooth_brake の区間を使用
                "smooth_brake":[20.788, 2.485],
                "normal_brake":[13.21, 2.027],
                "sudden_brake":[31.043, 1.579],
                "excellent_accel":[0, 2.837],
                "smooth_accel":[18.152, 2.635],
                "normal_accel":[8.152, 2.571],
                "sudden_accel":[28.578, 2.464],
                "excellent_turn":[5.431, 2.72],
                "smooth_turn":[23.234, 3.275],
                "normal_turn":[10.724, 2.485],
                "sharp_turn":[15.283, 2.869],
                "stable_drive":[26.55, 2.027],
                "unstable_drive":[32.623, 2.005]
              };

              if (window.isIOS && window.playEventAudioSegment) {

                  const seg = segments[brakeType] || segments["normal_brake"];

                  console.log("🎵 iOS segment playback:", brakeType, seg);

                  try {
                      window.playEventAudioSegment(seg[0], seg[1]);
                  } catch (e) {
                      console.warn("⚠️ segment playback failed:", e);
                  }

              } else {
                  // ---------------------------------------------------
                  // 🔊 Android/PC の通常音声
                  // ---------------------------------------------------

                  // sudden_brake 以外は各 brake 系イベントの名前で再生可能
                  if (!brakeType.includes("sudden")) {
                      playRandomAudio(brakeType);
                  } else {
                      playRandomAudio("sudden_brake");
                  }
              }

              // ===============================
              // 📌 音声再生後にバッファに追加（音声が鳴った時だけマーカー記録）
              // ===============================
              if (window.lastKnownPosition) {
                  const logData = {
                      timestamp: now,
                      latitude: window.lastKnownPosition.latitude,
                      longitude: window.lastKnownPosition.longitude,
                      speed: window.lastKnownPosition.speed || 0,
                      g_x: window.latestGX || 0,
                      g_y: window.latestGY || 0,
                      g_z: window.latestGZ || 0,
                      event: brakeType
                  };
                  window.gLogBuffer.push(logData);
                  window.avgGLogBuffer.push(logData);
                  window.gpsLogBuffer.push(logData);
                  console.log(`🚗 ${brakeType} | 音声再生＆3バッファに追加`);
              }
              
              lastEventTime = now;
          }

          drivingState.brakeEvaluated = true;
      }
  }

  // ★15km/h以上になったら再評価可能に
  if (speed > 15) drivingState.brakeEvaluated = false;

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
    // 🚫 ブレーキ系イベントは、すでに上で再生済みなのでスキップ
    if (!type.includes("brake")) {
      if (window.isIOS && window.playEventAudioSegment) {
        // 🎯 coaching音声開始前に進行中のTTS（ピン読み上げ等）を停止
        try {
          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            if (speechSynthesis.speaking) {
              console.debug('🛑 coaching(iOS seg)開始: 進行中のTTSをcancel');
              speechSynthesis.cancel();
            }
          }
          if (window.isPinSpeaking) window.isPinSpeaking = false;
        } catch (e) { console.warn('⚠️ TTS cancel failed before iOS segment playback', e); }
        const segments = {
          "excellent_brake":[2.838, 2.592],   // ← 新しく excellent_brake として smooth_brake の区間を使用
          "smooth_brake":[20.788, 2.485],
          "normal_brake":[13.21, 2.027],
          "sudden_brake":[31.043, 1.579],
          "excellent_accel":[0, 2.837],
          "smooth_accel":[18.152, 2.635],
          "normal_accel":[8.152, 2.571],
          "sudden_accel":[28.578, 2.464],
          "excellent_turn":[5.431, 2.72],
          "smooth_turn":[23.234, 3.275],
          "normal_turn":[10.724, 2.485],
          "sharp_turn":[15.283, 2.869],
          "stable_drive":[26.55, 2.027],
          "unstable_drive":[32.623, 2.005]
        };
        const seg = segments[type];
        if (seg) {
          console.log("🎵 iOS fallback playback:", type, seg);
          window.playEventAudioSegment(seg[0], seg[1]);
        } else {
          console.warn("⚠️ 未定義イベント:", type);
        }
      } else {
        // 🎯 coaching音声開始前に進行中のTTS（ピン読み上げ等）を停止
        try {
          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            if (speechSynthesis.speaking) {
              console.debug('🛑 coaching開始: 進行中のTTSをcancel');
              speechSynthesis.cancel();
            }
          }
          if (window.isPinSpeaking) window.isPinSpeaking = false;
        } catch (e) { console.warn('⚠️ TTS cancel failed before coaching playback', e); }
        playRandomAudio(type);
      }
      lastAudioTime = now;
    } else {
      console.log("🧠 brake event skipped duplicate audio");
    }
  }

  // ✅ GPSログの末尾にもイベントを同期反映
  if (window.gpsLogBuffer && window.gpsLogBuffer.length > 0) {
    const lastGps = window.gpsLogBuffer[window.gpsLogBuffer.length - 1];
    lastGps.event = type;
  }

  // ✅ 即イベント反映：イベント発生時にGPSログを複製して保存
  if (type) {
    const lastGPS = window.gpsLogBuffer?.[window.gpsLogBuffer.length - 1];
    if (lastGPS) {
      const eventLog = {
        ...lastGPS,
        event: type,
        timestamp: Date.now()
      };
      window.gpsLogBuffer.push(eventLog);
      console.log("📍 Event GPS log added:", eventLog);
    }
  }

  return type;
}

// =======================
// ユーティリティ
// =======================
export function getCurrentG() {
  return smoothedG;
}

// ★ 修正点1: export キーワードを削除
function resetMotion() {
  motionInitialized = false;
  sampleCount = 0;
  stopCalibrated = false;

  gWindow.length = 0;
  smoothedG = { x: 0, y: 0, z: 0 };

  speedHistory.length = 0;
  rotationHistory.length = 0;

  isCalibrating = false;
  calibrationSamples = [];
  gravityOffset = { x: 0, y: 0, z: 0 }; 
  orientationMode = 'unknown';
  isCalibrated = false;
  speedZeroStart = 0;
  
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

  window.addEventListener('devicemotion', handleDeviceMotion);
  console.log('▶️ startMotionDetection()');
}

export function stopMotionDetection() {
  if (!window.isMotionDetectionActive) return;
  window.removeEventListener('devicemotion', handleDeviceMotion);
  window.isMotionDetectionActive = false;
  console.log('⏹️ stopMotionDetection()');
}

// ★ 修正点2: detectDrivingPattern, resetMotion をまとめてエクスポート
export { detectDrivingPattern, resetMotion };

// =======================
// ★ 追加: iOS判定フラグの設定ロジック
// =======================

(function() {
  // ブラウザのUser AgentをチェックしてiOSかどうかを判定
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;

  // iOSデバイスの判定（iPhone, iPad, iPod）
  // または、最近のiPadOS (MacのようなUser Agentを持つもの)
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent) || 
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  
  // windowオブジェクトにフラグを設定（applyOrientationCorrection関数で使用）
  window.isIOS = isIOS;
  
  if (isIOS) {
    console.log("✅ Platform detected: iOS");
  } else {
    console.log("✅ Platform detected: Android/Other");
  }
})();