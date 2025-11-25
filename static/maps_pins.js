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
          <div style="min-width:220px; font-size:13px; line-height:1.5;">

              <div style="display:flex; align-items:center; margin-bottom:8px;">
                  <label for="memo_${pin.id}" style="width:70px;">メモ:</label>
                  <input type="text" id="memo_${pin.id}" 
                      value="${pin.label || ''}" 
                      placeholder="内容を入力" 
                      style="flex:1; padding:4px 6px; border:1px solid #ccc; border-radius:3px;" 
                      ${isOwner ? "" : "disabled"}>
              </div>

              <div style="display:flex; align-items:center; margin-bottom:8px;">
                  <label for="speak_${pin.id}" style="width:70px;">読み上げ:</label>
                  <input type="checkbox" id="speak_${pin.id}" 
                      ${pin.speak_enabled ? "checked" : ""} 
                      ${isOwner ? "" : "disabled"}>
              </div>

              <div style="display:flex; align-items:center; margin-bottom:8px;">
                  <label for="priority_${pin.id}" style="width:70px;">レベル:</label>
                  <select id="priority_${pin.id}" style="flex:1; padding:3px; border:1px solid #ccc; border-radius:3px;" ${isOwner ? '' : 'disabled'}>
                      <option value="1" ${priorityLevel===1?'selected':''}>1 (オレンジ)</option>
                      <option value="2" ${priorityLevel===2?'selected':''}>2 (紫)</option>
                      <option value="3" ${priorityLevel===3?'selected':''}>3 (赤)</option>
                  </select>
              </div>

              <div style="display:flex; align-items:center; margin-bottom:12px;">
                  <label style="width:70px;">時間帯:</label>
                  <input type="time" id="tw_start_${pin.id}" value="${firstWin?.start || ''}" style="width:80px; padding:3px; border:1px solid #ccc; border-radius:3px;" ${isOwner ? '' : 'disabled'}>
                  <span style="padding:0 4px;">〜</span>
                  <input type="time" id="tw_end_${pin.id}" value="${firstWin?.end || ''}" style="width:80px; padding:3px; border:1px solid #ccc; border-radius:3px;" ${isOwner ? '' : 'disabled'}>
              </div>
          `;

          if (isOwner) {
              infoContent += `
                  <div style="text-align:right; margin-top:10px;">
                      <button onclick="updatePinLabel('${pin.id}')"
                          style="background-color:#5c6bc0; color:#fff; border:none; padding:5px 10px; border-radius:4px; margin-right:5px; cursor:pointer;">保存</button>
                      <button onclick="deletePin('${pin.id}')"
                          style="background-color:#f55; color:#fff; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">削除</button>
                  </div>
              `;
          }

          // 作成者表示は最後に統合し、最後の<div>で閉じる
          infoContent += `
              <div style="text-align:right;">
                  <span style="font-size:10px; color:#999; display:block; margin-top:4px;">
                      作成者: ${pin.user_name || "不明"}
                  </span>
              </div>
          </div>`;


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

    // ⭐ 変更点: FirestoreへのAPI呼び出しを削除し、クライアント側で仮ピンを作成する
    try {
        // 新規作成ピンには、一時的なユニークIDを割り当てる (保存時にピンIDが確定する)
        const pinId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const isOwner = true; // クリックしたユーザーが作成者なのでtrueで固定
        // CURRENT_USER_NAME が定義されている前提
        const userName = window.CURRENT_USER_NAME || "自分"; 

        const marker = new google.maps.Marker({
          position: { lat, lng },
          map,
          icon: "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
          title: "(新規未保存ピン)",
          // ドラッグ可能にする（ドラッグ＆ドロップで位置修正できるように）
          draggable: true, 
        });
        
        // ピンに一時IDを付与
        marker.id = pinId;

        let infoContent = `
          <div style="min-width:220px; font-size:13px; line-height:1.5;">
              
              <div style="display:flex; align-items:center; margin-bottom:8px;">
                  <label for="memo_${pinId}" style="width:70px;">メモ:</label>
                  <input type="text" id="memo_${pinId}" 
                      placeholder="内容" 
                      style="flex:1; padding:4px 6px; border:1px solid #ccc; border-radius:3px;" 
                      ${isOwner ? "" : "disabled"}>
              </div>
              
              <div style="display:flex; align-items:center; margin-bottom:8px;">
                  <label for="speak_${pinId}" style="width:70px;">読み上げ:</label>
                  <input type="checkbox" id="speak_${pinId}" checked 
                      style="margin-left:0;"
                      ${isOwner ? "" : "disabled"}>
              </div>

              <div style="display:flex; align-items:center; margin-bottom:8px;">
                  <label for="priority_${pinId}" style="width:70px;">レベル:</label>
                  <select id="priority_${pinId}" style="flex:1; padding:3px; border:1px solid #ccc; border-radius:3px;" ${isOwner ? '' : 'disabled'}>
                      <option value="1" selected>1 (オレンジ)</option>
                      <option value="2">2 (紫)</option>
                      <option value="3">3 (赤)</option>
                  </select>
              </div>
              

              <div style="display:flex; align-items:center; margin-bottom:12px;">
                  <label style="width:70px;">時間帯:</label>
                  <input type="time" id="tw_start_${pinId}" style="width:80px; padding:3px; border:1px solid #ccc; border-radius:3px;" ${isOwner ? '' : 'disabled'}>
                  <span style="padding:0 4px;">〜</span>
                  <input type="time" id="tw_end_${pinId}" style="width:80px; padding:3px; border:1px solid #ccc; border-radius:3px;" ${isOwner ? '' : 'disabled'}>
              </div>

              <div style="text-align:right;">
                  <button onclick="updatePinLabel('${pinId}')"
                      style="background:#5c6bc0; color:#fff; border:none; padding:5px 10px; border-radius:4px; margin-right:5px; cursor:pointer;"
                      ${isOwner ? '' : 'disabled'}>保存</button>
                  <button onclick="deletePin('${pinId}')"
                      style="background:#f55; color:#fff; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;"
                      ${isOwner ? '' : 'disabled'}>削除</button>
              </div>
              
              <div style="text-align:right;">
                  <span style="font-size:10px; color:#999; display:block; margin-top:4px;">
                      作成者: ${userName}
                  </span>
              </div>
          </div>`;

        const info = new google.maps.InfoWindow({ content: infoContent });

        marker.addListener("click", () => {
          for (const key in window.currentInfoWindows) {
            window.currentInfoWindows[key].close();
          }
          info.open(map, marker);
        });
        
        // マーカーのドラッグ終了イベントを監視し、情報ウィンドウを閉じる
        marker.addListener('dragend', () => {
             info.close();
        });

        // 🔹 登録
        window.currentMarkers.push(marker);
        window.currentInfoWindows[pinId] = info;

        // 続けて情報ウィンドウを開く
        for (const key in window.currentInfoWindows) {
          if (key !== pinId) {
            window.currentInfoWindows[key].close();
          }
        }
        info.open(map, marker);

        google.maps.event.addListener(info, 'domready', function() {
            document.getElementById(`memo_${pinId}`)?.focus();
        });
        google.maps.event.addListener(info, "domready", () => {
          const prioEl = document.getElementById(`priority_${pinId}`);
          if (prioEl) {
            prioEl.addEventListener("change", () => {
              const lvl = Number(prioEl.value || 1);
              marker.setIcon(getPriorityIconUrl(lvl));
            });
          }
        });

    } catch (e) {
      console.error("❌ クライアントでの仮ピン作成エラー:", e);
    }
  });
}

// === ピン更新（新規登録/更新） ===
async function updatePinLabel(pinId) {
  const memoEl = document.getElementById(`memo_${pinId}`);
  const speakEl = document.getElementById(`speak_${pinId}`);
  const priorityEl = document.getElementById(`priority_${pinId}`);
  const twStartEl = document.getElementById(`tw_start_${pinId}`);
  const twEndEl = document.getElementById(`tw_end_${pinId}`);

  const memo = memoEl.value.trim();
  const speakEnabled = speakEl.checked; 
  
  if (!memo) return alert("メモを入力してください。");
    
  const marker = window.currentMarkers.find((m) => m.id === pinId);
  if (!marker) return alert("エラー: ピンが見つかりません。");

  try {
    // マーカーの現在の位置を取得（ドラッグされている可能性があるため）
    const position = marker.getPosition();
    const lat = position.lat();
    const lng = position.lng();
    
    // 登録するデータ本体を構築
    const body = { lat, lng, label: memo, speak_enabled: speakEnabled };
    
    let priorityLevel = 1;
    if (priorityEl) {
      const lvl = parseInt(priorityEl.value || '1', 10);
      body.priority_level = isNaN(lvl) ? 1 : Math.min(3, Math.max(1, lvl));
      priorityLevel = body.priority_level;
    }
    
    let timeWindows = [];
    if (twStartEl && twEndEl) {
      const s = twStartEl.value || '';
      const e = twEndEl.value || '';
      if (s && e) {
        body.speak_time_windows = [{ start: s, end: e }];
        timeWindows = body.speak_time_windows;
      } else {
        body.speak_time_windows = [];
      }
    }

    let apiUrl;
    let isNewPin = pinId.startsWith('temp_'); // 💡 新規ピン判定ロジック
    
    if (isNewPin) {
        // 新規登録 (ピンIDはAPI側で生成されるため不要)
        apiUrl = "/api/add_manual_pin";
    } else {
        // 既存ピンの更新
        apiUrl = "/api/update_pin";
        body.id = pinId; // 既存ピンIDを渡す
    }

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    
    const result = await res.json();
    let finalPinId = pinId;
    
    if (result.status === "success") {
        alert(`✅ ピンを${isNewPin ? '登録' : '更新'}しました！`);
        
        // 新規登録の場合、クライアント側の仮IDをFirestoreの確定IDに置き換える
        if (isNewPin) {
            const newPinId = result.pin_id;
            finalPinId = newPinId;
            
            // 1. currentMarkers内のIDを更新
            const markerIndex = window.currentMarkers.findIndex(m => m.id === pinId);
            if (markerIndex !== -1) {
                window.currentMarkers[markerIndex].id = newPinId;
                window.currentMarkers[markerIndex].title = memo; // タイトルも更新
            }
            
            // 2. currentInfoWindowsのキーを更新
            window.currentInfoWindows[newPinId] = window.currentInfoWindows[pinId];
            delete window.currentInfoWindows[pinId];
            
            // 3. マーカーオブジェクトにも確定IDを反映
            marker.id = newPinId;
            
            // 4. マーカーをドラッグ不可に戻す（新規作成時のみ）
            marker.setDraggable(false); 
        }

        // アイコンを注意レベルに応じて更新
        const lvl = body.priority_level || 1;
        marker.setIcon(getPriorityIconUrl(lvl));
        marker.setTitle(memo); // タイトル更新

        window.currentInfoWindows[marker.id]?.close();
    } else {
        alert(`❌ ${isNewPin ? '登録' : '更新'}失敗: ` + result.error);
        return; // 失敗時は再構築・再オープンしない
    }

    // 💡 InfoWindowのHTMLをinitMapと同じ構造で再構築
    const firstWin = timeWindows[0] || {};
    const isOwner = true; // updatePinLabelを呼び出したユーザー＝作成者と想定

    let infoContent = `
    <div style="min-width:220px; font-size:13px; line-height:1.5;">
        
        <div style="display:flex; align-items:center; margin-bottom:8px;">
            <label for="memo_${finalPinId}" style="width:70px;">メモ:</label>
            <input type="text" id="memo_${finalPinId}" 
                value="${memo || ''}" 
                placeholder="内容を入力" 
                style="flex:1; padding:4px 6px; border:1px solid #ccc; border-radius:3px;" 
                ${isOwner ? "" : "disabled"}>
        </div>
        
        <div style="display:flex; align-items:center; margin-bottom:8px;">
            <label for="speak_${finalPinId}" style="width:70px;">読み上げ:</label>
            <input type="checkbox" id="speak_${finalPinId}" 
                ${speakEnabled ? "checked" : ""} 
                style="margin-left:0;"
                ${isOwner ? "" : "disabled"}>
        </div>

        <div style="display:flex; align-items:center; margin-bottom:8px;">
            <label for="priority_${finalPinId}" style="width:70px;">レベル:</label>
            <select id="priority_${finalPinId}" style="flex:1; padding:3px; border:1px solid #ccc; border-radius:3px;" ${isOwner ? '' : 'disabled'}>
                <option value="1" ${priorityLevel===1?'selected':''}>1 (オレンジ)</option>
                <option value="2" ${priorityLevel===2?'selected':''}>2 (紫)</option>
                <option value="3" ${priorityLevel===3?'selected':''}>3 (赤)</option>
            </select>
        </div>
        
        <div style="display:flex; align-items:center; margin-bottom:12px;">
            <label style="width:70px;">時間帯:</label>
            <input type="time" id="tw_start_${finalPinId}" value="${firstWin?.start || ''}" style="width:80px; padding:3px; border:1px solid #ccc; border-radius:3px;" ${isOwner ? '' : 'disabled'}>
            <span style="padding:0 4px;">〜</span>
            <input type="time" id="tw_end_${finalPinId}" value="${firstWin?.end || ''}" style="width:80px; padding:3px; border:1px solid #ccc; border-radius:3px;" ${isOwner ? '' : 'disabled'}>
        </div>

        <div style="text-align:right;">
            <button onclick="updatePinLabel('${finalPinId}')"
                style="background-color:#5c6bc0; color:#fff; border:none; padding:5px 10px; border-radius:4px; margin-right:5px; cursor:pointer;"
                ${isOwner ? '' : 'disabled'}>保存</button>
            <button onclick="deletePin('${finalPinId}')"
                style="background-color:#f55; color:#fff; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;"
                ${isOwner ? '' : 'disabled'}>削除</button>
        </div>
        
        <div style="text-align:right;">
            <span style="font-size:10px; color:#999; display:block; margin-top:4px;">
                作成者: ${window.CURRENT_USER_NAME || "自分"}
            </span>
        </div>
    </div>`;


    // InfoWindow を開き直す
    const info = window.currentInfoWindows[finalPinId];
    if (info) {
      info.setContent(infoContent); 
      info.open(map, marker);
    }
  } catch (err) {
    console.error("❌ updatePinLabel error:", err);
  }
}

// === ピン削除 ===
async function deletePin(pinId) {
if (!confirm("このピンを削除しますか？")) return;
    
  const isTemporary = pinId.startsWith('temp_');
    
  try {
        if (!isTemporary) {
            // 既存ピンの場合のみAPIをコール
            const res = await fetch("/api/delete_pin", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: pinId }),
            });
            const result = await res.json();
            if (result.status !== "success") {
                alert("❌ 削除失敗: " + result.error);
                return;
            }
        }
    
    alert(`🗑 ピンを削除しました${isTemporary ? '（未保存）' : ''}`);
    const marker = window.currentMarkers.find((m) => m.id === pinId);
    if (marker) marker.setMap(null);
    delete window.currentInfoWindows[pinId];
    
    // currentMarkers配列からも削除
    window.currentMarkers = window.currentMarkers.filter(m => m.id !== pinId);
    
  } catch (err) {
    console.error("❌ deletePin error:", err);
  }
}




window.initMap = initMap;
