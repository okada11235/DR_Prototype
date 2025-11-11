console.log("=== maps_pins.js (map editor: editable pins) loaded ===");

// === Priority colored marker utilities (Google Maps standard pin shape) ===
function getPriorityIconUrl(level) {
  const lvl = Number(level || 1);
  if (lvl === 3) return "http://maps.google.com/mapfiles/ms/icons/red-dot.png";     // 赤
  if (lvl === 2) return "http://maps.google.com/mapfiles/ms/icons/purple-dot.png";  // 紫
  return "http://maps.google.com/mapfiles/ms/icons/orange-dot.png";                 // オレンジ(level1)
}

let map; // 公開用は後で window.map に設定

async function initMap() {
  console.log("✅ initMap called");

  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 35.681236, lng: 139.767125 },
    zoom: 15,
  });
  // 他スクリプトからも参照できるように公開
  window.map = map;

  // 初期表示の現在地パンは、ピン読み込み後に行う（fitBoundsの上書きを避けるため）

  // === Firestoreから既存ピンを取得 ===
  window.currentMarkers = [];
  window.currentInfoWindows = {};

  try {
    const res = await fetch(`/api/get_pins_all`);
    const data = await res.json();

    if (data.status === "success" && data.pins) {
      const bounds = new google.maps.LatLngBounds();
      data.pins.forEach((pin) => {
        const isTemporary = !pin.label || pin.label.trim() === "";
        const isVoiceRecording = pin.source === "voice_recording";
        const isVoiceCommand = pin.source === "voice_command";
        const isEdited = pin.edited || false; // 編集済みフラグ

        let iconUrl;
        if (isTemporary) {
          iconUrl = "http://maps.google.com/mapfiles/ms/icons/blue-dot.png"; // 青：未入力
        } else if (isVoiceRecording && !isEdited) {
          iconUrl = "http://maps.google.com/mapfiles/ms/icons/green-dot.png"; // 緑：録音作成・未編集
        } else if (isVoiceCommand && !isEdited) {
          iconUrl = "http://maps.google.com/mapfiles/ms/icons/yellow-dot.png"; // 黄：音声ピン・未編集
        } else {
          iconUrl = "http://maps.google.com/mapfiles/ms/icons/red-dot.png"; // 赤：編集済み
        }

        // 先に優先度などを決定（参照順序バグ修正）
        const priorityLevel = Number(pin.priority_level || 1);
        const timeWindows = Array.isArray(pin.speak_time_windows) ? pin.speak_time_windows : [];
        const firstWin = timeWindows[0] || null;

        const marker = new google.maps.Marker({
          position: { lat: pin.lat, lng: pin.lng },
          map,
          icon: getPriorityIconUrl(priorityLevel),
          title: pin.label || "(未入力ピン)",
        });
        marker.id = pin.id;
        window.currentMarkers.push(marker);
        if (pin.lat && pin.lng) {
          try { bounds.extend(new google.maps.LatLng(pin.lat, pin.lng)); } catch (_) {}
        }
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

            <label>注意レベル:</label><br>
            <select id="priority_${pin.id}" style="width:160px; margin-bottom:4px;" ${isOwner ? '' : 'disabled'}>
              <option value="1" ${priorityLevel===1?'selected':''}>1 (オレンジ)</option>
              <option value="2" ${priorityLevel===2?'selected':''}>2 (紫)</option>
              <option value="3" ${priorityLevel===3?'selected':''}>3 (赤)</option>
            </select><br>

            <label>読み上げ時間帯(任意):</label><br>
            <input type="time" id="tw_start_${pin.id}" value="${firstWin?.start || ''}" ${isOwner ? '' : 'disabled'}>
            〜
            <input type="time" id="tw_end_${pin.id}" value="${firstWin?.end || ''}" ${isOwner ? '' : 'disabled'}><br>
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
      // 1つ以上あれば自動フィット
      try {
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds);
        }
      } catch(e) { /* ignore */ }
    }
  } catch (err) {
    console.error("❌ /api/get_pins_all error:", err);
  }

  // === 初期表示で現在地へ（現在地へボタンと同挙動） ===
  if (typeof window.recenterToCurrent === 'function') {
    window.recenterToCurrent(false);
    if (window.map) {
      const currentZoom = window.map.getZoom();
      if (!currentZoom || currentZoom < 16) {
        window.map.setZoom(17);
      }
    }
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
          icon: getPriorityIconUrl(1),
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

            <label>注意レベル:</label><br>
            <select id="priority_${pinId}" style="width:160px; margin-bottom:4px;" ${isOwner ? '' : 'disabled'}>
              <option value="1" selected>1 (オレンジ)</option>
              <option value="2">2 (紫)</option>
              <option value="3">3 (赤)</option>
            </select><br>

            <label>読み上げ時間帯(任意):</label><br>
            <input type="time" id="tw_start_${pinId}" ${isOwner ? '' : 'disabled'}>
            〜
            <input type="time" id="tw_end_${pinId}" ${isOwner ? '' : 'disabled'}><br>
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
  const priorityEl = document.getElementById(`priority_${pinId}`);
  const twStartEl = document.getElementById(`tw_start_${pinId}`);
  const twEndEl = document.getElementById(`tw_end_${pinId}`);

  if (!memo) return alert("メモを入力してください。");

  try {
    const body = { id: pinId, label: memo, speak_enabled: speakEnabled };
    if (priorityEl) {
      const lvl = parseInt(priorityEl.value || '1', 10);
      body.priority_level = isNaN(lvl) ? 1 : Math.min(3, Math.max(1, lvl));
    }
    if (twStartEl && twEndEl) {
      const s = twStartEl.value || '';
      const e = twEndEl.value || '';
      if (s && e) {
        body.speak_time_windows = [{ start: s, end: e }];
      } else {
        body.speak_time_windows = [];
      }
    }
    const res = await fetch("/api/update_pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.status === "success") {
      alert("✅ ピンを更新しました！");
      const marker = window.currentMarkers.find((m) => m.id === pinId);
      if (marker) {
        // アイコンを注意レベルに応じて更新
        const lvl = priorityEl ? parseInt(priorityEl.value || '1', 10) : 1;
        marker.setIcon(getPriorityIconUrl(lvl));
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
