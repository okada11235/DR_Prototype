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

// (既存の startSession 関数)
function startSession() {
    console.log('startSession called');
    requestMotionPermission(() => {
        console.log('Motion permission granted');
        startMotionDetection();
        // サーバー側でセッションIDを生成し、そのIDをFirestoreのドキュメントIDとして使用
        fetch('/start', { method: 'POST' })
            .then(res => {
                if (!res.ok) { // サーバーからのエラーレスポンスをチェック
                    return res.json().then(err => { throw new Error(err.message || 'サーバーエラー'); });
                }
                return res.json();
            })
            .then(data => {
                if (data.session_id) {
                    sessionId = data.session_id; // サーバーからセッションIDを取得
                    document.getElementById('session_id').textContent = sessionId;
                    startTime = Date.now();
                    startTimer();
                    initMap();
                    watchPosition();
                    resetCounters();
                    alert('記録を開始しました');
                } else {
                    throw new Error('サーバーからのセッションIDが不正です。');
                }
            })
            .catch(err => {
                console.error('Error during /start fetch or response handling:', err);
                alert('記録開始時にエラーが発生しました: ' + err.message); // エラーメッセージを詳細化
            });
    });
}

// endSession 関数内 (最初のチェックだけで十分)
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
    if (window.DeviceMotionEvent) {
        window.removeEventListener('devicemotion', handleDeviceMotion);
    }

    const distance = calculateDistance(path);

    // ★ここを修正します: /end エンドポイントにデータをPOSTで送信する
    fetch('/end', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            session_id: sessionId,
            distance: distance,
            sudden_accels: suddenAccels,
            sudden_brakes: suddenBrakes,
            sharp_turns: sharpTurns,
            speed_violations: speedViolations,
            // stabilityは現在JSで計算されていないが、必要なら追加
            // stability: 0.0 // 例: デフォルト値
        }),
    })
    .then(response => {
        // サーバーからのHTTPステータスが200番台以外ならエラーとして処理
        if (!response.ok) {
            return response.json().then(errorData => {
                // サーバーからエラーメッセージがあればそれを使う
                throw new Error(errorData.message || '記録終了時にサーバーエラーが発生しました');
            });
        }
        return response.json(); // 成功レスポンスをJSONとしてパース
    })
    .then(data => {
        // サーバーからのレスポンスが成功を示しているか確認
        if (data.status === 'ok') {
            alert('記録を終了しました');
            sessionId = null;
            document.getElementById('session_id').textContent = '未開始';
            document.getElementById('speed').textContent = '0';
            document.getElementById('timer').textContent = '00:00';

            // UIリセットとカウンターリセット
            resetCounters(); 
            if (polyline) polyline.setPath([]);
            if (currentPositionMarker) currentPositionMarker.setMap(null); // 現在位置マーカーはクリア
            path = []; // パスもリセット

            // ★ここに追加します: イベントマーカーを全て削除
            eventMarkers.forEach(marker => marker.setMap(null));
            eventMarkers = []; // 配列もリセット

        } else {
            // サーバーから 'status: error' が返された場合
            alert('記録終了に失敗しました: ' + (data.message || '不明なエラー'));
        }
    })
    .catch(error => {
        // ネットワークエラーやJSONパースエラーなど
        console.error('記録終了中にエラーが発生しました:', error);
        alert('記録終了中にネットワークまたは処理エラーが発生しました: ' + error.message);
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

// addEventMarker 関数内で、イベントマーカーを配列に追加するように変更
function addEventMarker(lat, lng, type) {
    const colors = {
        sudden_brake: 'red',
        sudden_accel: 'green',
        sharp_turn: 'orange',
        speed_violation: 'purple'
    };
    const marker = new google.maps.Marker({ // marker 変数に格納
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
    eventMarkers.push(marker); // 新しく作成したマーカーを配列に追加
}

let eventMarkers = []; 

function initMap() {
    const mapDiv = document.getElementById('map');
    path = []; // 新しいセッションなのでパスを空にする

    // 既存のマップがあれば、ポリラインとマーカーをクリアし、イベントマーカーもクリア
    if (map) {
        polyline.setPath([]);
        if (currentPositionMarker) currentPositionMarker.setMap(null);
        
        // 既存のイベントマーカーも全て削除
        eventMarkers.forEach(marker => marker.setMap(null));
        eventMarkers = []; // 配列もリセット
    } else {
        // マップがまだない場合のみ新規作成
        map = new google.maps.Map(mapDiv, { zoom: 16, center: { lat: 35.681236, lng: 139.767125 } }); // デフォルトのセンター
        polyline = new google.maps.Polyline({
            path: [], // 初期パスは空
            geodesic: true,
            strokeColor: '#007bff',
            strokeOpacity: 1.0,
            strokeWeight: 4,
            map: map // mapを明示的に指定
        });
        currentPositionMarker = new google.maps.Marker({
            position: { lat: 35.681236, lng: 139.767125 }, // デフォルト位置
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

    // 初期位置の設定とマップの中心移動
    navigator.geolocation.getCurrentPosition(position => {
        const userLatLng = { lat: position.coords.latitude, lng: position.coords.longitude };
        map.setCenter(userLatLng);
        currentPositionMarker.setPosition(userLatLng);
    }, () => {
        // 許可されなかった場合やエラーの場合、デフォルト位置のまま
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

const Maps_API_KEY = 'AIzaSyBUyc6mj-SEOP8lopM2laEywMILL8qknvo'; // ここに実際のAPIキーを設定

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

        // GPSログをサーバーに送信 (Firestoreへ直接ではなく、Flaskサーバーへ)
        fetch('/log_gps', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                session_id: sessionId, // サーバーにセッションIDを渡す
                latitude: lat,
                longitude: lng,
                speed: speed,
                g_x: latestGX,
                g_y: latestGY,
                event: currentEvent
                // timestamp はサーバー側で生成されるため不要
            }),
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(errorData => {
                    throw new Error(errorData.message || 'GPSログ送信エラー');
                });
            }
            return response.json();
        })
        .then(data => {
            // console.log("GPS log sent to server successfully:", data);
        })
        .catch(error => {
            console.error("Error sending GPS log to server:", error);
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