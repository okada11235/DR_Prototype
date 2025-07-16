// script.js - 修正バージョン

let sessionId = null;
let timerInterval = null;
let startTime = null;
let watchId = null;
let map, polyline, path = [];

let suddenBrakes = 0;
let suddenAccels = 0;
let sharpTurns = 0;
let speedViolations = 0;

// クールダウン時間管理
let lastBrakeTime = 0;
let lastAccelTime = 0;
let lastTurnTime = 0;
const cooldownMs = 1000;

function startSession() {
    requestMotionPermission(() => {
        startMotionDetection();
        fetch('/start', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                sessionId = data.session_id;
                document.getElementById('session_id').textContent = sessionId;
                startTime = Date.now();
                startTimer();
                path = [];
                initMap();
                watchPosition();
                resetCounters();
                alert('記録を開始しました');
            });
    });
}

function requestMotionPermission(callback) {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
            .then(response => {
                if (response === 'granted') {
                    callback();
                } else {
                    alert('加速度センサーの使用が許可されませんでした。');
                }
            })
            .catch(err => {
                console.error('加速度センサーの許可リクエスト中にエラー:', err);
                alert('加速度センサーの使用許可リクエストでエラーが発生しました。');
            });
    } else {
        callback();
    }
}

function endSession() {
    if (!sessionId) {
        alert('まだ記録が開始されていません');
        return;
    }

    stopTimer();
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);

    const distance = calculateDistance(path);

    const data = {
        session_id: sessionId,
        distance,
        sudden_accels: suddenAccels,
        sudden_brakes: suddenBrakes,
        sharp_turns: sharpTurns,
        stability: 0.9,
        speed_violations: speedViolations
    };

    fetch('/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(res => res.json())
      .then(res => {
          if (res.status === 'ok') {
              alert('記録を終了しました');
              sessionId = null;
              document.getElementById('session_id').textContent = '未開始';
              document.getElementById('speed').textContent = '0';
              document.getElementById('timer').textContent = '00:00';
          } else {
              alert("エラー：" + res.message);
          }
      });
}

function deleteSession() {
    if (!sessionId) {
        alert("削除する記録がありません");
        return;
    }

    fetch(`/delete/${sessionId}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(res => {
            if (res.status === 'ok') {
                alert('記録を削除しました');
                sessionId = null;
                document.getElementById('session_id').textContent = '未開始';
                document.getElementById('speed').textContent = '0';
                document.getElementById('timer').textContent = '00:00';
            } else {
                alert("削除エラー：" + res.message);
            }
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

function startMotionDetection() {
    if (window.DeviceMotionEvent) {
        window.addEventListener('devicemotion', (event) => {
            const now = Date.now();
            const acc = event.acceleration || event.accelerationIncludingGravity;
            if (!acc) return;

            const x = acc.x || 0;
            const y = acc.y || 0;

            if (y < -8 && now - lastBrakeTime > cooldownMs) {
                suddenBrakes++;
                lastBrakeTime = now;
                document.getElementById('brake-count').textContent = suddenBrakes;
            }

            if (y > 8 && now - lastAccelTime > cooldownMs) {
                suddenAccels++;
                lastAccelTime = now;
                document.getElementById('accel-count').textContent = suddenAccels;
            }

            if (Math.abs(x) > 8 && now - lastTurnTime > cooldownMs) {
                sharpTurns++;
                lastTurnTime = now;
                document.getElementById('turn-count').textContent = sharpTurns;
            }
        });
    } else {
        alert("この端末は加速度センサーに対応していません");
    }
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

function initMap() {
    const mapDiv = document.getElementById('map');

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(position => {
            const userLatLng = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };
            map = new google.maps.Map(mapDiv, {
                zoom: 16,
                center: userLatLng
            });

            // もしルート表示（Polyline）があればここで初期化
            path = [];
            polyline = new google.maps.Polyline({
                path: path,
                geodesic: true,
                strokeColor: '#007bff',
                strokeOpacity: 1.0,
                strokeWeight: 4,
                map: map
            });

        }, error => {
            console.error("現在地の取得に失敗:", error);
            // 失敗した場合はデフォルトの座標で初期化
            map = new google.maps.Map(mapDiv, {
                zoom: 16,
                center: { lat: 35.681236, lng: 139.767125 }
            });
        });
    } else {
        alert('このブラウザは位置情報に対応していません');
    }
}

function watchPosition() {
    if (!navigator.geolocation) {
        alert('位置情報に対応していません');
        return;
    }
    watchId = navigator.geolocation.watchPosition(position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const speed = position.coords.speed !== null ? (position.coords.speed * 3.6).toFixed(1) : '0';

        document.getElementById('speed').textContent = speed;
        document.getElementById('position').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

        if (sessionId) {
            path.push({ lat, lng });
            polyline.setPath(path);

            fetch('/log_gps', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId, latitude: lat, longitude: lng })
            });
        }
    }, error => {
        console.error(error);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 });
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function calculateDistance(path) {
    let distance = 0;
    for (let i = 1; i < path.length; i++) {
        const prev = path[i - 1];
        const curr = path[i];
        distance += haversine(prev.lat, prev.lng, curr.lat, curr.lng);
    }
    return distance;
}