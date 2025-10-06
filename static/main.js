// main.js - メインエントリーポイント

import { startSession, endSession, startLogFlush, startPraiseCheck } from './session.js';
import { initMap, watchPosition } from './maps.js';
import { startMotionDetection, startAutoCalibration } from './sensors.js';
import { startTimer } from './utils.js';

console.log('=== main.js LOADED ===');
console.log('Current URL:', window.location.href);
console.log('Current pathname:', window.location.pathname);
console.log('Document ready state:', document.readyState);

// グローバル関数をwindowオブジェクトに設定（HTMLから呼び出すため）
window.startSession = startSession;
window.endSession = endSession;
window.initMap = initMap;

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
        startButton.addEventListener('click', () => startSession());
        startButton.hasEventListener = true;
    }
    if (endButton && !endButton.hasEventListener) {
        console.log('Adding click listener to end button');
        endButton.addEventListener('click', () => endSession(true));
        endButton.hasEventListener = true;
    }
    console.log('Initializing based on current path...');
    if (currentPath === '/recording/active') {
        console.log('Initializing active recording screen');
        initActiveRecording();
    } else if (currentPath === '/recording/start' || currentPath === '/') {
        console.log('Initializing start recording screen');
        if (typeof initMap === 'function') {
            console.log('Calling initMap function');
            initMap();
        } else {
            console.log('initMap function not available');
        }
        console.log('Starting GPS and motion monitoring for start screen (display only)');
        watchPosition();
        startMotionDetection();
        // ★FIX: start 画面でもキャリブレーション収集を開始
        startAutoCalibration();
    } else {
        console.log('No specific initialization for path:', currentPath);
    }
    console.log('=== DOMContentLoaded initialization completed ===');
});