// audio.js - 音声再生機能（iOS対応 + 無音KeepAlive版）
import { audioFiles, AUDIO_COOLDOWN_MS } from './config.js';

console.log('=== audio.js LOADED (iOS Safe Version with KeepAlive) ===');

// --- AudioContext（iOS対応のための共通インスタンス） ---
window.audioCtx = null;

// === iOS用：オーディオアンロック処理 =====================================
export function unlockAudio() {
    if (!window.audioCtx) {
        try {
            window.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn("AudioContext init failed:", e);
            return;
        }
    }
    if (window.audioCtx.state === "suspended") {
        window.audioCtx.resume().then(() => {
            console.log("🔈 AudioContext resumed (user gesture)");
        }).catch(e => console.warn("Audio resume failed:", e));
    }

    // 無音を一瞬だけ鳴らしてiOSの再生ロック解除
    const buffer = window.audioCtx.createBuffer(1, 1, 22050);
    const source = window.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(window.audioCtx.destination);
    try {
        source.start(0);
        console.log("🎧 Silent audio played to unlock iOS audio");
    } catch (e) {
        console.warn("Silent audio failed:", e);
    }
}

// --- iOS用：定期的にAudioContextを維持する（30秒おき） ---
function keepAudioAlive() {
    if (!window.audioCtx) return;
    if (window.audioCtx.state === "suspended") {
        window.audioCtx.resume().then(() => {
            console.log("🌀 AudioContext auto-resumed (keepAlive)");
        }).catch(() => {});
    } else {
        // 無音トーンでActivity維持
        const osc = window.audioCtx.createOscillator();
        const gain = window.audioCtx.createGain();
        gain.gain.value = 0;
        osc.connect(gain).connect(window.audioCtx.destination);
        osc.start();
        osc.stop(window.audioCtx.currentTime + 0.1);
    }
}
setInterval(keepAudioAlive, 30000); // 30秒ごとに維持

// === ユーザー操作イベントで自動アンロック（iOS用） ==========================
["touchstart", "click"].forEach(ev => {
    document.addEventListener(ev, unlockAudio, { once: true });
});

// === ランダムで音声を再生する関数（クールダウン付き + 記録中のみ + グローバルロック） ===
export function playRandomAudio(category) {
    if (!window.sessionId) {
        console.log(`🔇 Audio skipped (not recording): ${category}`);
        return;
    }
    if (window.isAudioPlaying) {
        console.log(`🔇 Audio locked (another audio playing): ${category}`);
        return;
    }
    if (!audioFiles[category]) {
        console.warn('Audio category not found:', category);
        return;
    }

    const now = Date.now();
    const lastPlayTime = window.lastAudioPlayTime?.[category] || 0;
    if (now - lastPlayTime < AUDIO_COOLDOWN_MS) {
        console.log(`🔇 Audio cooldown active for ${category} (${Math.round((AUDIO_COOLDOWN_MS - (now - lastPlayTime)) / 1000)}s remaining)`);
        return;
    }

    // --- Audio再生開始 ---
    window.isAudioPlaying = true;
    const files = audioFiles[category];
    const file = files[Math.floor(Math.random() * files.length)];
    console.log(`🔊 Playing audio: ${category} -> ${file}`);

    const audio = new Audio(file);

    // iOS Safari での "resume" 確認
    if (window.audioCtx && window.audioCtx.state === "suspended") {
        window.audioCtx.resume().then(() => console.log("🔈 AudioContext resumed before play"));
    }

    audio.play().then(() => {
        window.lastAudioPlayTime = window.lastAudioPlayTime || {};
        window.lastAudioPlayTime[category] = now;
        console.log(`✓ Audio played successfully: ${category}`);
        window.audioLockTimeout = setTimeout(() => {
            window.isAudioPlaying = false;
            console.log(`🔓 Audio lock released for ${category}`);
        }, Math.max(2000, AUDIO_COOLDOWN_MS / 3));
    }).catch(err => {
        console.warn("⚠️ Audio play failed:", err);
        window.isAudioPlaying = false;
        if (window.audioLockTimeout) {
            clearTimeout(window.audioLockTimeout);
            window.audioLockTimeout = null;
        }
    });
}
