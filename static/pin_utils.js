// === pin_utils.js ===
// マップ上または現在地からピンを追加する共通関数

window.addVoicePin = async function(lat, lng, label = "") {
  console.log("📍 addVoicePin():", lat, lng);
  try {
    const res = await fetch("/api/add_voice_pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng, label }),
    });
    const result = await res.json();

    if (result.status === "success") {
      console.log("✅ Firestoreにピン追加:", result.pin_id);
      // 🔵 マップがある場合のみ表示
      if (window.map && google?.maps) {
        new google.maps.Marker({
          position: { lat, lng },
          map: window.map,
          icon: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
          title: label || "(未入力ピン)"
        });
      }
      return result.pin_id;
    } else {
      console.warn("⚠️ Firestore保存失敗:", result.error);
    }
  } catch (err) {
    console.error("❌ addVoicePin エラー:", err);
  }
};

// 読み上げ設定付きでピンを作成する関数
window.addVoicePinWithOptions = async function(lat, lng, label = "", speakEnabled = true, source = "voice") {
  console.log("📍 addVoicePinWithOptions():", lat, lng, label, "speak:", speakEnabled, "source:", source);
  try {
    const res = await fetch("/api/add_voice_pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng, label, speak_enabled: speakEnabled, source: source }),
    });
    const result = await res.json();

    if (result.status === "success") {
      console.log("✅ Firestoreにピン追加:", result.pin_id);
      // 🔵 マップがある場合のみ表示
      if (window.map && google?.maps) {
        // ピンのソースに応じて色を決定
        let iconUrl;
        if (source === "voice_recording") {
          iconUrl = "http://maps.google.com/mapfiles/ms/icons/green-dot.png"; // 緑：録音ピン
        } else if (source === "voice_command") {
          iconUrl = "http://maps.google.com/mapfiles/ms/icons/yellow-dot.png"; // 黄：音声ピン
        } else {
          iconUrl = "http://maps.google.com/mapfiles/ms/icons/blue-dot.png"; // 青：その他
        }
          
        new google.maps.Marker({
          position: { lat, lng },
          map: window.map,
          icon: iconUrl,
          title: label || "(未入力ピン)"
        });
      }
      return result.pin_id;
    } else {
      console.warn("⚠️ Firestore保存失敗:", result.error);
    }
  } catch (err) {
    console.error("❌ addVoicePinWithOptions エラー:", err);
  }
};
