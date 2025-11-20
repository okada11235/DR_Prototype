export function resetState() {
    console.log("=== resetState() FULL RESET ===");

    // --- セッション情報 ---
    window.sessionId = null;
    window.startTime = null;

    // --- ログバッファ ---
    window.gLogBuffer = [];
    window.gpsLogBuffer = [];
    window.avgGLogBuffer = [];

    // --- GPS監視 ---
    if (window.watchId) {
        navigator.geolocation.clearWatch(window.watchId);
    }
    window.watchId = null;
    window.path = [];
    window.prevSpeed = null;
    window.prevLatLng = null;
    window.prevTime = null;

    // --- モーション関連 ---
    window.isMotionDetectionActive = false;
    window.motionFrameCounter = 0;
    window.motionInitialized = false;

    // 最新G値
    window.latestGX = 0;
    window.latestGY = 0;
    window.latestGZ = 0;

    // キャリブレーション
    window.orientationMode = "auto";
    window.calibrationData = null;
    window._calibSamples = [];
    window._calibTimer = null;
    window.isCalibrating = false;
    window.calibrationSamples = [];
    window.stableSampleCount = 0;

    // --- 各種イベント ---
    window.suddenBrakes = 0;
    window.suddenAccels = 0;
    window.sharpTurns = 0;
    window.speedViolations = 0;

    window.lastBrakeEventTime = 0;
    window.lastAccelEventTime = 0;
    window.lastTurnEventTime = 0;

    // drivingState
    window.drivingState = {
        turnStart: 0,
        accelStart: 0,
        brakeStart: 0,
        straightStart: 0
    };

    // --- タイマー ---
    if (window.timerInterval) clearInterval(window.timerInterval);
    window.timerInterval = null;

    // 褒め判定
    if (window.praiseInterval) clearInterval(window.praiseInterval);
    window.praiseInterval = null;

    // --- 音声 ---
    window.lastAudioPlayTime = {};
    window.isAudioPlaying = false;
    window.isUnlockAudioPlaying = false;

    console.log("=== reset complete ===");
}
