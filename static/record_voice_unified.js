console.log("🎙 record_voice_unified.js (統合改良版) loaded");

const storageRef = firebase.storage();
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isAndroid = /Android/i.test(navigator.userAgent);
console.log("📱 iOS Mode:", isIOS);
console.log("📱 Android Mode:", isAndroid);

// === Mic/Recognition 管理（権限/再起動抑止/競合防止） ===
const micManager = (() => {
  let stream = null;               // 再利用するMediaStream
  let requesting = false;          // 多重要求防止
  let permission = 'unknown';      // granted|denied|prompt|unknown
  let recognition = null;          // WebSpeechのインスタンス（Android/PC）
  let recognitionActive = false;   // 現在稼働状態
  let recorderActive = false;      // 録音中フラグ
  let restartTimer = null;         // onend再起動デバウンス
  let autoStartRecognition = false; // 既定: 自動起動しない（通知多発回避）
  let retainStream = false;        // 記録中ページではストリームを保持して再取得を避ける（Android対策）
  let noAutoRestart = false;       // onend/onerror 後に自動再起動しない（Android通知音対策）
  let keepAliveTimer = null;       // 緩やかな再起動用の定期タイマー
  let lastStartTs = 0;             // 直近start()実行時刻
  let startHistory = [];           // 過去のstart時刻（頻度制限用）
  let bgRecorder = null;           // 背景音声リスナー（MediaRecorder）
  let bgActive = false;            // 背景リスナー稼働中
  let commandCooldown = { pin: 0, record: 0 };
  let bgFallbackActivated = false; // /transcribe不可時にWebSpeechへフォールバック済みか

  async function queryPermission() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: 'microphone' });
        permission = status.state;
        status.onchange = () => {
          permission = status.state;
          console.log(`🎚 Mic permission changed → ${permission}`);
        };
        console.log(`🔐 Mic permission: ${permission}`);
      }
    } catch (e) {
      console.debug('Permissions API not available or failed:', e);
    }
    return permission;
  }

  async function ensureStream() {
    if (stream && stream.getTracks().some(t => t.readyState === 'live')) {
      return stream;
    }
    if (requesting) {
      // 既に要求中なら待つ
      return new Promise((resolve, reject) => {
        let tries = 0;
        const id = setInterval(() => {
          tries++;
          if (stream) {
            clearInterval(id);
            resolve(stream);
          } else if (tries > 40) { // ~4秒
            clearInterval(id);
            reject(new Error('Timed out waiting for mic stream'));
          }
        }, 100);
      });
    }
    requesting = true;
    try {
      await queryPermission();
      if (permission === 'denied') {
        throw new Error('microphone permission denied');
      }
      // 1回だけ取得し、以後再利用
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('🎤 Mic stream acquired');
      try { localStorage.setItem('perm_mic', 'granted'); } catch (_) {}
      return stream;
    } finally {
      requesting = false;
    }
  }

  function releaseStream() {
    if (stream) {
      stream.getTracks().forEach(t => {
        try { t.stop(); } catch(e) {}
      });
      stream = null;
      console.log('🛑 Mic stream released');
    }
  }

  // === SpeechRecognition の初期化（Android/PC） ===
  function initRecognitionIfNeeded() {
    if (recognition || !(window.SpeechRecognition || window.webkitSpeechRecognition) || isIOS) return recognition || null;
    recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.lang = 'ja-JP';
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onstart = () => {
      recognitionActive = true;
      lastStartTs = Date.now();
      startHistory.push(lastStartTs);
      // 履歴を直近15分に制限
      const cutoff = Date.now() - 15 * 60 * 1000;
      startHistory = startHistory.filter(t => t >= cutoff);
      console.log('🎙️ SpeechRecognition started');
    };
    recognition.onend = () => {
      recognitionActive = false;
      if (noAutoRestart) {
        console.log('🛑 Recognition onend (no auto-restart)');
        return;
      }
      // 録音中は再開しない。終了後、少し待ってから再開（通知音の連打を回避）
      if (!recorderActive) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          tryStartRecognition();
        }, 1500);
      }
    };
    recognition.onerror = (e) => {
      console.warn('🗣️ SpeechRecognition error:', e);
      if (noAutoRestart) {
        console.log('🛑 Recognition onerror (no auto-restart)');
        return;
      }
      // 過剰再起動を避け、数秒待つ
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (!recorderActive) tryStartRecognition();
      }, 3000);
    };
    return recognition;
  }

  function tryStartRecognition() {
    if (!recognition) return;
    if (recorderActive) return; // 録音中は開始しない
    if (recognitionActive) return;
    if (!autoStartRecognition) {
      console.log('ℹ️ Voice recognition is disabled (autoStartRecognition=false)');
      return;
    }
    // 頻度制限: Androidは短め(8s)、その他は60s
    const minIntervalMs = (typeof isAndroid !== 'undefined' && isAndroid) ? 8000 : 60000;
    if (Date.now() - lastStartTs < minIntervalMs) {
      console.log('⏱️ Skip start: throttled (<60s)');
      return;
    }
    // 15分で最大回数: Androidは10回、その他は5回
    const maxAttempts = (typeof isAndroid !== 'undefined' && isAndroid) ? 10 : 5;
    if (startHistory.length >= maxAttempts) {
      console.log('🧯 Skip start: max attempts reached in 15min');
      return;
    }
    try { recognition.start(); }
    catch (e) { console.debug('recognition.start skipped:', e?.name || e); }
  }

  function startKeepAlive(intervalSec = 120) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      if (noAutoRestart) return; // ポリシーで禁止中
      if (recorderActive) return; // 録音中は触らない
      if (!autoStartRecognition) return; // OFFなら何もしない
      if (!recognitionActive) {
        console.log('🫧 KeepAlive: tryStartRecognition');
        tryStartRecognition();
      }
    }, Math.max(60, intervalSec) * 1000);
  }

  function stopKeepAlive() {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  async function startBackgroundListener(onCommand) {
    if (bgActive) return;
    // Android向け: SpeechRecognitionが使えない場合の代替。
    // 単一のマイクストリームを維持し、2秒毎に短い音声をサーバーで文字起こし。
    const s = await ensureStream();
    const mimeType = pickBestAudioMime();
    try {
      bgRecorder = mimeType ? new MediaRecorder(s, { mimeType }) : new MediaRecorder(s);
    } catch (e) {
      console.warn('MediaRecorder init failed (BG). Retrying without mimeType:', e);
      try { bgRecorder = new MediaRecorder(s); } catch (e2) { console.error('BG MediaRecorder not available:', e2); throw e2; }
    }
    const maybeTriggerFallback = async (reason) => {
      if (bgFallbackActivated) return;
      bgFallbackActivated = true;
      console.warn('🔁 Switching to Web Speech fallback:', reason);
      stopBackgroundListener();
      // 競合回避設定を解除して、やさしく再起動
      try {
        setNoAutoRestart(false);
        stopKeepAlive();
        startKeepAlive(45); // 45秒毎に再起動チェック
        if (window.voiceRecognition && typeof window.voiceRecognition.start === 'function') {
          window.voiceRecognition.start();
        }
      } catch (e) { console.warn('Fallback start failed', e); }
    };

    bgRecorder.ondataavailable = async (e) => {
      try {
        if (!e.data || e.data.size < 800) return; // 短すぎる断片はスキップ
        const ext = extFromMime(mimeType || (e.data && e.data.type) || '');
        const res = await fetch('/transcribe', {
          method: 'POST',
          body: (() => { const fd = new FormData(); fd.append('audio', e.data, `bg_${Date.now()}.${ext}`); fd.append('session_id', window.sessionId || 'bg'); return fd; })()
        });
        if (!res.ok) {
          await maybeTriggerFallback(`HTTP ${res.status}`);
          return;
        }
        const json = await res.json().catch(() => ({}));
        if (!json || json.status !== 'ok') {
          await maybeTriggerFallback(json && json.message ? json.message : 'unknown error');
          return;
        }
        const text = (json && json.transcript) ? String(json.transcript) : '';
        if (!text) return;
        const now = Date.now();
        if ((/録音|ろくおん/).test(text) && now - commandCooldown.record > 6000) {
          commandCooldown.record = now;
          onCommand && onCommand('record');
        }
        if ((/ピン|ぴん/).test(text) && now - commandCooldown.pin > 6000) {
          commandCooldown.pin = now;
          onCommand && onCommand('pin');
        }
      } catch (err) {
        console.warn('BG transcribe error:', err);
        await maybeTriggerFallback(err && err.message ? err.message : 'exception');
      }
    };
  bgRecorder.start(2000); // 2秒チャンク
    bgActive = true;
    retainStream = true; // 背景動作中はストリームを維持
    console.log('🎧 Background voice listener started');
  }

  function stopBackgroundListener() {
    try { bgRecorder && bgRecorder.state !== 'inactive' && bgRecorder.stop(); } catch (e) {}
    bgRecorder = null;
    bgActive = false;
    retainStream = false;
    console.log('🛑 Background voice listener stopped');
  }

  function pauseBackgroundListener() {
    if (bgRecorder && bgRecorder.state !== 'inactive') {
      try { bgRecorder.stop(); } catch (e) {}
    }
    console.log('⏸️ Background listener paused');
  }

  async function resumeBackgroundListener() {
    if (!bgActive) return;
    try {
      if (bgRecorder) {
        if (bgRecorder.state !== 'recording') {
          bgRecorder.start(2000);
        }
      } else {
        // 何らかで破棄されていた場合は再作成
        await startBackgroundListener(null);
      }
      console.log('▶️ Background listener resumed');
    } catch (e) {
      console.warn('Failed to resume background listener', e);
    }
  }

  function stopRecognition() {
    if (!recognition) return;
    try {
      clearTimeout(restartTimer);
      // 停止を強制（ブラウザ実装差吸収）
      if (typeof recognition.abort === 'function') {
        try { recognition.abort(); } catch(e) { /* noop */ }
      }
      recognition.stop();
    } catch (e) {
      console.debug('recognition.stop error:', e?.name || e);
    }
  }

  function setRecorderActive(flag) {
    recorderActive = flag;
    console.log(`🎛 RecorderActive=${flag}`);
    if (flag) {
      stopRecognition();
    } else {
      // 録音停止後にやや遅延して再開（OS通知の断続的な音を回避）
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        tryStartRecognition();
      }, 1200);
    }
  }

  function getRecognition() {
    return recognition;
  }

  return {
    ensureStream,
    releaseStream,
    queryPermission,
    initRecognitionIfNeeded,
    getRecognition,
    tryStartRecognition,
    stopRecognition,
    setRecorderActive,
    setAutoStart(flag){ autoStartRecognition = !!flag; if(flag) tryStartRecognition(); },
    isAutoStart(){ return autoStartRecognition; },
    setRetainStream(flag){ retainStream = !!flag; },
    shouldRetainStream(){ return retainStream; },
    setNoAutoRestart(flag){ noAutoRestart = !!flag; },
    startKeepAlive,
    stopKeepAlive,
    startBackgroundListener,
    stopBackgroundListener,
    pauseBackgroundListener,
    resumeBackgroundListener,
    isBackgroundActive(){ return bgActive; }
  };
})();

// === 端末で使える音声コーデックを選ぶ（Android互換性向上） ===
function pickBestAudioMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];
  try {
    if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
      for (const mt of candidates) {
        try { if (MediaRecorder.isTypeSupported(mt)) return mt; } catch (_) {}
      }
    }
  } catch (_) {}
  return '';
}

function extFromMime(mt) {
  const m = (mt || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4')) return 'm4a'; // Whisperの推奨拡張子
  return 'webm';
}

// === ビープ音（開始・終了） ===
function playStartBeep() {
  // 2連ビープ: 880Hz(150ms) → 1200Hz(120ms)
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    // 1音目
    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(880, ctx.currentTime);
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.18, ctx.currentTime);
    g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc1.connect(g1);
    g1.connect(gain);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.15);

    // 2音目（オフセット開始）
    const start2 = ctx.currentTime + 0.30;
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(1200, start2);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.16, start2);
    g2.gain.exponentialRampToValueAtTime(0.001, start2 + 0.12);
    osc2.connect(g2);
    g2.connect(gain);
    osc2.start(start2);
    osc2.stop(start2 + 0.12);
  } catch (e) {
    console.warn("🎵 開始ビープ再生失敗:", e);
  }
}

function playEndBeep() {
  // 低めのシングルビープ: 500Hz(180ms)
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(500, ctx.currentTime);
    gain.gain.setValueAtTime(0.16, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
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
      // iOSでも録音中は音声認識を停止
      micManager.setRecorderActive(true);
      const stream = await micManager.ensureStream();
      const mimeType = pickBestAudioMime();
      let recorder;
      try { recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); }
      catch (e) {
        console.warn('iOS recorder init failed, retrying without mimeType:', e);
        recorder = new MediaRecorder(stream);
      }
      let chunks = [];

      recorder.ondataavailable = e => chunks.push(e.data);

      recorder.onstop = async () => {
        micManager.setRecorderActive(false);
        micManager.releaseStream();
        playEndBeep();
  const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        console.log("🎙 iOS録音完了", blob.size);

        // 無音チェック
        if (blob.size < 1000) {
          console.warn("⚠️ 録音が短すぎるため保存スキップ");
          return;
        }

  const ext = extFromMime(mimeType || recorder.mimeType || '');
  const fileName = `ios_${Date.now()}.${ext}`;
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

  // ✅ iOS向け 音声認識/フォールバック統一API
  let iosRecognition = null; // Web Speech
  let iosVoiceActive = false; // UI表示用

  function startIOSVoice() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRec) {
      if (!iosRecognition) {
        iosRecognition = new SpeechRec();
        iosRecognition.lang = 'ja-JP';
        iosRecognition.continuous = true;
        iosRecognition.interimResults = false;
        iosRecognition.onresult = (event) => {
          const transcript = event.results[event.results.length - 1][0].transcript.trim();
          console.log('🎤(iOS) 音声認識結果:', transcript);
          if (/録音|ろくおん/.test(transcript)) {
            console.log('✅ (iOS) 「録音」検出 → 録音');
            iosRecordOnce();
          }
          if (/ピン|ぴん/.test(transcript)) {
            console.log('📍 (iOS) 「ピン」検出 → 現在地ピン');
            if (navigator.geolocation) {
              navigator.geolocation.getCurrentPosition((pos) => {
                const { latitude, longitude } = pos.coords;
                const now = new Date();
                const dateString = now.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
                const timeString = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const label = `音声ピン ${dateString} ${timeString}`;
                window.addVoicePinWithOptions && window.addVoicePinWithOptions(latitude, longitude, label, false, 'voice_command');
              });
            }
          }
        };
        iosRecognition.onend = () => {
          console.log('🔁 (iOS) 音声認識 onend');
          // 過剰再起動を避けつつ再開
          if (iosVoiceActive) setTimeout(() => { try { iosRecognition.start(); } catch(e) {} }, 1500);
        };
        iosRecognition.onerror = (e) => console.error('音声認識エラー(iOS):', e);
      }
      try { iosRecognition.start(); iosVoiceActive = true; console.log('🎙 (iOS) Web Speech開始'); } catch(e) { console.warn('iOS Web Speech開始失敗:', e); }
      return;
    }
    // ❌ Web Speech非対応 → Whisperフォールバック（2秒チャンク）
    console.log('🧩 (iOS) Web Speech非対応 → サーバー文字起こしにフォールバック');
    micManager.startBackgroundListener(async (cmd) => {
      if (cmd === 'record') {
        await iosRecordOnce();
      } else if (cmd === 'pin') {
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition((pos) => {
            const { latitude, longitude } = pos.coords;
            const now = new Date();
            const dateString = now.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
            const timeString = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const label = `音声ピン ${dateString} ${timeString}`;
            window.addVoicePinWithOptions && window.addVoicePinWithOptions(latitude, longitude, label, false, 'voice_command');
          });
        }
      }
    });
    iosVoiceActive = true;
  }

  function stopIOSVoice() {
    try { iosVoiceActive = false; iosRecognition && iosRecognition.stop && iosRecognition.stop(); } catch(e) {}
    try { micManager.stopBackgroundListener && micManager.stopBackgroundListener(); } catch(e) {}
  }

  // グローバル操作API: 画面のトグルボタンからON/OFFできるように
  window.voiceRecognition = {
    start(){ startIOSVoice(); },
    stop(){ stopIOSVoice(); },
    isActive(){ return iosVoiceActive || (micManager.isBackgroundActive && micManager.isBackgroundActive()); }
  };

  // 初回ユーザー操作で一度だけ開始（iOSのオートスタート対策）
  const startOnUserGestureIOS = () => {
    try { startIOSVoice(); } catch(e) { console.warn('iOS音声開始失敗:', e); }
    window.removeEventListener('touchend', startOnUserGestureIOS);
    window.removeEventListener('click', startOnUserGestureIOS);
    window.removeEventListener('keydown', startOnUserGestureIOS);
  };
  window.addEventListener('touchend', startOnUserGestureIOS, { once: true });
  window.addEventListener('click', startOnUserGestureIOS, { once: true });
  window.addEventListener('keydown', startOnUserGestureIOS, { once: true });
}

// === Android / PC 音声認識トリガー ===
else if (window.SpeechRecognition || window.webkitSpeechRecognition) {
  // Android/PC: 初期状態ではAndroidでは音声認識を作成すらしない（手動開始で初期化）
  let recognition = null;

  function attachAndroidRecognitionHandlers(rec) {
    if (!rec) return;
    rec.onresult = async (event) => {
      const text = event.results[event.results.length - 1][0].transcript.trim();
      console.log("🎤 認識結果:", text);

      // === 録音トリガー ===
      if ((/録音|ろくおん/).test(text)) {
        await startRecordingAndUpload();
      }

      // === ピントリガー ===
      if ((/ピン|ぴん/).test(text)) {
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
  }

  if (!isAndroid) {
    recognition = micManager.initRecognitionIfNeeded();
    if (recognition) {
      recognition.lang = "ja-JP";
      recognition.continuous = true;
      recognition.interimResults = false;
      attachAndroidRecognitionHandlers(recognition);
    }
  }

  // 自動起動設定
  const saved = localStorage.getItem('voiceRecognitionAutoStart');
  let enable = isAndroid ? false : (saved === 'true');

  // 記録中ページではAndroidでも起動を許可（権限はensureStreamで都度取得）
  const page = document.body?.dataset?.page;
  if (isAndroid && page === 'recording_active') {
    try {
      recognition = micManager.initRecognitionIfNeeded();
      if (recognition) {
        recognition.lang = "ja-JP";
        recognition.continuous = true;
        recognition.interimResults = false;
        attachAndroidRecognitionHandlers(recognition);
      }
      enable = true;
      console.log('🎤 Auto-start recognition on recording_active (Android)');
    } catch (e) {
      console.warn('Recognition init failed on recording_active:', e);
    }
  }

  micManager.setAutoStart(enable);
  // tryStartRecognition は Android でも recording_active なら呼ぶ
  if (!isAndroid || (isAndroid && page === 'recording_active')) {
    micManager.tryStartRecognition();
  }
  console.log(`✅ 音声認識 初期化（autoStart=${enable}, page=${page}）`);

  // Androidの記録中ページでは、認識の自動再起動ループは抑制しつつ、緩やかなKeepAliveを有効化
  if (isAndroid && page === 'recording_active') {
    micManager.setNoAutoRestart(true);     // onend/onerrorの即時再起動はしない
    micManager.setRetainStream(false);     // 事前取得はしない（競合防止）
    micManager.startKeepAlive(180);        // 3分間隔で穏やかに再起動（上限とスロットル適用）
    // WebSpeechが不安定/未対応な端末向けに、背景リスナーを起動
    const speechAvailable = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    {
      micManager.startBackgroundListener(async (cmd) => {
        if (cmd === 'record') {
          await startRecordingAndUpload();
        } else if (cmd === 'pin') {
          // 現在地にピン
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((pos) => {
              const { latitude, longitude } = pos.coords;
              const now = new Date();
              const dateString = now.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
              const timeString = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              const label = `音声ピン ${dateString} ${timeString}`;
              window.addVoicePinWithOptions && window.addVoicePinWithOptions(latitude, longitude, label, false, 'voice_command');
            });
          }
        }
      });
      // 背景認識を優先するため、KeepAliveは停止（WebSpeech再起動は行わない）
      micManager.stopKeepAlive();
    }
  }

  // グローバル操作APIを公開（UIから制御可能）
  window.voiceRecognition = {
    start(){
      if (!recognition) {
        recognition = micManager.initRecognitionIfNeeded();
        if (recognition) {
          recognition.lang = "ja-JP";
          recognition.continuous = true;
          recognition.interimResults = false;
          attachAndroidRecognitionHandlers(recognition);
        }
      }
      localStorage.setItem('voiceRecognitionAutoStart','true');
      micManager.setAutoStart(true);
    },
    stop(){ micManager.stopRecognition(); localStorage.setItem('voiceRecognitionAutoStart','false'); micManager.setAutoStart(false); },
    isActive(){ return micManager.isAutoStart?.() || false; }
  };

  // Androidでは自動起動OFFだが、最初のユーザー操作で一度だけ起動して利便性を確保
  if (isAndroid) {
    const startOnUserGesture = () => {
      try {
        console.log('👂 初回操作で音声認識を開始（Android）');
        window.voiceRecognition.start();
      } catch (e) {
        console.warn('音声認識の開始に失敗:', e);
      } finally {
        window.removeEventListener('touchend', startOnUserGesture);
        window.removeEventListener('click', startOnUserGesture);
        window.removeEventListener('keydown', startOnUserGesture);
      }
    };
    window.addEventListener('touchend', startOnUserGesture, { once: true });
    window.addEventListener('click', startOnUserGesture, { once: true });
    window.addEventListener('keydown', startOnUserGesture, { once: true });
  }
}

// === Android・PC録音関数 ===
async function startRecordingAndUpload() {
  try {
    // 多重起動防止
    if (window.__isRecordingNow) {
      console.log('⏸️ Recording already in progress, ignoring duplicate trigger');
      return;
    }
    window.__isRecordingNow = true;
  // 録音中は音声認識/背景リスナーを停止し、権限/ストリームは再利用
    micManager.setRecorderActive(true);
  micManager.pauseBackgroundListener?.();
    const stream = await micManager.ensureStream();
    const mimeType = pickBestAudioMime();
    let recorder;
    try { recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); }
    catch (e) {
      console.warn('Recorder init failed, retrying without mimeType:', e);
      recorder = new MediaRecorder(stream);
    }
    const chunks = [];

    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      // 終了音を実停止に同期
      try { playEndBeep(); } catch (_) {}
  const audioBlob = new Blob(chunks, { type: mimeType || 'audio/webm' });
  const ext = extFromMime(mimeType || recorder.mimeType || '');
  const fileName = `whisper_${Date.now()}.${ext}`;
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

      // 録音後のクリーンアップ
      micManager.setRecorderActive(false);
      // 背景リスナー有効時はストリーム維持、無効時は解放
      if (micManager.isBackgroundActive && micManager.isBackgroundActive()) {
        micManager.setRetainStream && micManager.setRetainStream(true);
        micManager.ensureStream().catch(()=>{});
        micManager.resumeBackgroundListener && micManager.resumeBackgroundListener();
      } else {
        micManager.releaseStream();
      }
      window.__isRecordingNow = false;
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
      // 終了ビープは onstop 側で鳴らす
    }, 5000);
  } catch (err) {
    console.error("録音エラー:", err);
  } finally {
    // finallyではマイクを解放しない（録音継続中に止めてしまうのを防ぐ）
    // onstop内でクリーンアップを実施
  }
}

window.playStartBeep = playStartBeep;
window.playEndBeep = playEndBeep;


