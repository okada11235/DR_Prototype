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

let latestGX = 0;
let latestGY = 0;
let speed = 0;

function startSession() {
    console.log('startSession called');
    requestMotionPermission(() => {
        console.log('Motion permission granted');
        startMotionDetection();
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
                watchPosition();
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


function watchPosition() {
    watchId = navigator.geolocation.watchPosition(position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        speed = position.coords.speed !== null ? position.coords.speed * 3.6 : 0;

        document.getElementById('speed').textContent = speed.toFixed(1);
        document.getElementById('position').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

        // 線を引く
        const latlng = new google.maps.LatLng(lat, lng);
        path.push(latlng);
        polyline.setPath(path);

        // 現在位置マーカー更新
        if (window.currentPositionMarker) {
            window.currentPositionMarker.setPosition(latlng);
        } else {
            window.currentPositionMarker = new google.maps.Marker({
                position: latlng,
                map: map,
                title: '現在地',
            });
        }

        map.setCenter(latlng);

        // スピード違反判定（例：制限速度 60km/h 固定なら）
        const speedLimit = 60;
        if (speed > speedLimit + 5 && Date.now() - lastSpeedViolationTime > cooldownMs) {
            speedViolations++;
            lastSpeedViolationTime = Date.now();
            document.getElementById('violation-count').textContent = speedViolations;
            addEventMarker(lat, lng, 'speed_violation');
        }

        // 位置情報をサーバに送信
        fetch('/log_gps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, latitude: lat, longitude: lng, speed: speed })
        });
    }, err => {
        console.error('位置情報取得エラー:', err);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 });
}

function startMotionDetection() {
    if (window.DeviceMotionEvent) {
        window.addEventListener('devicemotion', event => {
            const now = Date.now();
            const acc = event.acceleration || event.accelerationIncludingGravity;
            if (!acc) return;
            const x = acc.x || 0, y = acc.y || 0, z = acc.z || 0;
            const gX = x / 9.8, gY = y / 9.8;

            latestGX = gX;
            latestGY = gY;

            document.getElementById('g-x').textContent = gX.toFixed(2);
            document.getElementById('g-y').textContent = gY.toFixed(2);
            document.getElementById('g-z').textContent = (z/9.8).toFixed(2);

            // 急ブレーキ判定
            if (gY < -0.3 && speed > 10 && now - lastBrakeTime > cooldownMs) {
                suddenBrakes++;
                lastBrakeTime = now;
                document.getElementById('brake-count').textContent = suddenBrakes;
                addEventMarker(window.currentPositionMarker.getPosition().lat(), window.currentPositionMarker.getPosition().lng(), 'sudden_brake');
            }

            // 急発進判定
            if (gY > 0.3 && speed < 10 && now - lastAccelTime > cooldownMs) {
                suddenAccels++;
                lastAccelTime = now;
                document.getElementById('accel-count').textContent = suddenAccels;
                addEventMarker(window.currentPositionMarker.getPosition().lat(), window.currentPositionMarker.getPosition().lng(), 'sudden_accel');
            }

            // 急カーブ判定
            if (Math.abs(gX) > 0.6 && now - lastTurnTime > cooldownMs) {
                sharpTurns++;
                lastTurnTime = now;
                document.getElementById('turn-count').textContent = sharpTurns;
                addEventMarker(window.currentPositionMarker.getPosition().lat(), window.currentPositionMarker.getPosition().lng(), 'sharp_turn');
            }
        });
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
    }, () => {
        map = new google.maps.Map(mapDiv, { zoom: 16, center: { lat: 35.681236, lng: 139.767125 } });
        polyline = new google.maps.Polyline({
            path,
            geodesic: true,
            strokeColor: '#007bff',
            strokeOpacity: 1.0,
            strokeWeight: 4,
            map
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
        const dLat = (b.lat() - a.lat()) * Math.PI / 180;
        const dLng = (b.lng() - a.lng()) * Math.PI / 180;
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(a.lat() * Math.PI / 180) * Math.cos(b.lat() * Math.PI / 180)
            * Math.sin(dLng / 2) ** 2;
        dist += 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }
    return dist;
}


const GOOGLE_MAPS_API_KEY = 'AIzaSyDjV8lvnNMujcDrw2pVLSfpTr7w0F6zl2cAIzaSyBb7m-VxM2tA-slsA0gf3kj0GtvathFXv0';

async function fetchSpeedLimit(lat, lng) {
    try {
        // Roads APIで速度制限を取得するためにはまずスナップポイントを取得する必要がある
        const snapResponse = await fetch(`https://roads.googleapis.com/v1/snapToRoads?path=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`);
        if (!snapResponse.ok) throw new Error('SnapToRoads API エラー');
        const snapData = await snapResponse.json();

        if (!snapData.snappedPoints || snapData.snappedPoints.length === 0) {
            return null; // スナップできなければ取得できない
        }

        // スナップポイントの placeId を取得
        const placeId = snapData.snappedPoints[0].placeId;

        // 速度制限を取得するためのエンドポイント（複数の placeId に対応）
        const speedLimitResponse = await fetch(`https://roads.googleapis.com/v1/speedLimits?placeId=${placeId}&key=${GOOGLE_MAPS_API_KEY}`);
        if (!speedLimitResponse.ok) throw new Error('SpeedLimits API エラー');
        const speedLimitData = await speedLimitResponse.json();

        if (speedLimitData.speedLimits && speedLimitData.speedLimits.length > 0) {
            // speedLimitData.speedLimits[0].speedLimit は mph なので km/hに変換
            const speedLimitMph = speedLimitData.speedLimits[0].speedLimit;
            const speedLimitKmh = Math.round(speedLimitMph * 1.60934);
            return speedLimitKmh;
        }
        return null;
    } catch (error) {
        console.error('速度制限取得エラー:', error);
        return null;
    }
}

let prevSpeed = null, prevLatLng = null, prevTime = null, prevPrevLatLng = null;
let lastSharpTurnTime = 0;

function watchPosition() {
    watchId = navigator.geolocation.watchPosition(async position => {
        const lat = position.coords.latitude, lng = position.coords.longitude;
        const speed = position.coords.speed !== null ? position.coords.speed * 3.6 : 0;
        const now = Date.now();

        document.getElementById('speed').textContent = speed.toFixed(1);
        document.getElementById('position').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

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
            } else {
                document.getElementById('speed').classList.remove('over-speed');
            }
        } else {
            speedLimitSpan.textContent = '不明';
            document.getElementById('speed').classList.remove('over-speed');
        }

        if (prevSpeed !== null && prevLatLng !== null && prevTime !== null) {
            const dt = (now - prevTime) / 1000;
            if (dt > 0) {
                const accel = (speed - prevSpeed) / dt;
                const gAccel = accel / 9.8;
                if (gAccel > 0.3 && now - lastAccelTime > cooldownMs) {
                    suddenAccels++;
                    document.getElementById('accel-count').textContent = suddenAccels;
                    lastAccelTime = now;
                    addEventMarker(lat, lng, 'sudden_accel');
                }
                if (gAccel < -0.3 && now - lastBrakeTime > cooldownMs) {
                    suddenBrakes++;
                    document.getElementById('brake-count').textContent = suddenBrakes;
                    lastBrakeTime = now;
                    addEventMarker(lat, lng, 'sudden_brake');
                }
                if (prevPrevLatLng && Math.abs(window.latestGX) > 0.6 && speed > 5 && now - lastSharpTurnTime > cooldownMs) {
                    sharpTurns++;
                    document.getElementById('turn-count').textContent = sharpTurns;
                    lastSharpTurnTime = now;
                    addEventMarker(lat, lng, 'sharp_turn');
                }
            }
        }

        prevPrevLatLng = prevLatLng;
        prevLatLng = { lat, lng };
        prevSpeed = speed;
        prevTime = now;
        path.push({ lat, lng });
        polyline.setPath(path);

        fetch('/log_gps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, latitude: lat, longitude: lng, speed: speed, g_y: latestGY })
        });
    }, console.error, { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 });
}

function calculateDistance(path) {
    const R = 6371;
    let dist = 0;
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLng = (b.lng - a.lng) * Math.PI / 180;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        dist += 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }
    return dist;
}
