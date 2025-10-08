// config.js - 設定値と定数

// === 基本テスト用ログ ===
console.log('=== config.js LOADED ===');

// ★★★ 新しい判定閾値とクールダウン期間の定数化 ★★★
export const COOLDOWN_MS = 3000; // イベント発生後のクールダウン期間（3秒）
export const BUMP_DETECTION_THRESHOLD = 0.30; // バンプ検出用縦G閾値（0.30g）
export const BUMP_DISABLE_DURATION = 300; // バンプ検出時の他軸判定休止時間（0.3s）

// ■ スムージング設定
export const SMOOTHING_ALPHA = 0.25; // 指数平滑化係数（α=0.2-0.3の中間値）
export const SMOOTHING_WINDOW_MS = 400; // 移動平均ウィンドウ（300-500msの中間値）

// ■ 褒め条件の閾値
export const GOOD_TURN_MIN_G = 0.10;     // 良い旋回 最小横G
export const GOOD_TURN_MAX_G = 0.25;     // 良い旋回 最大横G
export const GOOD_TURN_MAX_LONG_G = 0.20; // 良い旋回時の最大前後G
export const GOOD_TURN_DURATION = 1500;   // 良い旋回 持続時間（1.5s）

export const GOOD_ACCEL_MIN_G = 0.10;     // 良い加速 最小前後G
export const GOOD_ACCEL_MAX_G = 0.25;     // 良い加速 最大前後G
export const GOOD_ACCEL_MAX_LAT_G = 0.20; // 良い加速時の最大横G
export const GOOD_ACCEL_DURATION = 1000;  // 良い加速 持続時間（1.0s）

export const GOOD_BRAKE_MIN_G = -0.30;    // 良いブレーキ 最小前後G
export const GOOD_BRAKE_MAX_G = -0.15;    // 良いブレーキ 最大前後G
export const GOOD_BRAKE_MAX_LAT_G = 0.20; // 良いブレーキ時の最大横G
export const GOOD_BRAKE_DURATION = 1000;  // 良いブレーキ 持続時間（1.0s）

// ■ 警告条件の閾値
export const SUDDEN_ACCEL_G_THRESHOLD = 0.35;     // 急発進 前後G閾値

export const SUDDEN_BRAKE_G_THRESHOLD = -0.45;    // 急ブレーキ 前後G閾値

export const SHARP_TURN_G_THRESHOLD = 0.40;       // 急旋回 横G閾値

// DeviceMotionEventのフレームスキップ管理（60Hzを15Hzに削減）
export const MOTION_FRAME_SKIP = 4; // 4フレームに1回処理（元は6フレーム）

// 初期化期間管理（起動直後の不安定なデータを除外）
export const MOTION_INIT_DURATION = 3000; // 3秒間は初期化期間
export const STABLE_SAMPLES_REQUIRED = 10; // 10回連続で安定したら処理開始

// 褒め条件（3分間適切な運転を維持）
export const PRAISE_INTERVAL = 180000; // 3分間に戻す 

// 音声再生のクールダウン管理
export const AUDIO_COOLDOWN_MS = 3000; // 運転中の適切な指摘間隔（5秒）

// ★FIX: 音声ファイルパスの重複/不足を修正（カテゴリ名の不整合を解消）
export const audioFiles = {
    jerk_low: ["/static/audio/jerk_low_praise_1.wav", "/static/audio/jerk_low_praise_2.wav"],
    good_accel: ["/static/audio/acceleration_good_1.wav", "/static/audio/acceleration_good_2.wav"],
    ang_accel_good: ["/static/audio/angular_acceleration_good_1.wav", "/static/audio/angular_acceleration_good_2.wav"],
    ang_accel_high: ["/static/audio/angular_acceleration_good_1.wav", "/static/audio/angular_acceleration_good_2.wav"], // ★追加
    ang_vel_high: ["/static/audio/angular_velocity_high_1.wav", "/static/audio/angular_velocity_high_2.wav"],
    ang_vel_low: ["/static/audio/angular_velocity_low_1.wav", "/static/audio/angular_velocity_low_2.wav"],
    sharp_turn: ["/static/audio/sharp_turn_1.wav", "/static/audio/sharp_turn_2.wav", "/static/audio/sharp_turn_3.wav"],
    yaw_rate_high: ["/static/audio/sharp_turn_1.wav", "/static/audio/sharp_turn_2.wav", "/static/audio/sharp_turn_3.wav"], // ★重複キーを1本化
    sudden_brake: ["/static/audio/sudden_brake_1.wav", "/static/audio/sudden_brake_2.wav", "/static/audio/sudden_brake_3.wav"],
    sudden_accel: ["/static/audio/sudden_acceleration_1.wav", "/static/audio/sudden_acceleration_2.wav"],
    speed_fluct: ["/static/audio/speed_jerkiness_1.wav", "/static/audio/speed_jerkiness_2.wav"],
    jerk: ["/static/audio/speed_jerkiness_1.wav", "/static/audio/speed_jerkiness_2.wav"],
    good_brake: ["/static/audio/good_brake_1.wav", "/static/audio/good_brake_2.wav"],
    stable_drive: ["/static/audio/stable_drive_1.wav", "/static/audio/stable_drive_2.wav"],
    silence: ["/static/audio/silence.wav"]
};