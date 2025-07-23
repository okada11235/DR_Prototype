// script.js - 完全修正版 + 走行中にイベントマーカーを地図上に表示

let sessionId = null;
let timerInterval = null;
let startTime = null;
let watchId = null;
let map, polyline, path = [];

let suddenBrakes = 0;
let suddenAccels = 0;
let sharpTurns = 0;
let speedViolations = 0;

let lastBrakeTime = 0;
let lastAccelTime = 0;
let lastTurnTime = 0;
let lastSpeedViolationTime = 0;
const cooldownMs = 3000;

let latestGX = 0; // 加速度センサーからの最新のX軸G値
let latestGY = 0; // 加速度センサーからの最新のY軸G値

// 現在位置を示すマーカーをグローバルで管理
let currentPositionMarker = null;

function startSession() {
    console.log('startSession called');
    requestMotionPermission(() => {
        console.log('Motion permission granted');
        startMotionDetection(); // 加速度センサーのデータ取得を開始
        fetch('/start', { method: 'POST' })
            .then(res => {
                console.log('Response received from /start');
                return res.json();
            })
            .then(data => {
                console.log('Session ID:', data.session_id);
                sessionId = data.session_id;
                document.getElementById('session_id').textContent = sessionId;
                startTime = Date.now();
                startTimer();
                initMap();
                watchPosition(); // GPSとイベント判定を開始
                resetCounters();
                alert('記録を開始しました');
            })
            .catch(err => {
                console.error('Error during /start fetch:', err);
                alert('記録開始時にエラーが発生しました');
            });
    });
}

function endSession() {
    if (!sessionId) {
        alert('まだ記録が開始されていません');
        return;
    }
    stopTimer();
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    // DeviceMotionEventリスナーも停止
    if (window.DeviceMotionEvent) {
        window.removeEventListener('devicemotion', handleDeviceMotion);
    }

    // 記録中のセッションIDと統計情報をサーバに送信
    const distance = calculateDistance(path);
    fetch('/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session_id: sessionId,
            distance,
            sudden_accels: suddenAccels,
            sudden_brakes: suddenBrakes,
            sharp_turns: sharpTurns,
            speed_violations: speedViolations
        })
    }).then(res => res.json())
    .then(res => {
        if (res.status === 'ok') {
            alert('記録を終了しました');
            sessionId = null;
            document.getElementById('session_id').textContent = '未開始';
            document.getElementById('speed').textContent = '0';
            document.getElementById('timer').textContent = '00:00';
            resetCounters();
            // マーカーや線を消したい場合はここで処理を追加可能
            if (polyline) polyline.setPath([]);
            if (currentPositionMarker) currentPositionMarker.setMap(null);
            // マーカーを全て消去する処理（必要に応じて）
            // map.data.forEach(function(feature) {
            //     map.data.remove(feature);
            // });
        } else {
            alert('エラー：' + res.message);
        }
    }).catch(err => {
        console.error('終了リクエスト失敗:', err);
        alert('終了処理中にエラーが発生しました');
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

// DeviceMotionイベントハンドラを分離
function handleDeviceMotion(event) {
    // console.log("DeviceMotion event received:", event);
    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc) {
        // console.warn("Acceleration data is null or undefined."); 
        return; // 加速度データがない場合は処理をスキップ
    }
    const x = acc.x || 0, y = acc.y || 0, z = acc.z || 0;
    latestGX = x / 9.8;
    latestGY = y / 9.8;

    document.getElementById('g-x').textContent = latestGX.toFixed(2);
    document.getElementById('g-y').textContent = latestGY.toFixed(2);
    document.getElementById('g-z').textContent = (z/9.8).toFixed(2);
}

function startMotionDetection() {
    if (window.DeviceMotionEvent) {
        // イベントリスナーを一度だけ追加
        window.removeEventListener('devicemotion', handleDeviceMotion); // 二重登録防止
        window.addEventListener('devicemotion', handleDeviceMotion);
    }
}

function addEventMarker(lat, lng, type) {
    const colors = {
        sudden_brake: 'red',
        sudden_accel: 'green',
        sharp_turn: 'orange',
        speed_violation: 'purple'
    };
    new google.maps.Marker({
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
}

function initMap() {
    const mapDiv = document.getElementById('map');
    path = [];
    // マップが既に存在する場合は初期化しない
    if (map) {
        polyline.setPath([]); // 既存の線をクリア
        if (currentPositionMarker) currentPositionMarker.setMap(null); // 既存のマーカーをクリア
        return;
    }

    navigator.geolocation.getCurrentPosition(position => {
        const userLatLng = { lat: position.coords.latitude, lng: position.coords.longitude };
        map = new google.maps.Map(mapDiv, { zoom: 16, center: userLatLng });
        polyline = new google.maps.Polyline({
            path,
            geodesic: true,
            strokeColor: '#007bff',
            strokeOpacity: 1.0,
            strokeWeight: 4,
            map
        });
        // 現在位置マーカーの初期化
        currentPositionMarker = new google.maps.Marker({
            position: userLatLng,
            map: map,
            icon: {
                path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                scale: 6,
                fillColor: 'blue',
                fillOpacity: 0.8,
                strokeWeight: 1,
                strokeColor: '#fff',
                rotation: 0 // 最初は0
            }
        });
    }, () => {
        // 許可されなかった場合のデフォルト位置（東京駅）
        const defaultLatLng = { lat: 35.681236, lng: 139.767125 };
        map = new google.maps.Map(mapDiv, { zoom: 16, center: defaultLatLng });
        polyline = new google.maps.Polyline({
            path,
            geodesic: true,
            strokeColor: '#007bff',
            strokeOpacity: 1.0,
            strokeWeight: 4,
            map
        });
        currentPositionMarker = new google.maps.Marker({
            position: defaultLatLng,
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
    document.getElementById('violation-count').textContent = '0';
}

function calculateDistance(path) {
    const R = 6371; // 地球半径(km)
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

const Maps_API_KEY = 'YOUR_Maps_API_KEY'; // ここに実際のAPIキーを設定

async function fetchSpeedLimit(lat, lng) {
    try {
        const snapResponse = await fetch(`https://roads.googleapis.com/v1/snapToRoads?path=${lat},${lng}&key=${Maps_API_KEY}`);
        if (!snapResponse.ok) throw new Error(`SnapToRoads API エラー: ${snapResponse.statusText}`);
        const snapData = await snapResponse.json();

        if (!snapData.snappedPoints || snapData.snappedPoints.length === 0) {
            return null;
        }

        const placeId = snapData.snappedPoints[0].placeId;

        const speedLimitResponse = await fetch(`https://roads.googleapis.com/v1/speedLimits?placeId=${placeId}&key=${Maps_API_KEY}`);
        if (!speedLimitResponse.ok) throw new Error(`SpeedLimits API エラー: ${speedLimitResponse.statusText}`);
        const speedLimitData = await speedLimitResponse.json();

        if (speedLimitData.speedLimits && speedLimitData.speedLimits.length > 0) {
            const speedLimitKmh = speedLimitData.speedLimits[0].speedLimit;
            return speedLimitKmh;
        }
        return null;
    } catch (error) {
        console.error('速度制限取得エラー:', error);
        return null;
    }
}

let prevSpeed = null, prevLatLng = null, prevTime = null; // prevPrevLatLngは不要になりました
let lastSharpTurnTime = 0; // すでに定義済み

function watchPosition() {
    watchId = navigator.geolocation.watchPosition(async position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const currentLatLng = { lat, lng };
        const speed = position.coords.speed !== null ? position.coords.speed * 3.6 : 0; // km/h
        const now = Date.now();

        // UIの更新
        document.getElementById('speed').textContent = speed.toFixed(1);
        document.getElementById('position').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

        // 現在位置マーカーの更新と地図の中心移動
        if (currentPositionMarker) {
            currentPositionMarker.setPosition(currentLatLng);
            map.setCenter(currentLatLng);
        } else {
            // マーカーがまだない場合は作成
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
                    rotation: 0 // 適切な回転角度を設定することも可能
                }
            });
        }
        
        // ★イベントタイプを保持する変数。デフォルトは 'normal'
        let currentEvent = 'normal';

        // 速度制限の取得と超過判定
        const limit = await fetchSpeedLimit(lat, lng);
        const speedLimitSpan = document.getElementById('speed_limit');
        if (limit !== null) {
            speedLimitSpan.textContent = limit;
            if (speed > limit + 5 && now - lastSpeedViolationTime > cooldownMs) {
                speedViolations++;
                document.getElementById('violation-count').textContent = speedViolations;
                lastSpeedViolationTime = now;
                document.getElementById('speed').classList.add('over-speed');
                addEventMarker(lat, lng, 'speed_violation');
                currentEvent = 'speed_violation';
            } else {
                document.getElementById('speed').classList.remove('over-speed');
            }
        } else {
            speedLimitSpan.textContent = '不明';
            document.getElementById('speed').classList.remove('over-speed');
        }

        // 急発進、急ブレーキの判定 (GPSの速度変化から)
        if (prevSpeed !== null && prevTime !== null) {
            const dt = (now - prevTime) / 1000; // 時間差（秒）
            if (dt > 0) {
                const accel = (speed / 3.6 - prevSpeed / 3.6) / dt; // m/s^2
                const gAccel = accel / 9.8; // G単位の加速度

                // 急発進
                // 加速度センサーのgYも考慮することで、より正確な縦方向のGを判定できる
                if (gAccel > 0.3 && latestGY > 0.3 && now - lastAccelTime > cooldownMs) {
                    suddenAccels++;
                    document.getElementById('accel-count').textContent = suddenAccels;
                    lastAccelTime = now;
                    addEventMarker(lat, lng, 'sudden_accel');
                    if (currentEvent === 'normal' || currentEvent === 'speed_violation') {
                        currentEvent = 'sudden_accel';
                    }
                }
                // 急ブレーキ
                // 加速度センサーのgYも考慮
                if (gAccel < -0.3 && latestGY < -0.3 && now - lastBrakeTime > cooldownMs) {
                    suddenBrakes++;
                    document.getElementById('brake-count').textContent = suddenBrakes;
                    lastBrakeTime = now;
                    addEventMarker(lat, lng, 'sudden_brake');
                    if (currentEvent === 'normal' || currentEvent === 'speed_violation' || currentEvent === 'sudden_accel') {
                        currentEvent = 'sudden_brake';
                    }
                }
            }
        }
        
        // 急カーブ判定 (加速度センサーの横Gと速度から)
        // ある程度の速度が出ていて、かつ横Gが強い場合
        if (Math.abs(latestGX) > 0.6 && speed > 5 && now - lastSharpTurnTime > cooldownMs) {
            sharpTurns++;
            document.getElementById('turn-count').textContent = sharpTurns;
            lastSharpTurnTime = now;
            addEventMarker(lat, lng, 'sharp_turn');
            // 急カーブは他のイベントより優先度が高いとして、現在のイベントを上書き
            currentEvent = 'sharp_turn';
        }

        // 走行ルートの更新
        path.push({ lat, lng });
        if (polyline) {
            polyline.setPath(path);
        }

        // GPSログをサーバーに送信
        fetch('/log_gps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                latitude: lat,
                longitude: lng,
                speed: speed,
                g_x: latestGX, // X軸G値も送信
                g_y: latestGY, // Y軸G値も送信
                event: currentEvent
            })
        });

        // 次の計算のために現在の値を保存
        prevLatLng = currentLatLng;
        prevSpeed = speed;
        prevTime = now;

    }, console.error, { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 });
}

// イベントリスナーの設定
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('start-button').addEventListener('click', startSession);
    document.getElementById('end-button').addEventListener('click', endSession);
});