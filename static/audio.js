// audio.js - 音声再生機能

import { audioFiles, AUDIO_COOLDOWN_MS } from './config.js';

console.log('=== audio.js LOADED ===');

// --- ランダムで音声を再生する関数（クールダウン付き + 記録中のみ + グローバルロック） ---
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
    const lastPlayTime = window.lastAudioPlayTime[category] || 0;
    if (now - lastPlayTime < AUDIO_COOLDOWN_MS) {
        console.log(`🔇 Audio cooldown active for ${category} (${Math.round((AUDIO_COOLDOWN_MS - (now - lastPlayTime)) / 1000)}s remaining)`);
        return;
    }
    
    // 音声再生処理
    window.isAudioPlaying = true;
    const files = audioFiles[category];
    const file = files[Math.floor(Math.random() * files.length)];
    console.log(`🔊 Playing audio (recording): ${category} -> ${file}`);
    console.log(`Current cooldowns:`, Object.keys(window.lastAudioPlayTime).map(k => `${k}:${Math.round((Date.now() - window.lastAudioPlayTime[k])/1000)}s`).join(', '));
    
    const audio = new Audio(file);
    audio.play().then(() => {
        window.lastAudioPlayTime[category] = now;
        console.log(`✓ Audio played successfully: ${category} - Next available in ${AUDIO_COOLDOWN_MS/1000}s`);
        window.audioLockTimeout = setTimeout(() => {
            window.isAudioPlaying = false;
            console.log(`🔓 Audio lock released for ${category}`);
        }, Math.max(2000, AUDIO_COOLDOWN_MS / 3));
    }).catch(err => {
        console.warn("Audio play failed:", err);
        console.warn("Audio file path:", file);
        window.isAudioPlaying = false;
        if (window.audioLockTimeout) {
            clearTimeout(window.audioLockTimeout);
            window.audioLockTimeout = null;
        }
    });
}