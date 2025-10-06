// state.js - グローバル状態管理

console.log('=== state.js LOADED ===');

// セッション関連
window.sessionId = null;
window.timerInterval = null;
window.startTime = null;
window.watchId = null;
window.map = null;
window.polyline = null;
window.path = [];

// 現在位置を示すマーカー
window.currentPositionMarker = null;
window.eventMarkers = [];

// モーション検出の状態管理
window.isMotionDetectionActive = false;

// DeviceMotionEventのフレームスキップ管理
window.motionFrameCounter = 0;

// 初期化期間管理
window.motionInitTime = null;
window.stableSampleCount = 0;

// イベントカウンター
window.suddenBrakes = 0;
window.suddenAccels = 0;
window.sharpTurns = 0;
window.speedViolations = 0; // 法定速度チェックはなくなるが残す

// イベントのクールダウン管理
window.lastBrakeEventTime = 0;
window.lastAccelEventTime = 0;
window.lastTurnEventTime = 0;

// センサー最新値（G換算）
window.latestGX = 0;
window.latestGY = 0;
window.latestGZ = 0;

// ログ用バッファ
window.gLogBuffer = [];
window.gpsLogBuffer = [];

window.logFlushInterval = null; // 10秒ごとの送信タイマーID
window.isSessionStarting = false; // セッション開始リクエスト中フラグ

// センサー値補正
window.orientationMode = "auto"; 
window.calibrationData = null;

// === ジャーク・角速度・角加速度用 ===
// ジャーク用：直前サンプル
window.lastAccelSample = null;         // m/s^2
window.lastAccelSampleTime = null;     // ms
// 角速度・角加速度用：直前値
window.lastYawRate = null;             // rad/s
window.lastYawTime = null;             // ms

// rotationRateの利用可否（フォールバック判定に使用）
window._rotationAvailable = false;

// 褒め判定（最後に高値を超えた時刻）
window.lastHighJerkTime = Date.now();
window.lastHighAccelTime = Date.now();
window.lastHighYawRateTime = Date.now();
window.lastHighAngAccelTime = Date.now();

window.praiseInterval = null;

// 音声再生のクールダウン管理
window.lastAudioPlayTime = {};

// グローバル音声ロック（どのカテゴリでも1つしか同時再生しない）
window.isAudioPlaying = false;
window.audioLockTimeout = null;

// GPS関連の前回値
window.prevSpeed = null;
window.prevLatLng = null;
window.prevTime = null;

// オートキャリブレーション用
window._calibSamples = [];
window._calibTimer = null;

// セッションID設定関数
export function setSessionId(id) {
    window.sessionId = id;
}

// 状態リセット関数
export function resetState() {
    window.sessionId = null;
    window.suddenBrakes = 0;
    window.suddenAccels = 0;
    window.sharpTurns = 0;
    window.speedViolations = 0;
    window.lastAudioPlayTime = {};
    window.gLogBuffer = [];
    window.gpsLogBuffer = [];
    window.path = [];
    
    // カウンター表示更新
    const brakeElement = document.getElementById('brake-count');
    const accelElement = document.getElementById('accel-count');
    const turnElement = document.getElementById('turn-count');
    
    if (brakeElement) brakeElement.textContent = '0';
    if (accelElement) accelElement.textContent = '0';
    if (turnElement) turnElement.textContent = '0';
}