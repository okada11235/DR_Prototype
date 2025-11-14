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

  // ★ ライブモードの呼び出しは引数7つ。recentLogsは渡さない（undefinedになる）
  const eventType = detectDrivingPattern(gxs, gys, gzs, speed, deltaSpeed, avgRotZ, now);

  // FIX: Gログは生のG値を使用 (軸補正後だが平滑化前)
  window.gLogBuffer.push({ timestamp: now, g_x: gx, g_y: gy, g_z: gz, speed, event: eventType || 'normal' });
  // FIX: AVG Gログは平滑化後のG値を使用 (軸補正後かつ平滑化後)
  window.avgGLogBuffer.push({
    timestamp: now,
    g_x: smoothedG.x,  // ← 補正＆平滑化済み
    g_y: smoothedG.y,
    g_z: smoothedG.z,
    rot_z: avgRotZ,
    speed,
    event: eventType || 'normal'
  });

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
 * @param {Array<Object>} [recentLogs] - (再生時のみ使用) 直近のログデータ配列 ★オプション引数として追加★
 * @returns {string|null} 検出されたイベントタイプ ('smooth_turn', 'sharp_turn', 'stable_drive'など)
 */
function detectDrivingPattern(gx, gy, gz, speed, deltaSpeed, rotZ, now, recentLogs) {
  const absSide = Math.abs(gx);
  const absFwd = Math.abs(gz);
  const absRot = Math.abs(rotZ);
  
  let currentCondition = null;
  const isBraking = gz <= -0.13;
  const isAccelerating = gz >= 0.13;
  const isTurning =
    speed >= 13 &&                // 右左折は必ず10km/h以上
    absSide >= 0.10 &&            // 横Gが出始めたら（蛇行は除外）
    absRot >= 4;                  // rotZ 4deg/s以上で明確な方向転換
  const isStable =
    speed >= 20 &&
    absFwd < 0.12 &&
    absSide < 0.18 &&
    Math.abs(rotZ) < 3;

  // 1. 条件判定とステート更新
  if (isTurning && absFwd < 0.25) {

      // ---- 旋回判定（右左折開始） ----
      if (drivingState.turnStart === 0) drivingState.turnStart = now;
      currentCondition = 'turn';

  } else if (isAccelerating && deltaSpeed > 5 && absSide < 0.2 && speed >= 5) {

      // ---- 加速 ----
      if (drivingState.accelStart === 0) drivingState.accelStart = now;
      currentCondition = 'accel';

  } else if (isBraking && deltaSpeed < -5 && absSide < 0.2 && speed >= 10) {

      // ---- 減速 ----
      if (drivingState.brakeStart === 0) drivingState.brakeStart = now;
      currentCondition = 'brake';

  } else if (isStable) {

      // ---- 直進 ----
      if (drivingState.straightStart === 0) drivingState.straightStart = now;
      currentCondition = 'straight';

  } else {

      // ---- どの条件にも該当しない場合はリセット ----
      drivingState.turnStart = 0;
      drivingState.accelStart = 0;
      drivingState.brakeStart = 0;
      drivingState.straightStart = 0;
  }
  
  // 2. 継続時間チェックとイベント発火
  let type = null;
  let duration = 0;

  // --- ★ stable_drive の継続時間処理  直進判定---
  if (currentCondition === 'straight') {

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
  }

  //------------------------------------------------------
  // 旋回継続時間チェック（0.75秒）
  //------------------------------------------------------
  if (drivingState.turnStart > 0) {
    const duration = now - drivingState.turnStart;
    
    if (duration >= 750) {  // 0.75秒継続で「右左折確定」
      
      //--------------------------------------------------
      // 一般道向け sharp/smooth 判定ロジック
      //--------------------------------------------------
      
      // 基本値（一般道の右左折に最適化）
      let sharpG = 0.32;      // ← 0.40 だと強すぎるので下げた
      let sharpRot = 10;      // ← rotZ 10deg/s 以上なら急な右左折

      // 速度帯でG閾値を微調整（自然な判定になる）
      if (speed < 15) {
        sharpG -= 0.03;       // 極低速はGが出にくい → 少し緩め
      } else if (speed >= 30) {
        sharpG += 0.03;       // 速度があるとGが出やすい → 少し厳しく
      }

      //--------------------------------------------------
      // 分類（sharp / smooth）
      //--------------------------------------------------
      if (absSide >= sharpG && absRot >= sharpRot) {
        type = 'sharp_turn';         // 急な右左折
        window.sharpTurns = (window.sharpTurns || 0) + 1;
      } else if (absSide >= 0.12 && absRot >= 4) {
        type = 'smooth_turn';        // 丁寧な右左折
        window.sharpTurns = Math.max(0, (window.sharpTurns || 0) - 1);
      } else {
        type = null;                 // 旋回はしてるけど弱い（無視）
      }

      drivingState.turnStart = 0;    // リセット（次の判定へ）
    }
  }

  // 加速判定
  //if (currentCondition !== 'accel') drivingState.accelStart = 0;
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
  // 🚗 停止直前ブレーキ評価ロジック（シミュレーション対応）
  // ===============================
  // ★ ライブ時と再生時でデータソースを切り替える
  const isReplayMode = Array.isArray(recentLogs); 
  
  let currentSpeed = speed;
  if (isReplayMode) {
      // 再生モードの場合、currentSpeedはログから取得済み
      currentSpeed = speed; 
  } else {
      // ライブモードの場合、window.currentSpeedを参照
      currentSpeed = window.currentSpeed ?? 0;
  }
  
  // ブレーキ判定のトリガー条件（速度が低い、かつまだ評価されていない）
  if (!drivingState.brakeEvaluated && currentSpeed <= 12) {
    const windowMs = 3000; // 直前3秒を分析

    let recentData = [];
    if (isReplayMode) {
        // ★ 再生モード: 引数 recentLogs (avg_g_logs形式) を使用
        recentData = recentLogs; 
    } else {
        // ★ ライブモード: グローバルバッファ (window.gLogBuffer) を使用
        recentData = window.gLogBuffer.filter(g => now - (g.timestamp || 0) <= windowMs);
    }
    
    // データが少ない場合は評価しない
    if (recentData.length > 2) {
      
      // 速度とG値を分離して計算
      const recentGs = recentData; // Gログとして扱う (g_x, g_y, g_z を含む)
      const recentSpeeds = recentData.map(d => ({ t: d.timestamp || d.timestamp_ms, speed: d.speed || 0 }));

      // 速度変化率の計算 (直近3秒の初速と終速)
      const firstSpeed = recentSpeeds[0]?.speed || 0;
      const lastSpeed = recentSpeeds[recentSpeeds.length - 1]?.speed || 0;
      const startTime = recentSpeeds[0]?.t || now - windowMs;
      const endTime = recentSpeeds[recentSpeeds.length - 1]?.t || now;
      
      const deltaSpeedTotal = firstSpeed - lastSpeed;
      const durationSec = (endTime - startTime) / 1000;
      
      let decelRate = 0;
      if (durationSec > 0.5) { // 少なくとも0.5秒以上の時間が必要
          decelRate = deltaSpeedTotal / durationSec; // km/h/s
      }

      // G値の分析 (前後Gの平均と最大絶対値)
      const avgG = recentGs.reduce((sum, g) => sum + (g.g_z || 0), 0) / recentGs.length;
      const maxAbsG = Math.max(...recentGs.map(g => Math.abs(g.g_z || 0)));

      // 🚦 閾値（変更なし）
      let suddenBrakeThreshold = 0.40;
      let decelThreshold = 7.5; 

      // 低速時（20km/h以下）はさらに緩める（変更なし）
      if (currentSpeed < 20) {
        suddenBrakeThreshold = 0.45;
        decelThreshold = 9.0;
      }

      let type = null;
      if (decelRate > decelThreshold || maxAbsG >= suddenBrakeThreshold) {
        type = 'sudden_brake'; // 急ブレーキ
      } else if (decelRate > 2.5 || Math.abs(avgG) >= 0.12) {
        type = 'smooth_brake'; // 良いブレーキ（やや緩く）
      }

      if (type) {
        // ⚠️ シミュレーション時は、このブロックはイベントを返すだけで、
        //    GPSログの保存や音声再生は replay.js 側のコンソール出力に任せる
        if (isReplayMode) {
            if (type) {
                drivingState.brakeEvaluated = true; // 次の判定が speed > 15 までスキップされるようにする
                return type; // ここで判定を確定し、replay.js に結果を返す
            }
        } else {
            // ★ ライブモードの既存処理開始
            // ✅ GPS位置取得 & 鮮度・座標バリデーション
            let gps = window.lastKnownPosition;
            const FRESH_LIMIT_MS = 3000;
            const isFresh = gps && gps.timestamp && (now - gps.timestamp <= FRESH_LIMIT_MS);
            const isValidCoord = gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number' && !(gps.latitude === 0 && gps.longitude === 0);

            if (!isFresh || !isValidCoord) {
              // 直近のgpsLogBufferから鮮度・座標を満たすものを逆順探索
                for (let i = window.gpsLogBuffer.length - 1; i >= 0; i--) {
                  const cand = window.gpsLogBuffer[i];
                  const ts = cand.timestamp;
                  if (!ts) continue;
                  if ((now - ts) > FRESH_LIMIT_MS) break; // これより前は鮮度なし
                  if (cand.latitude === 0 && cand.longitude === 0) continue;
                  gps = { latitude: cand.latitude, longitude: cand.longitude, timestamp: ts };
                  console.warn("📍 補完GPS採用 (鮮度/座標不足):", gps);
                  break;
                }
            }

            if (!gps || !gps.latitude || !gps.longitude || gps.latitude === 0 && gps.longitude === 0) {
              console.warn("⚠️ 有効かつ鮮度のあるGPSがないため、ブレーキイベントをスキップしました。");
              return; // 保存しない
            }

            if (now - lastEventTime > COOLDOWN_MS) {
              console.log(`🚗 停止直前ブレーキ判定 → ${type} (decelRate=${decelRate.toFixed(2)}, maxG=${maxAbsG.toFixed(2)})`);
              // ✅ ここに iOSフォールバックブロックを追加
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
                  "smooth_brake": [0, 2.592],
                  "sharp_turn": [2.593, 2.869],
                  "smooth_accel": [5.463, 2.635],
                  "smooth_turn": [8.099, 2.72],
                  "stable_drive": [10.82, 2.197],
                  "sudden_accel": [13.017, 2.464],
                  "sudden_brake": [15.482, 1.579],
                  "unstable_drive": [17.062, 1.938]
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
                playRandomAudio(type); // ← Android/PCは従来通り
              }

              const gxs = window.latestGX ?? 0;
              const gys = window.latestGY ?? 0;
              const gzs = window.latestGZ ?? 0;

              const logData = {
                timestamp: now,
                latitude: gps.latitude,
                longitude: gps.longitude,
                g_x: gxs,
                g_y: gys,
                g_z: gzs,
                speed,
                event: type
              };

              // バッファ追加
              window.gLogBuffer.push(logData);
              window.avgGLogBuffer.push(logData);
              window.gpsLogBuffer.push(logData);

              console.log("✅ Firestoreバッファに保存:", type, logData);
              lastEventTime = now;
            }

            drivingState.brakeEvaluated = true;
        }
      }
    }
  }

  // ✅ 再発動許可（走り出したら解除）
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
          "good_brake": [0, 2.592],
          "sharp_turn": [2.593, 2.869],
          "smooth_accel": [5.463, 2.635],
          "smooth_turn": [8.099, 2.72],
          "stable_drive": [10.82, 2.197],
          "sudden_accel": [13.017, 2.464],
          "sudden_brake": [15.482, 1.579],
          "unstable_drive": [17.062, 1.938]
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

// ★ 修正点2: detectDrivingPattern, resetMotion をまとめてエクスポート
export { detectDrivingPattern, resetMotion };