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
    "std_gx": 0, "std_gz": 0, "max_gx": 0, "max_gz": 0
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
#  フォーカスタイプごとのデータ範囲設定
# ==========================================================
def get_time_window_for_focus(focus_type):
    if focus_type in ["brake_soft", "stop_smooth"]:
        return 5000, 2000   # 減速系：前を重視
    elif focus_type in ["accel_smooth"]:
        return 2000, 5000   # 加速系：後ろを重視
    elif focus_type in ["turn_stability"]:
        return 2000, 2000   # 旋回系：中心重視
    else:
        return 5000, 5000   # スムーズ・その他


# ==========================================================
#  focus_typeごとの4段階評価ロジック
# ==========================================================
def get_focus_rating(stats, focus_type):
    gx, gz = abs(stats["mean_gx"]), abs(stats["mean_gz"])
    std_gx, std_gz = stats["std_gx"], stats["std_gz"]
    rating = "ふつう"

    if focus_type in ["brake_soft", "stop_smooth"]:
        if abs(gz) < 0.10 and std_gz < 0.04:
            rating = "とてもいい"
        elif abs(gz) < 0.15:
            rating = "いい"
        elif abs(gz) < 0.25:
            rating = "ふつう"
        else:
            rating = "わるい"

    elif focus_type == "accel_smooth":
        if gz < 0.10 and std_gz < 0.04:
            rating = "とてもいい"
        elif gz < 0.18:
            rating = "いい"
        elif gz < 0.25:
            rating = "ふつう"
            # pass
        else:
            rating = "わるい"

    elif focus_type == "turn_stability":
        if gx < 0.10 and std_gx < 0.05:
            rating = "とてもいい"
        elif gx < 0.18:
            rating = "いい"
        elif gx < 0.25:
            rating = "ふつう"
        else:
            rating = "わるい"

    elif focus_type == "smooth_overall":
        if std_gx < 0.04 and std_gz < 0.04:
            rating = "とてもいい"
        elif std_gx < 0.06 and std_gz < 0.06:
            rating = "いい"
        elif std_gx < 0.09:
            rating = "ふつう"
        else:
            rating = "わるい"

    elif focus_type == "speed_consistency":
        # 速度変動（標準偏差）で評価
        speed_std = stats.get("std_speed", 0)

        if speed_std < 2.0:
            rating = "とてもいい"   # ほぼ一定速度を維持
        elif speed_std < 4.0:
            rating = "いい"        # 少し変動があるが安定
        elif speed_std < 6.0:
            rating = "ふつう"      # 変動がやや大きい
        else:
            rating = "わるい"      # アクセル操作にばらつきあり

    return rating


# ==========================================================
#  前回データとの比較
# ==========================================================
def compare_focus_stats(prev_stats, current_stats):
    if not prev_stats:
        return None, "前回データが見つからなかったため、今回は単独での評価です。"
    diff = {
        "avg_speed_diff": current_stats["avg_speed"] - prev_stats["avg_speed"],
        "gx_diff": current_stats["mean_gx"] - prev_stats["mean_gx"],
        "gz_diff": current_stats["mean_gz"] - prev_stats["mean_gz"],
        "std_gx_diff": current_stats["std_gx"] - prev_stats["std_gx"],
        "std_gz_diff": current_stats["std_gz"] - prev_stats["std_gz"]
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
#  AIフィードバック生成（Gemini 呼び出し）
# ==========================================================
def generate_ai_focus_feedback(focus_type_name, current_stats, diff, rating, diff_text):
    """
    OpenAI ではなく Gemini を使ってフィードバック文章を生成する。
    GEMINI_API_KEY（キー文字列）が環境変数に入っている前提。
    """
    model = get_gemini_model()
    if model is None:
        # キー未設定など
        return "AIフィードバック用の設定がまだ完了していないため、自動コメントを生成できませんでした。"

    # --- プロンプト構築（元の形式をほぼ維持） ---
    prompt = f"""
    あなたは運転コーチAI『ドライボ』です。
    この地点は「{focus_type_name}」を意識するよう設定されていました。
    以下のデータをもとに、今回の運転がどのような特徴を持っていたか、そして前回と比べてどう変化したかをコメントしてください。

    【走行データの概要】
    - 平均速度: {current_stats['avg_speed']:.1f} km/h
    - 前後の揺れ（加減速の滑らかさ）:
        平均 {current_stats['mean_gz']:.3f}、ばらつき {current_stats['std_gz']:.3f}、最大値 {current_stats['max_gz']:.3f}
    - 左右の揺れ（ハンドル操作やカーブの滑らかさ）:
        平均 {current_stats['mean_gx']:.3f}、ばらつき {current_stats['std_gx']:.3f}、最大値 {current_stats['max_gx']:.3f}

    【前回との比較】
    {diff_text}

    出力条件:
    - 専門用語や数値(Gx, Gzなど)を使わず、わかりやすい言葉で説明する
    - 「前後の揺れ」→加減速、「左右の揺れ」→ハンドル操作やカーブの滑らかさ として自然に説明する
    - 数値をそのまま書かず、「揺れが少なかった」「少し強めだった」などの表現を使う
    - 優しい口調で2〜3文
    - 必ず前回との比較を含め、「良くなった点」「安定している点」「もう少し改善できる点」をバランス良く述べる
    - もし改善が見られたら「成長」「上達」「安定」といった言葉を使う
    - 最後に前向きな一言と絵文字を添える（例：「この調子です！😊」「少しずつ上達していますね🚗✨」）
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
    if not sess_ref.get().exists:
        print(f"Session not found: {session_id}")
        return {}

    gps_logs = [d.to_dict() for d in sess_ref.collection("gps_logs").order_by("timestamp").stream()]
    avg_g_logs = [d.to_dict() for d in sess_ref.collection("avg_g_logs").order_by("timestamp").stream()]
    pins = [dict(p.to_dict(), id=p.id) for p in db.collection("priority_pins").where("user_id", "==", user_id).stream()]

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

        # --- 統計値算出 ---
        gx_vals = [g.get("g_x", 0) for g in nearby]
        gz_vals = [g.get("g_z", 0) for g in nearby]
        speeds = [g.get("speed", 0) for g in nearby]

        current_stats = {
            "avg_speed": sum(speeds)/len(speeds) if speeds else 0,
            "mean_gx": sum(gx_vals)/len(gx_vals),
            "mean_gz": sum(gz_vals)/len(gz_vals),
            "std_gx": statistics.pstdev(gx_vals) if len(gx_vals) > 1 else 0,
            "std_gz": statistics.pstdev(gz_vals) if len(gz_vals) > 1 else 0,
            "max_gx": max(gx_vals, default=0),
            "max_gz": max(gz_vals, default=0),
            "std_speed": statistics.pstdev(speeds) if len(speeds) > 1 else 0
        }

        # --- 前回データ取得（比較用） ---
        prev_stats = None

        prev_sessions = (
            db.collection("sessions")
            .where("user_id", "==", user_id)
            .where("status", "==", "completed")
            .order_by("end_time", direction=firestore.Query.DESCENDING)
            .stream()
        )

        for sdoc in prev_sessions:
            if sdoc.id == session_id:
                continue  # 今回のセッションを除外

            # 今回のpin_idに対応する前回の focus_feedback を探す
            fb_ref = db.collection("sessions").document(sdoc.id)\
                .collection("focus_feedbacks").document(pin_id)

            fb_doc = fb_ref.get()
            if fb_doc.exists:
                prev_stats = fb_doc.to_dict().get("stats")
                break

        diff, diff_text = compare_focus_stats(prev_stats, current_stats)
        rating = get_focus_rating(current_stats, focus_type)
        ai_comment = generate_ai_focus_feedback(focus_type_name, current_stats, diff, rating, diff_text)

        # ✅ 要約（短縮版フィードバック）を追加
        short_comment = summarize_feedback(ai_comment, diff_text)

        # --- Firestoreに保存 ---
        sess_ref.collection("focus_feedbacks").document(pin_id).set({
            "created_at": datetime.now(JST),
            "pin_label": pin.get("label", ""),
            "focus_type": focus_type,
            "focus_label": focus_type_name,
            "stats": current_stats,
            "diff": diff,
            "rating": rating,
            "ai_comment": ai_comment,       # ← 長文
            "short_comment": short_comment, # ← 短文（追加）
            "passed": True
        })

        results[pin_id] = {
            "pin_label": pin.get("label", ""),
            "focus_type": focus_type,
            "focus_label": focus_type_name,
            "rating": rating,
            "ai_comment": ai_comment,
            "stats": current_stats
        }

    print(f"✅ focus_feedbacks updated for session {session_id}")
    return results