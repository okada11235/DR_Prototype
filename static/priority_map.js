// priority_map.js - user_id付きシンプル版（認証チェックなし）
console.log("=== priority_map.js (with user_id) loaded ===");

let map;
let currentLocationMarker = null;
let markers = [];

// ✅ 初期化
export async function initPriorityMap() {
  console.log("✅ initPriorityMap called");

  const mapDiv = document.getElementById("priority-map");
  if (!mapDiv) {
    console.error("❌ #priority-map が見つかりません");
    return;
  }

  // 仮の地図を作成（現在地が取得できるまで東京駅を中心）
  map = new google.maps.Map(mapDiv, {
    center: { lat: 35.681236, lng: 139.767125 },
    zoom: 15,
  });

  // === 現在地取得（初期中心） ===
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setCenter(loc);

        // 現在地マーカー
        currentLocationMarker = new google.maps.Marker({
          position: loc,
          map,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: "#00aaff",
            fillOpacity: 0.9,
            strokeColor: "#fff",
            strokeWeight: 2,
          },
        });

        console.log("📍 地図を現在地に初期化:", loc);
      },
      (err) => {
        console.warn("📍 現在地取得失敗:", err);
        alert("位置情報の取得に失敗しました。ブラウザの設定を確認してください。");
      },
      { enableHighAccuracy: true, timeout: 5000 }
    );

    // 現在地を追跡（マーカーだけ動かす）
    navigator.geolocation.watchPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (currentLocationMarker) {
          currentLocationMarker.setPosition(loc);
        }
      },
      (err) => console.warn("📍 watchPositionエラー:", err),
      { enableHighAccuracy: true }
    );
  } else {
    alert("このブラウザでは位置情報が利用できません。");
  }

  // === Firestoreからピンを読み込み ===
  await loadPins();

  // === クリックでピン追加 ===
  map.addListener("click", async (event) => {
    const lat = event.latLng.lat();
    const lng = event.latLng.lng();
    const confirmAdd = confirm("ここを重点ポイントに設定しますか？");
    if (!confirmAdd) return;

    // ピン追加時
    const userId = window.FLASK_USER_ID || null;

    try {
    const docRef = await firebase.firestore().collection("priority_pins").add({
        lat,
        lng,
        user_id: userId,
        created_at: new Date(),
    });
    console.log("✅ ピン追加:", docRef.id, "user_id:", userId);
    addMarker({ id: docRef.id, lat, lng });
    } catch (err) {
    console.error("❌ Firestore追加エラー:", err);
    }
  });
}

// === Firestoreからピン読み込み ===
async function loadPins() {
  console.log("📥 ピンを読み込み中...");
  try {
    const snapshot = await firebase.firestore().collection("priority_pins").get();
    snapshot.forEach((doc) => {
      const data = doc.data();
      addMarker({
        id: doc.id,
        lat: data.lat,
        lng: data.lng,
      });
    });
    console.log(`📍 ${snapshot.size}件のピンを読み込み完了`);
  } catch (err) {
    console.error("❌ ピン読み込み失敗:", err);
  }
}

// === ピン追加 ===
function addMarker(pin) {
  const marker = new google.maps.Marker({
    position: { lat: pin.lat, lng: pin.lng },
    map,
    icon: {
      url: "https://maps.google.com/mapfiles/ms/icons/yellow-dot.png",
    },
  });

  marker.addListener("click", async () => {
    const confirmDel = confirm("このピンを削除しますか？");
    if (!confirmDel) return;

    try {
      await firebase.firestore().collection("priority_pins").doc(pin.id).delete();
      marker.setMap(null);
      console.log(`🗑️ ピン削除: ${pin.id}`);
    } catch (err) {
      console.error("❌ ピン削除エラー:", err);
    }
  });

  markers.push(marker);
}
