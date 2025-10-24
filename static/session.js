// session.js - セッション管理機能

import { stopMotionDetection, startMotionDetection, startAutoCalibration } from './sensors.js';
import { watchPosition, calculateDistance } from './maps.js';
import { startTimer, stopTimer, formatTime, calculateStability } from './utils.js';
import { unlockAudio, stopAudioSystem } from './audio.js'; // FIX: stopAudioSystemをimport
import { resetState } from './state.js';


console.log('=== session.js LOADED [FIXED] ===');

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

// 重点ポイント取得機能
function getFocusPoint() {
    const focusCheckboxes = document.querySelectorAll('input[name="focus"]:checked');
    if (focusCheckboxes.length > 0) {
        return focusCheckboxes[0].value;
    }
    return '';
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
    
    // 重点ポイントを取得して保存
    const focusPoint = getFocusPoint();
    console.log('Selected focus point:', focusPoint);
    localStorage.setItem('currentFocusPoint', focusPoint);
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
                window.avgGLogBuffer = []; // FIX: avgGLogBufferをリセット
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

    // === GPS監視の開始 ===
    if ('geolocation' in navigator) {
    // 既存のwatchが残っていたら一度解除（再実行防止）
    if (window.watchId) {
        navigator.geolocation.clearWatch(window.watchId);
    }

    window.watchId = navigator.geolocation.watchPosition(
        (pos) => {
        const { latitude, longitude, speed } = pos.coords;
        const timestamp = Date.now();
        const kmh = speed !== null ? speed * 3.6 : 0; // FIX: nullチェック

        // FIX: G値をセンサーの最新値と同期
        const gxs = window.latestGX || 0;
        const gys = window.latestGY || 0;
        const gzs = window.latestGZ || 0;

        const log = {
            latitude,
            longitude,
            speed: kmh,
            timestamp: timestamp, // FIX: timestamp_ms -> timestamp に変更
            g_x: gxs, // FIX: G値を追加
            g_y: gys,
            g_z: gzs,
            event: 'normal'
        };

        // 🔹 バッファ初期化を安全側に
        window.gpsLogBuffer = window.gpsLogBuffer || [];
        window.gpsLogBuffer.push(log);

        // 🔹 経路データ更新
        window.path = window.path || [];
        window.path.push({ lat: latitude, lng: longitude });

        // 🔹 sensors.js 側で速度参照用
        window.currentSpeed = kmh;

        console.log(`📍 GPS更新: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} (${kmh.toFixed(1)} km/h)`);
        },
        (err) => {
        console.error('⚠️ GPS取得エラー:', err);
        },
        {
        enableHighAccuracy: true, // ✅ 精度優先
        maximumAge: 1000,         // ✅ キャッシュ許容1秒
        timeout: 10000            // ✅ タイムアウト10秒
        }
    );

    console.log('✅ GPS監視を開始しました');
    } else {
    console.warn('⚠️ この端末ではGPSが利用できません');
    }
}

// 記録終了
export function endSession(showAlert = true) {
    console.log("=== endSession called ===");
    
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

    // FIX: AudioContextを安全に停止
    console.log("Stopping audio system...");
    stopAudioSystem();

    console.log("Calculating distance...");
    let distance = 0;
    try {
        distance = calculateDistance(window.path);
        console.log("Distance calculated:", distance, "km");
    } catch (error) {
        console.error("Error calculating distance:", error);
        distance = 0;
    }
    
    // FIX: サーバーに終了リクエストを送信する前に、残りのログをすべて送信
    const flushFinalLogs = () => {
        // FIX: ローカルバッファを強制フラッシュする関数
        const flushOneBuffer = (buffer, endpoint) => {
            if (buffer.length === 0) return Promise.resolve({ status: 'ok', saved_count: 0 });
            
            const logsToSend = buffer.splice(0, buffer.length); // すべて取り出す
            console.log(`Sending final ${logsToSend.length} logs to ${endpoint}`);
            
            return fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: window.sessionId, [endpoint.includes('gps') ? 'gps_logs' : endpoint.includes('avg') ? 'avg_g_logs' : 'g_logs']: logsToSend })
            })
            .then(r => r.json())
            .then(data => {
                console.log(`${endpoint} final save response:`, data);
                return data;
            })
            .catch(err => {
                console.error(`ERROR: Final ${endpoint} save failed:`, err);
                return { status: 'error', message: err.message };
            });
        };
        
        // ログの保存順序: GPSログがセッションの座標の主となるため、先に送る
        return Promise.all([
            flushOneBuffer(window.gpsLogBuffer, '/log_gps_bulk'),
            flushOneBuffer(window.gLogBuffer, '/log_g_only'),
            flushOneBuffer(window.avgGLogBuffer, '/log_avg_g_bulk') // FIX: avgGLogBufferも最後にフラッシュ
        ]);
    };


    console.log("Sending end request to server...");
    
    // 重点ポイントを localStorage から取得（fetchより前に取得）
    const focusPoint = localStorage.getItem('currentFocusPoint') || '';
    
    flushFinalLogs() // ログを先に送信
        .then(() => {
            console.log("All logs flushed, proceeding with session end request.");
            
            return fetch('/end', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: window.sessionId,
                    distance: distance,
                    sudden_accels: window.suddenAccels,
                    sudden_brakes: window.suddenBrakes,
                    sharp_turns: window.sharpTurns,
                    speed_violations: window.speedViolations,
                    focus_point: focusPoint,  // 重点ポイントを追加
                }),
            });
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
            if (data.status === 'ok' || data.status === 'warning') {
                console.log("Session end confirmed, preparing redirect.");
                
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
                    stability: calculateStability(window.suddenAccels, window.suddenBrakes, window.sharpTurns, distance),
                    session_id: window.sessionId,  // セッションIDを追加
                    focus_point: focusPoint        // 重点ポイントを追加
                };
                console.log("Session data prepared:", sessionData);
                localStorage.setItem('lastSessionData', JSON.stringify(sessionData));
                localStorage.removeItem('activeSessionId');
                localStorage.removeItem('sessionStartTime');
                window.sessionId = null;
                resetState();
                window.lastAudioPlayTime = {};
                console.log("Cleaning up map elements...");
                if (window.polyline) window.polyline.setPath([]);
                if (window.currentPositionMarker) window.currentPositionMarker.setMap(null);
                window.path = [];
                window.eventMarkers.forEach(marker => marker.setMap(null));
                window.eventMarkers = [];
                console.log("Redirecting to completed page...");
                window.location.href = '/recording/completed';
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
        console.log(`Interval flush check: sessionId=${window.sessionId}, G buffer=${window.gLogBuffer.length}, AVG buffer=${window.avgGLogBuffer?.length || 0}, GPS buffer=${window.gpsLogBuffer.length}`);

        if (!window.sessionId) {
            console.log('No session ID available for log flush');
            return;
        }

        // === Gログ送信 ===
        if (window.gLogBuffer.length > 0) {
            const logsToSend = window.gLogBuffer.splice(0, window.gLogBuffer.length);
            console.log(`Sending ${logsToSend.length} G logs for session ${window.sessionId}`);
            fetch('/log_g_only', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: window.sessionId, g_logs: logsToSend })
            })
            .then(r => r.json())
            .then(data => console.log('G logs save response:', data))
            .catch(err => console.error('Gログ送信エラー:', err));
        }

        // === 平滑化Gログ送信 ===
        if (window.avgGLogBuffer && window.avgGLogBuffer.length > 0) {
            const avgToSend = window.avgGLogBuffer.splice(0, window.avgGLogBuffer.length);
            console.log(`Sending ${avgToSend.length} AVG-G logs for session ${window.sessionId}`);
            fetch('/log_avg_g_bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: window.sessionId, avg_g_logs: avgToSend })
            })
            .then(r => r.json())
            .then(data => console.log('AVG G logs save response:', data))
            .catch(err => console.error('AVG Gログ送信エラー:', err));
        }

        // === GPSログ送信 ===
        if (window.gpsLogBuffer.length > 0) {
            const logsToSend = window.gpsLogBuffer.splice(0, window.gpsLogBuffer.length);
            console.log(`Sending ${logsToSend.length} GPS logs for session ${window.sessionId}`);
            fetch('/log_gps_bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: window.sessionId, gps_logs: logsToSend })
            })
            .then(r => r.json())
            .then(data => console.log('GPS logs save response:', data))
            .catch(err => console.error('GPSログ送信エラー:', err));
        }

    }, 10000); // 🔹10秒ごと
}

// 褒めチェック開始
export function startPraiseCheck() {
    console.log("⏸️ 定期褒めチェックは無効化されています。");
}