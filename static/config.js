// config.js - 設定値と定数

// === 基本テスト用ログ ===
console.log('=== config.js LOADED ===');

// ★★★ 判定閾値とクールダウン期間の定数化 ★★★
// ※ ご要望により「しきい値」は変更していません
export const COOLDOWN_MS = 3000; // イベント発生後のクールダウン期間（3秒に延長）

// ■ イベント（指摘）用 - ユーザー指定の閾値（※変更なし）
export const ACCEL_EVENT_MS2   = 1.0;  // |加速度| >= 1.0 m/s^2 -> 急発進/急ブレーキ
export const BRAKE_EVENT_MS2   = 1.0;  // |減速度| >= 1.0 m/s^2 -> 急ブレーキ
export const JERK_EVENT_MS3    = 3.0;  // |ジャーク| >= 3.0 m/s^3 -> 速度のカクつき指摘
export const YAW_RATE_EVENT    = 0.8;  // |角速度| >= 0.8 rad/s -> 急ハンドル
export const ANG_ACCEL_EVENT   = 1.5;  // |角加速度| >= 1.5 rad/s^2 -> カーブのカクつき指摘
export const SHARP_TURN_G_THRESHOLD = 0.5; // 横Gのしきい値 (やや厳しく: 0.5G)（※変更なし）

// DeviceMotionEventのフレームスキップ管理（60Hzを15Hzに削減）
export const MOTION_FRAME_SKIP = 4; // 4フレームに1回処理（元は6フレーム）

// 初期化期間管理（起動直後の不安定なデータを除外）
export const MOTION_INIT_DURATION = 3000; // 3秒間は初期化期間
export const STABLE_SAMPLES_REQUIRED = 10; // 10回連続で安定したら処理開始

// 褒め条件（3分間適切な運転を維持）
export const PRAISE_INTERVAL = 180000; // 3分間に戻す 

// 音声再生のクールダウン管理
export const AUDIO_COOLDOWN_MS = 5000; // 運転中の適切な指摘間隔（5秒）

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
    stable_drive: ["/static/audio/stable_drive_1.wav", "/static/audio/stable_drive_2.wav"]
};