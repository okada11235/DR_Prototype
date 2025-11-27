import math
import statistics
from datetime import datetime
from google.cloud import firestore
from pytz import timezone
import os
import numpy as np  # ジャーク計算で使用

# ==========================================================
#  基本設定
# ==========================================================
JST = timezone("Asia/Tokyo")
db = firestore.Client()

# 改良版スコアの重み（ユーザー指定：甘め設定）
WEIGHT_A = 3.0  # jerk（イベント密度）側の重み
WEIGHT_B = 2.0  # speed_std（速度ばらつき）側の重み

# ==========================================================
# 🚀 加加速度 (Jerk) と安定性指標の計算
# ==========================================================
def calculate_jerk_and_stability(avg_g_logs: list, sample_rate_hz: float = 10.0):
    """
    全走行ログからジャーク（加加速度）と速度の標準偏差を計算し、
    スコア計算に必要な指標を抽出する。

    Args:
        avg_g_logs: avg_g_logs コレクションから取得した時系列データ（dictのリスト）
                    必要キー: g_x, g_z, speed, （あれば）distance_km
        sample_rate_hz: サンプリングレート（例: 10Hz）

    Returns:
        dict: jerk_z_count / jerk_x_count / jerk_events_per_km / speed_std / total_distance_km / data_points
    """
    # Numpy配列化（欠損は0埋め）
    gz_vals = np.array([float(g.get("g_z", 0.0)) for g in avg_g_logs])  # 前後G
    gx_vals = np.array([float(g.get("g_x", 0.0)) for g in avg_g_logs])  # 左右G
    speeds  = np.array([float(g.get("speed", 0.0)) for g in avg_g_logs])  # 速度 (km/h)

    # データ点数が少なすぎる場合の早期リターン
    if len(gz_vals) < 2:
        return {
            "jerk_z_count": 0,
            "jerk_x_count": 0,
            "total_jerk_events": 0,
            "jerk_events_per_km": 0.0,
            "speed_std": 0.0,
            "total_distance_km": 0.1,  # 最低値を確保
            "data_points": len(gz_vals),
        }

    # === 1) ジャーク (ΔG/Δt) の計算 ===
    dt = 1.0 / float(sample_rate_hz)
    jerk_z = np.diff(gz_vals) / dt   # 前後
    jerk_x = np.diff(gx_vals) / dt   # 左右

    # === 2) ジャークイベントのカウント ===
    # 閾値（G/s）。1.0 G/s ≈ 9.8 m/s^3
    JERK_THRESHOLD = 0.5
    jerk_z_count = int(np.sum(np.abs(jerk_z) > JERK_THRESHOLD))
    jerk_x_count = int(np.sum(np.abs(jerk_x) > JERK_THRESHOLD))

    # === 3) 速度の標準偏差（そのまま） ===
    speed_std = float(np.std(speeds)) if len(speeds) > 1 else 0.0

    # === 4) 走行距離の取得 ===
    total_distance_km = avg_g_logs[-1].get("distance_km", 1.0)
    try:
        total_distance_km = float(total_distance_km)
    except Exception:
        total_distance_km = 1.0
    if total_distance_km < 0.1:
        total_distance_km = 0.1  # 極端な短距離は下限

    # === 5) 正規化指標 ===
    total_events = jerk_z_count + jerk_x_count
    jerk_events_per_km = total_events / total_distance_km

    return {
        "jerk_z_count": jerk_z_count,
        "jerk_x_count": jerk_x_count,
        "total_jerk_events": total_events,
        "jerk_events_per_km": float(jerk_events_per_km),
        "speed_std": float(speed_std),
        "total_distance_km": float(total_distance_km),
        "data_points": len(gz_vals),
    }

# ==========================================================
# 🌙 改良版スコア計算（log1pで減点を緩和）
# ==========================================================
def calculate_overall_driving_score(jerk_stats: dict, A=WEIGHT_A, B=WEIGHT_B):
    """
    改良版：減点を log1p に通して極端な値でも飽和しやすくする
      deduction = A*log1p(jerk_events_per_km) + B*log1p(speed_std)
      score     = clamp(100 - deduction, 0, 100)
    """
    if not jerk_stats or jerk_stats.get("data_points", 0) == 0:
        return 0, "データ点数が少ないため参考値です。データ不足"

    jerk_per_km = float(jerk_stats["jerk_events_per_km"])
    speed_std   = float(jerk_stats["speed_std"])

    from math import log1p
    Jn = log1p(jerk_per_km)
    Sn = log1p(speed_std)

    deduction = A * Jn + B * Sn
    final_score = 100 - deduction
    final_score = 0 if final_score < 0 else (100 if final_score > 100 else round(final_score))

    # コメント生成
    if   final_score >= 90: comment = "非常に滑らかで、ほとんど完璧な運転でした。素晴らしい！"
    elif final_score >= 80: comment = "安定性が高く、安全運転の意識が感じられます。急操作は非常に少ないです。"
    elif final_score >= 70: comment = "おおむね良好な運転ですが、加減速またはハンドルの操作に若干の揺れが見られました。"
    elif final_score >= 50: comment = "改善余地あり。急操作を減らし、速度変化を滑らかにするとスコアが上がります。"
    else:                   comment = "急な操作が多く、速度のばらつきも大きい傾向です。特に加減速の滑らかさを意識しましょう。"

    return final_score, comment

# ==========================================================
# 📊 総合スコア解析（Firestore読み込み→計算→保存）
# ==========================================================
def calculate_session_overall_score(session_id: str, user_id: str, sample_rate_hz: float = 10.0) -> dict:
    """
    セッション全体のログを対象に、ジャークと速度ばらつきに基づく総合スコアを計算し、Firestoreに保存する。
    """
    sess_ref = db.collection("sessions").document(session_id)

    # ログの読み込み（timestamp順）
    avg_g_logs = [
        d.to_dict()
        for d in sess_ref.collection("avg_g_logs").order_by("timestamp").stream()
    ]

    if not avg_g_logs or len(avg_g_logs) < 5:
        print(f"⚠️ ログデータが非常に少ないです（{len(avg_g_logs)}点）。参考値としてスコアを計算します。")
        jerk_stats = calculate_jerk_and_stability(avg_g_logs, sample_rate_hz=sample_rate_hz)
        overall_score, score_comment = calculate_overall_driving_score(jerk_stats)
        score_comment = "データ点数が少ないため参考値です。" + score_comment
        score_data = {
            "overall_score": overall_score,
            "score_comment": score_comment,
            "calculated_at": datetime.now(JST),
            "jerk_stats": jerk_stats,
            "weights": {"A": WEIGHT_A, "B": WEIGHT_B},
            "scoring_mode": "improved_log1p",
        }
        sess_ref.update(score_data)
        return score_data

    # 1) ジャーク＆安定性指標
    jerk_stats = calculate_jerk_and_stability(avg_g_logs, sample_rate_hz=sample_rate_hz)

    # 2) スコア
    overall_score, score_comment = calculate_overall_driving_score(jerk_stats)

    # 3) Firestoreに保存
    score_data = {
        "overall_score": overall_score,
        "score_comment": score_comment,
        "calculated_at": datetime.now(JST),
        "jerk_stats": jerk_stats,
        "weights": {"A": WEIGHT_A, "B": WEIGHT_B},
        "scoring_mode": "improved_log1p",
        "sample_rate_hz_used": float(sample_rate_hz),
    }

    sess_ref.update(score_data)
    print(f"✅ Session {session_id} の総合スコア: {overall_score}点（log1p改良版 / A={WEIGHT_A}, B={WEIGHT_B}）で更新")
    return score_data

# --- 呼び出し例 ---
# result = calculate_session_overall_score(session_id="YOUR_SESSION_ID", user_id="YOUR_USER_ID", sample_rate_hz=10.0)
# print(result)
