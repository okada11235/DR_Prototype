// maps.js - Google Maps関連機能

// GPS位置情報取得とマップ表示のみに特化

console.log('=== maps.js LOADED ===');

// 地図初期化
export function initMap() {
    const mapDiv = document.getElementById('map');
    if (!mapDiv) {
        console.warn('Map container (#map) not found. Skipping map init.');
        return;
    }
    window.path = [];

    if (window.map) {
        window.polyline.setPath([]);
        if (window.currentPositionMarker) window.currentPositionMarker.setMap(null);
        window.eventMarkers.forEach(marker => marker.setMap(null));
        window.eventMarkers = [];
    } else {
        window.map = new google.maps.Map(mapDiv, { zoom: 16, center: { lat: 35.681236, lng: 139.767125 } });
        window.polyline = new google.maps.Polyline({
            path: [],
            geodesic: true,
            strokeColor: '#007bff',
            strokeOpacity: 1.0,
            strokeWeight: 4,
            map: window.map
        });
        window.currentPositionMarker = new google.maps.Marker({
            position: { lat: 35.681236, lng: 139.767125 },
            map: window.map,
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
        window.map.setCenter(userLatLng);
        window.currentPositionMarker.setPosition(userLatLng);
    }, () => {
        console.warn("Geolocation permission denied or error. Using default map center.");
    });
}

// イベントマーカー追加
export function addEventMarker(lat, lng, type) {
    const colors = {
        sudden_brake: 'red',
        sudden_accel: 'green',
        sharp_turn: 'orange'
    };
    const marker = new google.maps.Marker({
        position: { lat, lng },
        map: window.map,
        icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 6,
            fillColor: colors[type] || 'gray',
            fillOpacity: 1,
            strokeWeight: 1,
            strokeColor: '#000'
        }
    });
    window.eventMarkers.push(marker);
}

export function watchPosition() {
    console.log('Starting GPS position watch...');
    if (!window.sessionId) {
        console.error("No sessionId! GPS log will not be saved");
    }
    window.watchId = navigator.geolocation.watchPosition(async position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const currentLatLng = { lat, lng };
        const speed = position.coords.speed !== null ? position.coords.speed * 3.6 : 0; // km/h
        const now = Date.now();

        console.log(`GPS position received: lat=${lat}, lng=${lng}, speed=${speed}, accuracy=${position.coords.accuracy}, sessionId=${window.sessionId || 'none'}`);

        const speedElement = document.getElementById('speed');
        if (speedElement) speedElement.textContent = speed.toFixed(1);
        const positionElement = document.getElementById('position');
        if (positionElement) positionElement.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

        if (window.currentPositionMarker && typeof google !== 'undefined') {
            window.currentPositionMarker.setPosition(currentLatLng);
            if (window.map) window.map.setCenter(currentLatLng);
        } else if (typeof google !== 'undefined' && window.map) {
            window.currentPositionMarker = new google.maps.Marker({
                position: currentLatLng,
                map: window.map,
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

        // 現在の速度をセンサーシステムに提供
        window.latestSpeed = speed;
        window.currentSpeed = speed;  // ★ sensors.js 判定用に追加
        
        // イベント情報はセンサーシステムから取得
        let currentEvent = window.currentDrivingEvent || 'normal';
        // イベントリセット
        window.currentDrivingEvent = 'normal';

        // 位置情報をパスに追加（Google Maps の有無に関係なく）
        window.path.push({ lat, lng });
        console.log(`Path updated: ${window.path.length} points, latest: lat=${lat.toFixed(5)}, lng=${lng.toFixed(5)}`);
        
        // Google Maps が利用可能な場合はポリラインも更新
        if (typeof google !== 'undefined') {
            if (window.polyline) window.polyline.setPath(window.path);
        }

        if (window.sessionId) {
            const gpsData = {
                timestamp: now,
                latitude: lat,
                longitude: lng,
                speed: speed,
                g_x: window.latestGX || 0,
                g_y: window.latestGY || 0,
                g_z: window.latestGZ || 0,
                event: currentEvent || 'normal'
            };
            window.gpsLogBuffer.push(gpsData);
            console.log(`GPS data added to buffer for session ${window.sessionId}:`, gpsData);
            console.log(`Buffer sizes -> GPS: ${window.gpsLogBuffer.length}, G: ${window.gLogBuffer.length}`);
        } else {
            console.log(`GPS position received (display only): lat=${lat.toFixed(5)}, lng=${lng.toFixed(5)}, speed=${speed.toFixed(1)}`);
        }

        window.prevLatLng = currentLatLng;
        window.prevSpeed = speed;
        window.prevTime = now;

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

export function calculateDistance(path) {
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

// === 📍 音声ピン・手動ピン追加（統合版） ===
window.addVoicePin = async function(lat, lng) {
  if (!window.map) return;

  // 地図に青ピンを追加
  new google.maps.Marker({
    position: { lat, lng },
    map: window.map,
    icon: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
  });

  // ✅ Flask経由でpinsコレクションに保存
  try {
    const res = await fetch("/api/add_voice_pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng, label: "" }),
    });
    const result = await res.json();
    if (result.status === "success") {
      console.log("✅ ピンをpinsコレクションに保存しました");
    } else {
      console.warn("⚠️ ピン保存失敗:", result.error);
    }
  } catch (e) {
    console.error("❌ サーバー保存エラー:", e);
  }
};
