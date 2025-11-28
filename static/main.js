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

    // ★ 通常運転が始まったら必ずルートモードを解除
    localStorage.setItem('priorityRouteRecordingActive', 'false');

    // バッファ初期化
    window.gpsLogBuffer = window.gpsLogBuffer || [];
    window.gLogBuffer = window.gLogBuffer || [];
    window.avgGLogBuffer = window.avgGLogBuffer || [];

    if (typeof initMap === 'function') {
        initMap();
    }

    const savedSessionId = localStorage.getItem('activeSessionId');
    const savedStartTime = localStorage.getItem('sessionStartTime');

    if (savedSessionId && savedStartTime) {

        window.sessionId = savedSessionId;
        window.startTime = parseInt(savedStartTime);

        // pause初期化
        window.pauseAccumulatedMs = 0;

        console.log('Session ID set to:', window.sessionId);
        console.log('GPS buffer size:', window.gpsLogBuffer.length);
        console.log('G buffer size:', window.gLogBuffer.length);

        // ★ audio OK
        console.log('🔊 Audio playback enabled (recording active)');

        const sessionIdElement = document.getElementById('session_id');
        if (sessionIdElement) sessionIdElement.textContent = window.sessionId;

        // タイマー開始
        startTimer();

        // GPS 監視開始（maps.js）
        watchPosition();

        // 加速度センサー開始
        if (!window.isMotionDetectionActive) {
            startMotionDetection();
        } else {
            console.log('Motion detection already active, skipping startup');
        }

        // 初期スコアリセット
        initScores();

        // 自動キャリブレーション開始
        startAutoCalibration();

        // ログフラッシュ開始
        startLogFlush();

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

    // ▶ 記録開始ボタン（recording_start.htmlで独自に処理されるためここでは何もしない）
    // recording_start.html内のインラインスクリプトでルート選択とセッション作成を行う
    if (startButton && !startButton.hasEventListener) {
        console.log('Start button found - handled by recording_start.html inline script');
        startButton.hasEventListener = true;
    }

    // ▶ 記録終了ボタン
    if (endButton && !endButton.hasEventListener) {
        console.log('Adding click listener to end button');
        endButton.addEventListener('click', async () => {
            const isRouteMode = localStorage.getItem('priorityRouteRecordingActive') === 'true';
            const confirmEnd = confirm(isRouteMode ? 'ルート記録を終了しますか？' : '記録を終了してよろしいですか？');
            if (!confirmEnd) {
                console.log('End canceled by user.');
                return;
            }

            // 🚗 ルート記録モードの終了
            if (isRouteMode && window.priorityRouteAPI) {
                window.priorityRouteAPI
                    .stop(true)
                    .then(() => {
                        // ルート記録フラグを確実にオフ
                        localStorage.setItem('priorityRouteRecordingActive', 'false');
                        window.location.href = '/recording/start';
                    })
                    .catch((e) => {
                        console.warn('Route stop error:', e);
                        // エラーしてもフラグはオフにしてスタート画面へ
                        localStorage.setItem('priorityRouteRecordingActive', 'false');
                        window.location.href = '/recording/start';
                    });
                return;
            }

            // 🚘 通常の運転セッション終了
            relockAudio(); // 🔒 終了時にロック
            // まず flush + セッション終了だけ実施（内部では画面遷移させない）
            await endSession(true);

            // 🔄 すぐに loading 画面へ遷移してユーザーに「処理中」を見せる
            window.location.href = `/sessions/recording/datasend?session_id=${window.sessionId}`;
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
                const routeStart =
                    (window.priorityRouteAPI &&
                        window.priorityRouteAPI.getRouteStartTime &&
                        window.priorityRouteAPI.getRouteStartTime()) ||
                    Number(localStorage.getItem('priorityRouteStartTime')) ||
                    Date.now();
                window.startTime = routeStart;
                startTimer();
            } catch (e) {
                console.warn('Failed to start route timer', e);
            }

            // G値とピンUIは非表示
            try {
                const gBox = document.getElementById('g-box');
                if (gBox) gBox.style.display = 'none';
                const pinBtn = document.getElementById('addPinBtn');
                if (pinBtn) pinBtn.style.display = 'none';
            } catch (e) {}

            // センサー/助言/音声は起動しない

        } else {
            // 通常記録モード
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
            // ★ FIX: start 画面でもキャリブレーション収集を開始
            startAutoCalibration();
        }
    } else {
        console.log('No specific initialization for path:', currentPath);
    }

    console.log('=== DOMContentLoaded initialization completed ===');
});
