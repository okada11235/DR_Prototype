// config.js - 設定値と定数

// === 基本テスト用ログ ===
console.log('=== config.js LOADED ===');

// ★★★ 判定閾値とクールダウン期間の定数化 ★★★
// ※ ご要望により「しきい値」は変更していません
export const COOLDOWN_MS = 3000; // イベント発生後のクールダウン期間（3秒に延長）

// ■ イベント（指摘）用 - ユーザー指定の閾値（※変更なし）
export const ACCEL_EVENT_MS2   = 0.4;  // |加速度| >= 0.4 m/s^2 -> 急発進/急ブレーキ
export const JERK_EVENT_MS3    = 1.5;  // |ジャーク| >= 1.5 m/s^3 -> 速度のカクつき指摘
export const YAW_RATE_EVENT    = 0.6;  // |角速度| >= 0.6 rad/s -> 急ハンドル
export const ANG_ACCEL_EVENT   = 0.6;  // |角加速度| >= 0.6 rad/s^2 -> カーブのカクつき指摘
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
    jerk_low: ["/static/audio/ジャークが少ないことについて褒める（1）.wav", "/static/audio/ジャークが少ないことについて褒める（2）.wav"],
    accel_good: ["/static/audio/加速度について褒める（1）.wav", "/static/audio/加速度について褒める（2）.wav"],
    ang_accel_good: ["/static/audio/角加速度について褒める（1）.wav", "/static/audio/角加速度について褒める（2）.wav"],
    ang_accel_high: ["/static/audio/角加速度が高いことに指摘（1）.wav", "/static/audio/角加速度が高いことに指摘（2）.wav"], // ★追加
    ang_vel_high: ["/static/audio/角速度が高いことに指摘（1）.wav", "/static/audio/角速度が高いことに指摘（2）.wav"],
    ang_vel_low: ["/static/audio/角速度が低いことについて褒める（1）.wav", "/static/audio/角速度が低いことについて褒める（2）.wav"],
    sharp_turn: ["/static/audio/急ハンドルについて指摘（1）.wav", "/static/audio/急ハンドルについて指摘（2）.wav", "/static/audio/急ハンドルについて指摘（3）.wav"],
    yaw_rate_high: ["/static/audio/急ハンドルについて指摘（1）.wav", "/static/audio/急ハンドルについて指摘（2）.wav", "/static/audio/急ハンドルについて指摘（3）.wav"], // ★重複キーを1本化
    sudden_brake: ["/static/audio/急ブレーキについて指摘（1）.wav", "/static/audio/急ブレーキについて指摘（2）.wav", "/static/audio/急ブレーキについて指摘（3）.wav"],
    sudden_accel: ["/static/audio/急発進について指摘（1）.wav", "/static/audio/急発進について指摘（2）.wav"],
    speed_fluct: ["/static/audio/速度の変化や「カクつき」について指摘（1）.wav", "/static/audio/速度の変化や「カクつき」について指摘（2）.wav"],
    jerk: ["/static/audio/速度の変化や「カクつき」について指摘（1）.wav", "/static/audio/速度の変化や「カクつき」について指摘（2）.wav"]
};