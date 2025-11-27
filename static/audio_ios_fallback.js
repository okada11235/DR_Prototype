// audio_ios_fallback.js - iOS限定フォールバック音声再生
console.log("🎧 audio_ios_fallback.js loaded");

window.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
window.eventAudioBuffer = null;

/**
 * iOS専用のevent_audio.wavをロード
 */
window.loadEventAudio = async function() {
  if (!window.isIOS) {
    console.log("✅ Non-iOS detected: skip event_audio load");
    return;
  }

  try {
    if (!window.audioContext)
      window.audioContext = new (window.AudioContext || window.webkitAudioContext)();

    const ctx = window.audioContext;
    const response = await fetch("/static/audio/combined_all.wav");
    const arrayBuffer = await response.arrayBuffer();
    window.eventAudioBuffer = await ctx.decodeAudioData(arrayBuffer);
    console.log("✅ event_audio.wav loaded successfully");
  } catch (err) {
    console.error("❌ Failed to load event_audio:", err);
  }
};

/**
 * iOS専用の範囲再生関数
 * @param {number} startSec - 再生開始位置（秒）
 * @param {number} durationSec - 再生する長さ（秒）
 */
window.playEventAudioSegment = function(startSec, durationSec = 2.0) {
  if (!window.isIOS || !window.audioContext || !window.eventAudioBuffer) return;
  try {
    const ctx = window.audioContext;
    const source = ctx.createBufferSource();
    source.buffer = window.eventAudioBuffer;
    source.connect(ctx.destination);
    source.start(0, startSec, durationSec);
    console.log(`▶️ iOS segment playback start=${startSec}s length=${durationSec}s`);
  } catch (e) {
    console.error("❌ playEventAudioSegment failed:", e);
  }
};

/**
 * iOS用 音声アンロック（touchイベント時に呼ぶ）
 */
window.initIOSAudioUnlock = function() {
  if (!window.isIOS) return;
  const unlock = () => {
    if (!window.audioContext)
      window.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = window.audioContext;
    if (ctx.state === "suspended") ctx.resume();
    // 無音再生でアンロック
    const buffer = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    console.log("🔓 iOS Audio unlocked via user gesture");
    document.removeEventListener("touchstart", unlock);
    document.removeEventListener("click", unlock);
  };
  document.addEventListener("touchstart", unlock, { once: true });
  document.addEventListener("click", unlock, { once: true });
};

// === 自動初期化 ===
document.addEventListener("DOMContentLoaded", async () => {
  if (window.isIOS) {
    window.initIOSAudioUnlock();
    await window.loadEventAudio();
  }
});
