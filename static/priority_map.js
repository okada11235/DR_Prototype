
console.log("=== priority_map.js (label編集＋S/G描画対応版) loaded ===");

window._displayedPins = [];

async function initPriorityMap() {
  console.log("✅ initPriorityMap called");

  const mapDiv = document.getElementById("priority-map");
  if (!mapDiv) {
    console.error("❌ #priority-map が見つかりません");
    return;
  }

  const map = new google.maps.Map(mapDiv, {
    center: { lat: 35.681236, lng: 139.767125 },
    zoom: 15,
  });

  window._priorityMapInstance = map;

  // === 現在地取得 ===
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setCenter(loc);
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
      },
      (err) => console.warn("📍 現在地取得失敗:", err),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  }


  // === ピン追加 ===
  map.addListener("click", async (event) => {
    const lat = event.latLng.lat();
    const lng = event.latLng.lng();
    const confirmAdd = confirm("ここを重点ポイントに設定しますか？");
    if (!confirmAdd) return;

    const label = prompt("この地点のラベル名を入力してください:", "交差点手前");
    if (label === null) return;

    // 🎯 focus_type選択（新規追加）
    const focusOptions = [
      { key: "brake_soft", name: "穏やかな減速" },
      { key: "accel_smooth", name: "滑らかな発進" },
      { key: "turn_stability", name: "カーブの安定性" },
      { key: "smooth_overall", name: "直進の安定性" },
      { key: "stop_smooth", name: "停止直前の滑らかさ" },
      { key: "speed_consistency", name: "一定速度の維持" }
    ];

    let focusMenu = "意識するポイントを選んでください：\n";
    focusOptions.forEach((opt, i) => {
      focusMenu += `${i + 1}. ${opt.name}\n`;
    });

    const choice = prompt(focusMenu, "1");
    if (!choice || isNaN(choice) || choice < 1 || choice > focusOptions.length) {
      alert("⚠️ 有効な番号を選んでください。");
      return;
    }
    const selectedFocus = focusOptions[choice - 1];

    const userId = window.FLASK_USER_ID || localStorage.getItem("CURRENT_USER_ID");
    try {
      const currentRouteId = localStorage.getItem("CURRENT_ROUTE_ID");
      const docRef = await firebase.firestore().collection("priority_pins").add({
        lat,
        lng,
        label,
        focus_type: selectedFocus.key,
        focus_label: selectedFocus.name,
        user_id: userId,
        route_id: currentRouteId,
        created_at: new Date(),
      });
      console.log("✅ ピン追加:", label, selectedFocus.name);
      addMarker(map, {
        id: docRef.id,
        lat,
        lng,
        label,
        focus_type: selectedFocus.key,
        focus_label: selectedFocus.name,
      });
    } catch (err) {
      console.error("❌ Firestore追加エラー:", err);
    }
  });
}

// === ピン読み込み ===
async function loadPins(map) {
  console.log("📥 ピンを読み込み中...");

  // 🔥 まず古いピンを全消去
  if (window._displayedPins && window._displayedPins.length > 0) {
    window._displayedPins.forEach(m => m.setMap(null));
    window._displayedPins = [];
  }

  const userId = window.FLASK_USER_ID || localStorage.getItem("CURRENT_USER_ID");
  const routeId = localStorage.getItem("CURRENT_ROUTE_ID");

  if (!routeId) {
    console.warn("❌ CURRENT_ROUTE_ID がありません");
    return;
  }

  const snapshot = await firebase.firestore()
      .collection("priority_pins")
      .where("user_id", "==", userId)
      .where("route_id", "==", routeId)
      .get();

  snapshot.forEach(doc => {
    const d = doc.data();
    addMarker(map, {
      id: doc.id,
      lat: d.lat,
      lng: d.lng,
      label: d.label || "(無題)",
      focus_type: d.focus_type,
      focus_label: d.focus_label
    });
  });

  console.log(`📍 ${snapshot.size}件のピンを読み込み完了`);
}

// === ピンだけを全て消す ===
function clearPins() {
  if (window._displayedPins && window._displayedPins.length > 0) {
    window._displayedPins.forEach(m => m.setMap(null));
  }
  window._displayedPins = [];
  console.log("🧹 すべての重点ポイントピンを消去しました");
}

// どこからでも呼べるように global へ
window.clearPins = clearPins;

// === ピン追加（編集＋削除） ===
function addMarker(map, pin) {

  // 🔥 追加：focus_type → 日本語名 変換表
  const focusNames = {
    "brake_soft": "穏やかな減速",
    "accel_smooth": "滑らかな発進",
    "turn_stability": "カーブの安定性",
    "smooth_overall": "直進の安定性",
    "stop_smooth": "停止直前の滑らかさ",
    "speed_consistency": "一定速度の維持"
  };

  const marker = new google.maps.Marker({
    position: { lat: pin.lat, lng: pin.lng },
    map,
    icon: { url: "https://maps.google.com/mapfiles/ms/icons/yellow-dot.png" },
  });

  const info = new google.maps.InfoWindow({
    content: `
      <div style="font-size:14px;">
        <label>ラベル：</label><br>
        <input id="label-${pin.id}" type="text" value="${pin.label || ""}"
              style="width:140px;padding:4px;margin-top:4px;border:1px solid #ccc;border-radius:4px;"><br>

        <label>意識ポイント：</label><br>
        <select id="focus-${pin.id}" style="width:150px;padding:4px;margin-top:4px;border:1px solid #ccc;border-radius:4px;">
          <option value="brake_soft" ${pin.focus_type === "brake_soft" ? "selected" : ""}>穏やかな減速</option>
          <option value="accel_smooth" ${pin.focus_type === "accel_smooth" ? "selected" : ""}>滑らかな発進</option>
          <option value="turn_stability" ${pin.focus_type === "turn_stability" ? "selected" : ""}>カーブの安定性</option>
          <option value="smooth_overall" ${pin.focus_type === "smooth_overall" ? "selected" : ""}>直進の安定性</option>
          <option value="stop_smooth" ${pin.focus_type === "stop_smooth" ? "selected" : ""}>停止直前の滑らかさ</option>
          <option value="speed_consistency" ${pin.focus_type === "speed_consistency" ? "selected" : ""}>一定速度の維持</option>
        </select><br>

        <button id="save-${pin.id}" style="background:#4CAF50;color:#fff;border:none;border-radius:4px;padding:4px 8px;margin-top:6px;">💾 保存</button>
        <button id="delete-${pin.id}" style="background:#f55;color:#fff;border:none;border-radius:4px;padding:4px 8px;margin-top:6px;margin-left:4px;">🗑️ 削除</button>
      </div>`,
  });

  marker.addListener("click", () => {
    info.open(map, marker);
    setTimeout(() => {
      const saveBtn = document.getElementById(`save-${pin.id}`);
      const delBtn = document.getElementById(`delete-${pin.id}`);
      const labelInput = document.getElementById(`label-${pin.id}`);

      if (saveBtn && labelInput) {
        saveBtn.addEventListener("click", async () => {
          const newLabel = labelInput.value.trim();
          const newFocus = document.getElementById(`focus-${pin.id}`).value;

          if (!newLabel) return alert("ラベルを入力してください。");

          // 🔥 Firestore の更新（focus_label を追加）
          await firebase.firestore().collection("priority_pins").doc(pin.id).update({
            label: newLabel,
            focus_type: newFocus,
            focus_label: focusNames[newFocus]  // ← ★ これが必要！
          });

          alert("✅ ピン情報を更新しました。");
          info.close();

          // 🔄 再描画
          if (window.clearPins) clearPins();
          await loadPins(map);
        });
      }

      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          if (!confirm(`「${pin.label}」を削除しますか？`)) return;
          await firebase.firestore().collection("priority_pins").doc(pin.id).delete();
          marker.setMap(null);
          info.close();
        });
      }
    }, 200);
  });

  window._displayedPins.push(marker);
}

// === ルート描画（S/G付き） ===
async function drawLatestRoute(map) {
  const userId = window.FLASK_USER_ID || localStorage.getItem("CURRENT_USER_ID");
  const routesCol = firebase.firestore().collection("priority_routes");
  const qs = await routesCol.where("user_id", "==", userId).get();
  if (qs.empty) return;

  const latestDoc = qs.docs.reduce((latest, d) => {
    const data = d.data();
    const ts = data.updated_at?.toMillis?.() || data.created_at?.toMillis?.() || 0;
    if (!latest) return { doc: d, ts };
    return ts > latest.ts ? { doc: d, ts } : latest;
  }, null)?.doc;
  if (!latestDoc) return;

  const ptsSnap = await routesCol.doc(latestDoc.id).collection("points").orderBy("timestamp_ms").get();
  const pts = [];
  ptsSnap.forEach((d) => {
    const p = d.data();
    if (p.lat && p.lng) pts.push({ lat: p.lat, lng: p.lng });
  });
  if (pts.length === 0) return;

  // 線を描画
  new google.maps.Polyline({
    path: pts,
    geodesic: true,
    strokeColor: "#ff6f00",
    strokeOpacity: 0.9,
    strokeWeight: 5,
    map,
  });

  // スタートとゴールマーカー
  const start = pts[0];
  const goal = pts[pts.length - 1];
  new google.maps.Marker({
    position: start,
    map,
    label: { text: "S", color: "#fff", fontWeight: "bold" },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: "#2e7d32",
      fillOpacity: 1,
      strokeColor: "#fff",
      strokeWeight: 2,
    },
  });
  new google.maps.Marker({
    position: goal,
    map,
    label: { text: "G", color: "#fff", fontWeight: "bold" },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: "#c62828",
      fillOpacity: 1,
      strokeColor: "#fff",
      strokeWeight: 2,
    },
  });

  // ビューポート調整
  const bounds = new google.maps.LatLngBounds();
  pts.forEach((p) => bounds.extend(p));
  map.fitBounds(bounds);
}

window.initPriorityMap = initPriorityMap;

// === 前回運転したルートを自動選択して表示する ===
document.addEventListener("DOMContentLoaded", async () => {
  const lastRouteId = localStorage.getItem("LAST_USED_ROUTE_ID");
  if (!lastRouteId) return;

  console.log("📌 前回のルートを自動選択:", lastRouteId);

  // セレクトボックスが存在する場合は選択状態にする
  const selectEl = document.getElementById("route-select");
  if (selectEl) {
    selectEl.value = lastRouteId;
  }

  // 現在のルートIDとして設定
  localStorage.setItem("CURRENT_ROUTE_ID", lastRouteId);
  window._selectedRouteId = lastRouteId;

  // 地図インスタンスが準備されるまで待つ
  const waitMap = () =>
    new Promise(resolve => {
      const check = () => {
        if (window._priorityMapInstance) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  await waitMap();

  const map = window._priorityMapInstance;

  // ルート描画
  await drawRouteById(map, lastRouteId);

  // ピン表示
  await loadPins(map);
});


// === 表示中のルート／マーカーを保持する配列（グローバル） ===
if (!window._displayedRoutes) window._displayedRoutes = [];

// === 現在表示しているルート要素をすべて削除する関数 ===
function clearDisplayedRoutes() {
  try {
    if (!window._displayedRoutes || window._displayedRoutes.length === 0) return;
    window._displayedRoutes.forEach(obj => {
      // obj は Polyline や Marker のインスタンスのはず
      if (obj && typeof obj.setMap === "function") {
        obj.setMap(null);
      }
    });
  } catch (e) {
    console.warn("clearDisplayedRoutes error:", e);
  } finally {
    window._displayedRoutes = [];
  }
}

async function drawRouteById(map, routeId) {
  // 先に既存描画要素をクリア
  clearDisplayedRoutes();

  const routesCol = firebase.firestore().collection("priority_routes");
  const docRef = routesCol.doc(routeId);
  const docSnap = await docRef.get();
  if (!docSnap.exists) {
    console.warn("❌ 指定ルートが存在しません:", routeId);
    return;
  }

  const ptsSnap = await docRef.collection("points").orderBy("timestamp_ms").get();
  const pts = [];
  ptsSnap.forEach((d) => {
    const p = d.data();
    if (p.lat !== undefined && p.lng !== undefined) pts.push({ lat: p.lat, lng: p.lng });
  });
  if (pts.length === 0) {
    console.warn("❌ ルートにポイントがありません:", routeId);
    return;
  }

  // ルート線を作成して地図に追加
  const polyline = new google.maps.Polyline({
    path: pts,
    geodesic: true,
    strokeColor: "#1E88E5",
    strokeOpacity: 0.9,
    strokeWeight: 5,
    map,
  });

  // S/G マーカー
  const start = pts[0];
  const goal = pts[pts.length - 1];
  const startMarker = new google.maps.Marker({
    position: start,
    map,
    label: { text: "S", color: "#fff", fontWeight: "bold" },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: "#2e7d32",
      fillOpacity: 1,
      strokeColor: "#fff",
      strokeWeight: 2,
    },
  });
  const goalMarker = new google.maps.Marker({
    position: goal,
    map,
    label: { text: "G", color: "#fff", fontWeight: "bold" },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: "#c62828",
      fillOpacity: 1,
      strokeColor: "#fff",
      strokeWeight: 2,
    },
  });

  // 表示範囲を自動調整
  const bounds = new google.maps.LatLngBounds();
  pts.forEach((p) => bounds.extend(p));
  map.fitBounds(bounds);

  // 描画した要素をグローバル配列に保存（次回クリア用）
  window._displayedRoutes = [polyline, startMarker, goalMarker];

  console.log(`✅ ルート「${routeId}」を描画しました`);
}

// グローバルに選択中ルートIDを保持
window._selectedRouteId = null;

function onRouteSelected(routeId) {
  if (!routeId) {
    window._selectedRouteId = null;
    const startBtn = document.getElementById("start-driving-btn");
    if (startBtn) startBtn.disabled = true;
    return;
  }

  window._selectedRouteId = routeId;
  localStorage.setItem("CURRENT_ROUTE_ID", routeId); // 🔸 センサー側でも参照可能に
  console.log("✅ 選択中ルート:", routeId);

  // 運転開始ボタンがある場合は有効化
  const startBtn = document.getElementById("start-driving-btn");
  if (startBtn) startBtn.disabled = false;

  // ===========================
// 🚗 運転開始機能（既存ルート選択）
// ===========================

// 選択中ルートIDをグローバルで保持
window.selectedRouteId = null;

// 地図上でルートクリック時に選択できるようにする
function enableRouteSelection() {
  if (!window.displayedRoutes) return;
  for (const routeId in window.displayedRoutes) {
    const polyline = window.displayedRoutes[routeId];
    polyline.addListener("click", () => {
      // 前回選択ルートのスタイルを戻す
      for (const rId in window.displayedRoutes) {
        window.displayedRoutes[rId].setOptions({ strokeColor: "#0000ff", strokeWeight: 4 });
      }
      // 選択ルートを強調表示
      polyline.setOptions({ strokeColor: "#ff0000", strokeWeight: 6 });
      window.selectedRouteId = routeId;
      console.log("✅ ルート選択:", routeId);
    });
  }
}

// 初期化時に選択機能を有効化
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(enableRouteSelection, 1500); // ルート描画後に実行
});

// ===========================
// 🚀 運転開始ボタン連携
// ===========================

document.getElementById("startDrivingBtn")?.addEventListener("click", async () => {
  if (!window.selectedRouteId) {
    alert("運転するルートを選択してください。");
    return;
  }

  // ここで選択したルートを localStorage に保存
  localStorage.setItem("SELECTED_ROUTE_ID", window.selectedRouteId);

  // もし route_recorder.js のAPIを使う場合：
  try {
    ensureFirebaseInitialized();
    console.log("🚗 運転開始: ルートID =", window.selectedRouteId);
    alert("選択したルートで運転を開始します。");
    // ここに運転開始時の処理を追加（例：ナビ画面へ遷移など）
    // window.location.href = "/driving.html"; // 例
  } catch (e) {
    console.error("運転開始エラー:", e);
    alert("運転開始に失敗しました。");
  }
});

}


