import math
import statistics
from datetime import datetime
from flask import current_app
from google.cloud import firestore
from pytz import timezone
import os
import google.generativeai as genai

JST = timezone("Asia/Tokyo")

# === Firestore Helper ===
db = firestore.Client()

# === 通過しなかった時の定義 ===
NOT_PASSED_STATS = {
    "avg_speed": 0, "mean_gx": 0, "mean_gz": 0,
    "std_gx": 0, "std_gz": 0, "max_gx": 0, "max_gz": 0,
    "min_gx": 0, "min_gz": 0, "median_gx": 0, "median_gz": 0,
    "max_speed": 0, "min_speed": 0, "median_speed": 0,
    "speed_range": 0, "acceleration_count": 0, "deceleration_count": 0,
    "sharp_turn_count": 0, "data_points": 0
}
NOT_PASSED_COMMENT = "この重点ポイントは今回の走行で通過しなかったようです。次回、挑戦してみましょう！"

# ==========================================================
#  Gemini クライアント設定ヘルパ
# ==========================================================
def get_gemini_model(model_name: str = "gemini-2.0-flash"):
    """
    GEMINI_API_KEY （キー文字列そのもの）を環境変数から取得して
    google-generativeai を初期化し、GenerativeModel オブジェクトを返す。
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("⚠️ GEMINI_API_KEY が環境変数に設定されていません。")
        return None

    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(model_name)
        return model
    except Exception as e:
        print(f"⚠️ Gemini 初期化エラー: {e}")
        return None


# ==========================================================
#  フォーカスタイプごとのデータ範囲設定（拡張版）
# ==========================================================
def get_time_window_for_focus(focus_type):
    """より広範囲のデータを取得してフィードバックの質を向上"""
    if focus_type in ["brake_soft", "stop_smooth"]:
        return 8000, 3000   # 減速系：前を重視（拡張）
    elif focus_type in ["accel_smooth"]:
        return 3000, 8000   # 加速系：後ろを重視（拡張）
    elif focus_type in ["turn_stability"]:
        return 4000, 4000   # 旋回系：中心重視（拡張）
    else:
        return 8000, 8000   # スムーズ・その他（拡張）


# ==========================================================
#  focus_typeごとの4段階評価ロジック
# ==========================================================
def get_focus_rating(stats, focus_type):
    if not stats or all(v == 0 for v in stats.values()):
        return "なし", 0

    gx, gz = abs(stats["mean_gx"]), abs(stats["mean_gz"])
    std_gx, std_gz = stats["std_gx"], stats["std_gz"]
    score = 70

    def clamp(val, minval, maxval):
        return max(minval, min(maxval, val))

    if focus_type in ["brake_soft", "stop_smooth"]:
        score = 100 - (abs(gz)-0.10)*400 - (std_gz-0.04)*500
        score = clamp(score, 40, 100)
    elif focus_type == "accel_smooth":
        score = 100 - (gz-0.10)*400 - (std_gz-0.04)*500
        score = clamp(score, 40, 100)
    elif focus_type == "turn_stability":
        score = 100 - (gx-0.10)*400 - (std_gx-0.05)*500
        score = clamp(score, 40, 100)
    elif focus_type == "smooth_overall":
        score = 100 - (std_gx-0.04)*600 - (std_gz-0.04)*600
        score = clamp(score, 40, 100)
    elif focus_type == "speed_consistency":
        speed_std = stats.get("std_speed", 0)
        score = 100 - (speed_std-2.0)*15
        score = clamp(score, 40, 100)

    score = int(round(score))
    if score >= 95:
        rating = "とてもいい"
    elif score >= 80:
        rating = "いい"
    elif score >= 60:
        rating = "ふつう"
    else:
        rating = "わるい"
    return rating, score


# ==========================================================
#  詳細統計データの計算
# ==========================================================
def calculate_detailed_stats(gx_vals, gz_vals, speeds):
    """より詳細な統計データを計算"""
    stats = {
        "avg_speed": sum(speeds)/len(speeds) if speeds else 0,
        "mean_gx": sum(gx_vals)/len(gx_vals) if gx_vals else 0,
        "mean_gz": sum(gz_vals)/len(gz_vals) if gz_vals else 0,
        "std_gx": statistics.pstdev(gx_vals) if len(gx_vals) > 1 else 0,
        "std_gz": statistics.pstdev(gz_vals) if len(gz_vals) > 1 else 0,
        "max_gx": max(gx_vals, default=0),
        "max_gz": max(gz_vals, default=0),
        "min_gx": min(gx_vals, default=0),
        "min_gz": min(gz_vals, default=0),
        "median_gx": statistics.median(gx_vals) if gx_vals else 0,
        "median_gz": statistics.median(gz_vals) if gz_vals else 0,
        "std_speed": statistics.pstdev(speeds) if len(speeds) > 1 else 0,
        "max_speed": max(speeds, default=0),
        "min_speed": min(speeds, default=0),
        "median_speed": statistics.median(speeds) if speeds else 0,
        "speed_range": (max(speeds, default=0) - min(speeds, default=0)),
        "data_points": len(gx_vals)
    }
    
    # 急加速・急減速の回数をカウント（閾値: 0.25G以上）
    stats["acceleration_count"] = sum(1 for gz in gz_vals if gz > 0.25)
    stats["deceleration_count"] = sum(1 for gz in gz_vals if gz < -0.25)
    
    # 急ハンドルの回数をカウント（閾値: 0.25G以上）
    stats["sharp_turn_count"] = sum(1 for gx in gx_vals if abs(gx) > 0.25)
    
    # 時系列パターン分析（前半・後半の比較）
    if len(gx_vals) >= 4:
        mid_point = len(gx_vals) // 2
        first_half_std_gx = statistics.pstdev(gx_vals[:mid_point]) if mid_point > 1 else 0
        second_half_std_gx = statistics.pstdev(gx_vals[mid_point:]) if mid_point > 1 else 0
        stats["gx_stability_trend"] = second_half_std_gx - first_half_std_gx
        
        first_half_std_gz = statistics.pstdev(gz_vals[:mid_point]) if mid_point > 1 else 0
        second_half_std_gz = statistics.pstdev(gz_vals[mid_point:]) if mid_point > 1 else 0
        stats["gz_stability_trend"] = second_half_std_gz - first_half_std_gz
    else:
        stats["gx_stability_trend"] = 0
        stats["gz_stability_trend"] = 0
    
    return stats


# ==========================================================
#  複数回の走行データ取得（直近3回分）
# ==========================================================
def get_historical_stats(user_id, session_id, pin_id, limit=3):
    """直近N回分の走行データを取得して比較"""
    prev_sessions = (
        db.collection("sessions")
        .where("user_id", "==", user_id)
        .where("status", "==", "completed")
        .order_by("end_time", direction=firestore.Query.DESCENDING)
        .stream()
    )
    
    historical_data = []
    for sdoc in prev_sessions:
        if sdoc.id == session_id:
            continue  # 今回のセッションを除外

        fb_ref = db.collection("sessions").document(sdoc.id)\
            .collection("focus_feedbacks").document(pin_id)

        fb_doc = fb_ref.get()
        if fb_doc.exists:
            fb_data = fb_doc.to_dict()
            stats = fb_data.get("stats")
            # statsがNoneまたはNOT_PASSED_STATS（全て0）の場合は追加しない
            if stats and any(v != 0 for v in stats.values()):
                historical_data.append({
                    "session_id": sdoc.id,
                    "stats": stats,
                    "rating": fb_data.get("rating"),
                    "created_at": fb_data.get("created_at")
                })
                if len(historical_data) >= limit:
                    break
    return historical_data


# ==========================================================
#  前回データとの詳細比較
# ==========================================================
def compare_focus_stats(prev_stats, current_stats):
    if not prev_stats:
        return None, "前回データが見つからなかったため、今回は単独での評価です。"
    
    # より詳細な差分計算
    diff = {
        "avg_speed_diff": current_stats["avg_speed"] - prev_stats["avg_speed"],
        "gx_diff": current_stats["mean_gx"] - prev_stats["mean_gx"],
        "gz_diff": current_stats["mean_gz"] - prev_stats["mean_gz"],
        "std_gx_diff": current_stats["std_gx"] - prev_stats["std_gx"],
        "std_gz_diff": current_stats["std_gz"] - prev_stats["std_gz"],
        "max_gx_diff": current_stats.get("max_gx", 0) - prev_stats.get("max_gx", 0),
        "max_gz_diff": current_stats.get("max_gz", 0) - prev_stats.get("max_gz", 0),
        "acceleration_count_diff": current_stats.get("acceleration_count", 0) - prev_stats.get("acceleration_count", 0),
        "deceleration_count_diff": current_stats.get("deceleration_count", 0) - prev_stats.get("deceleration_count", 0),
        "sharp_turn_count_diff": current_stats.get("sharp_turn_count", 0) - prev_stats.get("sharp_turn_count", 0),
    }

    # === diffを自然文に変換 ===
    diff_text = []

    def trend(value, positive_text, negative_text, threshold=0.01):
        """変化方向をやさしい日本語に変換"""
        if abs(value) < threshold:
            return "ほとんど変わりませんでした"
        elif value < 0:
            return positive_text  # 減少（揺れが小さくなった、安定した）
        else:
            return negative_text  # 増加（揺れが大きくなった）

    # 加減速の安定性（前後G）
    gz_trend = trend(
        diff["std_gz_diff"],
        "前後の揺れが少なくなり、加減速がより滑らかになっています",
        "前後の揺れが少し増え、加減速がやや急になっています"
    )

    # カーブ安定性（左右G）
    gx_trend = trend(
        diff["std_gx_diff"],
        "左右の揺れが落ち着き、ハンドル操作が安定しています",
        "左右の揺れがやや増えて、カーブでの安定感が下がっています"
    )

    # 速度変化
    speed_trend = trend(
        diff["avg_speed_diff"],
        "平均速度はやや低下し、落ち着いたペースになりました",
        "平均速度はやや上昇し、全体的に速めの走行となっています"
    )

    diff_text = f"{gz_trend}。{gx_trend}。{speed_trend}。"

    return diff, diff_text


# ==========================================================
#  AIフィードバック生成（Gemini 呼び出し・生データ版）
# ==========================================================
def generate_ai_focus_feedback(focus_type_name, current_stats, diff, rating, diff_text, historical_data=None, raw_data=None):
    """
    Gemini を使って詳細なフィードバック文章を生成する。
    生のgセンサーデータと速度データをすべて渡して、より詳細な分析を実現。
    """
    model = get_gemini_model()
    if model is None:
        return "AIフィードバック用の設定がまだ完了していないため、自動コメントを生成できませんでした。"

    # 過去データとの比較（直近3回分）
    historical_comparison = ""
    if historical_data and len(historical_data) > 0:
        historical_comparison = "\n【過去の走行との比較】\n"
        for i, hist in enumerate(historical_data[:3], 1):
            hist_stats = hist.get("stats", {})
            hist_rating = hist.get("rating", "不明")
            if i == 1:
                historical_comparison += f"- 前回: 評価「{hist_rating}」"
            else:
                historical_comparison += f"- {i}回前: 評価「{hist_rating}」"
            
            if hist_stats:
                std_gx_compare = current_stats["std_gx"] - hist_stats.get("std_gx", 0)
                std_gz_compare = current_stats["std_gz"] - hist_stats.get("std_gz", 0)
                
                if std_gx_compare < -0.02 or std_gz_compare < -0.02:
                    historical_comparison += "（今回の方が安定）\n"
                elif std_gx_compare > 0.02 or std_gz_compare > 0.02:
                    historical_comparison += "（今回の方が不安定）\n"
                else:
                    historical_comparison += "（ほぼ同じ）\n"
    
    # 生データをフォーマット（時系列で表示）
    raw_data_text = ""
    if raw_data:
        raw_data_text = "\n【この地点の全計測データ（時系列）】\n"
        raw_data_text += "時刻, 左右G(gx), 前後G(gz), 速度(km/h)\n"
        for i, point in enumerate(raw_data, 1):
            raw_data_text += f"{i}, {point['gx']:.3f}, {point['gz']:.3f}, {point['speed']:.1f}\n"
        
        raw_data_text += "\n※ 左右G(gx): 正=右旋回、負=左旋回\n"
        raw_data_text += "※ 前後G(gz): 正=加速、負=減速\n"
    
    # --- 詳細プロンプト構築（生データを含む） ---
    prompt = f"""
    あなたは運転コーチAI『ドライボ』です。
    この地点は「{focus_type_name}」を意識するよう設定されていました。
    以下の**実際の計測データすべて**をもとに、今回の運転の特徴と改善点をコメントしてください。

    {raw_data_text}

    【統計サマリー】
    - 平均速度: {current_stats['avg_speed']:.1f} km/h（最高 {current_stats.get('max_speed', 0):.1f} km/h、最低 {current_stats.get('min_speed', 0):.1f} km/h）
    - データ計測点数: {current_stats.get('data_points', 0)}点
    - 急加速: {current_stats.get('acceleration_count', 0)}回
    - 急ブレーキ: {current_stats.get('deceleration_count', 0)}回
    - 急ハンドル: {current_stats.get('sharp_turn_count', 0)}回

    【前回との直接比較】
    {diff_text}
    {historical_comparison}

    【今回の総合評価】
    {rating}

    出力条件:
    - 上記の時系列データから運転パターンを詳しく分析してください
    - 例えば「最初は安定していたが途中で急ブレーキがあった」「カーブ中に左右の揺れが連続した」など、具体的な場面を指摘する
    - 専門用語や数値(Gx, Gzなど)を使わず、わかりやすい言葉で説明する
    - 「前後の揺れ」→加減速、「左右の揺れ」→ハンドル操作やカーブの滑らかさ として自然に説明する
    - 数値をそのまま書かず、「揺れが少なかった」「少し強めだった」などの表現を使う
    - 優しい口調で3〜5文程度（生データを分析するため少し詳しめに）
    - 良くなった点、安定している点、改善できる点をバランス良く述べる
    - 時系列データから見える「運転の癖」や「改善のヒント」を具体的に提示する
    - 過去の走行との比較から「成長の軌跡」や「継続している課題」にも触れる
    - 最後に前向きな一言と絵文字を添える（例：「この調子です！😊」「着実に上達していますね🚗✨」）
    """

    try:
        response = model.generate_content(prompt)
        # google-generativeai は通常 .text で本文が取れる
        feedback_text = (response.text or "").strip()
        if not feedback_text:
            feedback_text = "AIフィードバックの生成結果が空でした。"
    except Exception as e:
        print(f"⚠️ AI生成エラー (Gemini): {e}")
        feedback_text = "AIフィードバック生成中にエラーが発生しました。"

    # --- 前回との比較を考慮してトーンを追加 ---
    if diff:
        trend = ""
        if diff["std_gx_diff"] < -0.01 or diff["std_gz_diff"] < -0.01:
            trend = "（前回より安定しています👏）"
        elif diff["std_gx_diff"] > 0.02 or diff["std_gz_diff"] > 0.02:
            trend = "（少し揺れが増えているようです💦）"
        else:
            trend = "（前回と同じくらい安定しています✨）"
        feedback_text += "\n" + trend

    return feedback_text


# ==========================================================
#  簡潔版フィードバック生成（Gemini 要約）
# ==========================================================
def summarize_feedback(ai_comment: str, diff_text: str) -> str:
    """長文のAIコメントから簡潔な要約を生成（良い点・改善点・比較）"""
    model = get_gemini_model()
    if model is None:
        # モデルが使えないときのデフォルト
        return (
            "😊 良い点: 全体的に安定した走行でした。\n"
            "⚠ 改善点: カーブ時の揺れに注意しましょう。\n"
            "📈 比較: 前回とほぼ同じ傾向です。"
        )

    prompt = f"""
    以下は運転に関するAIフィードバックです。
    この文章から「良い点」「改善点」「前回との比較」を1行ずつ簡潔に要約してください。

    {ai_comment}

    【出力フォーマット】
    😊 良い点: ...
    ⚠ 改善点: ...
    📈 比較: ...
    """

    try:
        res = model.generate_content(prompt)
        summary = (res.text or "").strip()
        if not summary:
            summary = (
                "😊 良い点: 全体的に安定した走行でした。\n"
                "⚠ 改善点: カーブ時の揺れに注意しましょう。\n"
                "📈 比較: 前回とほぼ同じ傾向です。"
            )
    except Exception as e:
        print(f"⚠️ 要約生成エラー (Gemini): {e}")
        summary = (
            "😊 良い点: 全体的に安定した走行でした。\n"
            "⚠ 改善点: カーブ時の揺れに注意しましょう。\n"
            "📈 比較: 前回とほぼ同じ傾向です。"
        )
    return summary


# ==========================================================
#  メイン：重点ポイント解析
# ==========================================================
def analyze_focus_points_for_session(session_id: str, user_id: str) -> dict:
    sess_ref = db.collection("sessions").document(session_id)
    sess_doc = sess_ref.get()

    if not sess_doc.exists:
        print(f"Session not found: {session_id}")
        return {}

    session_data = sess_doc.to_dict()

    # 🔥 ここで route_id を取得する（重要！）
    route_id = session_data.get("route_id")
    if not route_id:
        print("⚠️ このセッションに route_id が設定されていません。")
        return {}

    print(f"🎯 Using route_id={route_id} for evaluation")

    # GPS & AVG-G logs
    gps_logs = [
        d.to_dict()
        for d in sess_ref.collection("gps_logs").order_by("timestamp").stream()
    ]
    avg_g_logs = [
        d.to_dict()
        for d in sess_ref.collection("avg_g_logs").order_by("timestamp").stream()
    ]

    # 🔥 ピンを route_id で絞り込む（ここが最重要）
    pin_query = (
        db.collection("priority_pins")
        .where("user_id", "==", user_id)
        .where("route_id", "==", route_id)
    )

    pins = [dict(p.to_dict(), id=p.id) for p in pin_query.stream()]

    print(f"📌 Loaded {len(pins)} pins for this route.")

    results = {}
    for pin in pins:
        focus_type = pin.get("focus_type", "smooth_overall")
        focus_type_name = pin.get("focus_label", "全体の滑らかさ")
        lat, lng, pin_id = float(pin["lat"]), float(pin["lng"]), pin["id"]

        # --- 最近のGPSから最接近点を特定 ---
        nearest_point, nearest_dist = None, float("inf")
        for g in gps_logs:
            dist = ((lat - g.get("latitude", 0))**2 + (lng - g.get("longitude", 0))**2)**0.5
            if dist < nearest_dist:
                nearest_dist = dist
                nearest_point = g

        # --- 通過判定 ---
        if not nearest_point or nearest_dist > 0.0003:  # 約30m
            comment = NOT_PASSED_COMMENT
            sess_ref.collection("focus_feedbacks").document(pin_id).set({
                "created_at": datetime.now(JST),
                "pin_label": pin.get("label", ""),
                "focus_type": focus_type,
                "focus_label": focus_type_name,
                "passed": False,
                "ai_comment": comment,
                "rating": "なし",
                "stats": NOT_PASSED_STATS,
            })
            results[pin_id] = {"ai_comment": comment, "rating": "なし", "passed": False}
            continue

        # --- focus_type別の時間範囲取得 ---
        before_ms, after_ms = get_time_window_for_focus(focus_type)
        center_time = nearest_point.get("timestamp_ms", 0)

        nearby = [
            g for g in avg_g_logs
            if -before_ms <= g.get("timestamp_ms", 0) - center_time <= after_ms
        ]
        if not nearby:
            comment = "通過しましたが、この地点のGログが不足して解析できませんでした。"
            sess_ref.collection("focus_feedbacks").document(pin_id).set({
                "created_at": datetime.now(JST),
                "pin_label": pin.get("label", ""),
                "focus_type": focus_type,
                "focus_label": focus_type_name,
                "passed": True,
                "ai_comment": comment,
                "rating": "なし",
                "stats": NOT_PASSED_STATS,
            })
            results[pin_id] = {"ai_comment": comment, "rating": "なし", "passed": True}
            continue

        # --- 詳細統計値算出 ---
        gx_vals = [g.get("g_x", 0) for g in nearby]
        gz_vals = [g.get("g_z", 0) for g in nearby]
        speeds = [g.get("speed", 0) for g in nearby]

        current_stats = calculate_detailed_stats(gx_vals, gz_vals, speeds)

        # --- 生データを整形（AIに渡すため） ---
        raw_data_points = []
        for g in nearby:
            raw_data_points.append({
                "gx": g.get("g_x", 0),
                "gz": g.get("g_z", 0),
                "speed": g.get("speed", 0)
            })

        # --- 過去データ取得（直近3回分） ---
        historical_data = get_historical_stats(user_id, session_id, pin_id, limit=3)
        
        # 直前のデータを取得
        prev_stats = historical_data[0].get("stats") if historical_data else None

        diff, diff_text = compare_focus_stats(prev_stats, current_stats)
        rating, score = get_focus_rating(current_stats, focus_type)

        ai_comment = generate_ai_focus_feedback(
            focus_type_name,
            current_stats,
            diff,
            rating,
            diff_text,
            historical_data,
            raw_data_points
        )

        short_comment = summarize_feedback(ai_comment, diff_text)

        sess_ref.collection("focus_feedbacks").document(pin_id).set({
            "created_at": datetime.now(JST),
            "pin_label": pin.get("label", ""),
            "focus_type": focus_type,
            "focus_label": focus_type_name,
            "stats": current_stats,
            "diff": diff,
            "rating": rating,
            "score": score,
            "ai_comment": ai_comment,
            "short_comment": short_comment,
            "passed": True
        })

        results[pin_id] = {
            "pin_label": pin.get("label", ""),
            "focus_type": focus_type,
            "focus_label": focus_type_name,
            "rating": rating,
            "score": score,
            "ai_comment": ai_comment,
            "stats": current_stats
        }

    print(f"✅ focus_feedbacks updated for session {session_id}")
    return results