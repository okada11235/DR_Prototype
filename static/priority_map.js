console.log("=== priority_map.js (with user_id) loaded ===");

// ✅ グローバル関数として定義
async function initPriorityMap() {
  console.log("✅ initPriorityMap called");

  const mapDiv = document.getElementById("priority-map");
  if (!mapDiv) {
    console.error("❌ #priority-map が見つかりません");
    return;
  }

  // 仮の地図を作成（現在地が取得できるまで東京駅を中心）
  const map = new google.maps.Map(mapDiv, {
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
        new google.maps.Marker({
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
  } else {
    alert("このブラウザでは位置情報が利用できません。");
  }

  // === Firestoreからピンを読み込み ===
  await loadPins(map);

  // === ルート（最新）を描画 ===
  try {
    await drawLatestRoute(map);
  } catch (e) {
    console.warn('ルート描画に失敗:', e);
  }

  // === クリックでピン追加 ===
  map.addListener("click", async (event) => {
    const lat = event.latLng.lat();
    const lng = event.latLng.lng();
    const confirmAdd = confirm("ここを重点ポイントに設定しますか？");
    if (!confirmAdd) return;

    const userId = window.FLASK_USER_ID || null;

    try {
      const docRef = await firebase.firestore().collection("priority_pins").add({
        lat,
        lng,
        user_id: userId,
        created_at: new Date(),
      });
      console.log("✅ ピン追加:", docRef.id, "user_id:", userId);
      addMarker(map, { id: docRef.id, lat, lng });
    } catch (err) {
      console.error("❌ Firestore追加エラー:", err);
    }
  });
}

// === Firestoreからピン読み込み ===
async function loadPins(map) {
  console.log("📥 ピンを読み込み中...");
  try {
    const userId = window.FLASK_USER_ID || localStorage.getItem('CURRENT_USER_ID') || null;
    const query = userId
      ? firebase.firestore().collection("priority_pins").where("user_id", "==", userId)
      : firebase.firestore().collection("priority_pins");
    const snapshot = await query.get();
    snapshot.forEach((doc) => {
      const data = doc.data();
      addMarker(map, {
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
function addMarker(map, pin) {
  const marker = new google.maps.Marker({
    position: { lat: pin.lat, lng: pin.lng },
    map,
    icon: { url: "https://maps.google.com/mapfiles/ms/icons/yellow-dot.png" },
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
}

// === 最新のルートを読み込んで描画 ===
async function drawLatestRoute(map) {
  const userId = window.FLASK_USER_ID || localStorage.getItem('CURRENT_USER_ID') || null;
  const routesCol = firebase.firestore().collection('priority_routes');

  let routeDoc = null;
  if (userId) {
    // ⚠️ where + orderBy の複合はインデックスが必要になるため、ここでは where のみで取得→JS側で最新決定
    const qs = await routesCol.where('user_id', '==', userId).get();
    if (qs.empty) {
      console.log('🔍 このユーザーのルートが見つかりません');
      return;
    }
    // updated_at が最も新しいものを選ぶ（なければ created_at）
    routeDoc = qs.docs.reduce((latest, d) => {
      const data = d.data();
      const curTs = (data.updated_at?.toMillis?.() ? data.updated_at.toMillis() : (data.updated_at?.getTime?.() || 0))
                 || (data.created_at?.toMillis?.() ? data.created_at.toMillis() : (data.created_at?.getTime?.() || 0));
      if (!latest) return { doc: d, ts: curTs };
      return curTs > latest.ts ? { doc: d, ts: curTs } : latest;
    }, null)?.doc || null;
  } else {
    // ユーザー絞りなしで最新1件（orderByのみはインデックス不要）
    const qs = await routesCol.orderBy('updated_at', 'desc').limit(1).get();
    if (qs.empty) {
      console.log('🔍 ルートが見つかりません');
      return;
    }
    routeDoc = qs.docs[0];
  }

  if (!routeDoc) {
    console.log('🔍 ルートが選定できませんでした');
    return;
  }

  const routeId = routeDoc.id;
  console.log('🧭 描画対象ルート:', routeId);

  // 点群取得（timestamp_ms 昇順）
  const ptsSnap = await routesCol.doc(routeId).collection('points')
    .orderBy('timestamp_ms')
    .get();
  const pts = [];
  ptsSnap.forEach(d => {
    const o = d.data();
    if (o.lat != null && o.lng != null) pts.push({ lat: o.lat, lng: o.lng });
  });
  if (pts.length === 0) {
    console.log('ℹ️ ルート点群がまだありません');
    return;
  }

  // ポリライン描画
  new google.maps.Polyline({
    path: pts,
    geodesic: true,
    strokeColor: '#ff6f00',
    strokeOpacity: 0.9,
    strokeWeight: 5,
    map,
  });

  // スタート/ゴール
  const start = pts[0];
  const goal = pts[pts.length - 1];
  new google.maps.Marker({
    position: start,
    map,
    label: { text: 'S', color: '#fff', fontWeight: 'bold' },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: '#2e7d32',
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2,
    }
  });
  new google.maps.Marker({
    position: goal,
    map,
    label: { text: 'G', color: '#fff', fontWeight: 'bold' },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: '#c62828',
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2,
    }
  });

  // ビューポート調整
  if (pts.length === 1) {
    map.setCenter(start);
    map.setZoom(17);
  } else {
    const bounds = new google.maps.LatLngBounds();
    pts.forEach(p => bounds.extend(new google.maps.LatLng(p.lat, p.lng)));
    map.fitBounds(bounds);
  }
}

// 念のためグローバル公開
window.initPriorityMap = initPriorityMap;
