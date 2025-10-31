console.log("🎙 record_voice_unified.js (統合改良版) loaded");

const storageRef = firebase.storage();
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
console.log("📱 iOS Mode:", isIOS);

// === ビープ音（開始・終了） ===
function playStartBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";           // サイン波
    osc.frequency.value = 880;   // 高めの「ポン」
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch (e) {
    console.warn("🎵 開始ビープ再生失敗:", e);
  }
}

function playEndBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(600, ctx.currentTime); // 低めの「ピッ」
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch (e) {
    console.warn("🎵 終了ビープ再生失敗:", e);
  }
}


// === Whisper送信用関数（共通） ===
async function sendToServerForTranscription(audioBlob, meta = {}) {
  try {
    const formData = new FormData();
    formData.append("audio", audioBlob, meta.file_name || `record_${Date.now()}.webm`);
    formData.append("session_id", meta.session_id || window.sessionId || "unknown_session");
    if (meta.storage_path) formData.append("storage_path", meta.storage_path);
    if (meta.record_id) formData.append("record_id", meta.record_id);

    const res = await fetch("/transcribe", { method: "POST", body: formData });
    const data = await res.json();

    if (data.status === "ok") {
      console.log("✅ Whisper成功:", data.transcript);
    } else {
      console.warn("⚠️ Whisper失敗:", data.message || data);
    }
  } catch (err) {
    console.error("❌ Whisper送信エラー:", err);
  }
}

// === iOS Safari録音モード ===
if (isIOS) {
  console.log("🎧 iOS Safari: 音声コマンドで録音を制御");

  async function iosRecordOnce() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      let chunks = [];

      recorder.ondataavailable = e => chunks.push(e.data);

      recorder.onstop = async () => {
        playEndBeep();
        const blob = new Blob(chunks, { type: mimeType });
        console.log("🎙 iOS録音完了", blob.size);

        // 無音チェック
        if (blob.size < 1000) {
          console.warn("⚠️ 録音が短すぎるため保存スキップ");
          return;
        }

        const fileName = `ios_${Date.now()}.webm`;
        const path = `audio_records/${fileName}`;
        const storageRef = firebase.storage().ref().child(path);

        // Firebaseにアップロード
        await storageRef.put(blob);
        const url = await storageRef.getDownloadURL();

        const sessionId = window.sessionId || "unknown_session";
        const docRef = await db.collection("sessions").doc(sessionId)
          .collection("audio_records").add({
            url: url,
            storage_path: path,
            mime_type: mimeType,
            created_at: firebase.firestore.FieldValue.serverTimestamp(),
          });

        // Whisperへ転送
        await sendToServerForTranscription(blob, {
          session_id: sessionId,
          storage_path: path,
          record_id: docRef.id,
          file_name: fileName,
        });
      };

      // ✅ 録音スタート（5秒）
      playStartBeep();
      recorder.start();
      console.log("🎙 録音開始");
      
      // 🔹 録音開始時に現在地にピンを作成
      console.log("📍 録音開始検知 → 現在地ピン作成");
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
          const { latitude, longitude } = pos.coords;
          console.log("📍 録音開始時の現在地:", latitude, longitude);
          
          // 現在時刻を取得してフォーマット
          const now = new Date();
          const dateString = now.toLocaleDateString('ja-JP', {
            year: 'numeric',
            month: '2-digit', 
            day: '2-digit'
          });
          const timeString = now.toLocaleTimeString('ja-JP', { 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
          });
          const label = `録音ピン ${dateString} ${timeString}`;
          
          if (window.addVoicePinWithOptions) {
            // 読み上げ無効でピンを作成
            window.addVoicePinWithOptions(latitude, longitude, label, false, "voice_recording");
            console.log("✅ 録音開始ピンを作成しました:", label);
          } else {
            console.warn("⚠️ addVoicePinWithOptions 関数が未定義です");
          }
        }, (err) => {
          console.error("❌ 録音開始時の現在地取得エラー:", err);
        }, {
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 30000
        });
      }
      
      setTimeout(() => recorder.stop(), 5000);

    } catch (err) {
      console.error("❌ iOS録音エラー:", err);
      alert("マイクへのアクセスを許可してください。");
    }
  }

  // ✅ 音声認識で「録音」を検出したら呼び出す
  window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (window.SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      const transcript = event.results[event.results.length - 1][0].transcript.trim();
      console.log("🎤 音声認識結果:", transcript);

      if (transcript.includes("録音")) {
        console.log("✅ キーワード「録音」を検出 → 録音開始");
        iosRecordOnce();
      }

      // ✅ 追加：「ピン」で現在地に仮ピンを立てる
      if (transcript.includes("ピン") || transcript.includes("ぴん")) {
        console.log("📍 音声コマンド「ピン」検出 → 現在地取得中...");
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition((pos) => {
            const { latitude, longitude } = pos.coords;
            console.log("📍 現在地:", latitude, longitude);
            
            // 現在日時を取得してフォーマット
            const now = new Date();
            const dateString = now.toLocaleDateString('ja-JP', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit'
            });
            const timeString = now.toLocaleTimeString('ja-JP', { 
              hour: '2-digit', 
              minute: '2-digit', 
              second: '2-digit' 
            });
            const label = `音声ピン ${dateString} ${timeString}`;
            
            if (window.addVoicePinWithOptions) {
              // 読み上げ無効でピンを作成
              window.addVoicePinWithOptions(latitude, longitude, label, false, "voice_command");
              console.log("✅ 音声ピンを作成しました:", label);
            } else {
              console.warn("⚠️ addVoicePinWithOptions 関数が未定義です");
            }
          });
        } else {
          console.warn("❌ 現在地取得に未対応の環境");
        }
      }
    };

    recognition.onend = () => {
      console.log("🔁 音声認識が終了 → 自動再開");
      recognition.start();
    };

    recognition.onerror = (e) => console.error("音声認識エラー:", e);

    recognition.start();
    console.log("🎙 音声認識を開始（「録音」で録音開始）");
  }
}

// === Android / PC 音声認識トリガー ===
else if (window.SpeechRecognition || window.webkitSpeechRecognition) {
  const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
  recognition.lang = "ja-JP";
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onresult = async (event) => {
    const text = event.results[event.results.length - 1][0].transcript.trim();
    console.log("🎤 認識結果:", text);

    // === 録音トリガー ===
    if (text.includes("録音") || text.includes("ろくおん")) {
      await startRecordingAndUpload();
    }

    // === ピントリガー ===
    if (text.includes("ピン") || text.includes("ぴん")) {
      console.log("📍 音声コマンド「ピン」検出 → 現在地取得開始...");

      if (navigator.geolocation) {
        const geoOptions = {
          enableHighAccuracy: false,
          timeout: 20000,
          maximumAge: 0
        };

        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude } = pos.coords;
            console.log("✅ 現在地取得成功:", latitude, longitude);

            // 🔊 効果音を鳴らす
            try {
              const audio = new Audio("/static/audio/pin_set.wav");
              audio.volume = 0.8;
              audio.play().then(() => console.log("🔈 ピン設置音を再生しました"));
            } catch (e) {
              console.error("❌ 効果音エラー:", e);
            }

            // 現在日時を取得してフォーマット
            const now = new Date();
            const dateString = now.toLocaleDateString('ja-JP', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit'
            });
            const timeString = now.toLocaleTimeString('ja-JP', { 
              hour: '2-digit', 
              minute: '2-digit', 
              second: '2-digit' 
            });
            const label = `音声ピン ${dateString} ${timeString}`;

            // 🔹 ピン追加
            if (window.addVoicePinWithOptions) {
              console.log("📍 addVoicePinWithOptions 呼び出し");
              // 読み上げ無効でピンを作成
              window.addVoicePinWithOptions(latitude, longitude, label, false, "voice_command");
              console.log("✅ 音声ピンを作成しました:", label);
            } else {
              console.warn("⚠️ addVoicePinWithOptions 関数が未定義です");
            }
          },
          (err) => {
            console.error("❌ 現在地取得エラー:", err);
          },
          geoOptions
        );
      } else {
        console.warn("❌ navigator.geolocation 未対応");
      }
    }
  };

  recognition.onend = () => recognition.start();
  recognition.start();
  console.log("✅ Android 音声認識起動");
}

// === Android・PC録音関数 ===
async function startRecordingAndUpload() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "audio/mp4";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];

    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      const audioBlob = new Blob(chunks, { type: mimeType });
      const fileName = `whisper_${Date.now()}.webm`;
      const path = `audio_records/${fileName}`;

      const storage = firebase.storage().ref().child(path);
      await storage.put(audioBlob);
      const downloadURL = await storage.getDownloadURL();

      const sessionId = window.sessionId || "unknown_session";
      const docRef = await db.collection("sessions").doc(sessionId)
        .collection("audio_records").add({
          url: downloadURL,
          storage_path: path,
          mime_type: mimeType,
          created_at: firebase.firestore.FieldValue.serverTimestamp(),
        });

      await sendToServerForTranscription(audioBlob, {
        session_id: sessionId,
        storage_path: path,
        record_id: docRef.id,
        file_name: fileName,
      });
    };

    playStartBeep();
    recorder.start();
    console.log("🎙 録音開始");
    
    // 🔹 録音開始時に現在地にピンを作成
    console.log("📍 録音開始検知 → 現在地ピン作成");
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        const { latitude, longitude } = pos.coords;
        console.log("📍 録音開始時の現在地:", latitude, longitude);
        
        // 現在日時を取得してフォーマット
        const now = new Date();
        const dateString = now.toLocaleDateString('ja-JP', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        const timeString = now.toLocaleTimeString('ja-JP', { 
          hour: '2-digit', 
          minute: '2-digit', 
          second: '2-digit' 
        });
        const label = `録音ピン ${dateString} ${timeString}`;
        
        if (window.addVoicePinWithOptions) {
          // 読み上げ無効でピンを作成
          window.addVoicePinWithOptions(latitude, longitude, label, false, "voice_recording");
          console.log("✅ 録音開始ピンを作成しました:", label);
        } else {
          console.warn("⚠️ addVoicePinWithOptions 関数が未定義です");
        }
      }, (err) => {
        console.error("❌ 録音開始時の現在地取得エラー:", err);
      }, {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 30000
      });
    }
    
    setTimeout(() => {
      recorder.stop();
      playEndBeep();   // ← 終了音
    }, 5000);
  } catch (err) {
    console.error("録音エラー:", err);
  }
}

window.playStartBeep = playStartBeep;
window.playEndBeep = playEndBeep;


