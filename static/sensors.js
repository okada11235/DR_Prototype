// sensors.js - センサー処理とモーション検出（DriveBuddyリアルタイム判定統合版）

import { 
    MOTION_FRAME_SKIP, 
    MOTION_INIT_DURATION, 
    JERK_EVENT_MS3, 
    YAW_RATE_EVENT, 
    ANG_ACCEL_EVENT,
    AUDIO_COOLDOWN_MS,
    ACCEL_EVENT_MS2,
    BRAKE_EVENT_MS2,
    SHARP_TURN_G_THRESHOLD
} from './config.js';
import { playRandomAudio } from './audio.js';

console.log('=== sensors.js LOADED (Realtime Driving Feedback integrated) ===');

// === リアルタイム評価用の保持状態 ===
let holdStart = { accel: null, brake: null, turn: null, straight: null };
let lastPlay = { accel: 0, brake: 0, turn: 0, straight: 0 };
const HOLD_TIME = { accel: 1000, brake: 1000, turn: 1500, straight: 3000 };

// --- 以下、元のキャリブレーション・軸変換系はそのまま ---
export function calibrateOrientation(samples) {
    const avg = { x: 0, y: 0, z: 0 };
    samples.forEach(s => {
        avg.x += s.x; avg.y += s.y; avg.z += s.z;
    });
    avg.x /= samples.length;
    avg.y /= samples.length;
    avg.z /= samples.length;
    window.calibrationData = detectOrientation(avg);
    console.log("Auto-calibrated:", window.calibrationData);
}

export function detectOrientation(avg) {
    const { x, y, z } = avg;
    const absX = Math.abs(x), absY = Math.abs(y), absZ = Math.abs(z);
    if (absZ > absX && absZ > absY) return z > 0 ? "flat_screen_up" : "flat_screen_down";
    else if (absX > absY) return x > 0 ? "landscape_right" : "landscape_left";
    else return y > 0 ? "default" : "upside_down";
}

export function adjustOrientation(ax, ay, az) {
    let mode = window.calibrationData || "default";
    switch (mode) {
        case "default": return { forward: -az, side: ax, up: -ay };
        case "landscape_left": return { forward: -az, side: ay, up: -ax };
        case "landscape_right": return { forward: -az, side: -ay, up: ax };
        case "flat_screen_down": return { forward: ay, side: ax, up: -az };
        case "flat_screen_up": return { forward: ay, side: ax, up: az };
        case "upside_down": return { forward: -az, side: -ax, up: ay };
        default: return { forward: -az, side: ax, up: -ay };
    }
}

export function mapYawFromRotationRate(rr) {
    if (!rr) return 0;
    const deg2rad = Math.PI / 180;
    const alpha = (rr.alpha || 0) * deg2rad;
    const beta  = (rr.beta  || 0) * deg2rad;
    const gamma = (rr.gamma || 0) * deg2rad;
    const mode = window.calibrationData || "default";
    switch (mode) {
        case "landscape_left":  return  gamma;
        case "landscape_right": return -gamma;
        case "flat_screen_up":  return  alpha;
        case "flat_screen_down":return -alpha;
        case "upside_down":     return -alpha;
        default:                return  alpha;
    }
}

// === DeviceMotionイベントハンドラ ===
export function handleDeviceMotion(event) {
    const now = Date.now();

    // --- 初期化 ---
    if (!window.motionInitTime) {
        window.motionInitTime = now;
        window.motionFrameCounter = 0;
        console.log('📱 Motion detection initialized');
        return;
    }
    if (now - window.motionInitTime < MOTION_INIT_DURATION) return;
    window.motionFrameCounter++;
    if (window.motionFrameCounter % MOTION_FRAME_SKIP !== 0) return;

    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc) return;
    if (event.rotationRate) window._rotationAvailable = true;

    const { forward, side, up } = adjustOrientation(acc.x || 0, acc.y || 0, acc.z || 0);
    window.latestGZ = forward / 9.8;
    window.latestGX = side    / 9.8;
    window.latestGY = up      / 9.8;

    // ===== 1) ジャーク・角速度・角加速度（既存処理） =====
    const accelMs2 = forward;
    if (window.lastAccelSample !== null && window.lastAccelSampleTime !== null) {
        const dt = (now - window.lastAccelSampleTime) / 1000;
        if (dt > 0.05 && dt < 1.0) {
            const jerk = (accelMs2 - window.lastAccelSample) / dt;
            if (Math.abs(jerk) >= JERK_EVENT_MS3 && Math.abs(jerk) < 50) {
                const lastJerkAudio = window.lastAudioPlayTime['jerk'] || 0;
                if (now - lastJerkAudio >= AUDIO_COOLDOWN_MS) {
                    console.log(`⚠️ Jerk detected: ${jerk.toFixed(2)} m/s^3`);
                    playRandomAudio("jerk");
                    window.lastHighJerkTime = now;
                }
            }
        }
    }
    window.lastAccelSample = accelMs2;
    window.lastAccelSampleTime = now;

    // --- 角速度 ---
    let yawRate = 0;
    if (event.rotationRate) {
        yawRate = mapYawFromRotationRate(event.rotationRate);
        if (Math.abs(yawRate) >= YAW_RATE_EVENT && Math.abs(yawRate) < 10) {
            const lastTurnAudio = window.lastAudioPlayTime['yaw_rate_high'] || 0;
            if (now - lastTurnAudio >= AUDIO_COOLDOWN_MS) {
                console.log(`⚠️ High yaw rate detected: ${yawRate.toFixed(3)} rad/s`);
                playRandomAudio("yaw_rate_high");
                window.lastHighYawRateTime = now;
            }
        }
        if (window.lastYawRate !== null && window.lastYawTime !== null) {
            const dtYaw = (now - window.lastYawTime) / 1000;
            if (dtYaw > 0.05 && dtYaw < 1.0) {
                const angAccel = (yawRate - window.lastYawRate) / dtYaw;
                if (Math.abs(angAccel) >= ANG_ACCEL_EVENT && Math.abs(angAccel) < 20) {
                    const lastAngAccelAudio = window.lastAudioPlayTime['ang_accel_high'] || 0;
                    if (now - lastAngAccelAudio >= AUDIO_COOLDOWN_MS) {
                        console.log(`⚠️ High angular acceleration: ${angAccel.toFixed(3)} rad/s^2`);
                        playRandomAudio("ang_accel_high");
                        window.lastHighAngAccelTime = now;
                    }
                }
            }
        }
        window.lastYawRate = yawRate;
        window.lastYawTime = now;
    }

    // ===== 2) 新しい「旋回／加速／減速／直進」フィードバック =====
    const jerkNow = (accelMs2 - (window.lastAccelSample || accelMs2)) / ((now - (window.lastAccelSampleTime || now)) / 1000 || 1);
    const speedKmh = window.currentSpeed || 0;

    const turning = Math.abs(window.latestGX) >= SHARP_TURN_G_THRESHOLD && Math.abs(window.latestGZ) < 0.2 && speedKmh >= 15;
    const accelOK = window.latestGZ <= -ACCEL_EVENT_MS2 && Math.abs(window.latestGX) < 0.2 && speedKmh >= 5;
    const brakeOK = window.latestGZ >= BRAKE_EVENT_MS2 && Math.abs(window.latestGX) < 0.2;
    const straight =
        speedKmh >= 30 &&
        Math.abs(window.latestGZ) < 0.15 &&
        Math.abs(window.latestGX) < 0.15 &&
        Math.abs(yawRate) < 0.05;

    handleHold("turn", turning, now, jerkNow);
    handleHold("accel", accelOK, now, jerkNow);
    handleHold("brake", brakeOK, now, jerkNow);
    handleHold("straight", straight, now, jerkNow);

    // ===== UI 更新とログ保存（既存処理） =====
    const gxElement = document.getElementById('g-x');
    const gzElement = document.getElementById('g-z');
    const gyElement = document.getElementById('g-y');
    if (gxElement) gxElement.textContent = window.latestGX.toFixed(2);
    if (gzElement) gzElement.textContent = window.latestGZ.toFixed(2);
    if (gyElement) gyElement.textContent = window.latestGY.toFixed(2);

    const gData = { timestamp: now, g_x: window.latestGX, g_y: window.latestGY, g_z: window.latestGZ };
    if (window.sessionId) window.gLogBuffer.push(gData);
}

// === リアルタイム状態維持 ===
function handleHold(type, ok, now, jerk) {
    const t = holdStart[type];
    if (ok) {
        if (t == null) holdStart[type] = now;
        else if (now - t >= HOLD_TIME[type] && now - lastPlay[type] > AUDIO_COOLDOWN_MS) {
            playFeedback(type, jerk);
            holdStart[type] = null;
            lastPlay[type] = now;
        }
    } else holdStart[type] = null;
}

function playFeedback(type, jerk) {
    const smooth = Math.abs(jerk) < 1.0;
    switch (type) {
        case "accel": playRandomAudio(smooth ? "good_accel" : "sudden_accel"); break;
        case "brake": playRandomAudio(smooth ? "jerk" : "sudden_brake"); break; //good_brakeはまだできてないから仮で
        case "turn":  playRandomAudio(smooth ? "ang_vel_low" : "sharp_turn"); break;
        case "straight": playRandomAudio("stable_drive"); break;
    }
}

export function startMotionDetection() {
    if (window.DeviceMotionEvent && !window.isMotionDetectionActive) {
        window.removeEventListener('devicemotion', handleDeviceMotion);
        window.addEventListener('devicemotion', handleDeviceMotion, { passive: true });
        window.isMotionDetectionActive = true;
        console.log('DeviceMotion listener registered (first time)');
    } else if (window.isMotionDetectionActive) {
        console.log('DeviceMotion already active, skipping registration');
    }
}

export function stopMotionDetection() {
    if (window.DeviceMotionEvent && window.isMotionDetectionActive) {
        window.removeEventListener('devicemotion', handleDeviceMotion);
        window.isMotionDetectionActive = false;
        window.motionInitTime = null; // 初期化時刻をリセット
        console.log('DeviceMotion listener removed');
    }
}

export function requestMotionPermission(callback) {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission().then(response => {
            if (response === 'granted') callback();
            else alert('加速度センサーの使用が許可されませんでした。');
        }).catch(err => {
            console.error('加速度センサーの許可リクエスト中にエラー:', err);
            alert('加速度センサーの使用許可リクエストでエラーが発生しました。');
        });
    } else {
        callback();
    }
}

// ★FIX: 起動時に数十サンプル収集して自動キャリブレーションを行う
export function startAutoCalibration() {
    try {
        window._calibSamples = [];
        if (window._calibTimer) {
            clearTimeout(window._calibTimer);
            window._calibTimer = null;
        }
        const calibListener = (e) => {
            const a = e.accelerationIncludingGravity || e.acceleration;
            if (!a) return;
            window._calibSamples.push({ x: a.x || 0, y: a.y || 0, z: a.z || 0 });
            if (window._calibSamples.length >= 60) { // 約1秒相当（60Hz想定）
                window.removeEventListener('devicemotion', calibListener);
                calibrateOrientation(window._calibSamples);
                window._calibSamples = [];
            }
        };
        window.addEventListener('devicemotion', calibListener, { passive: true });
        // 2秒で打ち切り・実行
        window._calibTimer = setTimeout(() => {
            window.removeEventListener('devicemotion', calibListener);
            if (window._calibSamples.length >= 10) {
                calibrateOrientation(window._calibSamples);
            } else {
                console.log('Auto-calibration skipped (insufficient samples)');
            }
            window._calibSamples = [];
            window._calibTimer = null;
        }, 2000);
    } catch (e) {
        console.warn('Auto calibration start failed:', e);
    }
}