// audio.js - 音声再生機能（iOS対応強化版＋無音パルス安定化）
import { audioFiles, AUDIO_COOLDOWN_MS } from './config.js';

console.log('=== audio.js LOADED (iOS Enhanced + KeepAlive Version) [FIXED] ===');

// --- iOS対策用のグローバル状態管理 ---
window.audioCtx = null;
window.audioUnlocked = false;
window.audioPreloadedFiles = new Map();
window.isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
window.isUnlockAudioPlaying = false; // アンロック用音声再生フラグ
window.keepAliveIntervalId = null;   // ←★ 無音パルス管理用を追加

// FIX: AudioContextの初期化は初回アクセスまたはジェスチャー時に遅延させる
// if (!window.audioContext) {
//   window.audioContext = new (window.AudioContext || window.webkitAudioContext)();
//   console.log("🔊 AudioContext initialized globally");
// }

// 状態が suspend の場合、自動復帰
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && window.audioContext?.state === "suspended") {
    window.audioContext.resume();
    console.log("🔄 AudioContext resumed (visibilitychange)");
  }
});


// === 音声ファイルプリロード機能（Android対策で無効化） ===============
function preloadAudioFiles() {
    console.log('🔄 Audio preload disabled for Android compatibility');
    return;
}

// === Android/iOS対応：強化されたオーディオアンロック処理 (AudioContextを遅延作成)==============
export function unlockAudio() {
  try {
    if (!window.audioContext) { // FIX: 初回アクセス時に作成
      window.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      console.log("🎧 AudioContext created (on unlock)");
    }
    const ctx = window.audioContext;
    if (ctx.state === 'suspended') {
        ctx.resume();
        console.log("🔄 AudioContext resumed (iOS対応)");
    }

    // 無音再生でアンロック
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);

    window.audioUnlocked = true;
    localStorage.setItem('audioUnlocked', 'true'); // ✅ 状態保存
    console.log("🔓 AudioContext unlocked (iOS対応)");
  } catch (err) {
    console.error("❌ unlockAudio failed:", err);
  }
}

export function relockAudio() {
  try {
    if (window.audioContext) {
      // FIX: AudioContextを閉じず、suspendしてインスタンスを保持
      window.audioContext.suspend(); 
      console.log("🔒 AudioContext suspended (FIXED)");
    }
    // localStorage.removeItem('audioUnlocked'); // 状態は保持し、次回自動再開を試みる
    window.audioUnlocked = false;
    console.log("🔒 Audio relocked");
  } catch (err) {
    console.error("❌ relockAudio failed:", err);
  }
}



// === Android専用の補助関数（無効化） ======================
// Android対策：機能を簡素化するため無効化

// === 新規追加：記録終了時にAudioContextを安全に停止 ===
export function stopAudioSystem() {
    console.log("🛑 Stopping Audio System...");
    if (window.keepAliveIntervalId) {
        clearInterval(window.keepAliveIntervalId);
        window.keepAliveIntervalId = null;
        console.log("⏹️ keep-alive interval cleared");
    }
    // FIX: close() の代わりに relockAudio() を使用
    relockAudio();
    // window.audioCtx = null; // インスタンスは保持する
    window.audioUnlocked = false;
}

// --- iOS用：定期的にAudioContextを維持 + 追加のiOS対策 ---
function keepAudioAlive() {
  if (!window.audioContext) return;

  // 状態をチェックして必要なら再開
  if (window.audioContext.state === "suspended") {
    window.audioContext.resume().then(() => {
      console.log("🌀 AudioContext auto-resumed (keepAlive)");
      window.audioUnlocked = true;
    }).catch(e => {
      console.warn("⚠️ AudioContext resume failed in keepAlive:", e);
    });
  }

  // 無音パルスを再生して Safari に「音声を維持中」と伝える
  try {
    const buffer = window.audioContext.createBuffer(1, 1, 22050);
    const source = window.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(window.audioContext.destination);
    source.start(0);
    console.log("💓 keep-alive silent pulse played");
  } catch (e) {
    console.warn("⚠️ keep-alive pulse failed:", e);
  }
}

// Android対応：静かな音声テスト再生
function testQuietAudioPlayback() {
    // アンロック用のsilence.wav再生なので、playRandomAudio経由で実行
    console.log('🔇 Playing silence.wav for unlock (won\'t block other audio)');
    playRandomAudio('silence', true); // isUnlockAudio = true
}

// ページ可視性変更時の対策（iOS Safari のタブ切り替え対応）
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && window.audioContext && window.audioContext.state === 'suspended') {
        console.log('📱 Page became visible, attempting AudioContext resume...');
        window.audioContext.resume().catch(e => {
            console.warn('Failed to resume AudioContext on visibility change:', e);
        });
    }
});

// === 強化されたランダム音声再生（Android対応デバッグ強化版） ============
export async function playRandomAudio(category, isUnlockAudio = false) {
    // === 詳細デバッグ情報 ===
    console.log('=== AUDIO PLAY REQUEST DEBUG ===');
    console.log(`📱 Device: ${navigator.userAgent}`);
    console.log(`🎵 Category: ${category}`);
    console.log(`📊 SessionID: ${window.sessionId || 'NONE'}`);
    console.log(`🔒 IsPlaying: ${window.isAudioPlaying || false}`);
    console.log(`🔓 AudioUnlocked: ${window.audioUnlocked}`);
    console.log(`🎧 AudioCtx State: ${window.audioContext ? window.audioContext.state : 'NONE'}`); // FIX: window.audioContextに統一
    console.log(`📁 Audio Files Available: ${Object.keys(audioFiles).length}`);
    console.log(`🔓 IsUnlockAudio: ${isUnlockAudio}`);

    try {
        if (!window.audioContext) { // FIX: window.audioContextに統一
            window.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log("🎧 AudioContext created (auto init in playRandomAudio)");
        }
        if (window.audioContext.state === 'suspended') {
            console.log("🔄 AudioContext suspended → resume()");
            await window.audioContext.resume();
            console.log("✅ AudioContext resumed successfully");
            window.audioUnlocked = true;
        }
    } catch (err) {
        console.warn("⚠️ Failed to initialize or resume AudioContext:", err);
    }
    
    // 基本的な再生条件チェック
    if (!window.sessionId && !isUnlockAudio && !window.isReplayMode) {
        console.log(`🔇 Audio skipped (not recording): ${category}`);
        return;
    }
    // アンロック用音声でない場合のみ音声ロックをチェック
    if (!isUnlockAudio && window.isAudioPlaying && !window.isUnlockAudioPlaying) {
        console.log(`🔇 Audio locked (another audio playing): ${category}`);
        return;
    }
    if (!audioFiles[category]) {
        console.warn('❌ Audio category not found:', category);
        console.log('Available categories:', Object.keys(audioFiles));
        return;
    }

    // クールダウンチェック（アンロック音声は除外）
    if (!isUnlockAudio) {
        const now = Date.now();
        const lastPlayTime = window.lastAudioPlayTime?.[category] || 0;
        if (now - lastPlayTime < AUDIO_COOLDOWN_MS) {
            console.log(`🔇 Audio cooldown active for ${category} (${Math.round((AUDIO_COOLDOWN_MS - (now - lastPlayTime)) / 1000)}s remaining)`);
            return;
        }
    }

    // Android対策：音声システムの状態詳細チェック
    console.log('=== ANDROID AUDIO SYSTEM CHECK ===');
    console.log(`🤖 Is Android: ${/Android/.test(navigator.userAgent)}`);
    console.log(`🎵 Audio Context: ${window.audioContext ? 'Created' : 'Not Created'}`);
    console.log(`📱 User Gesture Detected: ${window.audioUnlocked}`);
    console.log(`🔊 Preloaded Files: ${window.audioPreloadedFiles ? window.audioPreloadedFiles.size : 0}`);

    // iOS特有の事前チェック（アンロック音声は除外）
    if (!isUnlockAudio && window.isIOSDevice && !window.audioUnlocked) {
        console.warn('⚠️ iOS device detected but audio not unlocked yet');
        return;
    }

    // AudioContext状態チェック（AndroidにもAudioContext対応）
    if (window.audioContext && window.audioContext.state === "suspended" && !isUnlockAudio) {
        console.log('🔄 Attempting to resume AudioContext before playback...');
        window.audioContext.resume().then(() => {
            console.log("🔈 AudioContext resumed, proceeding with playback");
            executeAudioPlayback(category, Date.now(), isUnlockAudio);
        }).catch(e => {
            console.warn("Failed to resume AudioContext:", e);
            // AudioContextが失敗してもHTML5 Audioで試行
            executeAudioPlayback(category, Date.now(), isUnlockAudio);
        });
    } else {
        console.log('✅ AudioContext ready or not needed, proceeding with playback');
        executeAudioPlayback(category, Date.now(), isUnlockAudio);
    }
}

// === 実際の音声再生実行（Android対応デバッグ強化版） =================
function executeAudioPlayback(category, timestamp, isUnlockAudio = false) {
    // アンロック音声用の特別なフラグ管理
    if (isUnlockAudio) {
        window.isUnlockAudioPlaying = true;
        console.log('🔓 Unlock audio playback started, other audio can still play');
    } else {
        window.isAudioPlaying = true;
        console.log('🔒 Regular audio playback started, blocking other regular audio');
    }
    
    const files = audioFiles[category];
    const file = files[Math.floor(Math.random() * files.length)];
    console.log(`🔊 Playing audio: ${category} -> ${file} (unlock: ${isUnlockAudio})`);

    // Android対策：プリロードを使わずシンプルな音声再生
    let audio = new Audio(file);
    let usingPreloaded = false;
    audio.volume = 1.0;
    audio.preload = 'auto';
    
    // Android対策
    if (/Android/.test(navigator.userAgent)) {
        audio.crossOrigin = 'anonymous';
    }
    
    if (window.audioPreloadedFiles && window.audioPreloadedFiles.has(file)) {
        const preloadedAudio = window.audioPreloadedFiles.get(file);
        console.log(`📦 Preloaded audio found - readyState: ${preloadedAudio.readyState}`);
        
        // Android対策：プリロード音声の状態詳細チェック
        if (preloadedAudio.readyState >= 2) { // HAVE_CURRENT_DATA以上
            audio = preloadedAudio.cloneNode();
            usingPreloaded = true;
            console.log('✅ Using healthy preloaded audio file');
        } else {
            console.warn('⚠️ Preloaded audio not ready, creating new instance');
            audio = new Audio(file);
        }
    } else {
        audio = new Audio(file);
        console.log(' Creating new audio instance (no preload available)');
    }

    // Android対策：音声要素の詳細設定
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous'; // CORS対策
    
    // Android Chrome対策：明示的に音量設定
    try {
        audio.volume = 1.0;
        console.log(`🔊 Volume set to: ${audio.volume}`);
    } catch (e) {
        console.warn('⚠️ Volume setting failed:', e);
    }

    // Android対策：再生前の状態チェック
    console.log(`=== AUDIO ELEMENT STATUS ===`);
    console.log(`📁 Source: ${audio.src}`);
    console.log(`📊 ReadyState: ${audio.readyState}`);
    console.log(`📱 NetworkState: ${audio.networkState}`);
    console.log(`🔇 Muted: ${audio.muted}`);
    console.log(`🔊 Volume: ${audio.volume}`);
    console.log(`⏸️ Paused: ${audio.paused}`);

    // iOS/Android共通：再生前の追加設定
    if (window.isIOSDevice || /Android/.test(navigator.userAgent)) {
        try {
            audio.load(); // 明示的にロード
            console.log('📱 Mobile: Explicit load() called');
        } catch (e) {
            console.warn('⚠️ Mobile load() failed:', e);
        }
    }

    // === 音声再生実行（エラーハンドリング強化） ===
    let playAttempted = false;
    const playPromise = audio.play();
    
    if (playPromise !== undefined) {
        playAttempted = true;
        console.log('🎵 Promise-based playback initiated...');
        
        playPromise
            .then(() => {
                // 再生成功
                if (!isUnlockAudio) {
                    window.lastAudioPlayTime = window.lastAudioPlayTime || {};
                    window.lastAudioPlayTime[category] = timestamp;
                }
                console.log(`✅ Audio played successfully: ${category} (unlock: ${isUnlockAudio})`);
                console.log(`📊 Final audio state - duration: ${audio.duration}s, currentTime: ${audio.currentTime}s`);
                
                // 再生終了またはタイムアウトでロック解除
                const unlockAudioLock = () => {
                    if (isUnlockAudio) {
                        window.isUnlockAudioPlaying = false;
                        console.log(`🔓 Unlock audio lock released for ${category}`);
                    } else {
                        window.isAudioPlaying = false;
                        console.log(`🔓 Regular audio lock released for ${category}`);
                    }
                };

                // 音声終了イベントリスナー
                audio.addEventListener('ended', () => {
                    console.log(`🏁 Audio ended naturally: ${category} (unlock: ${isUnlockAudio})`);
                    unlockAudioLock();
                }, { once: true });
                
                audio.addEventListener('error', (e) => {
                    console.error(`❌ Audio error during playback: ${category} (unlock: ${isUnlockAudio})`, e);
                    unlockAudioLock();
                }, { once: true });

                // フォールバック：最大再生時間でタイムアウト
                const timeoutDuration = isUnlockAudio ? 1000 : Math.max(5000, AUDIO_COOLDOWN_MS);
                window.audioLockTimeout = setTimeout(() => {
                    console.log(`⏰ Audio timeout for ${category} (unlock: ${isUnlockAudio})`);
                    unlockAudioLock();
                }, timeoutDuration);
            })
            .catch(err => {
                // 再生失敗
                console.error("❌ Promise-based audio play failed:", err);
                console.log(`📊 Error details - name: ${err.name}, message: ${err.message}`);
                handleAudioPlayFailure(category, err, isUnlockAudio);
            });
    } else {
        // Promise未対応ブラウザ（古いAndroid等）
        console.log('🔄 Fallback: Using event-based audio playback');
        playAttempted = true;
        
        audio.addEventListener('canplaythrough', () => {
            if (!isUnlockAudio) {
                window.lastAudioPlayTime = window.lastAudioPlayTime || {};
                window.lastAudioPlayTime[category] = timestamp;
            }
            console.log(`✅ Audio played successfully (fallback): ${category} (unlock: ${isUnlockAudio})`);
        }, { once: true });

        audio.addEventListener('error', (err) => {
            console.error("❌ Event-based audio play failed:", err);
            handleAudioPlayFailure(category, err, isUnlockAudio);
        }, { once: true });

        // 再生終了でロック解除
        audio.addEventListener('ended', () => {
            if (isUnlockAudio) {
                window.isUnlockAudioPlaying = false;
                console.log(`🔓 Unlock audio lock released (fallback) for ${category}`);
            } else {
                window.isAudioPlaying = false;
                console.log(`🔓 Regular audio lock released (fallback) for ${category}`);
            }
        }, { once: true });

        // フォールバックタイムアウト
        const timeoutDuration = isUnlockAudio ? 1000 : Math.max(5000, AUDIO_COOLDOWN_MS);
        window.audioLockTimeout = setTimeout(() => {
            if (isUnlockAudio) {
                window.isUnlockAudioPlaying = false;
                console.log(`🔓 Unlock audio lock timeout (fallback) for ${category}`);
            } else {
                window.isAudioPlaying = false;
                console.log(`🔓 Regular audio lock timeout (fallback) for ${category}`);
            }
        }, timeoutDuration);
    }

    // 再生試行が行われなかった場合の緊急処理
    if (!playAttempted) {
        console.error('❌ No audio playback method available');
        if (isUnlockAudio) {
            window.isUnlockAudioPlaying = false;
        } else {
            window.isAudioPlaying = false;
        }
    }
}

// === 音声再生失敗時の処理（Android対応強化） ======================
function handleAudioPlayFailure(category, error, isUnlockAudio = false) {
    if (isUnlockAudio) {
        window.isUnlockAudioPlaying = false;
        console.log('🔓 Unlock audio playback failed, releasing unlock lock');
    } else {
        window.isAudioPlaying = false;
        console.log('🔒 Regular audio playback failed, releasing regular lock');
    }
    
    if (window.audioLockTimeout) {
        clearTimeout(window.audioLockTimeout);
        window.audioLockTimeout = null;
    }

    console.error(`=== AUDIO PLAYBACK FAILURE ===`);
    console.error(`📂 Category: ${category}`);
    console.error(`❌ Error Name: ${error.name}`);
    console.error(`📝 Error Message: ${error.message}`);
    console.error(`🤖 Is Android: ${/Android/.test(navigator.userAgent)}`);
    console.error(`📱 Is iOS: ${window.isIOSDevice}`);

    // iOS特有のエラー判定と対策
    if (window.isIOSDevice && error.name === 'NotAllowedError') {
        console.warn('🚫 iOS audio playback not allowed - user gesture may be required');
        window.audioUnlocked = false; // アンロック状態をリセット
    } 
    // Android特有のエラー判定と対策
    else if (/Android/.test(navigator.userAgent)) {
        if (error.name === 'NotAllowedError') {
            console.warn('🚫 Android audio playback not allowed - user gesture may be required');
            window.audioUnlocked = false;
            
            // Android用：即座に再アンロック試行
            setTimeout(() => {
                console.log('🤖 Android: Attempting immediate re-unlock...');
                unlockAudio();
            }, 1000);
        } else if (error.name === 'NotSupportedError') {
            console.warn('🚫 Android audio format not supported');
            // 音声ファイル形式の問題の可能性
        } else if (error.name === 'AbortError') {
            console.warn('🔄 Android audio playback aborted - may retry on next request');
        }
    } 
    else if (error.name === 'AbortError') {
        console.warn('🔄 Audio playback aborted - may retry on next request');
    } else {
        console.error('❌ Unknown audio playback error:', error);
    }
}

// === デバッグ用：手動音声テスト関数（開発者コンソール用） =============
window.testAudioPlayback = function(category = 'good_brake') {
    console.log('🧪 === MANUAL AUDIO TEST ===');
    console.log(`Testing category: ${category}`);
    
    // セッション状態を一時的に設定
    const originalSessionId = window.sessionId;
    const originalIsPlaying = window.isAudioPlaying;
    
    window.sessionId = 'test-session';
    window.isAudioPlaying = false;
    
    try {
        playRandomAudio(category);
    } finally {
        // 5秒後に元の状態を復元
        setTimeout(() => {
            window.sessionId = originalSessionId;
            window.isAudioPlaying = originalIsPlaying;
            console.log('🧪 Test completed, original state restored');
        }, 5000);
    }
};

// === デバッグ用：音声システム状態表示 ============================
window.showAudioStatus = function() {
    console.log('=== AUDIO SYSTEM STATUS ===');
    console.log(`📱 User Agent: ${navigator.userAgent}`);
    console.log(`🤖 Is Android: ${/Android/.test(navigator.userAgent)}`);
    console.log(`📱 Is iOS: ${window.isIOSDevice}`);
    console.log(`🔓 Audio Unlocked: ${window.audioUnlocked}`);
    console.log(`🎧 AudioContext: ${window.audioContext ? window.audioContext.state : 'Not Created'}`);
    console.log(`📦 Preloaded Files: ${window.audioPreloadedFiles ? window.audioPreloadedFiles.size : 0}`);
    console.log(`🔒 Is Playing: ${window.isAudioPlaying}`);
    console.log(` Is Unlock Playing: ${window.isUnlockAudioPlaying}`);
    console.log(`📊 Session ID: ${window.sessionId || 'NONE'}`);
    console.log(`🕐 Last Play Times:`, window.lastAudioPlayTime || 'NONE');
    
    if (window.audioPreloadedFiles && window.audioPreloadedFiles.size > 0) {
        console.log('=== PRELOADED AUDIO FILES ===');
        window.audioPreloadedFiles.forEach((audio, path) => {
            console.log(`📁 ${path}: readyState=${audio.readyState}, networkState=${audio.networkState}`);
        });
    }
};

// === audio.js の末尾に追加 ===
window.playRandomAudio = playRandomAudio;