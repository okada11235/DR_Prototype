import math
import statistics
from datetime import datetime
from google.cloud import firestore
from pytz import timezone
import os
import numpy as np # 新たに追加: ジャーク計算のためにNumpyを使用
# google.generativeai の初期化コードは省略

JST = timezone("Asia/Tokyo")
db = firestore.Client()

# === 定義済みの定数などは省略 ===

# ==========================================================
# 🚀 新規追加：加加速度 (Jerk) 関連の処理
# ==========================================================

def calculate_jerk_and_stability(avg_g_logs: list, sample_rate_hz: float = 10.0):
    """
    全走行ログからジャーク（加加速度）と速度の標準偏差を計算し、
    スコア計算に必要な指標を抽出する。
    
    Args:
        avg_g_logs: avg_g_logs コレクションから取得した時系列データリスト
        sample_rate_hz: センサーデータのサンプリングレート（例: 1秒間に10回）
        
    Returns:
        dict: Jerk Events per km, 速度の標準偏差などスコア指標
    """
    # データを Numpy 配列に変換
    gz_vals = np.array([g.get("g_z", 0.0) for g in avg_g_logs]) # 前後G
    gx_vals = np.array([g.get("g_x", 0.0) for g in avg_g_logs]) # 左右G
    speeds = np.array([g.get("speed", 0.0) for g in avg_g_logs]) # 速度 (km/h)

    if len(gz_vals) < 2:
        return None, 0

    # 1. 加速度の変化率 (Jerk) の計算 (numpy.diffを使用)
    # Jerk = d(Acceleration) / dt
    # dt はサンプリング間隔 (1 / sample_rate_hz)
    dt = 1.0 / sample_rate_hz
    
    # 前後Gのジャーク (加減速の変化の唐突さ)
    jerk_z = np.diff(gz_vals) / dt 
    
    # 左右Gのジャーク (ハンドリングの変化の唐突さ)
    jerk_x = np.diff(gx_vals) / dt 
    
    # 2. ジャークイベントのカウント
    
    # 運転の急操作を測るためのジャーク閾値 (単位: G/s, 経験的に設定)
    # G=9.8m/s^2 なので、1.0 G/s は 9.8 m/s^3 程度の変化率
    JERK_THRESHOLD = 0.5 
    
    # Jerk_zが閾値を超えたイベント回数 (急加速/急減速)
    jerk_z_count = np.sum(np.abs(jerk_z) > JERK_THRESHOLD)
    
    # Jerk_xが閾値を超えたイベント回数 (急ハンドル/急な車線変更)
    jerk_x_count = np.sum(np.abs(jerk_x) > JERK_THRESHOLD)

    # 3. 速度の標準偏差 (安定性)
    # 速度データはGPSから取得し、平滑化されていないため、そのまま標準偏差を計算
    if len(speeds) > 1:
        speed_std = np.std(speeds)
    else:
        speed_std = 0.0

    # 4. 走行距離の計算 (正規化のため)
    # ここでは、セッション情報から走行距離 (total_distance_km) を取得する前提
    # 走行距離がない場合は、データ点数で代替するなどの措置が必要
    total_distance_km = avg_g_logs[-1].get("distance_km", 1.0) # ログの最後の要素から距離を取得
    if total_distance_km < 0.1: # 短すぎる走行は 0.1km で計算
         total_distance_km = 0.1 

    # 5. 正規化された指標の算出
    jerk_events_per_km = (jerk_z_count + jerk_x_count) / total_distance_km
    
    return {
        "jerk_z_count": int(jerk_z_count),
        "jerk_x_count": int(jerk_x_count),
        "total_jerk_events": int(jerk_z_count + jerk_x_count),
        "jerk_events_per_km": float(jerk_events_per_km),
        "speed_std": float(speed_std),
        "total_distance_km": float(total_distance_km),
        "data_points": len(gz_vals),
    }

def calculate_overall_driving_score(jerk_stats: dict):
    """
    ジャーク統計と標準偏差を使って総合スコアを計算する関数 (100点満点)。
    
    スコア計算式: 100 - (重みA * Jerk Events per km) - (重みB * Speed Std)
    """
    if not jerk_stats:
        return 0, "データ不足"

    # 重みパラメータの決定 (調整可能)
    # A: Jerk Events per km の重み (急操作の回数がスコアに与える影響)
    WEIGHT_A = 2.0 
    # B: Speed Std の重み (速度の安定性がスコアに与える影響)
    WEIGHT_B = 3.0
    
    # 指標値
    jerk_index = jerk_stats["jerk_events_per_km"]
    speed_std_index = jerk_stats["speed_std"]
    
    # 基礎点 (100点) から減点
    deduction = (WEIGHT_A * jerk_index) + (WEIGHT_B * speed_std_index)
    
    # 最終スコアを計算し、0〜100点に丸める
    final_score = 100 - deduction
    
    if final_score < 0:
        final_score = 0
    elif final_score > 100:
        final_score = 100
        
    final_score = round(final_score)
    
    # 運転評価コメントの生成
    if final_score >= 90:
        comment = "非常に滑らかで、ほとんど完璧な運転でした。素晴らしい！"
    elif final_score >= 80:
        comment = "安定性が高く、安全運転の意識が感じられます。急操作は非常に少ないです。"
    elif final_score >= 70:
        comment = "おおむね良好な運転ですが、加減速またはハンドルの操作に若干の揺れが見られました。"
    else:
        comment = "急な操作が散見されます。特に加減速の変化を滑らかにする練習をしましょう。"

    return final_score, comment


# ==========================================================
# 📊 新規追加：メイン総合スコア解析
# ==========================================================
def calculate_session_overall_score(session_id: str, user_id: str) -> dict:
    """
    セッション全体のログを対象に、加加速度と標準偏差に基づく総合スコアを計算し、
    Firestoreに保存する。
    """
    sess_ref = db.collection("sessions").document(session_id)
    
    # ログの読み込み
    # avg_g_logs には g_x, g_z, speed, distance_km (累積距離) が含まれている前提
    avg_g_logs = [
        d.to_dict()
        for d in sess_ref.collection("avg_g_logs").order_by("timestamp").stream()
    ]
    
    if not avg_g_logs or len(avg_g_logs) < 10: # 最低限のデータ点数
        print(f"⚠️ ログデータが不足しています（{len(avg_g_logs)}点）。スコア計算をスキップします。")
        return {"overall_score": 0, "comment": "データ不足によりスコア計算ができませんでした。"}
    
    # 1. ジャークと安定性指標の計算
    jerk_stats = calculate_jerk_and_stability(avg_g_logs)
    
    # 2. 総合スコアの計算
    overall_score, score_comment = calculate_overall_driving_score(jerk_stats)
    
    # 3. Firestoreに保存
    score_data = {
        "overall_score": overall_score,
        "score_comment": score_comment,
        "calculated_at": datetime.now(JST),
        "jerk_stats": jerk_stats # 詳細な指標も保存
    }
    
    # sessionsドキュメント自体に保存
    sess_ref.update(score_data)
    
    print(f"✅ Session {session_id} の総合スコア: {overall_score}点 で更新されました。")
    return score_data

# --- 他の関数（calculate_detailed_stats, get_focus_ratingなど）はそのまま利用 ---
# ... (既存の関数群) ...
# ... (既存の関数群) ...