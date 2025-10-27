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
        // 録音ピンの場合は緑色、それ以外は青色
        const iconUrl = source === "voice_recording" 
          ? "http://maps.google.com/mapfiles/ms/icons/green-dot.png"
          : "http://maps.google.com/mapfiles/ms/icons/blue-dot.png";
          
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
