// sensors.js - DriveBuddy 新ロジック版（旋回・加速・減速・直進判定）
// ============================================================

import { 
    MOTION_FRAME_SKIP, 
    MOTION_INIT_DURATION, 
    AUDIO_COOLDOWN_MS 
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
}

// === 運転状況判定（4分類） =====================================

function checkDrivingConditions(now) {
    const { forward, side, rotation } = window.latestValues;
    const speed = window.latestSpeed || 0;

    // --- 1. 旋回（コーナリング評価） ---
    if (Math.abs(side) >= 0.25 && Math.abs(forward) < 0.2 && speed >= 15) {
        handleHold("turn", true, now);
    } else handleHold("turn", false, now);

    // --- 2. 加速 ---
    if (forward <= -0.3 && window.speedDelta > 5 && Math.abs(side) < 0.2 && speed > 5) {
        handleHold("accel", true, now);
    } else handleHold("accel", false, now);

    // --- 3. 減速 ---
    if (forward >= 0.3 && window.speedDelta < -5 && Math.abs(side) < 0.2 && Math.abs(side) < 0.25) {
        handleHold("brake", true, now);
    } else handleHold("brake", false, now);

    // --- 4. 直進 ---
    if (speed >= 30 && Math.abs(forward) < 0.15 && Math.abs(side) < 0.15 && Math.abs(rotation) < 0.05) {
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

// === モーション許可リクエスト =====================================

export function requestMotionPermission(callback) {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
        // iOS専用の許可リクエスト
        DeviceMotionEvent.requestPermission().then(response => {
            if (response === 'granted') {
                console.log('✅ Motion permission granted');
                if (callback) callback();
            } else {
                alert('⚠️ 加速度センサーの使用が許可されませんでした。設定から再度許可してください。');
            }
        }).catch(err => {
            console.error('加速度センサー許可リクエスト中にエラー:', err);
            alert('加速度センサーの使用許可リクエストでエラーが発生しました。');
        });
    } else {
        // Androidなど、許可が不要な場合
        console.log('✅ Motion permission not required');
        if (callback) callback();
    }
}

