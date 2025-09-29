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
                    document.getElementById('session_id').textContent = sessionId;
                    startTime = Date.now();
                    startTimer();
                    initMap();
                    watchPosition();
                    const speedLimitSpan = document.getElementById('speed_limit');
                    if (speedLimitSpan) {
                        speedLimitSpan.textContent = '－';
                    }
                    resetCounters();
                    alert('記録を開始しました');

                    // 開始ボタンを非表示にし、終了ボタンを表示
                    document.getElementById('start-button').style.display = 'none';
                    document.getElementById('end-button').style.display = 'block';

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
    console.log(gLogBuffer);
    console.log("=== Debug: GPS Logs before save ===");
    console.log(gpsLogBuffer);
    if (!sessionId) {
        if (showAlert) {
            alert('まだ記録が開始されていません');
        }
        return;
    }

    stopTimer();
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
            // ★ 一括保存処理 ★
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
                sessionId = null;
                if (showAlert) {
                    alert('記録を終了しました');
                }

                document.getElementById('session_id').textContent = '未開始';
                document.getElementById('speed').textContent = '0';
                document.getElementById('timer').textContent = '00:00';
                resetCounters();
                if (polyline) polyline.setPath([]);
                if (currentPositionMarker) currentPositionMarker.setMap(null);
                path = [];
                eventMarkers.forEach(marker => marker.setMap(null));
                eventMarkers = [];
                const speedLimitSpan = document.getElementById('speed_limit');
                if (speedLimitSpan) {
                    speedLimitSpan.textContent = '－';
                }

                document.getElementById('start-button').style.display = 'block';
                document.getElementById('end-button').style.display = 'none';
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

    document.getElementById('g-x').textContent = latestGX.toFixed(2);
    document.getElementById('g-z').textContent = latestGZ.toFixed(2);
    document.getElementById('g-y').textContent = latestGY.toFixed(2);

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
        document.getElementById('timer').textContent = `${mins}:${secs}`;
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
    document.getElementById('brake-count').textContent = '0';
    document.getElementById('accel-count').textContent = '0';
    document.getElementById('turn-count').textContent = '0';
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

        document.getElementById('speed').textContent = speed.toFixed(1);
        document.getElementById('position').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

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
        document.getElementById('speed').classList.remove('over-speed');

        if (prevSpeed !== null && prevTime !== null) {
            const dt = (now - prevTime) / 1000;
            if (dt > 0) {
                const accel = (speed / 3.6 - prevSpeed / 3.6) / dt;
                const gAccel = accel / 9.8;

                if (gAccel > ACCEL_BRAKE_G_THRESHOLD && latestGZ > ACCEL_BRAKE_G_THRESHOLD && now - lastAccelTime > COOLDOWN_MS) {
                    suddenAccels++;
                    document.getElementById('accel-count').textContent = suddenAccels;
                    lastAccelTime = now;
                    addEventMarker(lat, lng, 'sudden_accel');
                    if (currentEvent === 'normal') {
                        currentEvent = 'sudden_accel';
                    }
                }
                if (gAccel < -ACCEL_BRAKE_G_THRESHOLD && latestGZ < -ACCEL_BRAKE_G_THRESHOLD && now - lastBrakeTime > COOLDOWN_MS) {
                    suddenBrakes++;
                    document.getElementById('brake-count').textContent = suddenBrakes;
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
            document.getElementById('turn-count').textContent = sharpTurns;
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
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('start-button').addEventListener('click', startSession);
    document.getElementById('end-button').addEventListener('click', () => {
        endSession(true);
    });
    window.addEventListener('beforeunload', () => {
        endSession(false);
    });
});
