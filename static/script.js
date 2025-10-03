// script.js - 一括保存対応版 + 走行中にイベントマーカーを地図上に表示
// 法定速度の検査と取得に関する部分を削除

// === 基本テスト用ログ ===
console.log('=== script.js LOADED ===');
console.log('Current URL:', window.location.href);
console.log('Current pathname:', window.location.pathname);
console.log('Document ready state:', document.readyState);

let sessionId = null;
let timerInterval = null;
let startTime = null;
let watchId = null;
let map, polyline, path = [];

// モーション検出の状態管理
let isMotionDetectionActive = false;

// DeviceMotionEventのフレームスキップ管理（60Hzを15Hzに削減）
let motionFrameCounter = 0;
const MOTION_FRAME_SKIP = 4; // 4フレームに1回処理（元は6フレーム）

// 初期化期間管理（起動直後の不安定なデータを除外）
let motionInitTime = null;
const MOTION_INIT_DURATION = 3000; // 3秒間は初期化期間
let stableSampleCount = 0;
const STABLE_SAMPLES_REQUIRED = 10; // 10回連続で安定したら処理開始

let suddenBrakes = 0;
let suddenAccels = 0;
let sharpTurns = 0;
let speedViolations = 0; // 法定速度チェックはなくなるが残す

// ★★★ 判定閾値とクールダウン期間の定数化 ★★★
const COOLDOWN_MS = 3000; // イベント発生後のクールダウン期間（3秒に延長）

// ■ イベント（指摘）用 - ユーザー指定の閾値
const ACCEL_EVENT_MS2   = 0.4;  // |加速度| >= 0.4 m/s^2 -> 急発進/急ブレーキ
const JERK_EVENT_MS3    = 1.5;  // |ジャーク| >= 1.5 m/s^3 -> 速度のカクつき指摘
const YAW_RATE_EVENT    = 0.6;  // |角速度| >= 0.6 rad/s -> 急ハンドル
const ANG_ACCEL_EVENT   = 0.6;  // |角加速度| >= 0.6 rad/s^2 -> カーブのカクつき指摘
const SHARP_TURN_G_THRESHOLD = 0.5; // 横Gのしきい値 (やや厳しく: 0.5G)

// イベントのクールダウン管理
let lastBrakeEventTime = 0;
let lastAccelEventTime = 0;
let lastTurnEventTime  = 0;

// センサー最新値（G換算）
let latestGX = 0;
let latestGY = 0;
let latestGZ = 0;

// 現在位置を示すマーカー
let currentPositionMarker = null;
let eventMarkers = [];

// ログ用バッファ
let gLogBuffer = [];
let gpsLogBuffer = [];

let logFlushInterval = null; // 10秒ごとの送信タイマーID
let isSessionStarting = false; // セッション開始リクエスト中フラグ

// センサー値補正
let orientationMode = "auto"; 
let calibrationData = null;

// === ジャーク・角速度・角加速度用 ===
// ジャーク用：直前サンプル
let lastAccelSample = null;         // m/s^2
let lastAccelSampleTime = null;     // ms
// 角速度・角加速度用：直前値
let lastYawRate = null;             // rad/s
let lastYawTime = null;             // ms

// rotationRateの利用可否（フォールバック判定に使用）
window._rotationAvailable = false;

// 褒め判定（最後に高値を超えた時刻）
let lastHighJerkTime = Date.now();
let lastHighAccelTime = Date.now();
let lastHighYawRateTime = Date.now();
let lastHighAngAccelTime = Date.now();

// 褒め条件（3分間適切な運転を維持）
const PRAISE_INTERVAL = 180000; // 3分間に戻す 
let praiseInterval = null;

// 音声再生のクールダウン管理
let lastAudioPlayTime = {};
const AUDIO_COOLDOWN_MS = 5000; // 運転中の適切な指摘間隔（5秒）

// グローバル音声ロック（どのカテゴリでも1つしか同時再生しない）
let isAudioPlaying = false;
let audioLockTimeout = null;

// 音声ファイルパス（統一して /static/audio/ プレフィックス使用）
const audioFiles = {
    jerk_low: ["/static/audio/ジャークが少ないことについて褒める（1）.wav", "/static/audio/ジャークが少ないことについて褒める（2）.wav"],
    accel_good: ["/static/audio/加速度について褒める（1）.wav", "/static/audio/加速度について褒める（2）.wav"],
    ang_accel_good: ["/static/audio/角加速度について褒める（1）.wav", "/static/audio/角加速度について褒める（2）.wav"],
    ang_vel_high: ["/static/audio/角速度が高いことに指摘（1）.wav", "/static/audio/角速度が高いことに指摘（2）.wav"],
    ang_vel_low: ["/static/audio/角速度が低いことについて褒める（1）.wav", "/static/audio/角速度が低いことについて褒める（2）.wav"],
    sharp_turn: ["/static/audio/急ハンドルについて指摘（1）.wav", "/static/audio/急ハンドルについて指摘（2）.wav", "/static/audio/急ハンドルについて指摘（3）.wav"],
    yaw_rate_high: ["/static/audio/急ハンドルについて指摘（1）.wav", "/static/audio/急ハンドルについて指摘（2）.wav", "/static/audio/急ハンドルについて指摘（3）.wav"],
    yaw_rate_high: ["/static/audio/急ハンドルについて指摘（1）.wav", "/static/audio/急ハンドルについて指摘（2）.wav", "/static/audio/急ハンドルについて指摘（3）.wav"],
    sudden_brake: ["/static/audio/急ブレーキについて指摘（1）.wav", "/static/audio/急ブレーキについて指摘（2）.wav", "/static/audio/急ブレーキについて指摘（3）.wav"],
    sudden_accel: ["/static/audio/急発進について指摘（1）.wav", "/static/audio/急発進について指摘（2）.wav"],
    speed_fluct: ["/static/audio/速度の変化や「カクつき」について指摘（1）.wav", "/static/audio/速度の変化や「カクつき」について指摘（2）.wav"],
    jerk: ["/static/audio/速度の変化や「カクつき」について指摘（1）.wav", "/static/audio/速度の変化や「カクつき」について指摘（2）.wav"]
};

// --- ランダムで音声を再生する関数（クールダウン付き + 記録中のみ + グローバルロック） ---
function playRandomAudio(category) {
    // 記録中でない場合は音声再生しない
    if (!sessionId) {
        console.log(`🔇 Audio skipped (not recording): ${category}`);
        return;
    }
    
    // グローバル音声ロックチェック
    if (isAudioPlaying) {
        console.log(`🔇 Audio locked (another audio playing): ${category}`);
        return;
    }
    
    if (!audioFiles[category]) {
        console.warn('Audio category not found:', category);
        return;
    }
    
    // クールダウンチェック
    const now = Date.now();
    const lastPlayTime = lastAudioPlayTime[category] || 0;
    
    if (now - lastPlayTime < AUDIO_COOLDOWN_MS) {
        console.log(`🔇 Audio cooldown active for ${category} (${Math.round((AUDIO_COOLDOWN_MS - (now - lastPlayTime)) / 1000)}s remaining)`);
        return;
    }
    
    // グローバルロック設定
    isAudioPlaying = true;
    
    const files = audioFiles[category];
    const file = files[Math.floor(Math.random() * files.length)];
    console.log(`🔊 Playing audio (recording): ${category} -> ${file}`);
    console.log(`Current cooldowns:`, Object.keys(lastAudioPlayTime).map(k => `${k}:${Math.round((Date.now() - lastAudioPlayTime[k])/1000)}s`).join(', '));
    
    const audio = new Audio(file);
    audio.play().then(() => {
        // 再生成功時にクールダウン時刻を記録
        lastAudioPlayTime[category] = now;
        console.log(`✓ Audio played successfully: ${category} - Next available in ${AUDIO_COOLDOWN_MS/1000}s`);
        
        // 音声の長さに応じてロックを解除（運転中に適切な間隔：2秒）
        audioLockTimeout = setTimeout(() => {
            isAudioPlaying = false;
            console.log(`🔓 Audio lock released for ${category}`);
        }, Math.max(2000, AUDIO_COOLDOWN_MS / 3));
        
    }).catch(err => {
        console.warn("Audio play failed:", err);
        console.warn("Audio file path:", file);
        // エラー時もロックを解除
        isAudioPlaying = false;
        if (audioLockTimeout) {
            clearTimeout(audioLockTimeout);
            audioLockTimeout = null;
        }
    });
}

// センサー値を一定時間集めて平均化
function calibrateOrientation(samples) {
    const avg = { x: 0, y: 0, z: 0 };
    samples.forEach(s => {
        avg.x += s.x;
        avg.y += s.y;
        avg.z += s.z;
    });
    avg.x /= samples.length;
    avg.y /= samples.length;
    avg.z /= samples.length;

    calibrationData = detectOrientation(avg);
    console.log("Auto-calibrated:", calibrationData);
}

// 姿勢検出
function detectOrientation(avg) {
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
function adjustOrientation(ax, ay, az) {
    let mode = calibrationData || "default";

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

// === DeviceMotionイベントハンドラ（ジャーク／角速度／角加速度） ===
function handleDeviceMotion(event) {
    // 初期化期間の管理
    const now = Date.now();
    if (!motionInitTime) {
        motionInitTime = now;
        console.log('📱 Motion detection initialized, waiting for stable data...');
        return;
    }
    
    // 初期化期間中は音声再生しない
    if (now - motionInitTime < MOTION_INIT_DURATION) {
        return;
    }
    
    // フレームスキップ（処理頻度を下げて重複を防ぐ）
    motionFrameCounter++;
    if (motionFrameCounter % MOTION_FRAME_SKIP !== 0) {
        return; // このフレームはスキップ
    }

    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc) return;

    // rotationRate 利用可否フラグ（フォールバック判定用）
    if (event.rotationRate) {
        window._rotationAvailable = true;
    }

    // 端末姿勢に合わせて車両軸へ変換
    const { forward, side, up } = adjustOrientation(acc.x || 0, acc.y || 0, acc.z || 0);

    // UI表示＆ログ用の G 値
    latestGZ = forward / 9.8;
    latestGX = side    / 9.8;
    latestGY = up      / 9.8;

    // ===== 1) ジャーク（m/s^3） =====
    const accelMs2 = forward; // m/s^2

    if (lastAccelSample !== null && lastAccelSampleTime !== null) {
        const dt = (now - lastAccelSampleTime) / 1000;
        if (dt > 0.05 && dt < 1.0) { // 時間間隔が適切かチェック（0.05-1.0秒）
            const jerk = (accelMs2 - lastAccelSample) / dt; // m/s^3
            // 異常値を除外（非現実的な値をフィルタリング）
            if (Math.abs(jerk) >= JERK_EVENT_MS3 && Math.abs(jerk) < 50) {
                const lastJerkAudio = lastAudioPlayTime['jerk'] || 0;
                if (now - lastJerkAudio >= AUDIO_COOLDOWN_MS) {
                    console.log(`⚠️ Jerk detected: ${jerk.toFixed(2)} m/s^3`);
                    playRandomAudio("jerk"); // ジャーク（速度変化のカクつき）
                    lastHighJerkTime = now;         // 褒めカウンタをリセット
                }
            }
        }
    }
    lastAccelSample = accelMs2;
    lastAccelSampleTime = now;

    // ===== 2) 角速度・角加速度（rad/s, rad/s^2） =====
    if (event.rotationRate) {
        // ブラウザ多くは deg/s を返す。rad/s へ変換
        let yawRate = (event.rotationRate.alpha || 0) * Math.PI / 180; // rad/s

        // 角速度の指摘（クールダウン付き）- DeviceMotion系の急ハンドル
        if (Math.abs(yawRate) >= YAW_RATE_EVENT && Math.abs(yawRate) < 10) { // 異常値を除外
            const lastTurnAudio = lastAudioPlayTime['yaw_rate_high'] || 0;
            if (now - lastTurnAudio >= AUDIO_COOLDOWN_MS) {
                console.log(`⚠️ High yaw rate detected: ${yawRate.toFixed(3)} rad/s`);
                playRandomAudio("yaw_rate_high");  // 角速度系の急ハンドル
                lastHighYawRateTime = now;      
            }
        }

        // 角加速度
        if (lastYawRate !== null && lastYawTime !== null) {
            const dtYaw = (now - lastYawTime) / 1000;
            if (dtYaw > 0.05 && dtYaw < 1.0) { // 時間間隔が適切かチェック
                const angAccel = (yawRate - lastYawRate) / dtYaw; // rad/s^2
                if (Math.abs(angAccel) >= ANG_ACCEL_EVENT && Math.abs(angAccel) < 20) { // 異常値を除外
                    const lastAngAccelAudio = lastAudioPlayTime['ang_accel_high'] || 0;
                    if (now - lastAngAccelAudio >= AUDIO_COOLDOWN_MS) {
                        console.log(`⚠️ High angular acceleration: ${angAccel.toFixed(3)} rad/s^2`);
                        playRandomAudio("ang_accel_high"); // 角加速度が高い（カーブのカクつき）
                        lastHighAngAccelTime = now;     
                    }
                }
            }
        }
        lastYawRate = yawRate;
        lastYawTime = now;
    }

    // UI 更新
    const gxElement = document.getElementById('g-x');
    const gzElement = document.getElementById('g-z');
    const gyElement = document.getElementById('g-y');
    if (gxElement) gxElement.textContent = latestGX.toFixed(2);
    if (gzElement) gzElement.textContent = latestGZ.toFixed(2);
    if (gyElement) gyElement.textContent = latestGY.toFixed(2);

    // Gログバッファへ
    const gData = { timestamp: now, g_x: latestGX, g_y: latestGY, g_z: latestGZ };
    if (sessionId) gLogBuffer.push(gData);
}

function startMotionDetection() {
    if (window.DeviceMotionEvent && !isMotionDetectionActive) {
        // 既存のリスナーを確実に削除
        window.removeEventListener('devicemotion', handleDeviceMotion);
        // 新しいリスナーを追加
        window.addEventListener('devicemotion', handleDeviceMotion);
        isMotionDetectionActive = true;
        console.log('DeviceMotion listener registered (first time)');
    } else if (isMotionDetectionActive) {
        console.log('DeviceMotion already active, skipping registration');
    }
}

function stopMotionDetection() {
    if (window.DeviceMotionEvent && isMotionDetectionActive) {
        window.removeEventListener('devicemotion', handleDeviceMotion);
        isMotionDetectionActive = false;
        motionInitTime = null; // 初期化時刻をリセット
        console.log('DeviceMotion listener removed');
    }
}

// 記録開始
function startSession() {
    console.log('=== startSession function called ===');
    console.log('Current sessionId:', sessionId);
    console.log('isSessionStarting:', isSessionStarting);
    
    // 既にリクエスト中の場合は防止
    if (isSessionStarting) {
        console.warn('Session start already in progress');
        alert('セッション開始処理中です。しばらくお待ちください。');
        return;
    }
    
    // 既にセッションが開始されている場合は防止
    if (sessionId) {
        console.warn('Session already started:', sessionId);
        alert('既に記録が開始されています');
        return;
    }
    
    // LocalStorageから既存のアクティブセッションをチェック
    const existingSessionId = localStorage.getItem('activeSessionId');
    if (existingSessionId) {
        console.warn('Active session found in localStorage:', existingSessionId);
        const confirmResult = confirm('既にアクティブなセッションがあります。新しいセッションを開始しますか？');
        if (!confirmResult) {
            return;
        }
        // 既存セッションをクリア
        localStorage.removeItem('activeSessionId');
        localStorage.removeItem('sessionStartTime');
    }
    
    // リクエスト中フラグを設定
    isSessionStarting = true;
    
    // ボタンを無効化して重複クリックを防止
    const startButton = document.getElementById('start-button');
    if (startButton) {
        startButton.disabled = true;
        startButton.textContent = '開始中...';
    }
    
    requestMotionPermission(() => {
        console.log('Motion permission granted');
        startMotionDetection();
        
        console.log('Sending session start request...');
        fetch('/start', { method: 'POST' })
            .then(res => {
                console.log('Session start response status:', res.status);
                if (!res.ok) {
                    return res.json().then(err => { throw new Error(err.message || 'サーバーエラー'); });
                }
                return res.json();
            })
            .then(data => {
                console.log('Session start response data:', data);
                
                // サーバーから既存のアクティブセッションが返された場合
                if (data.status === 'warning' && data.session_id) {
                    console.log('Using existing active session:', data.session_id);
                    sessionId = data.session_id;
                    startTime = Date.now(); // 現在時刻で開始（既存セッションの継続）
                } else if (data.session_id) {
                    sessionId = data.session_id;
                    startTime = Date.now();
                    console.log('Session created successfully:', sessionId);
                } else {
                    throw new Error('サーバーからのセッションIDが不正です。');
                }
                
                // セッション情報をLocalStorageに保存
                localStorage.setItem('activeSessionId', sessionId);
                localStorage.setItem('sessionStartTime', startTime.toString());
                
                // バッファをクリアして新しいセッション用に準備
                gLogBuffer = [];
                gpsLogBuffer = [];
                console.log('Cleared data buffers for new session');
                console.log('SessionID now set to:', sessionId);
                console.log('About to redirect to /recording/active');
                
                resetCounters();
                
                // 記録中画面に遷移
                window.location.href = '/recording/active';

            })
            .catch(err => {
                console.error('Error during /start fetch or response handling:', err);
                alert('記録開始時にエラーが発生しました: ' + err.message);
                
                // ボタンを復活
                if (startButton) {
                    startButton.disabled = false;
                    startButton.textContent = '記録開始';
                }
            })
            .finally(() => {
                // リクエスト中フラグをリセット
                isSessionStarting = false;
            });
    });
}

// 記録終了
function endSession(showAlert = true) {
    console.log("=== endSession called ===");
    
    console.log("=== Debug: G Logs before save ===");
    gLogBuffer.forEach((log, i) => {
        console.log(`[${i}] timestamp=${log.timestamp}, g_x=${log.g_x}, g_y=${log.g_y}, g_z=${log.g_z}`);
    });
    console.log("=== Debug: GPS Logs before save ===");
    gpsLogBuffer.forEach((log, i) => {
        console.log(
            `[${i}] ${log.timestamp} | event=${log.event} | g_x=${log.g_x} | g_y=${log.g_y} | lat=${log.latitude} | lon=${log.longitude} | speed=${log.speed}`
        );
    });
    
    if (!sessionId) {
        console.log("No sessionId found");
        if (showAlert) {
            alert('まだ記録が開始されていません');
        }
        return;
    }

    console.log("Stopping timer...");
    stopTimer();

    console.log("Clearing intervals...");
    // 定期送信タイマー停止
    if (logFlushInterval) {
        clearInterval(logFlushInterval);
        logFlushInterval = null;
    }
    // 褒めチェック停止
    if (praiseInterval) {
        clearInterval(praiseInterval);
        praiseInterval = null;
    }

    console.log("Clearing GPS watch...");
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    
    console.log("Stopping motion detection...");
    // DeviceMotionEventリスナーを削除
    stopMotionDetection();

    console.log("Resetting audio locks...");
    // 音声ロックをリセット
    isAudioPlaying = false;
    if (audioLockTimeout) {
        clearTimeout(audioLockTimeout);
        audioLockTimeout = null;
    }
    lastAudioPlayTime = {}; // 音声クールダウンもリセット

    console.log("Calculating distance...");
    let distance = 0;
    try {
        distance = calculateDistance(path);
        console.log("Distance calculated:", distance);
    } catch (error) {
        console.error("Error calculating distance:", error);
        distance = 0;
    }

    console.log("Sending end request to server...");
    fetch('/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session_id: sessionId,
            distance: distance,
            sudden_accels: suddenAccels,
            sudden_brakes: suddenBrakes,
            sharp_turns: sharpTurns,
            speed_violations: speedViolations,
        }),
    })
    .then(response => {
        console.log("End request response status:", response.status);
        if (!response.ok) {
            return response.json().then(errorData => {
                throw new Error(errorData.message || '記録終了時にサーバーエラーが発生しました');
            });
        }
        return response.json();
    })
    .then(data => {
        console.log("End request response data:", data);
        if (data.status === 'ok') {
            // 残り分だけ送信
            const flushLogs = Promise.all([
                gLogBuffer.length > 0
                    ? fetch('/log_g_only', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: sessionId, g_logs: gLogBuffer })
                    }).finally(() => { gLogBuffer = []; })
                    : Promise.resolve(),
                gpsLogBuffer.length > 0
                    ? fetch('/log_gps_bulk', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: sessionId, gps_logs: gpsLogBuffer })
                    })
                    .then(response => response.json())
                    .then(data => {
                        console.log(`Final GPS logs save for session ${sessionId}:`, data);
                    })
                    .finally(() => { gpsLogBuffer = []; })
                    : Promise.resolve()
            ]);
            flushLogs.finally(() => {
                console.log("All logs flushed, preparing session data...");
                
                // 時間計算の安全性確保
                let elapsedTime = 0;
                if (startTime && typeof startTime === 'number') {
                    elapsedTime = Math.floor((Date.now() - startTime) / 1000);
                    console.log("Elapsed time calculated:", elapsedTime);
                } else {
                    console.warn("startTime is not valid:", startTime);
                }
                
                // セッションデータを保存して記録完了画面に遷移
                const sessionData = {
                    distance: distance,
                    sudden_accels: suddenAccels,
                    sudden_brakes: suddenBrakes,
                    sharp_turns: sharpTurns,
                    speed_violations: speedViolations,
                    totalTime: formatTime(elapsedTime),
                    stability: calculateStability(suddenAccels, suddenBrakes, sharpTurns, distance)
                };
                
                console.log("Session data prepared:", sessionData);
                
                // LocalStorageに保存
                localStorage.setItem('lastSessionData', JSON.stringify(sessionData));
                
                // アクティブセッション情報をクリア
                localStorage.removeItem('activeSessionId');
                localStorage.removeItem('sessionStartTime');
                
                // セッション変数をリセット
                sessionId = null;
                resetCounters();
                
                // 音声クールダウンもリセット
                lastAudioPlayTime = {};
                console.log('🔇 Audio playback disabled (recording ended)');
                
                console.log("Cleaning up map elements...");
                if (polyline) polyline.setPath([]);
                if (currentPositionMarker) currentPositionMarker.setMap(null);
                path = [];
                eventMarkers.forEach(marker => marker.setMap(null));
                eventMarkers = [];
                
                console.log("Redirecting to completed page...");
                // 記録完了画面に遷移
                window.location.href = '/recording/completed';
            });

        } else {
            console.error("End session failed:", data);
            if (showAlert) {
                alert('記録終了に失敗しました: ' + (data.message || '不明なエラー'));
            }
        }
    })
    .catch(error => {
        console.error('記録終了中にエラーが発生しました:', error);
        console.error('Error stack:', error.stack);
        if (showAlert) {
            alert('記録終了中にネットワークまたは処理エラーが発生しました: ' + error.message);
        }
    });
}

function requestMotionPermission(callback) {
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

// イベントマーカー追加
function addEventMarker(lat, lng, type) {
    const colors = {
        sudden_brake: 'red',
        sudden_accel: 'green',
        sharp_turn: 'orange'
    };
    const marker = new google.maps.Marker({
        position: { lat, lng },
        map,
        icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 6,
            fillColor: colors[type] || 'gray',
            fillOpacity: 1,
            strokeWeight: 1,
            strokeColor: '#000'
        }
    });
    eventMarkers.push(marker);
}

// 地図初期化
function initMap() {
    const mapDiv = document.getElementById('map');
    if (!mapDiv) {
        console.warn('Map container (#map) not found. Skipping map init.');
        return;
    }
    path = [];

    if (map) {
        polyline.setPath([]);
        if (currentPositionMarker) currentPositionMarker.setMap(null);
        eventMarkers.forEach(marker => marker.setMap(null));
        eventMarkers = [];
    } else {
        map = new google.maps.Map(mapDiv, { zoom: 16, center: { lat: 35.681236, lng: 139.767125 } });
        polyline = new google.maps.Polyline({
            path: [],
            geodesic: true,
            strokeColor: '#007bff',
            strokeOpacity: 1.0,
            strokeWeight: 4,
            map: map
        });
        currentPositionMarker = new google.maps.Marker({
            position: { lat: 35.681236, lng: 139.767125 },
            map: map,
            icon: {
                path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                scale: 6,
                fillColor: 'blue',
                fillOpacity: 0.8,
                strokeWeight: 1,
                strokeColor: '#fff',
                rotation: 0
            }
        });
    }

    navigator.geolocation.getCurrentPosition(position => {
        const userLatLng = { lat: position.coords.latitude, lng: position.coords.longitude };
        map.setCenter(userLatLng);
        currentPositionMarker.setPosition(userLatLng);
    }, () => {
        console.warn("Geolocation permission denied or error. Using default map center.");
    });
}

function startTimer() {
    timerInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const mins = Math.floor(elapsed / 60000).toString().padStart(2, '0');
        const secs = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');
        const timerElement = document.getElementById('timer');
        if (timerElement) {
            timerElement.textContent = `${mins}:${secs}`;
        }
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
}

function resetCounters() {
    suddenBrakes = 0;
    suddenAccels = 0;
    sharpTurns = 0;
    speedViolations = 0;
    
    const brakeElement = document.getElementById('brake-count');
    const accelElement = document.getElementById('accel-count');
    const turnElement = document.getElementById('turn-count');
    
    if (brakeElement) brakeElement.textContent = '0';
    if (accelElement) accelElement.textContent = '0';
    if (turnElement) turnElement.textContent = '0';
}

function calculateDistance(path) {
    const R = 6371;
    let dist = 0;
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLng = (b.lng - a.lng) * Math.PI / 180;
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180)
            * Math.sin(dLng / 2) ** 2;
        dist += 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }
    return dist;
}

// 褒めチェック開始
function startPraiseCheck() {
    if (praiseInterval) clearInterval(praiseInterval);
    praiseInterval = setInterval(() => {
        const now = Date.now();

        // ジャーク 1.5 m/s³ 未満が3分続いた
        if (now - lastHighJerkTime > PRAISE_INTERVAL) {
            playRandomAudio("jerk_low");
            lastHighJerkTime = now;
        }

        // 加速度 0.4 m/s² 未満が3分続いた
        if (now - lastHighAccelTime > PRAISE_INTERVAL) {
            playRandomAudio("accel_good");
            lastHighAccelTime = now;
        }

        // 角速度 0.6 rad/s 未満が3分続いた
        if (now - lastHighYawRateTime > PRAISE_INTERVAL) {
            playRandomAudio("ang_vel_low");
            lastHighYawRateTime = now;
        }

        // 角加速度 0.6 rad/s² 未満が3分続いた（※コメントは0.1→仕様に合わせ0.6に統一）
        if (now - lastHighAngAccelTime > PRAISE_INTERVAL) {
            playRandomAudio("ang_accel_good");
            lastHighAngAccelTime = now;
        }
    }, 10000); // 10秒ごとにチェック
}

let prevSpeed = null, prevLatLng = null, prevTime = null;

function watchPosition() {
    console.log('Starting GPS position watch...');
    if (!sessionId) {
        console.error("No sessionId! GPS log will not be saved");
    }
    watchId = navigator.geolocation.watchPosition(async position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const currentLatLng = { lat, lng };
        const speed = position.coords.speed !== null ? position.coords.speed * 3.6 : 0; // km/h
        const now = Date.now();

        console.log(`GPS position received: lat=${lat}, lng=${lng}, speed=${speed}, accuracy=${position.coords.accuracy}, sessionId=${sessionId || 'none'}`);

        const speedElement = document.getElementById('speed');
        if (speedElement) {
            speedElement.textContent = speed.toFixed(1);
        }
        const positionElement = document.getElementById('position');
        if (positionElement) {
            positionElement.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        }

        if (currentPositionMarker && typeof google !== 'undefined') {
            currentPositionMarker.setPosition(currentLatLng);
            if (map) {
                map.setCenter(currentLatLng);
            }
        } else if (typeof google !== 'undefined' && map) {
            currentPositionMarker = new google.maps.Marker({
                position: currentLatLng,
                map: map,
                icon: {
                    path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                    scale: 6,
                    fillColor: 'blue',
                    fillOpacity: 0.8,
                    strokeWeight: 1,
                    strokeColor: '#fff',
                    rotation: 0
                }
            });
        }

        let currentEvent = 'normal';

        if (prevSpeed !== null && prevTime !== null) {
            const dt = (now - prevTime) / 1000;
            if (dt > 0) {
                // m/s^2 へ正規化（GPS速度の差分）
                const accelMs2 = (speed / 3.6 - prevSpeed / 3.6) / dt;

                // ★ 急発進（指摘）
                if (accelMs2 >= ACCEL_EVENT_MS2 && now - lastAccelEventTime > COOLDOWN_MS) {
                    suddenAccels++;
                    const accelElement = document.getElementById('accel-count');
                    if (accelElement) accelElement.textContent = suddenAccels;
                    lastAccelEventTime = now;

                    if (typeof google !== 'undefined') addEventMarker(lat, lng, 'sudden_accel');
                    if (currentEvent === 'normal') currentEvent = 'sudden_accel';

                    const lastAccelAudio = lastAudioPlayTime['sudden_accel'] || 0;
                    if (now - lastAccelAudio >= AUDIO_COOLDOWN_MS) {
                        playRandomAudio("sudden_accel"); // （1/2）からランダム
                    }
                    lastHighAccelTime = now;         // 褒めカウンタをリセット
                }

                // ★ 急ブレーキ（指摘）
                if (accelMs2 <= -ACCEL_EVENT_MS2 && now - lastBrakeEventTime > COOLDOWN_MS) {
                    suddenBrakes++;
                    const brakeElement = document.getElementById('brake-count');
                    if (brakeElement) brakeElement.textContent = suddenBrakes;
                    lastBrakeEventTime = now;

                    if (typeof google !== 'undefined') addEventMarker(lat, lng, 'sudden_brake');
                    if (currentEvent === 'normal' || currentEvent === 'sudden_accel') currentEvent = 'sudden_brake';

                    const lastBrakeAudio = lastAudioPlayTime['sudden_brake'] || 0;
                    if (now - lastBrakeAudio >= AUDIO_COOLDOWN_MS) {
                        playRandomAudio("sudden_brake"); // （1/2/3）からランダム
                    }
                    lastHighAccelTime = now;         // 褒めカウンタをリセット
                }
            }
        }

        // rotationRate が使えない端末向けフォールバック（横G）
        // 適切な速度での走行中のみ横Gをチェック（停車中の誤検出防止）
        if (!window._rotationAvailable) {
            if (Math.abs(latestGX) > SHARP_TURN_G_THRESHOLD && speed > 20 && now - lastTurnEventTime > COOLDOWN_MS) {
                sharpTurns++;
                const turnElement = document.getElementById('turn-count');
                if (turnElement) turnElement.textContent = sharpTurns;
                lastTurnEventTime = now;

                if (typeof google !== 'undefined') addEventMarker(lat, lng, 'sharp_turn');
                currentEvent = 'sharp_turn';

                const lastSharpTurnAudio = lastAudioPlayTime['sharp_turn'] || 0;
                if (now - lastSharpTurnAudio >= AUDIO_COOLDOWN_MS) {
                    playRandomAudio("sharp_turn");
                }
                lastHighYawRateTime = now; // 褒めカウンタをリセット
            }
        }

        // Google Maps APIが利用可能な場合のみパス追加
        if (typeof google !== 'undefined') {
            path.push({ lat, lng });
            if (polyline) {
                polyline.setPath(path);
            }
        }

        // GPSログを保存（セッションIDがある場合のみ）
        if (sessionId) {
            const gpsData = {
                timestamp: now,
                latitude: lat,
                longitude: lng,
                speed: speed,
                g_x: latestGX || 0,
                g_y: latestGY || 0,
                g_z: latestGZ || 0,
                event: currentEvent || 'normal'
            };
            gpsLogBuffer.push(gpsData);
            console.log(`GPS data added to buffer for session ${sessionId}:`, gpsData);
            console.log(`Buffer sizes -> GPS: ${gpsLogBuffer.length}, G: ${gLogBuffer.length}`);
        } else {
            console.log(`GPS position received (display only): lat=${lat.toFixed(5)}, lng=${lng.toFixed(5)}, speed=${speed.toFixed(1)}`);
        }

        prevLatLng = currentLatLng;
        prevSpeed = speed;
        prevTime = now;

    }, (error) => {
        console.error('GPS position error:', error);
        console.error('Error code:', error.code);
        console.error('Error message:', error.message);
        
        switch(error.code) {
            case error.PERMISSION_DENIED:
                console.error("GPS permission denied by user");
                break;
            case error.POSITION_UNAVAILABLE:
                console.error("GPS position unavailable");
                break;
            case error.TIMEOUT:
                console.error("GPS position timeout");
                break;
            default:
                console.error("Unknown GPS error");
                break;
        }
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
}

// 時間をフォーマットする関数
function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

// 安定度を計算する関数
function calculateStability(accels, brakes, turns, distance) {
    if (distance === 0) return 100;
    
    // イベント密度を計算（1kmあたりのイベント数）
    const totalEvents = accels + brakes + turns;
    const eventDensity = totalEvents / distance;
    
    // 安定度スコアを計算（0-100%）
    // イベント密度が低いほど高いスコア
    let stability = Math.max(0, 100 - (eventDensity * 20));
    
    return Math.round(stability);
}

// ログフラッシュ処理を開始する関数
function startLogFlush() {
    if (logFlushInterval) {
        clearInterval(logFlushInterval);
    }
    
    // 10秒ごとにGPSとGログを送信
    logFlushInterval = setInterval(() => {
        console.log(`Interval flush check: sessionId=${sessionId}, G buffer=${gLogBuffer.length}, GPS buffer=${gpsLogBuffer.length}`);
        
        if (sessionId) {
            // Gログ送信
            if (gLogBuffer.length > 0) {
                const logsToSend = gLogBuffer.splice(0, gLogBuffer.length);
                console.log(`Sending ${logsToSend.length} G logs for session ${sessionId}`);
                fetch('/log_g_only', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sessionId, g_logs: logsToSend })
                })
                .then(response => response.json())
                .then(data => {
                    console.log('G logs save response:', data);
                })
                .catch(err => console.error('Gログ送信エラー:', err));
            }

            // GPSログ送信
            if (gpsLogBuffer.length > 0) {
                const logsToSend = gpsLogBuffer.splice(0, gpsLogBuffer.length);
                console.log(`=== GPS BULK SEND STARTED ===`);
                console.log(`Sending ${logsToSend.length} GPS logs for session ${sessionId}`);
                if (logsToSend.length > 0) {
                    console.log('First GPS log sample:', logsToSend[0]);
                    console.log('Last GPS log sample:', logsToSend[logsToSend.length - 1]);
                }
                
                const requestBody = { session_id: sessionId, gps_logs: logsToSend };
                console.log('GPS bulk request body:', requestBody);
                
                fetch('/log_gps_bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody)
                })
                .then(response => {
                    console.log('GPS bulk response status:', response.status);
                    console.log('GPS bulk response ok:', response.ok);
                    return response.json();
                })
                .then(data => {
                    console.log('GPS logs save response:', data);
                    console.log(`=== GPS BULK SEND COMPLETED ===`);
                })
                .catch(err => {
                    console.error('GPSログ送信エラー:', err);
                    console.log(`=== GPS BULK SEND FAILED ===`);
                });
            } else {
                console.log('No GPS logs to send (buffer empty)');
            }
        } else {
            console.log('No session ID available for log flush');
        }
    }, 10000); // 10秒ごと
}

// 記録中画面の初期化処理
function initActiveRecording() {
    // 地図の初期化（active画面でも必要）
    if (typeof initMap === 'function') {
        initMap();
    }

    // LocalStorageからセッション情報を復元
    const savedSessionId = localStorage.getItem('activeSessionId');
    const savedStartTime = localStorage.getItem('sessionStartTime');
    
    if (savedSessionId && savedStartTime) {
        sessionId = savedSessionId;
        startTime = parseInt(savedStartTime);
        
        console.log('Session ID set to:', sessionId);
        console.log('GPS buffer size:', gpsLogBuffer.length);
        console.log('G buffer size:', gLogBuffer.length);
        console.log('🔊 Audio playback enabled (recording active)');
        
        // DOM要素の更新
        const sessionIdElement = document.getElementById('session_id');
        if (sessionIdElement) {
            sessionIdElement.textContent = sessionId;
        }
        
        // タイマー開始
        startTimer();
        
        // 位置情報とセンサーの監視開始（記録中は音声あり）
        watchPosition();
        if (!isMotionDetectionActive) {
            startMotionDetection();
        } else {
            console.log('Motion detection already active, skipping startup');
        }
        
        // 定期ログ送信開始（1回だけ）
        startLogFlush();
        // 褒めチェック開始
        startPraiseCheck();
        
        console.log('Active recording initialized with session:', sessionId);
    } else {
        console.error('No active session found');
        // セッション情報がない場合は記録開始画面に戻る
        window.location.href = '/recording/start';
    }
}

// ページ読み込み時の初期化
document.addEventListener('DOMContentLoaded', function() {
    console.log('=== DOMContentLoaded EVENT FIRED ===');
    
    // URLに基づいて適切な初期化を実行
    const currentPath = window.location.pathname;
    console.log('Current path detected:', currentPath);
    
    // ボタンのイベントリスナー設定
    const startButton = document.getElementById('start-button');
    const endButton = document.getElementById('end-button');
    
    console.log('Start button found:', !!startButton);
    console.log('End button found:', !!endButton);
    
    if (startButton && !startButton.hasEventListener) {
        console.log('Adding click listener to start button');
        startButton.addEventListener('click', startSession);
        startButton.hasEventListener = true;  // 重複登録防止フラグ
    }
    if (endButton && !endButton.hasEventListener) {
        console.log('Adding click listener to end button');
        endButton.addEventListener('click', () => {
            endSession(true);
        });
        endButton.hasEventListener = true;  // 重複登録防止フラグ
    }
    
    // NOTE: beforeunload で終了処理を呼ぶと fetch がキャンセルされやすい（特にiOS/Safari）
    // 必要なら sendBeacon 等の軽量通知に置き換えてください。
    // window.addEventListener('beforeunload', () => { endSession(false); });
    
    console.log('Initializing based on current path...');
    
    if (currentPath === '/recording/active') {
        console.log('Initializing active recording screen');
        initActiveRecording();
    } else if (currentPath === '/recording/start' || currentPath === '/') {
        console.log('Initializing start recording screen');
        // 記録開始画面では地図と位置情報表示のみ初期化
        if (typeof initMap === 'function') {
            console.log('Calling initMap function');
            initMap();
        } else {
            console.log('initMap function not available');
        }
        // 位置情報とセンサーの監視を開始（記録はしない）
        console.log('Starting GPS and motion monitoring for start screen (display only)');
        watchPosition();
        startMotionDetection();
    } else {
        console.log('No specific initialization for path:', currentPath);
    }
    // recording/completed画面では特別な初期化は不要（HTMLに記述済み）
    
    console.log('=== DOMContentLoaded initialization completed ===');
});
