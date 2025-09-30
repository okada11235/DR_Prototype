// script.js - 一括保存対応版 + 走行中にイベントマーカーを地図上に表示
// 法定速度の検査と取得に関する部分を削除

let sessionId = null;
let timerInterval = null;
let startTime = null;
let watchId = null;
let map, polyline, path = [];

let suddenBrakes = 0;
let suddenAccels = 0;
let sharpTurns = 0;
let speedViolations = 0; // 法定速度チェックがなくなるため、このカウンターは使われなくなるが、残しておく

// ★★★ 判定閾値とクールダウン期間の定数化 ★★★
const COOLDOWN_MS = 2000; // イベント発生後のクールダウン期間（ミリ秒）

// 急発進・急ブレーキのG値閾値
const ACCEL_BRAKE_G_THRESHOLD = 0.3;

// 急カーブのG値閾値
const SHARP_TURN_G_THRESHOLD = 0.4;

let lastBrakeTime = 0;
let lastAccelTime = 0;
let lastTurnTime = 0;

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

// センサー値を補正
let orientationMode = "auto"; 
let calibrationData = null;

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

// 記録開始
function startSession() {
    console.log('startSession called');
    requestMotionPermission(() => {
        console.log('Motion permission granted');
        startMotionDetection();
        fetch('/start', { method: 'POST' })
            .then(res => {
                if (!res.ok) {
                    return res.json().then(err => { throw new Error(err.message || 'サーバーエラー'); });
                }
                return res.json();
            })
            .then(data => {
                if (data.session_id) {
                    sessionId = data.session_id;
                    startTime = Date.now();
                    
                    // セッション情報をLocalStorageに保存
                    localStorage.setItem('activeSessionId', sessionId);
                    localStorage.setItem('sessionStartTime', startTime.toString());
                    
                    resetCounters();
                    
                    // 記録中画面に遷移
                    window.location.href = '/recording/active';

                } else {
                    throw new Error('サーバーからのセッションIDが不正です。');
                }
            })
            .catch(err => {
                console.error('Error during /start fetch or response handling:', err);
                alert('記録開始時にエラーが発生しました: ' + err.message);
            });
    });
}

// 記録終了
function endSession(showAlert = true) {
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
        if (showAlert) {
            alert('まだ記録が開始されていません');
        }
        return;
    }

    stopTimer();
    // ★ 定期送信タイマーを止める
    if (logFlushInterval) {
        clearInterval(logFlushInterval);
        logFlushInterval = null;
    }
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (window.DeviceMotionEvent) {
        window.removeEventListener('devicemotion', handleDeviceMotion);
    }

    const distance = calculateDistance(path);

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
        if (!response.ok) {
            return response.json().then(errorData => {
                throw new Error(errorData.message || '記録終了時にサーバーエラーが発生しました');
            });
        }
        return response.json();
    })
    .then(data => {
        if (data.status === 'ok') {
            // ★ 残り分だけ送信 ★
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
                    }).finally(() => { gpsLogBuffer = []; })
                    : Promise.resolve()
            ]);
            flushLogs.finally(() => {
                // セッションデータを保存して記録完了画面に遷移
                const sessionData = {
                    distance: distance,
                    sudden_accels: suddenAccels,
                    sudden_brakes: suddenBrakes,
                    sharp_turns: sharpTurns,
                    speed_violations: speedViolations,
                    totalTime: formatTime(Math.floor((Date.now() - startTime) / 1000)),
                    stability: calculateStability(suddenAccels, suddenBrakes, sharpTurns, distance)
                };
                
                // LocalStorageに保存
                localStorage.setItem('lastSessionData', JSON.stringify(sessionData));
                
                // アクティブセッション情報をクリア
                localStorage.removeItem('activeSessionId');
                localStorage.removeItem('sessionStartTime');
                
                // セッション変数をリセット
                sessionId = null;
                resetCounters();
                if (polyline) polyline.setPath([]);
                if (currentPositionMarker) currentPositionMarker.setMap(null);
                path = [];
                eventMarkers.forEach(marker => marker.setMap(null));
                eventMarkers = [];
                
                // 記録完了画面に遷移
                window.location.href = '/recording/completed';
            });

        } else {
            if (showAlert) {
                alert('記録終了に失敗しました: ' + (data.message || '不明なエラー'));
            }
        }
    })
    .catch(error => {
        console.error('記録終了中にエラーが発生しました:', error);
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

// DeviceMotionイベントハンドラ
function handleDeviceMotion(event) {
    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc) return;

    const { forward, side, up } = adjustOrientation(acc.x || 0, acc.y || 0, acc.z || 0);

    latestGZ = forward / 9.8;
    latestGX = side / 9.8;
    latestGY = up / 9.8;

    const gxElement = document.getElementById('g-x');
    const gzElement = document.getElementById('g-z');
    const gyElement = document.getElementById('g-y');
    
    if (gxElement) gxElement.textContent = latestGX.toFixed(2);
    if (gzElement) gzElement.textContent = latestGZ.toFixed(2);
    if (gyElement) gyElement.textContent = latestGY.toFixed(2);

    const gData = {
        timestamp: Date.now(),
        g_x: latestGX,
        g_y: latestGY,
        g_z: latestGZ
    };
    gLogBuffer.push(gData);
}

function startMotionDetection() {
    if (window.DeviceMotionEvent) {
        window.removeEventListener('devicemotion', handleDeviceMotion);
        window.addEventListener('devicemotion', handleDeviceMotion);
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

function initMap() {
    const mapDiv = document.getElementById('map');
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

let prevSpeed = null, prevLatLng = null, prevTime = null;

function watchPosition() {
    watchId = navigator.geolocation.watchPosition(async position => {
        if (!sessionId) return;
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const currentLatLng = { lat, lng };
        const speed = position.coords.speed !== null ? position.coords.speed * 3.6 : 0;
        const now = Date.now();

        const speedElement = document.getElementById('speed');
        if (speedElement) {
            speedElement.textContent = speed.toFixed(1);
        }
        const positionElement = document.getElementById('position');
        if (positionElement) {
            positionElement.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        }

        if (currentPositionMarker) {
            currentPositionMarker.setPosition(currentLatLng);
            map.setCenter(currentLatLng);
        } else {
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
        const speedDisplayElement = document.getElementById('speed');
        if (speedDisplayElement) {
            speedDisplayElement.classList.remove('over-speed');
        }

        if (prevSpeed !== null && prevTime !== null) {
            const dt = (now - prevTime) / 1000;
            if (dt > 0) {
                const accel = (speed / 3.6 - prevSpeed / 3.6) / dt;
                const gAccel = accel / 9.8;

                if (gAccel > ACCEL_BRAKE_G_THRESHOLD && latestGZ > ACCEL_BRAKE_G_THRESHOLD && now - lastAccelTime > COOLDOWN_MS) {
                    suddenAccels++;
                    const accelElement = document.getElementById('accel-count');
                    if (accelElement) {
                        accelElement.textContent = suddenAccels;
                    }
                    lastAccelTime = now;
                    addEventMarker(lat, lng, 'sudden_accel');
                    if (currentEvent === 'normal') {
                        currentEvent = 'sudden_accel';
                    }
                }
                if (gAccel < -ACCEL_BRAKE_G_THRESHOLD && latestGZ < -ACCEL_BRAKE_G_THRESHOLD && now - lastBrakeTime > COOLDOWN_MS) {
                    suddenBrakes++;
                    const brakeElement = document.getElementById('brake-count');
                    if (brakeElement) {
                        brakeElement.textContent = suddenBrakes;
                    }
                    lastBrakeTime = now;
                    addEventMarker(lat, lng, 'sudden_brake');
                    if (currentEvent === 'normal' || currentEvent === 'sudden_accel') {
                        currentEvent = 'sudden_brake';
                    }
                }
            }
        }

        if (Math.abs(latestGX) > SHARP_TURN_G_THRESHOLD && speed > 15 && now - lastTurnTime > COOLDOWN_MS) {
            sharpTurns++;
            const turnElement = document.getElementById('turn-count');
            if (turnElement) {
                turnElement.textContent = sharpTurns;
            }
            lastTurnTime = now;
            addEventMarker(lat, lng, 'sharp_turn');
            currentEvent = 'sharp_turn';
        }

        path.push({ lat, lng });
        if (polyline) {
            polyline.setPath(path);
        }

        // ★ GPSログを保存（送信せず）
        const gpsData = {
            timestamp: now,
            latitude: lat,
            longitude: lng,
            speed: speed,
            g_x: latestGX,
            g_y: latestGY,
            g_z: latestGZ,
            event: currentEvent
        };
        gpsLogBuffer.push(gpsData);

        prevLatLng = currentLatLng;
        prevSpeed = speed;
        prevTime = now;

    }, console.error, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
}

// イベントリスナー

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
        if (sessionId) {
            // Gログ送信
            if (gLogBuffer.length > 0) {
                const logsToSend = gLogBuffer.splice(0, gLogBuffer.length);
                fetch('/log_g_only', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sessionId, g_logs: logsToSend })
                }).catch(err => console.error('Gログ送信エラー:', err));
            }

            // GPSログ送信
            if (gpsLogBuffer.length > 0) {
                const logsToSend = gpsLogBuffer.splice(0, gpsLogBuffer.length);
                fetch('/log_gps_bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sessionId, gps_logs: logsToSend })
                }).catch(err => console.error('GPSログ送信エラー:', err));
            }
        }
    }, 10000); // 10秒ごと
}

// 記録中画面の初期化処理
function initActiveRecording() {
    // LocalStorageからセッション情報を復元
    const savedSessionId = localStorage.getItem('activeSessionId');
    const savedStartTime = localStorage.getItem('sessionStartTime');
    
    if (savedSessionId && savedStartTime) {
        sessionId = savedSessionId;
        startTime = parseInt(savedStartTime);
        
        // DOM要素の更新
        const sessionIdElement = document.getElementById('session_id');
        if (sessionIdElement) {
            sessionIdElement.textContent = sessionId;
        }
        
        // タイマー開始
        startTimer();
        
        // 位置情報とセンサーの監視開始
        watchPosition();
        startMotionDetection();
        
        // 定期ログ送信開始
        startLogFlush();
        
        console.log('Active recording initialized with session:', sessionId);
    } else {
        console.error('No active session found');
        // セッション情報がない場合は記録開始画面に戻る
        window.location.href = '/recording/start';
    }
}

// ページ読み込み時の初期化
document.addEventListener('DOMContentLoaded', function() {
    // URLに基づいて適切な初期化を実行
    const currentPath = window.location.pathname;
    
    // ボタンのイベントリスナー設定
    const startButton = document.getElementById('start-button');
    const endButton = document.getElementById('end-button');
    
    if (startButton) {
        startButton.addEventListener('click', startSession);
    }
    if (endButton) {
        endButton.addEventListener('click', () => {
            endSession(true);
        });
    }
    
    window.addEventListener('beforeunload', () => {
        endSession(false);
    });
    
    if (currentPath === '/recording/active') {
        initActiveRecording();
    } else if (currentPath === '/recording/start' || currentPath === '/') {
        // 記録開始画面では地図のみ初期化
        if (typeof initMap === 'function') {
            initMap();
        }
    }
    // recording/completed画面では特別な初期化は不要（HTMLに記述済み）
});
