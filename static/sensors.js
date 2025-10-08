// sensors.js - DriveBuddy 新ロジック版（改良版運転評価システム）
// ============================================================

import { 
    MOTION_FRAME_SKIP, 
    MOTION_INIT_DURATION, 
    AUDIO_COOLDOWN_MS,
    COOLDOWN_MS,
    SMOOTHING_ALPHA,
    SMOOTHING_WINDOW_MS,
    BUMP_DETECTION_THRESHOLD,
    BUMP_DISABLE_DURATION,
    GOOD_TURN_MIN_G,
    GOOD_TURN_MAX_G,
    GOOD_TURN_MAX_LONG_G,
    GOOD_TURN_DURATION,
    GOOD_ACCEL_MIN_G,
    GOOD_ACCEL_MAX_G,
    GOOD_ACCEL_MAX_LAT_G,
    GOOD_ACCEL_DURATION,
    GOOD_BRAKE_MIN_G,
    GOOD_BRAKE_MAX_G,
    GOOD_BRAKE_MAX_LAT_G,
    GOOD_BRAKE_DURATION,
    SUDDEN_ACCEL_G_THRESHOLD,
    SUDDEN_BRAKE_G_THRESHOLD,
    SHARP_TURN_G_THRESHOLD
} from './config.js';
import { playRandomAudio } from './audio.js';
import { updateRealtimeScore } from './utils.js';
import { addEventMarker } from './maps.js';

console.log('=== sensors.js (final synced version) LOADED ===');

// === キャリブレーション ======================================

export function calibrateOrientation(samples) {
    const avg = { x: 0, y: 0, z: 0 };
    samples.forEach(s => { avg.x += s.x; avg.y += s.y; avg.z += s.z; });
    avg.x /= samples.length; avg.y /= samples.length; avg.z /= samples.length;
    window.calibrationData = detectOrientation(avg);
    console.log("Auto-calibrated:", window.calibrationData);
}

export function detectOrientation(avg) {
    const { x, y, z } = avg;
    const absX = Math.abs(x), absY = Math.abs(y), absZ = Math.abs(z);
    if (absZ > absX && absZ > absY) return z > 0 ? "flat_screen_up" : "flat_screen_down";
    if (absX > absY) return x > 0 ? "landscape_right" : "landscape_left";
    return y > 0 ? "default" : "upside_down";
}

export function adjustOrientation(ax, ay, az) {
    const mode = window.calibrationData || "default";
    switch (mode) {
        case "default": return { forward: -az, side: ax, up: -ay };
        case "landscape_left": return { forward: -az, side: ay, up: -ax };
        case "landscape_right": return { forward: -az, side: -ay, up: ax };
        case "flat_screen_down": return { forward: ay, side: ax, up: -az };
        case "flat_screen_up": return { forward: ay, side: ax, up: az };
        default: return { forward: -az, side: ax, up: -ay };
    }
}

// === 内部状態管理 =============================================

// 最新値とスムージング用データ
window.latestValues = { forward: 0, side: 0, up: 0, rotation: 0, speed: 0 };
window.smoothedValues = { forward: 0, side: 0, up: 0 };
window.jerkValues = { forward: 0 };
window.gHistory = []; // スムージング用履歴

// 継続状態管理
window.holdStart = { goodTurn: null, goodAccel: null, goodBrake: null };
window.lastAudioPlayTime = {};

// バンプ検出・無効化
window.bumpDisableUntil = 0;

// 警告クールダウン管理
window.lastWarningTime = { suddenAccel: 0, suddenBrake: 0, sharpTurn: 0 };

// 旧システム互換用
window.speedHistory = [];
window.prevGpsSpeed = null;
window.prevGpsTime = null;
window.suddenAccels = 0;
window.suddenBrakes = 0;
window.sharpTurns = 0;

// === DeviceMotionイベント ====================================

export function handleDeviceMotion(event) {
    console.log('📡 DeviceMotion event received');
    const now = Date.now();

    // 初期化期間のスキップ
    if (!window.motionInitTime) {
        window.motionInitTime = now;
        return;
    }
    if (now - window.motionInitTime < MOTION_INIT_DURATION) return;

    // フレームスキップ
    window.motionFrameCounter++;
    if (window.motionFrameCounter % MOTION_FRAME_SKIP !== 0) return;

    const acc = event.accelerationIncludingGravity || event.acceleration;
    if (!acc) return;

    const { forward, side, up } = adjustOrientation(acc.x || 0, acc.y || 0, acc.z || 0);
    let rotationZ = 0;
    if (event.rotationRate?.alpha !== undefined) {
        rotationZ = (event.rotationRate.alpha * Math.PI) / 180;
    }

    // 生データ更新（G単位換算）
    window.latestValues.forward = forward / 9.8;
    window.latestValues.side = side / 9.8;
    window.latestValues.up = up / 9.8;
    window.latestValues.rotation = rotationZ;
    window.latestValues.speed = window.latestSpeed || 0;

    // 履歴追加（スムージング用）
    window.gHistory.push({
        time: now,
        forward: window.latestValues.forward,
        side: window.latestValues.side,
        up: window.latestValues.up
    });
    
    // 古いデータを削除（指定時間以上前のデータ）
    const cutoffTime = now - SMOOTHING_WINDOW_MS;
    window.gHistory = window.gHistory.filter(h => h.time > cutoffTime);

    // スムージング処理
    applySmoothing();

    // ジャーク計算
    calculateJerk(now);

    // バンプ検出と他軸判定無効化
    checkBumpDetection(now);

    // 運転状況評価（バンプ無効化中でなければ実行）
    if (now > window.bumpDisableUntil) {
        checkDrivingConditions(now);
    }

    // === 互換性維持：旧システム用グローバル変数の更新 ===
    window.latestGX = window.latestValues.side;
    window.latestGY = window.latestValues.rotation;
    window.latestGZ = window.latestValues.forward;

    // === Gログバッファに追加（互換性維持）===
    if (window.sessionId) {
        const gData = {
            timestamp: now,
            g_x: window.latestValues.side,
            g_y: window.latestValues.rotation,
            g_z: window.latestValues.forward,
        };
        if (!window.gLogBuffer) window.gLogBuffer = [];
        window.gLogBuffer.push(gData);
    }

    console.log(`G: fwd=${window.smoothedValues.forward.toFixed(2)}G, side=${window.smoothedValues.side.toFixed(2)}G, up=${window.smoothedValues.up.toFixed(2)}G, jerk_fwd=${window.jerkValues.forward.toFixed(2)}g/s`);
}

// === スムージング処理 ==========================================

function applySmoothing() {
    if (window.gHistory.length === 0) return;

    // 指数平滑化を使用
    if (!window.smoothedValues.forward && !window.smoothedValues.side && !window.smoothedValues.up) {
        // 初回は生データを使用
        window.smoothedValues.forward = window.latestValues.forward;
        window.smoothedValues.side = window.latestValues.side;
        window.smoothedValues.up = window.latestValues.up;
    } else {
        // 指数平滑化: smoothed = α * current + (1-α) * previous
        window.smoothedValues.forward = SMOOTHING_ALPHA * window.latestValues.forward + (1 - SMOOTHING_ALPHA) * window.smoothedValues.forward;
        window.smoothedValues.side = SMOOTHING_ALPHA * window.latestValues.side + (1 - SMOOTHING_ALPHA) * window.smoothedValues.side;
        window.smoothedValues.up = SMOOTHING_ALPHA * window.latestValues.up + (1 - SMOOTHING_ALPHA) * window.smoothedValues.up;
    }
}

// === ジャーク計算 ===============================================

function calculateJerk(now) {
    // 前回の前後G値を保存しておき、差分から前後ジャークを計算
    if (!window.prevForwardG || !window.prevForwardTime) {
        window.prevForwardG = window.smoothedValues.forward;
        window.prevForwardTime = now;
        window.jerkValues.forward = 0;
        return;
    }

    const dt = (now - window.prevForwardTime) / 1000; // 秒単位
    if (dt > 0) {
        const deltaG = window.smoothedValues.forward - window.prevForwardG;
        window.jerkValues.forward = deltaG / dt; // g/s単位
        
        window.prevForwardG = window.smoothedValues.forward;
        window.prevForwardTime = now;
    }
}

// === バンプ検出・無効化 =========================================

function checkBumpDetection(now) {
    // 縦G（ハイパスフィルタ相当）の絶対値が閾値を超えた場合
    if (Math.abs(window.smoothedValues.up) > BUMP_DETECTION_THRESHOLD) {
        window.bumpDisableUntil = now + BUMP_DISABLE_DURATION;
        console.log(`🚧 バンプ検出: up=${window.smoothedValues.up.toFixed(2)}G, 他軸判定を${BUMP_DISABLE_DURATION}ms休止`);
    }
}

// === 運転状況判定（新システム） ==================================

function checkDrivingConditions(now) {
    const { forward, side } = window.smoothedValues;
    const jerk_forward = window.jerkValues.forward;

    // === 褒め条件（警告中は褒めを抑制） ===
    const isWarningActive = isAnyWarningActive(now);

    if (!isWarningActive) {
        // 1. 良い旋回（なめらかカーブ）
        checkGoodTurn(now, side, forward);

        // 2. 良い加速（無理のない踏み増し）
        checkGoodAccel(now, forward, side, jerk_forward);

        // 3. 良いブレーキ（予見的減速）
        checkGoodBrake(now, forward, side, jerk_forward);
    }

    // === 警告条件 ===
    // 1. 急発進
    checkSuddenAccel(now, forward, jerk_forward);

    // 2. 急ブレーキ
    checkSuddenBrake(now, forward, jerk_forward);

    // 3. 急旋回
    checkSharpTurn(now, side);
}

// === 警告状態チェック ===========================================

function isAnyWarningActive(now) {
    const SAME_CATEGORY_COOLDOWN = 3000; // 同カテゴリ3秒クールダウン
    
    return (now - window.lastWarningTime.suddenAccel < SAME_CATEGORY_COOLDOWN) ||
           (now - window.lastWarningTime.suddenBrake < SAME_CATEGORY_COOLDOWN) ||
           (now - window.lastWarningTime.sharpTurn < SAME_CATEGORY_COOLDOWN);
}

// === 褒め条件の個別判定 ======================================

function checkGoodTurn(now, side, forward) {
    const absSide = Math.abs(side);
    const absForward = Math.abs(forward);
    
    const condition = (absSide >= GOOD_TURN_MIN_G && absSide <= GOOD_TURN_MAX_G && 
                      absForward < GOOD_TURN_MAX_LONG_G);
    
    handleHold("goodTurn", condition, now, GOOD_TURN_DURATION, () => {
        console.log(`🎵 良い旋回音声再生をリクエスト: ang_vel_low, sessionId=${window.sessionId || 'NONE'}`);
        playRandomAudio("ang_vel_low");
        updateRealtimeScore("turn", +3);
        console.log(`👍 良い旋回: side=${side.toFixed(2)}G, forward=${forward.toFixed(2)}G`);
    });
}

function checkGoodAccel(now, forward, side, jerk_forward) {
    const absSide = Math.abs(side);
    
    const condition = (forward >= GOOD_ACCEL_MIN_G && forward <= GOOD_ACCEL_MAX_G &&
                      absSide < GOOD_ACCEL_MAX_LAT_G);
    
    handleHold("goodAccel", condition, now, GOOD_ACCEL_DURATION, () => {
        console.log(`🎵 良い加速音声再生をリクエスト: good_accel, sessionId=${window.sessionId || 'NONE'}`);
        playRandomAudio("good_accel");
        updateRealtimeScore("accel", +2);
        console.log(`👍 良い加速: forward=${forward.toFixed(2)}G, side=${side.toFixed(2)}G`);
    });
}

function checkGoodBrake(now, forward, side, jerk_forward) {
    const absSide = Math.abs(side);
    
    const condition = (forward >= GOOD_BRAKE_MIN_G && forward <= GOOD_BRAKE_MAX_G &&
                      absSide < GOOD_BRAKE_MAX_LAT_G);
    
    handleHold("goodBrake", condition, now, GOOD_BRAKE_DURATION, () => {
        console.log(`🎵 良いブレーキ音声再生をリクエスト: good_brake, sessionId=${window.sessionId || 'NONE'}`);
        playRandomAudio("good_brake");
        updateRealtimeScore("brake", +2);
        console.log(`👍 良いブレーキ: forward=${forward.toFixed(2)}G, side=${side.toFixed(2)}G`);
    });
}

// === 警告条件の個別判定 ======================================

function checkSuddenAccel(now, forward, jerk_forward) {
    if (forward >= SUDDEN_ACCEL_G_THRESHOLD) {
        if (now - window.lastWarningTime.suddenAccel >= COOLDOWN_MS) {
            console.log(`🚨 急発進検出! forward=${forward.toFixed(2)}G, sessionId=${window.sessionId || 'NONE'}`);
            
            window.lastWarningTime.suddenAccel = now;
            window.suddenAccels++;

            const accelElement = document.getElementById('accel-count');
            if (accelElement) accelElement.textContent = window.suddenAccels;

            // GPS位置が利用可能な場合、地図にマーカーを追加
            if (window.prevLatLng && typeof addEventMarker === 'function') {
                addEventMarker(window.prevLatLng.lat, window.prevLatLng.lng, 'sudden_accel');
                console.log(`📍 急発進マーカー追加: lat=${window.prevLatLng.lat.toFixed(5)}, lng=${window.prevLatLng.lng.toFixed(5)}`);
            }

            // GPSログに保存するためのイベント設定
            window.currentDrivingEvent = 'sudden_accel';

            console.log(`🎵 急発進音声再生をリクエスト: sudden_accel`);
            playRandomAudio("sudden_accel");
            updateRealtimeScore("accel", -4);
            console.log(`⚠️ 急発進: forward=${forward.toFixed(2)}G`);
        } else {
            console.log(`🕐 急発進検出（クールダウン中）: ${Math.round((COOLDOWN_MS - (now - window.lastWarningTime.suddenAccel)) / 1000)}s remaining`);
        }
    }
}

function checkSuddenBrake(now, forward, jerk_forward) {
    if (forward <= SUDDEN_BRAKE_G_THRESHOLD) {
        if (now - window.lastWarningTime.suddenBrake >= COOLDOWN_MS) {
            console.log(`🚨 急ブレーキ検出! forward=${forward.toFixed(2)}G, sessionId=${window.sessionId || 'NONE'}`);
            
            window.lastWarningTime.suddenBrake = now;
            window.suddenBrakes++;

            const brakeElement = document.getElementById('brake-count');
            if (brakeElement) brakeElement.textContent = window.suddenBrakes;

            // GPS位置が利用可能な場合、地図にマーカーを追加
            if (window.prevLatLng && typeof addEventMarker === 'function') {
                addEventMarker(window.prevLatLng.lat, window.prevLatLng.lng, 'sudden_brake');
                console.log(`📍 急ブレーキマーカー追加: lat=${window.prevLatLng.lat.toFixed(5)}, lng=${window.prevLatLng.lng.toFixed(5)}`);
            }

            // GPSログに保存するためのイベント設定
            window.currentDrivingEvent = 'sudden_brake';

            console.log(`🎵 急ブレーキ音声再生をリクエスト: sudden_brake`);
            playRandomAudio("sudden_brake");
            updateRealtimeScore("brake", -7);
            console.log(`⚠️ 急ブレーキ: forward=${forward.toFixed(2)}G`);
        } else {
            console.log(`🕐 急ブレーキ検出（クールダウン中）: ${Math.round((COOLDOWN_MS - (now - window.lastWarningTime.suddenBrake)) / 1000)}s remaining`);
        }
    }
}

function checkSharpTurn(now, side) {
    const absSide = Math.abs(side);
    
    if (absSide >= SHARP_TURN_G_THRESHOLD) {
        if (now - window.lastWarningTime.sharpTurn >= COOLDOWN_MS) {
            console.log(`🚨 急旋回検出! side=${side.toFixed(2)}G, sessionId=${window.sessionId || 'NONE'}`);
            
            window.lastWarningTime.sharpTurn = now;
            window.sharpTurns++;

            const turnElement = document.getElementById('turn-count');
            if (turnElement) turnElement.textContent = window.sharpTurns;

            // GPS位置が利用可能な場合、地図にマーカーを追加
            if (window.prevLatLng && typeof addEventMarker === 'function') {
                addEventMarker(window.prevLatLng.lat, window.prevLatLng.lng, 'sharp_turn');
                console.log(`📍 急旋回マーカー追加: lat=${window.prevLatLng.lat.toFixed(5)}, lng=${window.prevLatLng.lng.toFixed(5)}`);
            }

            // GPSログに保存するためのイベント設定
            window.currentDrivingEvent = 'sharp_turn';

            console.log(`🎵 急旋回音声再生をリクエスト: sharp_turn`);
            playRandomAudio("sharp_turn");
            updateRealtimeScore("turn", -3);
            console.log(`⚠️ 急旋回: side=${side.toFixed(2)}G`);
        } else {
            console.log(`🕐 急旋回検出（クールダウン中）: ${Math.round((COOLDOWN_MS - (now - window.lastWarningTime.sharpTurn)) / 1000)}s remaining`);
        }
    }
}

// === 継続判定・音声発火 ==========================================

function handleHold(type, active, now, duration, callback) {
    if (active) {
        if (!window.holdStart[type]) {
            window.holdStart[type] = now;
        }
        const holdDuration = now - window.holdStart[type];
        const lastPlay = window.lastAudioPlayTime[type] || 0;

        if (holdDuration >= duration && now - lastPlay >= AUDIO_COOLDOWN_MS) {
            callback();
            window.lastAudioPlayTime[type] = now;
            window.holdStart[type] = null; // リセットして再判定可能にする
        }
    } else {
        window.holdStart[type] = null;
    }
}

// === 旧システム互換用（GPS速度変化による指摘） =================

function checkSpeedBasedEvents(now, currentSpeed) {
    // 互換性のために残しておく（必要に応じて新システムに統合可能）
    if (window.prevGpsSpeed !== null && window.prevGpsTime !== null) {
        const dt = (now - window.prevGpsTime) / 1000;
        
        if (dt >= 0.3 && dt <= 3.0) {
            const accelMs2 = (currentSpeed / 3.6 - window.prevGpsSpeed / 3.6) / dt;
            // 旧システムの処理は新システムに統合済みのため、ここでは省略
        }
    }
    
    window.prevGpsSpeed = currentSpeed;
    window.prevGpsTime = now;
}

// === 検出開始・停止 =============================================

export function startMotionDetection() {
    if (window.DeviceMotionEvent && !window.isMotionDetectionActive) {
        // 基本初期化
        window.motionFrameCounter = 0;
        window.motionInitTime = null;
        window.lastAudioPlayTime = {};
        
        // 新システム用初期化
        window.holdStart = { goodTurn: null, goodAccel: null, goodBrake: null };
        window.smoothedValues = { forward: 0, side: 0, up: 0 };
        window.jerkValues = { forward: 0 };
        window.gHistory = [];
        window.bumpDisableUntil = 0;
        window.lastWarningTime = { suddenAccel: 0, suddenBrake: 0, sharpTurn: 0 };
        
        // 互換性用初期化
        window.suddenAccels = window.suddenAccels || 0;
        window.suddenBrakes = window.suddenBrakes || 0;
        window.sharpTurns = window.sharpTurns || 0;
        window.prevGpsSpeed = null;
        window.prevGpsTime = null;
        window.currentDrivingEvent = 'normal';
        
        // ジャーク計算用初期化
        window.prevForwardG = null;
        window.prevForwardTime = null;
        
        window.addEventListener('devicemotion', handleDeviceMotion, { passive: true });
        window.isMotionDetectionActive = true;
        console.log('📱 Motion detection started with new evaluation system.');
    }
}

export function stopMotionDetection() {
    if (window.DeviceMotionEvent && window.isMotionDetectionActive) {
        window.removeEventListener('devicemotion', handleDeviceMotion);
        window.isMotionDetectionActive = false;
        console.log('🛑 Motion detection stopped.');
    }
}

// === 自動キャリブレーション ====================================

export function startAutoCalibration() {
    try {
        window._calibSamples = [];
        const calibListener = (e) => {
            const a = e.accelerationIncludingGravity || e.acceleration;
            if (!a) return;
            window._calibSamples.push({ x: a.x || 0, y: a.y || 0, z: a.z || 0 });
            if (window._calibSamples.length >= 60) {
                window.removeEventListener('devicemotion', calibListener);
                calibrateOrientation(window._calibSamples);
            }
        };
        window.addEventListener('devicemotion', calibListener, { passive: true });
        setTimeout(() => {
            window.removeEventListener('devicemotion', calibListener);
            if (window._calibSamples.length >= 10) {
                calibrateOrientation(window._calibSamples);
            }
        }, 2000);
    } catch (e) {
        console.warn('Auto calibration start failed:', e);
    }
}

