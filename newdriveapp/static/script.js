// script.js - 完全修正版 + 走行中にイベントマーカーを地図上に表示
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

// 急発進・急ブレーキのG値閾値 (GPS計算G値とデバイスG値の両方に適用)
const ACCEL_BRAKE_G_THRESHOLD = 0.3;

// 急カーブのG値閾値 (デバイスの横Gに適用)
const SHARP_TURN_G_THRESHOLD = 0.4;

let lastBrakeTime = 0;
let lastAccelTime = 0;
let lastTurnTime = 0;
let lastSpeedViolationTime = 0;

let latestGX = 0; // 加速度センサーからの最新のX軸G値
let latestGY = 0; // 加速度センサーからの最新のY軸G値
let latestGZ = 0; // 加速度センサーからの最新のZ軸G値

// 現在位置を示すマーカーをグローバルで管理
let currentPositionMarker = null;
let eventMarkers = []; // イベントマーカーを管理する配列

let orientationMode = "default";

// 選択した向きを保持
document.getElementById("orientation").addEventListener("change", (e) => {
    orientationMode = e.target.value;
    console.log("選択された設置向き:", orientationMode);
});

// センサー値を補正
function adjustOrientation(ax, ay, az) {
    switch (orientationMode) {
        case "default": // 縦置き・画面は運転者側
            return { forward: -az, side: ax, up: -ay };
        case "default_right": // 縦置き（画面は車の右側を向く）
            return { forward: ax, side: az, up: -ay };
        case "default_left": // 縦置き（画面は車の左側を向く）
            return { forward: -ax, side: -az, up: -ay };
        case "landscape_left": // 横置き（画面は運転者側・左側面が上）
            return { forward: -az, side: ay, up: -ax };
        case "landscape_right": // 横置き（画面は運転者側・右側面が上）
            return { forward: -az, side: -ay, up: ax };
        case "camera_screen_left": // 横置き（上辺が進行方向・画面は車の左側を向く）
            return { forward: ay, side: -az, up: ax };
        case "camera_screen_right": // 横置き（上辺が進行方向・画面は車の右側を向く）
            return { forward: ay, side: az, up: -ax };
        case "upside_down": // 逆さま
            return { forward: -az, side: -ax, up: ay };
        case "flat_screen_down": // 水平置き（上辺が進行方向・画面下向き）
            return { forward: ay, side: ax, up: -az };
        case "flat_screen_up": // 水平置き（上辺が進行方向・画面上向き）
            return { forward: ay, side: ax, up: az };
        case "flat_screen_down_top_front": // 水平置き（上辺が進行方向と逆・画面下向き）
            return { forward: -ay, side: -ax, up: -az };
        case "flat_screen_up_top_front": // 水平置き（上辺が進行方向と逆・画面上向き）
            return { forward: -ay, side: -ax, up: az };
        default:
            return { forward: -az, side: ax, up: -ay };
    }
}

// (既存の startSession 関数)
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

                    // ★★★ 修正箇所: 開始ボタンを非表示にし、終了ボタンを表示 ★★★
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
                alert('記録を終了しました');
                sessionId = null;
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

                // ★★★ 修正箇所: 終了ボタンを非表示にし、開始ボタンを表示 ★★★
                document.getElementById('start-button').style.display = 'block';
                document.getElementById('end-button').style.display = 'none';

            } else {
                alert('記録終了に失敗しました: ' + (data.message || '不明なエラー'));
            }
        })
        .catch(error => {
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
    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc) return;

    const { forward, side, up } = adjustOrientation(acc.x || 0, acc.y || 0, acc.z || 0);

    // forward（前後G）、side（横G）、up（上下G）
    latestGZ = forward / 9.8; // 急加速・急ブレーキ用
    latestGX = side / 9.8;    // 急カーブ用
    latestGY = up / 9.8; 

    document.getElementById('g-x').textContent = latestGX.toFixed(2);
    document.getElementById('g-z').textContent = latestGZ.toFixed(2);
    document.getElementById('g-y').textContent = latestGY.toFixed(2);
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
        // speed_violation: 'purple' // 法定速度チェックがなくなるため、このタイプは使われなくなる
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
    speedViolations = 0; // 使われなくなるが、リセットは残す
    document.getElementById('brake-count').textContent = '0';
    document.getElementById('accel-count').textContent = '0';
    document.getElementById('turn-count').textContent = '0';
    //document.getElementById('violation-count').textContent = '0'; // 使われなくなるが、リセットは残す
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

// Maps_API_KEY と fetchSpeedLimit 関数を削除

let prevSpeed = null, prevLatLng = null, prevTime = null;

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

        // 速度制限の取得と超過判定に関する部分を全て削除
        // UIの速度表示からover-speedクラスを削除
        document.getElementById('speed').classList.remove('over-speed');

        // 急発進、急ブレーキの判定 (GPSの速度変化と加速度センサーのG値から)
        if (prevSpeed !== null && prevTime !== null) {
            const dt = (now - prevTime) / 1000; // 時間差（秒）
            if (dt > 0) {
                const accel = (speed / 3.6 - prevSpeed / 3.6) / dt; // m/s^2
                const gAccel = accel / 9.8; // G単位の加速度

                // 急発進
                if (gAccel > ACCEL_BRAKE_G_THRESHOLD && latestGZ > ACCEL_BRAKE_G_THRESHOLD && now - lastAccelTime > COOLDOWN_MS) {
                    suddenAccels++;
                    document.getElementById('accel-count').textContent = suddenAccels;
                    lastAccelTime = now;
                    addEventMarker(lat, lng, 'sudden_accel');
                    // currentEvent の更新ロジックを簡略化（speed_violationがなくなったため）
                    if (currentEvent === 'normal') {
                        currentEvent = 'sudden_accel';
                    }
                }
                // 急ブレーキ
                if (gAccel < -ACCEL_BRAKE_G_THRESHOLD && latestGZ < -ACCEL_BRAKE_G_THRESHOLD && now - lastBrakeTime > COOLDOWN_MS) {
                    suddenBrakes++;
                    document.getElementById('brake-count').textContent = suddenBrakes;
                    lastBrakeTime = now;
                    addEventMarker(lat, lng, 'sudden_brake');
                    // currentEvent の更新ロジックを簡略化（speed_violationがなくなったため）
                    if (currentEvent === 'normal' || currentEvent === 'sudden_accel') {
                        currentEvent = 'sudden_brake';
                    }
                }
            }
        }

        // 急カーブ判定 (加速度センサーの横Gと速度から)
        if (Math.abs(latestGX) > SHARP_TURN_G_THRESHOLD && speed > 15 && now - lastTurnTime > COOLDOWN_MS) {
            sharpTurns++;
            document.getElementById('turn-count').textContent = sharpTurns;
            lastTurnTime = now;
            addEventMarker(lat, lng, 'sharp_turn');
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
                session_id: sessionId,
                latitude: lat,
                longitude: lng,
                speed: speed,
                g_x: latestGX,
                g_y: latestGY,
                g_z: latestGZ,
                event: currentEvent // イベントタイプは送信を継続
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