// main.js - メインエントリーポイント

import { startSession, endSession, startLogFlush, startPraiseCheck } from './session.js';
import { initMap, watchPosition } from './maps.js';
import { startMotionDetection, startAutoCalibration, stopMotionDetection } from './sensors.js';
import { startTimer, initScores } from './utils.js';
import { unlockAudio, relockAudio } from './audio.js';

console.log('=== main.js LOADED ===');
console.log('Current URL:', window.location.href);
console.log('Current pathname:', window.location.pathname);
console.log('Document ready state:', document.readyState);

// グローバル関数をwindowオブジェクトに設定（HTMLから呼び出すため）
window.startSession = startSession;
window.endSession = endSession;
window.initMap = initMap;
window.unlockAudio = unlockAudio; // iOS音声アンロック用に追加
// iOSのユーザー操作イベントから呼べるようにエクスポート
window.startMotionDetection = startMotionDetection;
window.stopMotionDetection = stopMotionDetection;

// 記録中画面の初期化処理
function initActiveRecording() {
    if (typeof initMap === 'function') {
        initMap();
    }
    const savedSessionId = localStorage.getItem('activeSessionId');
    const savedStartTime = localStorage.getItem('sessionStartTime');
    if (savedSessionId && savedStartTime) {
        window.sessionId = savedSessionId;
        window.startTime = parseInt(savedStartTime);
        console.log('Session ID set to:', window.sessionId);
        console.log('GPS buffer size:', window.gpsLogBuffer.length);
        console.log('G buffer size:', window.gLogBuffer.length);
        console.log('🔊 Audio playback enabled (recording active)');
        const sessionIdElement = document.getElementById('session_id');
        if (sessionIdElement) sessionIdElement.textContent = window.sessionId;
        startTimer();
        watchPosition();
        if (!window.isMotionDetectionActive) {
            startMotionDetection();
        } else {
            console.log('Motion detection already active, skipping startup');
        }

        // ★スコア初期化（走行開始時にリセット）
        initScores();
        // ★FIX: active画面でもキャリブレーションを念のため実行
        startAutoCalibration();
        startLogFlush();
        //startPraiseCheck();
        console.log('Active recording initialized with session:', window.sessionId);
    } else {
        console.error('No active session found');
        window.location.href = '/recording/start';
    }
}

// ページ読み込み時の初期化
document.addEventListener('DOMContentLoaded', function() {
    console.log('=== DOMContentLoaded EVENT FIRED ===');
    const currentPath = window.location.pathname;
    console.log('Current path detected:', currentPath);
    const startButton = document.getElementById('start-button');
    const endButton = document.getElementById('end-button');
    console.log('Start button found:', !!startButton);
    console.log('End button found:', !!endButton);
    if (startButton && !startButton.hasEventListener) {
        console.log('Adding click listener to start button');
        startButton.addEventListener('click', () => {
            // ルートの存在チェック（アクティブ・保存済みの両方を考慮）
            const routeIdLS = localStorage.getItem('priorityRouteId');
            let latestRouteExists = false;
            try {
                if (window.priorityRouteAPI && window.priorityRouteAPI.getLatestRouteId) {
                    const latestId = window.priorityRouteAPI.getLatestRouteId();
                    latestRouteExists = !!latestId;
                }
            } catch (e) { console.warn('Failed to check latest route id:', e); }

            if (!routeIdLS && !latestRouteExists) {
                const doSetup = confirm('ルートが設定されていません。ルート設定を開始しますか？');
                if (doSetup) {
                    if (window.priorityRouteAPI && window.priorityRouteAPI.start) {
                        try {
                            window.priorityRouteAPI.start();
                            window.location.assign('/recording/active');
                        } catch (e) {
                            console.error('ルート設定開始に失敗:', e);
                            alert('ルート設定の開始に失敗しました。ネットワークや位置情報の許可をご確認ください。');
                        }
                    } else {
                        alert('ルート設定機能が読み込まれていません');
                    }
                }
                return; // ルート未設定時は通常の運転開始をしない
            }

            const confirmStart = confirm('記録を開始してよろしいですか？');
            if (confirmStart) {
                startSession();
            } else {
                console.log('Recording start canceled by user.');
            }
        });
        startButton.hasEventListener = true;
    }
    if (endButton && !endButton.hasEventListener) {
        console.log('Adding click listener to end button');
        endButton.addEventListener('click', async () => {
            const isRouteMode = localStorage.getItem('priorityRouteRecordingActive') === 'true';
            const confirmEnd = confirm(isRouteMode ? 'ルート記録を終了しますか？' : '記録を終了してよろしいですか？');
            if (!confirmEnd) {
                console.log('End canceled by user.');
                return;
            }

            if (isRouteMode && window.priorityRouteAPI) {
                // ルート記録の終了
                window.priorityRouteAPI.stop(true).then(() => {
                    window.location.href = '/recording/start';
                }).catch(() => {
                    window.location.href = '/recording/start';
                });
                return;
            }

            // 🚗 通常の運転セッション終了
            relockAudio(); // 🔒 終了時にロック
            await endSession(true); // Firestore保存含む

            // ✅ ここから重点ポイントAI評価を実行
            try {
                // ... 前提条件チェック (sessionId) ...

                console.log(`🤖 重点ポイントAIフィードバック生成開始: session_id=${sessionId}`);
                const res = await fetch(`/api/focus_feedback/${sessionId}`, { method: 'POST' });

                if (res.ok) {
                    const data = await res.json();
                    console.log('✅ フィードバック生成成功:', data);
                    //alert('重点ポイントのフィードバックを生成しました！結果は次の画面で確認できます。'); // 成功
                } else {
                    // API側でエラーが起きている (4xx, 5xx ステータス)
                    console.error('❌ フィードバック生成APIエラー (HTTP):', res.status);
                    //alert(`重点ポイントフィードバックの生成に失敗しました。サーバーエラー: ${res.status}`); // APIエラー
                }
            } catch (err) {
                // ネットワーク、JSONパースエラーなど
                console.error('❌ フィードバック生成中に致命的なエラー:', err);
                //alert('ネットワーク接続またはデータ処理中に予期せぬエラーが発生しました。'); // 致命的エラー
            }

            // 🧭 終了後にセッション一覧ページへ遷移
            window.location.href = '/recording/completed';
        });

        endButton.hasEventListener = true;
    }
    console.log('Initializing based on current path...');
    if (currentPath === '/recording/active') {
        console.log('Initializing active recording screen');
        const isRouteMode = localStorage.getItem('priorityRouteRecordingActive') === 'true';
        if (isRouteMode) {
            // ルートモード: セッションは使わない
            console.log('Route recording mode detected. Initializing minimal map UI.');
            // セッション関連を明示的に無効化
            try {
                window.sessionId = null;
                localStorage.removeItem('activeSessionId');
                localStorage.removeItem('sessionStartTime');
            } catch (e) {}
            if (typeof initMap === 'function') {
                initMap();
            }
            // UI更新用にGPSは使う（maps.js 側で sessionId が無ければ保存しない）
            try { watchPosition(); } catch (e) {}
            // タイマー表示（ルート開始時刻を使用）
            try {
                const routeStart = (window.priorityRouteAPI && window.priorityRouteAPI.getRouteStartTime && window.priorityRouteAPI.getRouteStartTime())
                    || Number(localStorage.getItem('priorityRouteStartTime'))
                    || Date.now();
                window.startTime = routeStart;
                startTimer();
            } catch (e) { console.warn('Failed to start route timer', e); }
            // G値とピンUIは非表示
            try {
                const gBox = document.getElementById('g-box');
                if (gBox) gBox.style.display = 'none';
                const pinBtn = document.getElementById('addPinBtn');
                if (pinBtn) pinBtn.style.display = 'none';
            } catch (e) {}
            // センサー/助言/音声は起動しない
        } else {
            initActiveRecording();
        }
    } else if (currentPath === '/recording/start' || currentPath === '/') {
        console.log('Initializing start recording screen');
        if (typeof initMap === 'function') {
            console.log('Calling initMap function');
            initMap();
        } else {
            console.log('initMap function not available');
        }
        // ルート記録モード中は助言・指摘・音声を起動しない（GPSのみ背景で route_recorder が担当）
        if (localStorage.getItem('priorityRouteRecordingActive') === 'true') {
            console.log('Route recording active: suppressing sensors and advice on start screen');
        } else {
            console.log('Starting GPS and motion monitoring for start screen (display only)');
            watchPosition();
            startMotionDetection();
            // ★FIX: start 画面でもキャリブレーション収集を開始
            startAutoCalibration();
        }
    } else {
        console.log('No specific initialization for path:', currentPath);
    }
    console.log('=== DOMContentLoaded initialization completed ===');
});