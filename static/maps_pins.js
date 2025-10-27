console.log("=== maps_pins.js (map editor: editable pins) loaded ===");

let map;

async function initMap() {
  console.log("✅ initMap called");

  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 35.681236, lng: 139.767125 },
    zoom: 15,
  });

  // === 現在地中心に移動 ===
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
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
    });
  }

  // === Firestoreから既存ピンを取得 ===
  window.currentMarkers = [];
  window.currentInfoWindows = {};

  try {
    const res = await fetch(`/api/get_pins_all`);
    const data = await res.json();

    if (data.status === "success" && data.pins) {
      data.pins.forEach((pin) => {
        const isTemporary = !pin.label || pin.label.trim() === "";

        const marker = new google.maps.Marker({
          position: { lat: pin.lat, lng: pin.lng },
          map,
          icon: isTemporary
            ? "http://maps.google.com/mapfiles/ms/icons/blue-dot.png"
            : "http://maps.google.com/mapfiles/ms/icons/red-dot.png",
          title: pin.label || "(未入力ピン)",
        });
        marker.id = pin.id;
        window.currentMarkers.push(marker);

        const isOwner = pin.user_id === CURRENT_USER_ID; // ← 現在ログイン中ユーザーID（下で定義）

        let infoContent = `
          <div style="min-width:220px;">
            <label>メモ:</label><br>
            <input type="text" id="memo_${pin.id}" 
                  value="${pin.label || ''}" 
                  placeholder="内容を入力" 
                  style="width:150px; margin-bottom:4px;" 
                  ${isOwner ? "" : "disabled"}><br>

            <label style="font-size:13px;">
              <input type="checkbox" id="speak_${pin.id}" 
                ${pin.speak_enabled ? "checked" : ""} 
                ${isOwner ? "" : "disabled"}>
              読み上げる
            </label><br>
        `;

        if (isOwner) {
          infoContent += `
            <button onclick="updatePinLabel('${pin.id}')">💾 保存</button>
            <button onclick="deletePin('${pin.id}')"
                    style="margin-left:5px; background-color:#f55; color:#fff; border:none; padding:3px 8px; border-radius:4px;">
                    🗑 削除
            </button>
          `;
        }

        infoContent += `
            <div style="font-size:12px; color:#666; margin-top:6px;">
              作成者: ${pin.user_name || "不明"}
            </div>
          </div>
        `;


        const info = new google.maps.InfoWindow({ content: infoContent });

        marker.addListener("click", () => {
          // 他のInfoWindowを閉じる
          for (const key in window.currentInfoWindows) {
            window.currentInfoWindows[key].close();
          }
          info.open(map, marker);
        });

        window.currentInfoWindows[pin.id] = info;
      });

      console.log("📍 Firestoreピン読込完了:", data.pins.length);
    }
  } catch (err) {
    console.error("❌ /api/get_pins_all error:", err);
  }

  // === 🖱️ マップクリックで新しいピンを追加 ===
  map.addListener("click", async (event) => {
    const lat = event.latLng.lat();
    const lng = event.latLng.lng();
    console.log(`🖱️ マップクリック: ${lat}, ${lng}`);

    try {
      // Firestoreへ追加
      const res = await fetch("/api/add_manual_pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng, label: "" }),
      });
      const result = await res.json();
      if (result.status === "success") {
        console.log("✅ 新しい仮ピンを追加しました");

        const pinId = result.pin_id;
        const userId = result.user_id;
        const userName = result.user_name || "不明";

        const marker = new google.maps.Marker({
          position: { lat, lng },
          map,
          icon: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
          title: "(未入力ピン)",
        });

        const isOwner = userId === CURRENT_USER_ID;

        let infoContent = `
          <div style="min-width:220px;">
            <label>メモ:</label><br>
            <input type="text" id="memo_${pinId}" 
                  value="" 
                  placeholder="内容を入力" 
                  style="width:150px; margin-bottom:4px;" 
                  ${isOwner ? "" : "disabled"}><br>

            <label style="font-size:13px;">
              <input type="checkbox" id="speak_${pinId}" checked ${isOwner ? "" : "disabled"}>
              読み上げる
            </label><br>
        `;

        if (isOwner) {
          infoContent += `
            <button onclick="updatePinLabel('${pinId}')">💾 保存</button>
            <button onclick="deletePin('${pinId}')"
                    style="margin-left:5px; background-color:#f55; color:#fff; border:none; padding:3px 8px; border-radius:4px;">
                    🗑 削除
            </button>
          `;
        }

        infoContent += `
            <div style="font-size:12px; color:#666; margin-top:6px;">
              作成者: ${userName}
            </div>
          </div>
        `;

        const info = new google.maps.InfoWindow({ content: infoContent });

        marker.addListener("click", () => {
          for (const key in window.currentInfoWindows) {
            window.currentInfoWindows[key].close();
          }
          info.open(map, marker);
        });

        // 🔹 登録
        marker.id = pinId;
        window.currentMarkers.push(marker);
        window.currentInfoWindows[pinId] = info;
      }else {
        console.warn("⚠️ Firestore保存失敗:", result.error);
      }
    } catch (e) {
      console.error("❌ サーバー保存エラー:", e);
    }
  });
}

// === ピン更新 ===
async function updatePinLabel(pinId) {
  const memo = document.getElementById(`memo_${pinId}`).value.trim();
  const speakEnabled = document.getElementById(`speak_${pinId}`).checked; // ✅ チェック状態取得

  if (!memo) return alert("メモを入力してください。");

  try {
    const res = await fetch("/api/update_pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pinId, label: memo, speak_enabled: speakEnabled }),
    });
    const result = await res.json();
    if (result.status === "success") {
      alert("✅ ピンを更新しました！");
      const marker = window.currentMarkers.find((m) => m.id === pinId);
      if (marker) {
        marker.setIcon("http://maps.google.com/mapfiles/ms/icons/red-dot.png");
        marker.setTitle(memo);
      }
      window.currentInfoWindows[pinId]?.close();
    } else {
      alert("❌ 更新失敗: " + result.error);
    }
  } catch (err) {
    console.error("❌ updatePinLabel error:", err);
  }
}

// === ピン削除 ===
async function deletePin(pinId) {
  if (!confirm("このピンを削除しますか？")) return;
  try {
    const res = await fetch("/api/delete_pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pinId }),
    });
    const result = await res.json();
    if (result.status === "success") {
      alert("🗑 ピンを削除しました");
      const marker = window.currentMarkers.find((m) => m.id === pinId);
      if (marker) marker.setMap(null);
      delete window.currentInfoWindows[pinId];
    } else {
      alert("❌ 削除失敗: " + result.error);
    }
  } catch (err) {
    console.error("❌ deletePin error:", err);
  }
}

window.initMap = initMap;
