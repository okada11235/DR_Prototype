// sensors.js - センサー処理とモーション検出

import { 
    MOTION_FRAME_SKIP, 
    MOTION_INIT_DURATION, 
    JERK_EVENT_MS3, 
    YAW_RATE_EVENT, 
    ANG_ACCEL_EVENT,
    AUDIO_COOLDOWN_MS 
} from './config.js';
import { playRandomAudio } from './audio.js';

console.log('=== sensors.js LOADED ===');

// センサー値を一定時間集めて平均化（呼び出しは後述で自動実行） 
export function calibrateOrientation(samples) {
    const avg = { x: 0, y: 0, z: 0 };
    samples.forEach(s => {
        avg.x += s.x;
        avg.y += s.y;
        avg.z += s.z;
    });
    avg.x /= samples.length;
    avg.y /= samples.length;
    avg.z /= samples.length;
    window.calibrationData = detectOrientation(avg);
    console.log("Auto-calibrated:", window.calibrationData);
}

// 姿勢検出
export function detectOrientation(avg) {
    const { x, y, z } = avg;
    const absX = Math.abs(x);
    const absY = Math.abs(y);
    const absZ = Math.abs(z);
    if (absZ > absX && absZ > absY) {
        return z > 0 ? "flat_screen_up" : "flat_screen_down";
    } else if (absX > absY) {
        return x > 0 ? "landscape_right" : "landscape_left";
    } else {
        return y > 0 ? "default" : "upside_down";
    }
}

// 軸変換
export function adjustOrientation(ax, ay, az) {
    let mode = window.calibrationData || "default";
    switch (mode) {
        case "default":
            return { forward: -az, side: ax, up: -ay };
        case "landscape_left":
            return { forward: -az, side: ay, up: -ax };
        case "landscape_right":
            return { forward: -az, side: -ay, up: ax };
        case "flat_screen_down":
            return { forward: ay, side: ax, up: -az };
        case "flat_screen_up":
            return { forward: ay, side: ax, up: az };
        case "upside_down":
            return { forward: -az, side: -ax, up: ay };
        default:
            return { forward: -az, side: ax, up: -ay };
    }
}

// ★FIX: rotationRate を端末姿勢に合わせて「車両のヨー」に近い成分へマッピング
export function mapYawFromRotationRate(rr) {
    if (!rr) return 0;
    const deg2rad = Math.PI / 180;
    const alpha = (rr.alpha || 0) * deg2rad; // Z 回り
    const beta  = (rr.beta  || 0) * deg2rad; // X 回り
    const gamma = (rr.gamma || 0) * deg2rad; // Y 回り
    const mode = window.calibrationData || "default";
    switch (mode) {
        case "landscape_left":  return  gamma;   // 横置き左: Y軸が車両Z相当
        case "landscape_right": return -gamma;   // 横置き右: 反転
        case "flat_screen_up":  return  alpha;   // 画面上: Zがそのまま
        case "flat_screen_down":return -alpha;   // 画面下: 反転
        case "upside_down":     return -alpha;   // だいたいの近似
        default:                return  alpha;   // 縦置き: Zを採用
    }
}

// === DeviceMotionイベントハンドラ（ジャーク／角速度／角加速度） ===
export function handleDeviceMotion(event) {
    const now = Date.now();

    // 初期化期間の管理
    if (!window.motionInitTime) {
        window.motionInitTime = now;
        console.log('📱 Motion detection initialized, waiting for stable data...');
        return;
    }
    if (now - window.motionInitTime < MOTION_INIT_DURATION) {
        return; // 初期3秒は無視
    }

    // フレームスキップ（処理頻度を下げて重複を防ぐ）
    window.motionFrameCounter++;
    if (window.motionFrameCounter % MOTION_FRAME_SKIP !== 0) {
        return;
    }

    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc) return;

    // rotationRate 利用可否フラグ
    if (event.rotationRate) {
        window._rotationAvailable = true;
    }

    // 端末姿勢に合わせて車両軸へ変換（加速度）
    const { forward, side, up } = adjustOrientation(acc.x || 0, acc.y || 0, acc.z || 0);

    // UI表示＆ログ用の G 値
    window.latestGZ = forward / 9.8;
    window.latestGX = side    / 9.8;
    window.latestGY = up      / 9.8;

    // ===== 1) ジャーク（m/s^3） =====
    const accelMs2 = forward; // m/s^2
    if (window.lastAccelSample !== null && window.lastAccelSampleTime !== null) {
        const dt = (now - window.lastAccelSampleTime) / 1000;
        if (dt > 0.05 && dt < 1.0) {
            const jerk = (accelMs2 - window.lastAccelSample) / dt; // m/s^3
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

    // ===== 2) 角速度・角加速度（rad/s, rad/s^2） =====
    if (event.rotationRate) {
        // ★FIX: 姿勢に応じて車両ヨー相当を算出
        let yawRate = mapYawFromRotationRate(event.rotationRate); // rad/s 相当
        // 角速度の指摘（クールダウン付き）- DeviceMotion系の急ハンドル
        if (Math.abs(yawRate) >= YAW_RATE_EVENT && Math.abs(yawRate) < 10) {
            const lastTurnAudio = window.lastAudioPlayTime['yaw_rate_high'] || 0;
            if (now - lastTurnAudio >= AUDIO_COOLDOWN_MS) {
                console.log(`⚠️ High yaw rate detected: ${yawRate.toFixed(3)} rad/s`);
                playRandomAudio("yaw_rate_high");
                window.lastHighYawRateTime = now;      
            }
        }
        // 角加速度
        if (window.lastYawRate !== null && window.lastYawTime !== null) {
            const dtYaw = (now - window.lastYawTime) / 1000;
            if (dtYaw > 0.05 && dtYaw < 1.0) {
                const angAccel = (yawRate - window.lastYawRate) / dtYaw; // rad/s^2
                if (Math.abs(angAccel) >= ANG_ACCEL_EVENT && Math.abs(angAccel) < 20) {
                    const lastAngAccelAudio = window.lastAudioPlayTime['ang_accel_high'] || 0; // ★FIX: 定義済みカテゴリへ
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

    // UI 更新
    const gxElement = document.getElementById('g-x');
    const gzElement = document.getElementById('g-z');
    const gyElement = document.getElementById('g-y');
    if (gxElement) gxElement.textContent = window.latestGX.toFixed(2);
    if (gzElement) gzElement.textContent = window.latestGZ.toFixed(2);
    if (gyElement) gyElement.textContent = window.latestGY.toFixed(2);

    // Gログバッファへ
    const gData = { timestamp: now, g_x: window.latestGX, g_y: window.latestGY, g_z: window.latestGZ };
    if (window.sessionId) window.gLogBuffer.push(gData);
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