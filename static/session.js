// session.js - セッション管理機能

import { stopMotionDetection, startMotionDetection, startAutoCalibration } from './sensors.js';
import { watchPosition, calculateDistance } from './maps.js';
import { startTimer, stopTimer, formatTime, calculateStability } from './utils.js';
import { unlockAudio } from './audio.js';
import { resetState } from './state.js';

console.log('=== session.js LOADED ===');

// ✅ iOS用アンロックイベント（audio.jsのunlockAudioを使用）
document.addEventListener("touchstart", unlockAudio, { once: true });

// ✅ iOS & Android モーション許可リクエスト
async function requestMotionPermission(callback) {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        try {
            const response = await DeviceMotionEvent.requestPermission();
            if (response === 'granted') {
                console.log("✅ Motion permission granted (iOS)");
                callback();
            } else {
                alert('加速度センサーの使用が許可されませんでした。');
            }
        } catch (err) {
            console.error('Motion permission request error:', err);
            alert('加速度センサーの使用許可リクエストでエラーが発生しました。');
        }
    } else {
        console.log("✅ Motion permission not required (Android or Desktop)");
        callback();
    }
}

// 記録開始
export function startSession() {
    console.log('=== startSession function called ===');
    console.log('Current sessionId:', window.sessionId);
    console.log('isSessionStarting:', window.isSessionStarting);
    
    if (window.isSessionStarting) {
        console.warn('Session start already in progress');
        alert('セッション開始処理中です。しばらくお待ちください。');
        return;
    }
    if (window.sessionId) {
        console.warn('Session already started:', window.sessionId);
        alert('既に記録が開始されています');
        return;
    }
    const existingSessionId = localStorage.getItem('activeSessionId');
    if (existingSessionId) {
        console.warn('Active session found in localStorage:', existingSessionId);
        const confirmResult = confirm('既にアクティブなセッションがあります。新しいセッションを開始しますか？');
        if (!confirmResult) return;
        localStorage.removeItem('activeSessionId');
        localStorage.removeItem('sessionStartTime');
    }
    window.isSessionStarting = true;
    
    const startButton = document.getElementById('start-button');

    unlockAudio()

    if (startButton) {
        startButton.disabled = true;
        startButton.textContent = '開始中...';
    }
    
    requestMotionPermission(() => {
        console.log('Motion permission granted');
        startMotionDetection();

        // ★FIX: 起動時オートキャリブレーションを実行
        startAutoCalibration();

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
                if (data.status === 'warning' && data.session_id) {
                    console.log('Using existing active session:', data.session_id);
                    window.sessionId = data.session_id;
                    window.startTime = Date.now();
                } else if (data.session_id) {
                    window.sessionId = data.session_id;
                    window.startTime = Date.now();
                    console.log('Session created successfully:', window.sessionId);
                } else {
                    throw new Error('サーバーからのセッションIDが不正です。');
                }
                localStorage.setItem('activeSessionId', window.sessionId);
                localStorage.setItem('sessionStartTime', window.startTime.toString());
                resetState();
                window.gLogBuffer = [];
                window.gpsLogBuffer = [];
                window.path = [];
                console.log('Cleared data buffers for new session');
                console.log('SessionID now set to:', window.sessionId);
                console.log('About to redirect to /recording/active');
                window.location.href = '/recording/active';
            })
            .catch(err => {
                console.error('Error during /start fetch or response handling:', err);
                alert('記録開始時にエラーが発生しました: ' + err.message);
                if (startButton) {
                    startButton.disabled = false;
                    startButton.textContent = '記録開始';
                }
            })
            .finally(() => {
                window.isSessionStarting = false;
            });
    });
}

// 記録終了
export function endSession(showAlert = true) {
    console.log("=== endSession called ===");
    
    console.log("=== Debug: G Logs before save ===");
    window.gLogBuffer.forEach((log, i) => {
        console.log(`[${i}] timestamp=${log.timestamp}, g_x=${log.g_x}, g_y=${log.g_y}, g_z=${log.g_z}`);
    });
    console.log("=== Debug: GPS Logs before save ===");
    window.gpsLogBuffer.forEach((log, i) => {
        console.log(
            `[${i}] ${log.timestamp} | event=${log.event} | g_x=${log.g_x} | g_y=${log.g_y} | lat=${log.latitude} | lon=${log.longitude} | speed=${log.speed}`
        );
    });
    
    if (!window.sessionId) {
        console.log("No sessionId found");
        if (showAlert) alert('まだ記録が開始されていません');
        return;
    }

    console.log("Stopping timer...");
    stopTimer();

    console.log("Clearing intervals...");
    if (window.logFlushInterval) {
        clearInterval(window.logFlushInterval);
        window.logFlushInterval = null;
    }
    if (window.praiseInterval) {
        clearInterval(window.praiseInterval);
        window.praiseInterval = null;
    }

    console.log("Clearing GPS watch...");
    if (window.watchId !== null) {
        navigator.geolocation.clearWatch(window.watchId);
        window.watchId = null;
    }
    
    console.log("Stopping motion detection...");
    stopMotionDetection();

    console.log("Resetting audio locks...");
    window.isAudioPlaying = false;
    if (window.audioLockTimeout) {
        clearTimeout(window.audioLockTimeout);
        window.audioLockTimeout = null;
    }
    window.lastAudioPlayTime = {};

    console.log("Calculating distance...");
    console.log("Path points:", window.path.length);
    if (window.path.length > 0) {
        console.log("First point:", window.path[0]);
        console.log("Last point:", window.path[window.path.length - 1]);
    }
    let distance = 0;
    try {
        distance = calculateDistance(window.path);
        console.log("Distance calculated:", distance, "km");
    } catch (error) {
        console.error("Error calculating distance:", error);
        distance = 0;
    }

    console.log("Sending end request to server...");
    fetch('/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session_id: window.sessionId,
            distance: distance,
            sudden_accels: window.suddenAccels,
            sudden_brakes: window.suddenBrakes,
            sharp_turns: window.sharpTurns,
            speed_violations: window.speedViolations,
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
            const flushLogs = Promise.all([
                window.gLogBuffer.length > 0
                    ? fetch('/log_g_only', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: window.sessionId, g_logs: window.gLogBuffer })
                    }).finally(() => { window.gLogBuffer = []; })
                    : Promise.resolve(),
                window.gpsLogBuffer.length > 0
                    ? fetch('/log_gps_bulk', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: window.sessionId, gps_logs: window.gpsLogBuffer })
                    })
                    .then(response => response.json())
                    .then(data => {
                        console.log(`Final GPS logs save for session ${window.sessionId}:`, data);
                    })
                    .finally(() => { window.gpsLogBuffer = []; })
                    : Promise.resolve()
            ]);
            flushLogs.finally(() => {
                console.log("All logs flushed, preparing session data...");
                let elapsedTime = 0;
                if (window.startTime && typeof window.startTime === 'number') {
                    elapsedTime = Math.floor((Date.now() - window.startTime) / 1000);
                    console.log("Elapsed time calculated:", elapsedTime);
                } else {
                    console.warn("startTime is not valid:", window.startTime);
                }
                const sessionData = {
                    distance: distance,
                    sudden_accels: window.suddenAccels,
                    sudden_brakes: window.suddenBrakes,
                    sharp_turns: window.sharpTurns,
                    speed_violations: window.speedViolations,
                    totalTime: formatTime(elapsedTime),
                    stability: calculateStability(window.suddenAccels, window.suddenBrakes, window.sharpTurns, distance)
                };
                console.log("Session data prepared:", sessionData);
                localStorage.setItem('lastSessionData', JSON.stringify(sessionData));
                localStorage.removeItem('activeSessionId');
                localStorage.removeItem('sessionStartTime');
                window.sessionId = null;
                resetState();
                window.lastAudioPlayTime = {};
                console.log('🔇 Audio playback disabled (recording ended)');
                console.log("Cleaning up map elements...");
                if (window.polyline) window.polyline.setPath([]);
                if (window.currentPositionMarker) window.currentPositionMarker.setMap(null);
                window.path = [];
                window.eventMarkers.forEach(marker => marker.setMap(null));
                window.eventMarkers = [];
                console.log("Redirecting to completed page...");
                window.location.href = '/recording/completed';
            });
        } else {
            console.error("End session failed:", data);
            if (showAlert) alert('記録終了に失敗しました: ' + (data.message || '不明なエラー'));
        }
    })
    .catch(error => {
        console.error('記録終了中にエラーが発生しました:', error);
        console.error('Error stack:', error.stack);
        if (showAlert) alert('記録終了中にネットワークまたは処理エラーが発生しました: ' + error.message);
    });
}

// ログフラッシュ処理を開始する関数
export function startLogFlush() {
    if (window.logFlushInterval) clearInterval(window.logFlushInterval);
    window.logFlushInterval = setInterval(() => {
        console.log(`Interval flush check: sessionId=${window.sessionId}, G buffer=${window.gLogBuffer.length}, GPS buffer=${window.gpsLogBuffer.length}`);
        if (window.sessionId) {
            if (window.gLogBuffer.length > 0) {
                const logsToSend = window.gLogBuffer.splice(0, window.gLogBuffer.length);
                console.log(`Sending ${logsToSend.length} G logs for session ${window.sessionId}`);
                fetch('/log_g_only', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: window.sessionId, g_logs: logsToSend })
                })
                .then(response => response.json())
                .then(data => {
                    console.log('G logs save response:', data);
                })
                .catch(err => console.error('Gログ送信エラー:', err));
            }
            if (window.gpsLogBuffer.length > 0) {
                const logsToSend = window.gpsLogBuffer.splice(0, window.gpsLogBuffer.length);
                console.log(`=== GPS BULK SEND STARTED ===`);
                console.log(`Sending ${logsToSend.length} GPS logs for session ${window.sessionId}`);
                if (logsToSend.length > 0) {
                    console.log('First GPS log sample:', logsToSend[0]);
                    console.log('Last GPS log sample:', logsToSend[logsToSend.length - 1]);
                }
                const requestBody = { session_id: window.sessionId, gps_logs: logsToSend };
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

// 褒めチェック開始
export function startPraiseCheck() {
    console.log("⏸️ 定期褒めチェックは無効化されています。");
}