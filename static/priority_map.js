console.log("=== priority_map.js (label編集＋S/G描画対応版) loaded ===");

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

  await loadPins(map);
  try { await drawLatestRoute(map); } catch (e) { console.warn("ルート描画失敗:", e); }

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

    const userId = window.FLASK_USER_ID || null;
    try {
      const docRef = await firebase.firestore().collection("priority_pins").add({
        lat,
        lng,
        label,
        focus_type: selectedFocus.key,
        focus_label: selectedFocus.name,
        user_id: userId,
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
  const userId = window.FLASK_USER_ID || localStorage.getItem("CURRENT_USER_ID");
  const query = firebase.firestore().collection("priority_pins").where("user_id", "==", userId);
  const snapshot = await query.get();
  snapshot.forEach((doc) => {
    const d = doc.data();
    addMarker(map, { id: doc.id, lat: d.lat, lng: d.lng, label: d.label || "(無題)" });
  });
  console.log(`📍 ${snapshot.size}件のピンを読み込み完了`);
}

// === ピン追加（編集＋削除） ===
function addMarker(map, pin) {
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

          await firebase.firestore().collection("priority_pins").doc(pin.id).update({
            label: newLabel,
            focus_type: newFocus,
          });

          pin.label = newLabel;
          pin.focus_type = newFocus;
          alert("✅ ピン情報を更新しました。");
          info.close();
        });
      }

      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          if (!confirm(`「${pin.label}」を削除しますか？`)) return;
          await firebase.firestore().collection("priority_pins").doc(pin.id).delete();
          marker.setMap(null);
          info.close();
          console.log("🗑️ ピン削除:", pin.id);
        });
      }
    }, 200);
  });
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
