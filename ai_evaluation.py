# ai_evaluation.py - 生成AIによる運転評価システム
import openai
import json
import os
from datetime import datetime, timezone, timedelta
from firebase_admin import firestore
from config import JST

# OpenAI APIキーを環境変数または設定ファイルから取得
api_key_path = os.getenv('OPENAI_API_KEY')
api_key_value = None

# 1. 直接環境変数から取得を試行
if os.getenv('OPENAI_API_KEY_DIRECT'):
    api_key_value = os.getenv('OPENAI_API_KEY_DIRECT')
    print("Using OpenAI API key from OPENAI_API_KEY_DIRECT")
# 2. ファイルから取得を試行
elif api_key_path and os.path.exists(api_key_path):
    try:
        with open(api_key_path, 'r') as f:
            api_key_value = f.read().strip()
        print(f"Using OpenAI API key from file: {api_key_path}")
    except Exception as e:
        print(f"Failed to read API key file: {e}")
# 3. テスト用ダミーキー（実際には動作しない）
else:
    api_key_value = "test-key-for-development"
    print("Using test API key for development (AI features will use fallback)")

openai.api_key = api_key_value

# OpenAIクライアントの設定（新しいAPIバージョン用）
try:
    from openai import OpenAI
    if api_key_value and api_key_value != "test-key-for-development":
        client = OpenAI(api_key=api_key_value)
        print("OpenAI client initialized successfully")
    else:
        client = None
        print("Warning: OpenAI API key not valid. Using fallback evaluation.")
except ImportError:
    client = None
    print("Warning: OpenAI client not available. Using fallback evaluation.")
except Exception as e:
    client = None
    print(f"Warning: OpenAI client initialization failed: {e}. Using fallback evaluation.")

def analyze_session_data(session_id, user_id, focus_point=''):
    """
    セッションデータを分析して運転評価を生成
    """
    try:
        # Firestoreクライアントを取得
        db = firestore.client()
        
        # セッションデータを取得
        session_ref = db.collection('sessions').document(session_id)
        session_doc = session_ref.get()
        
        if not session_doc.exists:
            return None
            
        session_data = session_doc.to_dict()
        if session_data.get('user_id') != user_id:
            return None
            
        # GPSデータとGセンサーデータを取得
        gps_logs = []
        for doc in session_ref.collection('gps_logs').order_by('timestamp').stream():
            gps_logs.append(doc.to_dict())
            
        g_logs = []
        for doc in session_ref.collection('g_logs').order_by('timestamp').stream():
            g_logs.append(doc.to_dict())
            
        avg_g_logs = []
        for doc in session_ref.collection('avg_g_logs').order_by('timestamp').stream():
            avg_g_logs.append(doc.to_dict())
            
        # データ統計を計算
        stats = calculate_driving_stats(session_data, gps_logs, g_logs, avg_g_logs)

        # 一個前のセッションの統計を取得
        prev_stats = get_previous_session_stats(user_id, session_id)

        # 成長コメント生成（前回比較込み）
        evaluation = generate_ai_evaluation(stats, focus_point)
        if evaluation and 'comments' in evaluation:
            evaluation['comments'] = generate_ai_growth_comments(stats, prev_stats)

        return evaluation
        
    except Exception as e:
        print(f"Error analyzing session data: {e}")
        return None

def calculate_driving_stats(session_data, gps_logs, g_logs, avg_g_logs):
    """
    運転データから統計情報を計算
    """
    # 基本統計
    total_distance = session_data.get('distance', 0)
    duration_minutes = 0
    if session_data.get('start_time') and session_data.get('end_time'):
        duration = session_data['end_time'] - session_data['start_time']
        duration_minutes = duration.total_seconds() / 60
    
    # イベント統計
    sudden_brakes = session_data.get('sudden_brakes', 0)
    sudden_accels = session_data.get('sudden_accels', 0)
    sharp_turns = session_data.get('sharp_turns', 0)
    
    # Gセンサーデータの統計
    g_stats = {
        'mean_g_x': 0,
        'mean_g_y': 0,
        'mean_g_z': 0,
        'max_g_x': 0,
        'max_g_y': 0,
        'max_g_z': 0
    }
    
    if avg_g_logs:
        g_x_values = [log.get('g_x', 0) for log in avg_g_logs]
        g_y_values = [log.get('g_y', 0) for log in avg_g_logs]
        g_z_values = [log.get('g_z', 0) for log in avg_g_logs]
        
        if g_x_values:
            g_stats['mean_g_x'] = sum(g_x_values) / len(g_x_values)
            g_stats['max_g_x'] = max(abs(g) for g in g_x_values)
        if g_y_values:
            g_stats['mean_g_y'] = sum(g_y_values) / len(g_y_values)
            g_stats['max_g_y'] = max(abs(g) for g in g_y_values)
        if g_z_values:
            g_stats['mean_g_z'] = sum(g_z_values) / len(g_z_values)
            g_stats['max_g_z'] = max(abs(g) for g in g_z_values)
    
    # 速度統計
    speed_stats = {'avg_speed': 0, 'max_speed': 0}
    if gps_logs:
        speeds = [log.get('speed', 0) for log in gps_logs if log.get('speed', 0) > 0]
        if speeds:
            speed_stats['avg_speed'] = sum(speeds) / len(speeds)
            speed_stats['max_speed'] = max(speeds)
    
    return {
        'duration_minutes': duration_minutes,
        'total_distance': total_distance,
        'sudden_brakes': sudden_brakes,
        'sudden_accels': sudden_accels,
        'sharp_turns': sharp_turns,
        'g_stats': g_stats,
        'speed_stats': speed_stats
    }

def generate_ai_evaluation(stats, focus_point=''):
    """
    統計データを元に生成AIで「成長コメント」を作成
    （スコア・評価結果・重点ポイントなし版）
    """
    generation_method = "rule-based"

    if client and openai.api_key:
        try:
            print("🤖 Generating growth feedback using OpenAI GPT-3.5-turbo...")
            comments = generate_ai_growth_comments(stats)
            overall_comment = generate_ai_growth_summary(stats)
            generation_method = "openai"
            print("✅ AI growth feedback generated successfully")
        except Exception as e:
            print(f"❌ OpenAI API error: {e}")
            print("🔄 Using fallback rule-based comments...")
            comments = generate_growth_comments(stats)
            overall_comment = "運転データの傾向を解析できませんでしたが、次回の安定走行を期待しています🚗"
    else:
        print("⚠️ OpenAI API not available, using rule-based comments...")
        comments = generate_growth_comments(stats)
        overall_comment = "データから全体的な変化を分析しました。引き続き安定した運転を目指しましょう💪"

    return {
        'comments': comments,
        'overall_comment': overall_comment,
        'generation_method': generation_method,
        'generated_at': datetime.now(JST)
    }
"""
def calculate_scores(stats):
    
    統計データからスコアを計算
    
    # 減速スコア（急ブレーキの数で計算）
    brake_score = max(50, 100 - stats['sudden_brakes'] * 10)
    
    # 加速スコア（急加速の数で計算）
    accel_score = max(50, 100 - stats['sudden_accels'] * 10)
    
    # 旋回スコア（急カーブの数で計算）
    turn_score = max(50, 100 - stats['sharp_turns'] * 8)
    
    # 直進スコア（平均G値の安定度で計算）
    g_variation = (abs(stats['g_stats']['mean_g_x']) + 
                   abs(stats['g_stats']['mean_g_y'])) / 2
    straight_score = max(60, min(95, 90 - g_variation * 50))
    
    # 総合スコア
    overall_score = int((brake_score + accel_score + turn_score + straight_score) / 4)
    
    return {
        'brake': int(brake_score),
        'accel': int(accel_score),
        'turn': int(turn_score),
        'straight': int(straight_score),
        'overall': overall_score
    }
"""
def compare_stats(prev_stats, current_stats):
    """
    前回と今回の統計情報の差分を計算して返す
    """
    if not prev_stats:
        return None

    diff = {
        "sudden_brakes_diff": current_stats["sudden_brakes"] - prev_stats["sudden_brakes"],
        "sudden_accels_diff": current_stats["sudden_accels"] - prev_stats["sudden_accels"],
        "sharp_turns_diff": current_stats["sharp_turns"] - prev_stats["sharp_turns"],
        "mean_gx_diff": round(current_stats["g_stats"]["mean_g_x"] - prev_stats["g_stats"]["mean_g_x"], 3),
        "mean_gy_diff": round(current_stats["g_stats"]["mean_g_y"] - prev_stats["g_stats"]["mean_g_y"], 3),
        "avg_speed_diff": round(current_stats["speed_stats"]["avg_speed"] - prev_stats["speed_stats"]["avg_speed"], 2),
    }

    return diff
"""
def generate_growth_comments(stats):
    
    AIが使えない場合のフォールバック用・成長コメント（手動生成）
    
    comments = {}

    # 減速
    comments["brake"] = {
        "detail": f"急ブレーキ {stats['sudden_brakes']}回",
        "comment": "最近はブレーキがより丁寧になってきています👏"
    }

    # 加速
    comments["accel"] = {
        "detail": f"急加速 {stats['sudden_accels']}回",
        "comment": "加速が穏やかで安定しています🚗💨"
    }

    # 旋回
    comments["turn"] = {
        "detail": f"急カーブ {stats['sharp_turns']}回",
        "comment": "カーブ時のG変化が少なくなり、ハンドル操作が上達しています✨"
    }

    # 直進
    comments["straight"] = {
        "detail": f"平均速度 {stats['speed_stats']['avg_speed']:.1f}km/h",
        "comment": "全体的にまっすぐ安定した走行ができています💪"
    }

    return comments
"""

def generate_ai_growth_summary(stats):
    """
    OpenAI APIで全体の成長傾向コメントを生成（点数なし）
    """
    driving_data = f"""
走行時間: {stats['duration_minutes']:.1f}分
走行距離: {stats['total_distance']:.2f}km
急ブレーキ: {stats['sudden_brakes']}回
急加速: {stats['sudden_accels']}回
急カーブ: {stats['sharp_turns']}回
平均速度: {stats['speed_stats']['avg_speed']:.1f}km/h
"""

    prompt = f"""
あなたは運転アドバイザーAI「ドライボ」です。
以下の運転データを参考に、全体的な“成長”や“安定の変化”を
やさしい口調で2〜3文にまとめてください。
点数や評価結果(result)は不要です。

条件：
- 成長や安定の変化を褒める
- 前向きで温かい文章
- 絵文字を使用
- スコア・数字は表示しない

運転データ:
{driving_data}
"""

    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "あなたは優しい運転コーチAI『ドライボ』です。"},
                {"role": "user", "content": prompt}
            ],
            max_tokens=300,
            temperature=0.7
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print(f"⚠️ AI summary generation failed: {e}")
        return "全体的に運転が安定してきています👏 引き続き丁寧な操作を意識していきましょう🚗💨"
"""
def generate_overall_comment(stats, scores):
    
    総評コメントを生成（スコア表示あり - 旧バージョン）
    
    overall_score = scores['overall']
    
    # 最も優秀な項目を特定
    best_aspect = max(scores, key=lambda k: scores[k] if k != 'overall' else 0)
    best_score = scores[best_aspect]
    
    # 改善が必要な項目を特定
    worst_aspect = min(scores, key=lambda k: scores[k] if k != 'overall' else 100)
    
    aspect_names = {
        'brake': '減速',
        'accel': '加速',
        'turn': '旋回',
        'straight': '直進'
    }
    
    best_name = aspect_names.get(best_aspect, best_aspect)
    worst_name = aspect_names.get(worst_aspect, worst_aspect)
    
    if overall_score >= 85:
        return f"今回の総評は{overall_score}点でした！素晴らしい運転でした👏 " \
               f"特に{best_name}の安定感が素晴らしいです。安全運転の模範です🚗💨"
    elif overall_score >= 75:
        return f"今回の総評は{overall_score}点でした！全体的に安定した運転でした👏 " \
               f"特に{best_name}の安定感が素晴らしいです🚗💨 " \
               f"{worst_name}時のG変化をもう少し抑えられれば、さらに上級者レベルです🔥"
    elif overall_score >= 65:
        return f"今回の総評は{overall_score}点でした！基本はできています " \
               f"{best_name}が良好です。{worst_name}を意識して、さらにスムーズな運転を目指しましょう！"
    else:
        return f"今回の総評は{overall_score}点でした。 " \
               f"まだまだ伸びしろがあります！特に{worst_name}を意識して、安全第一で上達していきましょう🚗"
"""
"""
def generate_overall_comment_no_score(stats, scores):
    
    総評コメントを生成（スコア表示なし）
    
    # 最も優秀な項目を特定
    best_aspect = max(scores, key=lambda k: scores[k] if k != 'overall' else 0)
    best_score = scores[best_aspect]
    
    # 改善が必要な項目を特定
    worst_aspect = min(scores, key=lambda k: scores[k] if k != 'overall' else 100)
    
    aspect_names = {
        'brake': '減速',
        'accel': '加速',
        'turn': '旋回',
        'straight': '直進'
    }
    
    best_name = aspect_names.get(best_aspect, best_aspect)
    worst_name = aspect_names.get(worst_aspect, worst_aspect)
    
    overall_score = scores['overall']
    
    if overall_score >= 85:
        return f"素晴らしい運転でした👏 " \
               f"特に{best_name}の安定感が素晴らしいです。安全運転の模範です🚗💨"
    elif overall_score >= 75:
        return f"全体的に安定した運転でした👏 " \
               f"特に{best_name}の安定感が素晴らしいです🚗💨 " \
               f"{worst_name}時のG変化をもう少し抑えられれば、さらに上級者レベルです🔥"
    elif overall_score >= 65:
        return f"基本はできています！ " \
               f"{best_name}が良好です。{worst_name}を意識して、さらにスムーズな運転を目指しましょう！"
    else:
        return f"まだまだ伸びしろがあります！特に{worst_name}を意識して、安全第一で上達していきましょう🚗"
"""
def generate_ai_growth_comments(stats, prev_stats=None):
    """
    OpenAI APIを使用して「成長コメント」を生成
    一個前のセッションとの差分を含めてAIに投げる
    """
    diff_text = ""
    if prev_stats:
        diff = compare_stats(prev_stats, stats)
        if diff:
            diff_text = f"""
前回との差分データ:
- 急ブレーキ変化: {diff['sudden_brakes_diff']}回
- 急加速変化: {diff['sudden_accels_diff']}回
- 急カーブ変化: {diff['sharp_turns_diff']}回
- 平均G(前後)変化: {diff['mean_gx_diff']}
- 平均G(左右)変化: {diff['mean_gy_diff']}
- 平均速度変化: {diff['avg_speed_diff']}km/h
"""

    driving_data = f"""
今回の運転データ:
- 走行時間: {stats['duration_minutes']:.1f}分
- 走行距離: {stats['total_distance']:.2f}km
- 急ブレーキ: {stats['sudden_brakes']}回
- 急加速: {stats['sudden_accels']}回
- 急カーブ: {stats['sharp_turns']}回
- 平均G値 (前後): {stats['g_stats']['mean_g_x']:.2f}
- 平均G値 (左右): {stats['g_stats']['mean_g_y']:.2f}
- 平均速度: {stats['speed_stats']['avg_speed']:.1f}km/h
"""

    prompt = f"""
あなたは運転の成長を見守るアドバイザーAI「ドライボ」です。
以下の運転データと、前回との差分を参考に、
成長や安定の変化を自然な言葉で伝えてください。

条件：
- スコアや数値は使わない
- 「改善した点」「変化した点」を中心に具体的に述べる
- 前向きで温かいトーン
- 絵文字を使う
- 出力は JSON 形式で返す
- 各項目は "brake", "accel", "turn", "straight" と "overall_comment"

出力例：
{{
  "brake": {{
    "detail": "前回より急ブレーキが2回減りました",
    "comment": "減速がスムーズになり、落ち着いた運転になっています👏"
  }},
  "accel": {{
    "detail": "急加速の回数はほぼ変わりませんでした",
    "comment": "安定した加速が維持されています💨"
  }},
  "turn": {{
    "detail": "横Gが小さくなっています",
    "comment": "カーブ時の姿勢がより安定しました✨"
  }},
  "straight": {{
    "detail": "平均G変化が減少しました",
    "comment": "直進時のハンドル操作が丁寧になっています🚗"
  }},
  "overall_comment": "全体的に安定した運転になっています👏 この調子で続けていきましょう！"
}}

分析データ:
{driving_data}
{diff_text}
"""

    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "あなたは優しい運転コーチAI『ドライボ』です。"},
                {"role": "user", "content": prompt}
            ],
            max_tokens=800,
            temperature=0.7
        )
        ai_response = response.choices[0].message.content.strip()
        try:
            return json.loads(ai_response)
        except json.JSONDecodeError:
            print("⚠️ JSON解析失敗。フォールバック使用。")
            return generate_growth_comments(stats)
    except Exception as e:
        print(f"❌ OpenAI API error: {e}")
        return generate_growth_comments(stats)
    
def get_previous_session_stats(user_id, current_session_id):
    """
    同一ユーザーの「一個前のセッション」をFirestoreから取得し、
    calculate_driving_stats() で統計情報を返す。
    """
    try:
        db = firestore.client()
        sessions_ref = (
            db.collection('sessions')
            .where('user_id', '==', user_id)
            .order_by('start_time', direction=firestore.Query.DESCENDING)
            .limit(3)
        )
        sessions = list(sessions_ref.stream())

        # セッションが2件以上ある（今回＋前回）
        if len(sessions) >= 2:
            current_id = sessions[0].id
            prev_doc = sessions[1]

            # 現在のIDが一致しない場合はスキップ
            if current_id != current_session_id:
                return None

            prev_session_data = prev_doc.to_dict()
            prev_ref = db.collection('sessions').document(prev_doc.id)

            gps_logs = [doc.to_dict() for doc in prev_ref.collection('gps_logs').order_by('timestamp').stream()]
            g_logs = [doc.to_dict() for doc in prev_ref.collection('g_logs').order_by('timestamp').stream()]
            avg_g_logs = [doc.to_dict() for doc in prev_ref.collection('avg_g_logs').order_by('timestamp').stream()]

            prev_stats = calculate_driving_stats(prev_session_data, gps_logs, g_logs, avg_g_logs)
            return prev_stats
        else:
            print("⚠️ 前回セッションが見つかりません。")
            return None
    except Exception as e:
        print(f"Error getting previous session stats: {e}")
        return None


def generate_ai_overall_comment(stats, scores, focus_point=''):
    """
    OpenAI APIを使用して総評コメントと重点ポイント評価を生成
    """
    
    driving_data = f"""
運転統計データ:
- 走行時間: {stats['duration_minutes']:.1f}分
- 走行距離: {stats['total_distance']:.2f}km
- 急ブレーキ: {stats['sudden_brakes']}回
- 急加速: {stats['sudden_accels']}回
- 急カーブ: {stats['sharp_turns']}回
"""
    
    if focus_point:
        driving_data += f"- 今回の重点ポイント: {focus_point}\n"
    
    prompt = f"""
あなたは親しみやすい運転アドバイザーのAI「ドライボ」です。
以下の運転データを分析して、総評コメントを生成してください。

{driving_data}

条件:
- スコアや点数は表示しない
- 2-3文で簡潔に
- 具体的な項目名を含める
- 親しみやすい口調で
- 絵文字を使用
- 前向きで励ましを含める
- 改善点があれば具体的に指摘

例: "全体的に安定した運転でした👏 特に直進の安定感が素晴らしいです🚗💨 旋回時のG変化をもう少し抑えられれば、さらに上級者レベルです🔥"
"""

    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "あなたは親しみやすい運転アドバイザーAI「ドライボ」です。運転者を励まし、具体的なアドバイスを提供します。スコアや点数は表示しません。"},
                {"role": "user", "content": prompt}
            ],
            max_tokens=300,
            temperature=0.7
        )
        
        ai_response = response.choices[0].message.content.strip()
        return ai_response
        
    except Exception as e:
        print(f"OpenAI API call failed: {e}")
        # エラーの場合はフォールバック
        return generate_overall_comment_no_score(stats, scores)

def generate_ai_focus_point_comment(stats, scores, focus_point=''):
    """
    OpenAI APIを使用して重点ポイントの評価コメントを生成
    """
    if not focus_point:
        return "次回は重点ポイントを選んで挑戦してみよう！🚗"
    
    driving_data = f"""
運転統計データ:
- 走行時間: {stats['duration_minutes']:.1f}分
- 走行距離: {stats['total_distance']:.2f}km
- 急ブレーキ: {stats['sudden_brakes']}回
- 急加速: {stats['sudden_accels']}回
- 急カーブ: {stats['sharp_turns']}回
- 重点ポイント: {focus_point}
"""
    
    prompt = f"""
あなたは親しみやすい運転アドバイザーのAI「ドライボ」です。
今回の運転で重点的に意識した項目「{focus_point}」について評価コメントを生成してください。

{driving_data}

条件:
- 重点ポイント「{focus_point}」に焦点を当てる
- スコアや点数は表示しない
- 2-3文で簡潔に
- 親しみやすい口調で
- 絵文字を使用
- 前向きで励ましを含める
- 次回への意欲を引き出す

例: "今回の重点ポイント「減速」への意識が素晴らしかったです！🚗 急ブレーキを控えめにした運転で、同乗者も快適だったと思います👏 この調子で次は「旋回」も意識してみると、さらにスムーズな運転になりますよ🔥"
"""

    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "あなたは親しみやすい運転アドバイザーAI「ドライボ」です。重点ポイントについて具体的で励ましのコメントを提供します。"},
                {"role": "user", "content": prompt}
            ],
            max_tokens=200,
            temperature=0.7
        )
        
        ai_response = response.choices[0].message.content.strip()
        return ai_response
        
    except Exception as e:
        print(f"OpenAI API call failed: {e}")
        # エラーの場合はフォールバック
        return f"今回の重点ポイント「{focus_point}」への意識、お疲れさまでした！🚗 継続して意識することで、より安全で快適な運転が身につきます💨"

def save_evaluation_to_session(session_id, user_id, evaluation):
    """
    評価結果をFirestoreに保存
    """
    try:
        # Firestoreクライアントを取得
        db = firestore.client()
        session_ref = db.collection('sessions').document(session_id)
        session_ref.update({
            'ai_evaluation': evaluation,
            'evaluation_generated_at': firestore.SERVER_TIMESTAMP
        })
        return True
    except Exception as e:
        print(f"Error saving evaluation: {e}")
        return False
"""
def generate_feedback(logs):
    
    走行データからAI評価を生成し、総評＋各項目のフィードバックを返す
    
    if not logs:
        return {
            "overall": "この範囲にはデータがありません。",
            "details": {}
        }

    # ==== 統計情報を抽出 ====
    avg_speed = sum(l.get('speed', 0) for l in logs) / len(logs)
    sudden_brakes = sum(1 for l in logs if l.get('event') == 'sudden_brake')
    sudden_accels = sum(1 for l in logs if l.get('event') == 'sudden_accel')
    sharp_turns = sum(1 for l in logs if l.get('event') == 'sharp_turn')

    # Gセンサー値（平均値）
    gx_values = [l.get('g_x', 0) for l in logs]
    gy_values = [l.get('g_y', 0) for l in logs]
    gz_values = [l.get('g_z', 0) for l in logs]
    g_stats = {
        "mean_g_x": sum(gx_values) / len(gx_values),
        "mean_g_y": sum(gy_values) / len(gy_values),
        "mean_g_z": sum(gz_values) / len(gz_values)
    }

    # ==== 簡易的な統計辞書を作成 ====
    stats = {
        "duration_minutes": len(logs) / 6,  # 約10Hz換算
        "total_distance": 0,  # この範囲では不明
        "sudden_brakes": sudden_brakes,
        "sudden_accels": sudden_accels,
        "sharp_turns": sharp_turns,
        "g_stats": g_stats,
        "speed_stats": {"avg_speed": avg_speed, "max_speed": max(gz_values) if gz_values else 0}
    }

    # ==== 各項目スコアを算出 ====
    scores = calculate_scores(stats)

    # ==== 各ポイントのコメント生成 ====
    comments = generate_comments(stats, scores)

    # ==== 総評コメント生成 ====
    overall_comment = generate_overall_comment(stats, scores)

    # ==== まとめて返す ====
    feedback = {
        "overall": overall_comment,
        "details": comments,
        "scores": scores
    }

    return feedback
"""

def generate_ai_focus_feedback(current_stats, diff=None, first_time=False):
    """
    各重点ポイント地点のAIコメントを生成（比較済みの数値を渡す）
    """
    prompt = "あなたは運転コーチAI『ドライボ』です。\n"
    if first_time:
        prompt += "これは初めて重視した地点です。\n"

    prompt += f"""
地点での運転データ:
- 平均速度: {current_stats['avg_speed']:.1f} km/h
- 平均G前後: {current_stats['mean_gz']:.3f}
- 横G: {current_stats['mean_gx']:.3f}
"""
    if diff:
        prompt += f"""
前回との差分:
- 平均速度変化: {diff['speed_diff']:.2f}
- G前後変化: {diff['gz_diff']:.3f}
- 横G変化: {diff['gx_diff']:.3f}
"""

    prompt += """
これらを踏まえ、やさしい口調で1〜2文のフィードバックを出してください。
例：「減速がよりスムーズになりました👏」「この地点の進入が落ち着いてきました✨」
"""

    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
            max_tokens=150,
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print("⚠️ AI focus feedback failed:", e)
        return "データをもとにした解析に失敗しましたが、引き続き安全運転を意識しましょう🚗"

def compare_focus_stats(prev, curr):
    if not prev:
        return None
    return {
        "speed_diff": curr["avg_speed"] - prev["avg_speed"],
        "gx_diff": curr["mean_gx"] - prev["mean_gx"],
        "gz_diff": curr["mean_gz"] - prev["mean_gz"],
    }


# --- 追加: 2点間の距離[m]（ハバースイン） ---
from math import radians, sin, cos, sqrt, atan2

def get_distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """地球上の2点間距離（m）"""
    R = 6371000.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
    return R * 2.0 * atan2(sqrt(a), sqrt(1.0 - a))

# --- 追加: 重点ポイント近傍の統計を作る（速度/Gの平均） ---
def calc_focus_area_stats(gps_nearby: list) -> dict:
    if not gps_nearby:
        return {"avg_speed": 0.0, "mean_gx": 0.0, "mean_gz": 0.0}

    n = float(len(gps_nearby))
    avg_speed = sum(g.get("speed", 0.0) or 0.0 for g in gps_nearby) / n
    mean_gx   = sum(g.get("g_x",   0.0) or 0.0 for g in gps_nearby) / n
    mean_gz   = sum(g.get("g_z",   0.0) or 0.0 for g in gps_nearby) / n
    return {
        "avg_speed": round(avg_speed, 3),
        "mean_gx":   round(mean_gx,   4),
        "mean_gz":   round(mean_gz,   4),
    }

# --- 追加: 前回との差分計算 ---
def compare_focus_stats(prev: dict|None, curr: dict) -> dict|None:
    if not prev:
        return None
    return {
        "speed_diff": round(curr["avg_speed"] - (prev.get("avg_speed") or 0.0), 3),
        "gx_diff":    round(curr["mean_gx"]   - (prev.get("mean_gx")   or 0.0), 4),
        "gz_diff":    round(curr["mean_gz"]   - (prev.get("mean_gz")   or 0.0), 4),
    }

# --- 追加: 各重点ポイントのAIコメント（比較済みの数値だけ渡す） ---
def generate_ai_focus_feedback(current_stats: dict, diff: dict|None, first_time: bool) -> str:
    intro = "はじめて重視した地点です。 " if first_time else ""
    # AIはコメント生成のみを担当。数値比較は上で済ませている
    prompt = f"""あなたは運転コーチAI『ドライボ』です。
{intro}次の数値（平均速度・G値と、その前回からの変化）が与えられます。
やさしい口調で1〜2文で、具体的かつ前向きなフィードバックを返してください。
スコアや点数は出さないでください。絵文字を少し使ってください。

今回の地点データ:
- 平均速度: {current_stats['avg_speed']} km/h
- 平均G(前後): {current_stats['mean_gz']}
- 平均G(横): {current_stats['mean_gx']}

前回との差分:
{('- 平均速度変化: ' + str(diff['speed_diff']) + '\\n- 前後G変化: ' + str(diff['gz_diff']) + '\\n- 横G変化: ' + str(diff['gx_diff'])) if diff else '（前回データなし）'}
"""
    try:
        if client:
            res = client.chat.completions.create(
                model="gpt-3.5-turbo",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.6,
                max_tokens=180,
            )
            return res.choices[0].message.content.strip()
    except Exception as e:
        print("AI focus feedback error:", e)

    # フォールバック（AIが使えない/失敗時）
    if first_time:
        return "はじめて重視した地点です。落ち着いた進入と丁寧な減速を意識できるとさらに安心です👏"
    if diff:
        tips = []
        if diff["speed_diff"] < 0: tips.append("進入速度が落ち着いてきました")
        if diff["gz_diff"]   < 0: tips.append("減速がよりスムーズになっています")
        if diff["gx_diff"]   < 0: tips.append("横Gが小さく安定しています")
        if not tips: tips.append("安定感が維持されています")
        return " / ".join(tips) + "。この調子でいきましょう🚗"
    return "落ち着いた操作を意識できています。次回も安全第一でいきましょう✨"

# --- 追加: 未通過時のコメント定数 ---
NOT_PASSED_COMMENT = "この重点ポイントは今回の走行で通過しなかったようです。次回、挑戦してみましょう！"
NOT_PASSED_STATS = {"avg_speed": 0.0, "mean_gx": 0.0, "mean_gz": 0.0}
MAX_PASS_DISTANCE_M = 50

# --- 追加: セッション内の重点ポイントごとに解析し保存 ---
def analyze_focus_points_for_session(session_id: str, user_id: str, time_window_ms: int = 5000, max_pass_distance_m: int = MAX_PASS_DISTANCE_M) -> dict: # <-- max_pass_distance_mを追加
    """
    - recording_start.html で設定した priority_pins（user_id一致）を列挙
    - 各ピンの位置に最も近いGPSログを探してそのtimestamp_msを取得
    - ±5秒の範囲で avg_g_logs を抽出して統計を作成
    - 前回（過去セッション）の同pin_idの stats を比較
    - AIでコメント“だけ”生成
    - 保存先: sessions/{session_id}/focus_feedbacks/{pin_id}
    """
    db = firestore.client()
    sess_ref = db.collection("sessions").document(session_id)

    if not sess_ref.get().exists:
        print("session not found:", session_id)
        return {}

    # GPSログと avg_g_logs を取得
    gps_logs = [d.to_dict() for d in sess_ref.collection("gps_logs").order_by("timestamp").stream()]
    avg_g_logs = [d.to_dict() for d in sess_ref.collection("avg_g_logs").order_by("timestamp").stream()]

    # ユーザーの重点ピン（recording_start で作成）を取得
    pins = []
    for p in db.collection("priority_pins").where("user_id", "==", user_id).stream():
        o = p.to_dict()
        o["id"] = p.id
        pins.append(o)

    results = {}

    for pin in pins:
            prev_stats = None
            lat, lng, pin_id = float(pin["lat"]), float(pin["lng"]), pin["id"]

            # --- GPSログから一番近い時刻を見つける ---
            nearest_point = None
            nearest_dist = float("inf")
            for g in gps_logs:
                dist = get_distance_meters(lat, lng, g.get("latitude", 0.0), g.get("longitude", 0.0))
                if dist < nearest_dist:
                    nearest_dist = dist
                    nearest_point = g

            if not nearest_point:
                continue

            # 🚨 【重要】未通過判定ロジックをここに追加 🚨
            passed_flag = True
            
            # 1. 未通過チェック (最も近い距離が許容範囲外)
            if nearest_dist > max_pass_distance_m:
                print(f"⚠️ Pin {pin_id} (Label: {pin.get('label', '')}) not passed. Nearest distance: {nearest_dist:.2f}m")
                current_stats = NOT_PASSED_STATS
                comment = NOT_PASSED_COMMENT
                diff = None # 未通過の場合は比較不要
                passed_flag = False

            # 2. 通過したが、ログがないチェック (既存ロジックを修正)
            else:
                center_time = nearest_point.get("timestamp_ms")
                if not center_time:
                    # このケースは通常起こらないが、念のためスキップ
                    continue 

                # --- avg_g_logsから±5秒の範囲を抽出 ---
                nearby = [g for g in avg_g_logs if abs(g.get("timestamp_ms", 0) - center_time) <= time_window_ms]

                if not nearby:
                    print(f"⚠️ No avg_g_logs found near pin {pin_id}. Treating as unanalyzed.")
                    # ログがない場合は、未通過コメントとは違う、ログ不足のコメントにする
                    current_stats = NOT_PASSED_STATS
                    comment = "通過は確認されましたが、この地点でのGセンサーログが不足しているため、解析できませんでした。"
                    diff = None
                    
                else:
                    # --- 通過かつログありの通常処理 ---
                    current_stats = calc_focus_area_stats(nearby)
                    
                    # ... (中略: 前回データ取得ロジック - 変更なし) ...
                    
                    # --- 差分計算 ---
                    diff = compare_focus_stats(prev_stats, current_stats)

                    # --- AIコメント生成 ---
                    comment = generate_ai_focus_feedback(current_stats, diff, first_time=(prev_stats is None))

            # --- Firestoreに保存 ---
            # 🚨 【重要】保存データに passed_flag を追加 🚨
            sess_ref.collection("focus_feedbacks").document(pin_id).set({
                "created_at": datetime.now(JST),
                "user_id": user_id,
                "pin_id": pin_id,
                "pin_label": pin.get("label", ""),
                "stats": current_stats,
                "diff": diff,
                "ai_comment": comment,
                "passed": passed_flag, # 通過フラグを保存
            })

            results[pin_id] = {
                "pin_label": pin.get("label", ""),
                "stats": current_stats,
                "diff": diff,
                "ai_comment": comment
            }

    print(f"✅ focus_feedbacks (time-based) stored under sessions/{session_id}")
    return results

