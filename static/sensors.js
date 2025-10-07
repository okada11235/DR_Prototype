// sensors.js - DriveBuddy 新ロジック版（旋回・加速・減速・直進判定）
// ============================================================

import { 
    MOTION_FRAME_SKIP, 
    MOTION_INIT_DURATION, 
    AUDIO_COOLDOWN_MS,
    ACCEL_EVENT_MS2,
    SHARP_TURN_G_THRESHOLD,
    COOLDOWN_MS
} from './config.js';
import { playRandomAudio } from './audio.js';
import { updateRealtimeScore } from './utils.js';

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

window.latestValues = { forward: 0, side: 0, rotation: 0, speed: 0 };
window.holdStart = { turn: null, accel: null, brake: null, straight: null };
window.lastAudioPlayTime = {};
window.speedHistory = [];

// GPS速度変化追跡用
window.prevGpsSpeed = null;
window.prevGpsTime = null;
window.lastAccelEventTime = 0;
window.lastBrakeEventTime = 0;
window.lastTurnEventTime = 0;

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

    const { forward, side } = adjustOrientation(acc.x || 0, acc.y || 0, acc.z || 0);
    let rotationZ = 0;
    if (event.rotationRate?.alpha !== undefined) {
        rotationZ = (event.rotationRate.alpha * Math.PI) / 180;
    }

    // 最新値更新（G単位換算）
    window.latestValues.forward = forward / 9.8;
    window.latestValues.side = side / 9.8;
    window.latestValues.rotation = rotationZ;
    const speed = window.latestSpeed || 0;
    
    // 最新のG値を後方互換のためにグローバルに保存
    window.latestGX = window.latestValues.side;
    window.latestGY = window.latestValues.rotation;
    window.latestGZ = window.latestValues.forward;

    // 速度変化履歴（過去約0.5〜1秒）
    window.speedHistory.push({ time: now, speed });
    if (window.speedHistory.length > 10) window.speedHistory.shift();
    const prevSpeed = window.speedHistory[0]?.speed || speed;
    window.speedDelta = speed - prevSpeed;

    // 条件チェック
    checkDrivingConditions(now);

    // === Gログバッファに追加 ===
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

    console.log(`G: fwd=${(forward/9.8).toFixed(2)}G, side=${(side/9.8).toFixed(2)}G, speed=${speed.toFixed(1)}km/h, Δv=${window.speedDelta.toFixed(2)}km/h`);
}

// === 運転状況判定（4分類） =====================================

function checkDrivingConditions(now) {
    const { forward, side, rotation } = window.latestValues;
    const speed = window.latestSpeed || 0;

    // --- GPS速度変化による指摘機能 ---
    checkSpeedBasedEvents(now, speed);
    
    // --- 横G急旋回指摘（rotationRate非対応端末用） ---
    checkLateralGEvents(now, speed);

    // --- 1. 旋回（コーナリング評価） ---
    if (Math.abs(side) >= 0.15 && Math.abs(forward) < 0.25 && speed >= 15) {
        handleHold("turn", true, now);
    } else handleHold("turn", false, now);

    // --- 2. 加速（forward 正方向） ---
    if (forward >= 0.2 && window.speedDelta > 3 && Math.abs(side) < 0.2 && speed > 3) {
        handleHold("accel", true, now);
    } else handleHold("accel", false, now);

    // --- 3. 減速（forward 負方向） ---
    if (forward <= -0.2 && window.speedDelta < -3 && Math.abs(side) < 0.25) {
        handleHold("brake", true, now);
    } else handleHold("brake", false, now);

    // --- 4. 直進 ---
    if (speed >= 25 && Math.abs(forward) < 0.25 && Math.abs(side) < 0.25 && Math.abs(rotation) < 0.08) {
        handleHold("straight", true, now);
    } else handleHold("straight", false, now);
}

// === 継続判定・音声発火 ==========================================

function handleHold(type, active, now) {
    const HOLD_TIME = { turn: 1500, accel: 1000, brake: 1000, straight: 3000 };

    if (active) {
        if (!window.holdStart[type]) window.holdStart[type] = now;
        const duration = now - window.holdStart[type];
        const lastPlay = window.lastAudioPlayTime[type] || 0;

        if (duration >= HOLD_TIME[type] && now - lastPlay >= AUDIO_COOLDOWN_MS) {
            playFeedback(type);
            window.lastAudioPlayTime[type] = now;
            window.holdStart[type] = null;
        }
    } else {
        window.holdStart[type] = null;
    }
}

// === GPS速度変化による指摘機能 ===============================

function checkSpeedBasedEvents(now, currentSpeed) {
    if (window.prevGpsSpeed !== null && window.prevGpsTime !== null) {
        const dt = (now - window.prevGpsTime) / 1000;
        
        // GPS品質ガード（0.3〜3秒間隔）
        if (dt >= 0.3 && dt <= 3.0) {
            const accelMs2 = (currentSpeed / 3.6 - window.prevGpsSpeed / 3.6) / dt; // m/s²
            
            // === 急発進（強め加速） ===
            if (accelMs2 >= ACCEL_EVENT_MS2 * 1.8 && speed > 10 && now - window.lastAccelEventTime > COOLDOWN_MS) {
                if (!window.suddenAccels) window.suddenAccels = 0;
                window.suddenAccels++;

                const accelElement = document.getElementById('accel-count');
                if (accelElement) accelElement.textContent = window.suddenAccels;

                window.lastAccelEventTime = now;
                window.currentDrivingEvent = 'sudden_accel';

                const lastAccelAudio = window.lastAudioPlayTime['sudden_accel'] || 0;
                if (now - lastAccelAudio >= AUDIO_COOLDOWN_MS) {
                    playRandomAudio("sudden_accel");
                    window.lastAudioPlayTime['sudden_accel'] = now;
                }

                updateRealtimeScore("accel", -4);
                console.log(`⚠️ 急発進検出: ${accelMs2.toFixed(2)} m/s²`);
            }
            
            // === 強ブレーキ判定（加速度ベース） ===
            if (window.latestValues.forward <= -0.5 && speed > 10 && now - window.lastBrakeEventTime > COOLDOWN_MS) {
                if (!window.suddenBrakes) window.suddenBrakes = 0;
                window.suddenBrakes++;

                const brakeElement = document.getElementById('brake-count');
                if (brakeElement) brakeElement.textContent = window.suddenBrakes;

                window.lastBrakeEventTime = now;
                window.currentDrivingEvent = 'hard_brake';

                const lastHardBrakeAudio = window.lastAudioPlayTime['hard_brake'] || 0;
                if (now - lastHardBrakeAudio >= AUDIO_COOLDOWN_MS) {
                    playRandomAudio("hard_brake");
                    window.lastAudioPlayTime['hard_brake'] = now;
                }

                updateRealtimeScore("brake", -7); // 強ブレーキはより減点
                console.log(`💥 強ブレーキ検出: forward=${window.latestValues.forward.toFixed(2)} G`);
            }
        }
    }
    
    window.prevGpsSpeed = currentSpeed;
    window.prevGpsTime = now;
}

function checkLateralGEvents(now, speed) {
    // === 急カーブ（急旋回） ===
    if (!window._rotationAvailable &&
        Math.abs(window.latestValues.side) > SHARP_TURN_G_THRESHOLD * 1.3 && 
        speed > 25 && 
        now - window.lastTurnEventTime > COOLDOWN_MS) {

        if (!window.sharpTurns) window.sharpTurns = 0;
        window.sharpTurns++;

        const turnElement = document.getElementById('turn-count');
        if (turnElement) turnElement.textContent = window.sharpTurns;

        window.lastTurnEventTime = now;
        window.currentDrivingEvent = 'sharp_turn';

        const lastTurnAudio = window.lastAudioPlayTime['sharp_turn'] || 0;
        if (now - lastTurnAudio >= AUDIO_COOLDOWN_MS) {
            playRandomAudio("sharp_turn");
            window.lastAudioPlayTime['sharp_turn'] = now;
        }

        updateRealtimeScore("turn", -3);
        console.log(`⚠️ 急旋回検出: ${window.latestValues.side.toFixed(2)} G`);
    }
}

// === フィードバック音声＋スコア反映 ===============================

function playFeedback(type) {
    switch (type) {
        case "turn":
            playRandomAudio("ang_vel_low");
            updateRealtimeScore("turn", +3);
            break;
        case "accel":
            playRandomAudio("good_accel");
            updateRealtimeScore("accel", +2);
            break;
        case "brake":
            playRandomAudio("good_brake");
            updateRealtimeScore("brake", +2);
            break;
        case "straight":
            playRandomAudio("stable_drive");
            updateRealtimeScore("straight", +1);
            break;
    }
}

// === 検出開始・停止 =============================================

export function startMotionDetection() {
    if (window.DeviceMotionEvent && !window.isMotionDetectionActive) {
        window.motionFrameCounter = 0;
        window.motionInitTime = null;
        window.lastAudioPlayTime = {};
        window.holdStart = {};
        
        // 指摘用変数の初期化
        window.suddenAccels = window.suddenAccels || 0;
        window.suddenBrakes = window.suddenBrakes || 0;
        window.sharpTurns = window.sharpTurns || 0;
        window.prevGpsSpeed = null;
        window.prevGpsTime = null;
        window.lastAccelEventTime = 0;
        window.lastBrakeEventTime = 0;
        window.lastTurnEventTime = 0;
        window.currentDrivingEvent = 'normal'; // イベント状態初期化
        
        window.addEventListener('devicemotion', handleDeviceMotion, { passive: true });
        window.isMotionDetectionActive = true;
        console.log('📱 Motion detection started.');
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

