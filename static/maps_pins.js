// static/js/maps_pins.js
console.log("=== maps_pins.js loaded ===");

let map;
let tempMarker = null;
let selectedLatLng = null;
let pinMarkers = []; // ← 追加：既存ピンを管理

// === 地図初期化 ===
function initMap() {
  console.log("✅ initMap called (pins editor)");

  // 一旦デフォルト座標（東京駅）で地図を仮描画
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 35.681236, lng: 139.767125 },
    zoom: 15,
  });

  // ✅ 現在地を取得して地図を移動
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const userLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        console.log("📍 現在地を取得:", userLocation);
        map.setCenter(userLocation);

        // 現在地マーカーを表示（青丸）
        new google.maps.Marker({
          position: userLocation,
          map,
          title: "あなたの現在地",
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: "#00aaff",
            fillOpacity: 0.9,
            strokeColor: "#fff",
            strokeWeight: 2
          }
        });
      },
      (error) => {
        console.warn("⚠️ 位置情報の取得に失敗:", error.message);
        alert("現在地を取得できませんでした。位置情報の許可を確認してください。");
      }
    );
  } else {
    alert("このブラウザは位置情報取得に対応していません。");
  }

  // 🔹 Firestoreから既存ピンを取得（従来通り）
  fetch("/api/get_pins")
    .then(res => res.json())
    .then(data => {
      if (data.pins) {
        console.log(`📍 ${data.pins.length} pins loaded`);
        data.pins.forEach(pin => {
          const marker = new google.maps.Marker({
            position: { lat: pin.lat, lng: pin.lng },
            map,
            title: pin.label || "(無題のピン)",
            icon: "http://maps.google.com/mapfiles/ms/icons/red-dot.png"
          });

          // ピン削除機能そのまま
          marker.addListener("click", () => showPinInfo(marker, pin));
        });
      }
    })
    .catch(err => console.error("❌ Failed to load pins:", err));

  // 🔹 地図クリックで仮ピンを設置
  map.addListener("click", (e) => {
    if (tempMarker) tempMarker.setMap(null);
    selectedLatLng = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    tempMarker = new google.maps.Marker({
      position: selectedLatLng,
      map,
      icon: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png"
    });
    console.log(`🟦 Temporary pin placed at: ${selectedLatLng.lat}, ${selectedLatLng.lng}`);
  });
}


// === ピン詳細・削除ボタンを表示 ===
function showPinInfo(marker, pin) {
  const infoWindow = new google.maps.InfoWindow({
    content: `
      <div style="min-width:180px;">
        <label>ピン名:</label><br>
        <input id="pinLabelInput" type="text" value="${pin.label || ''}" style="width:140px;"><br>
        <label style="margin-top:5px;display:inline-block;">
          <input type="checkbox" id="speakToggle" ${pin.speak_enabled ? 'checked' : ''}>
          読み上げON
        </label><br>
        <button id="savePinEditBtn" style="margin-top:5px;background:#4caf50;color:white;border:none;padding:3px 8px;border-radius:4px;">保存</button>
        <button id="deletePinBtn" style="margin-top:5px;background:red;color:white;border:none;padding:3px 8px;border-radius:4px;">削除</button>
      </div>
    `
  });
  infoWindow.open(map, marker);

  // InfoWindow内のボタン制御
  google.maps.event.addListenerOnce(infoWindow, "domready", () => {
    const input = document.getElementById("pinLabelInput");
    const toggle = document.getElementById("speakToggle");

    // 🔹 編集保存
    document.getElementById("savePinEditBtn").addEventListener("click", async () => {
      const newLabel = input.value.trim();
      const speakEnabled = toggle.checked;
      const res = await fetch("/api/update_pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: pin.id, label: newLabel, speak_enabled: speakEnabled })
      });
      const result = await res.json();
      if (result.status === "success") {
        alert("ピンを更新しました。");
        marker.setTitle(newLabel);
        infoWindow.close();
      } else {
        alert("更新に失敗しました: " + result.error);
      }
    });

    // 🔹 削除
    document.getElementById("deletePinBtn").addEventListener("click", async () => {
      const confirmDelete = confirm("このピンを削除しますか？");
      if (!confirmDelete) return;

      const res = await fetch("/api/delete_pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: pin.id })
      });
      const result = await res.json();

      if (result.status === "success") {
        alert("ピンを削除しました。");
        marker.setMap(null);
        infoWindow.close();
      } else {
        alert("削除に失敗しました: " + result.error);
      }
    });
  });
}


// ✅ Google Maps APIのcallbackで呼べるようにグローバル登録
window.initMap = initMap;

// === ピン保存処理 ===
document.getElementById("savePinBtn").addEventListener("click", async () => {
  if (!selectedLatLng) {
    alert("地図をクリックしてピンの位置を選択してください。");
    return;
  }

  const label = document.getElementById("pinLabel").value || "(無題のピン)";
  const res = await fetch("/api/save_pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...selectedLatLng, label })
  });

  const result = await res.json();
  if (result.status === "success") {
    alert("ピンを保存しました！");
    location.reload();
  } else {
    alert("保存に失敗しました: " + result.error);
  }
});

// maps_pins.js に追加
fetch(`/api/get_voice_pins?session_id=${sessionId}`)
  .then(res => res.json())
  .then(data => {
    data.pins.forEach(pin => {
      const marker = new google.maps.Marker({
        position: { lat: pin.lat, lng: pin.lng },
        map,
        icon: pin.confirmed
          ? "http://maps.google.com/mapfiles/ms/icons/red-dot.png"
          : "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
        title: pin.label || "(未入力ピン)"
      });

      if (!pin.confirmed) {
        const info = new google.maps.InfoWindow({
          content: `
            <div>
              <input type="text" id="memo_${pin.id}" placeholder="メモ内容を入力">
              <button onclick="confirmVoicePin('${pin.id}')">確定</button>
            </div>`
        });
        marker.addListener("click", () => info.open(map, marker));
      }
    });
  });

async function confirmVoicePin(pinId) {
  const memo = document.getElementById(`memo_${pinId}`).value.trim();
  const res = await fetch("/api/confirm_voice_pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: pinId, label: memo, confirmed: true })
  });
  const result = await res.json();
  if (result.status === "success") alert("✅ ピンを確定しました！");
}
