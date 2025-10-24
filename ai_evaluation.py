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
        
        # 生成AIで評価を作成（一旦ダミーデータで代替）
        evaluation = generate_ai_evaluation(stats, focus_point)
        
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
    統計データを元に生成AIで運転評価を作成
    OpenAI APIが利用可能な場合は使用し、そうでなければフォールバック
    """
    
    # スコア計算
    scores = calculate_scores(stats)
    
    # OpenAI APIが利用可能な場合はAIで生成、そうでなければフォールバック
    if client and openai.api_key:
        try:
            comments = generate_ai_comments(stats, scores, focus_point)
            overall_comment = generate_ai_overall_comment(stats, scores, focus_point)
        except Exception as e:
            print(f"OpenAI API error: {e}")
            # エラーの場合はフォールバック
            comments = generate_comments(stats, scores)
            overall_comment = generate_overall_comment_no_score(stats, scores)
    else:
        # OpenAI APIが使用できない場合はフォールバック
        comments = generate_comments(stats, scores)
        overall_comment = generate_overall_comment_no_score(stats, scores)
    
    return {
        'scores': scores,
        'comments': comments,
        'overall_comment': overall_comment,
        'focus_point': focus_point,
        'generated_at': datetime.now(JST)
    }

def calculate_scores(stats):
    """
    統計データからスコアを計算
    """
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

def generate_comments(stats, scores):
    """
    各項目のコメントを生成
    """
    comments = {}
    
    # 減速コメント
    if scores['brake'] >= 85:
        comments['brake'] = {
            'result': 'とても丁寧！',
            'detail': f"急ブレーキ {stats['sudden_brakes']}回",
            'comment': 'ブレーキのタイミングが完璧！乗り心地バッチリ👏'
        }
    elif scores['brake'] >= 70:
        comments['brake'] = {
            'result': '安定感あり',
            'detail': f"急ブレーキ {stats['sudden_brakes']}回",
            'comment': '適度な減速で安心感があります。この調子で！💨'
        }
    else:
        comments['brake'] = {
            'result': 'もう少し余裕を',
            'detail': f"急ブレーキ {stats['sudden_brakes']}回",
            'comment': '少し急なブレーキが多いかも。前方をよく見て早めの減速を心がけましょう！'
        }
    
    # 加速コメント
    if scores['accel'] >= 85:
        comments['accel'] = {
            'result': 'スムーズで快適！',
            'detail': f"急加速 {stats['sudden_accels']}回",
            'comment': '加速がとてもなめらか！快適な運転です🚗'
        }
    elif scores['accel'] >= 70:
        comments['accel'] = {
            'result': 'まずまず',
            'detail': f"急加速 {stats['sudden_accels']}回",
            'comment': '勢いあるドライブ！でももう少し抑えるとよりスムーズ💨'
        }
    else:
        comments['accel'] = {
            'result': '少し強めかな？',
            'detail': f"急加速 {stats['sudden_accels']}回",
            'comment': 'アクセルをもう少し優しく踏むと、より快適な運転になります！'
        }
    
    # 旋回コメント
    if scores['turn'] >= 85:
        comments['turn'] = {
            'result': 'ふんわり上手！',
            'detail': f"急カーブ {stats['sharp_turns']}回",
            'comment': 'カーブをとてもスムーズに曲がれています！お手本のような運転🔥'
        }
    elif scores['turn'] >= 70:
        comments['turn'] = {
            'result': 'まずまず',
            'detail': f"急カーブ {stats['sharp_turns']}回",
            'comment': '少し内側に切り込み気味！次はもう少し外へふんわり回ろう！'
        }
    else:
        comments['turn'] = {
            'result': 'やや急め？',
            'detail': f"急カーブ {stats['sharp_turns']}回",
            'comment': 'カーブではもう少しゆっくりと、ハンドルを優しく操作してみましょう！'
        }
    
    # 直進コメント
    if scores['straight'] >= 85:
        comments['straight'] = {
            'result': '安定感バッチリ！',
            'detail': f"平均速度 {stats['speed_stats']['avg_speed']:.0f}km/h",
            'comment': '真っすぐ走行キープ！安定感すごい🔥'
        }
    elif scores['straight'] >= 70:
        comments['straight'] = {
            'result': '概ね安定',
            'detail': f"平均速度 {stats['speed_stats']['avg_speed']:.0f}km/h",
            'comment': '直進は安定してます。この調子で他の項目も伸ばしましょう！'
        }
    else:
        comments['straight'] = {
            'result': '少しふらつき？',
            'detail': f"平均速度 {stats['speed_stats']['avg_speed']:.0f}km/h",
            'comment': 'ハンドルを軽く握って、まっすぐ走ることを意識してみましょう！'
        }
    
    return comments

def generate_overall_comment(stats, scores):
    """
    総評コメントを生成（スコア表示あり - 旧バージョン）
    """
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

def generate_overall_comment_no_score(stats, scores):
    """
    総評コメントを生成（スコア表示なし）
    """
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

def generate_ai_comments(stats, scores, focus_point=''):
    """
    OpenAI APIを使用して各項目のコメントを生成
    """
    # 運転データをテキスト形式で整理
    driving_data = f"""
運転統計データ:
- 走行時間: {stats['duration_minutes']:.1f}分
- 走行距離: {stats['total_distance']:.2f}km
- 急ブレーキ: {stats['sudden_brakes']}回
- 急加速: {stats['sudden_accels']}回
- 急カーブ: {stats['sharp_turns']}回
- 平均速度: {stats['speed_stats']['avg_speed']:.1f}km/h
- 平均G値 (前後): {stats['g_stats']['mean_g_x']:.2f}
- 平均G値 (左右): {stats['g_stats']['mean_g_y']:.2f}

スコア:
- 減速: {scores['brake']}点
- 加速: {scores['accel']}点
- 旋回: {scores['turn']}点
- 直進: {scores['straight']}点
"""
    
    if focus_point:
        driving_data += f"- 今回の重点ポイント: {focus_point}\n"
    
    prompt = f"""
あなたは親しみやすい運転アドバイザーのAI「ドライボ」です。
以下の運転データを分析して、各項目について具体的で励ましを含むコメントを生成してください。

{driving_data}

以下のJSON形式で出力してください：
{{
  "brake": {{
    "result": "評価結果（例：とても丁寧！）",
    "detail": "詳細データ（例：急ブレーキ 1回）", 
    "comment": "親しみやすくて具体的なアドバイス"
  }},
  "accel": {{
    "result": "評価結果",
    "detail": "詳細データ",
    "comment": "親しみやすくて具体的なアドバイス"
  }},
  "turn": {{
    "result": "評価結果",
    "detail": "詳細データ", 
    "comment": "親しみやすくて具体的なアドバイス"
  }},
  "straight": {{
    "result": "評価結果",
    "detail": "詳細データ",
    "comment": "親しみやすくて具体的なアドバイス"
  }}
}}

※コメントには絵文字を使用して親しみやすくしてください
※スコアが高い場合は積極的に褒め、低い場合も前向きなアドバイスを心がけてください
"""

    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "あなたは親しみやすい運転アドバイザーAI「ドライボ」です。運転者を励まし、具体的なアドバイスを提供します。"},
                {"role": "user", "content": prompt}
            ],
            max_tokens=1000,
            temperature=0.7
        )
        
        ai_response = response.choices[0].message.content.strip()
        
        # JSONとして解析
        try:
            comments = json.loads(ai_response)
            return comments
        except json.JSONDecodeError:
            print(f"Failed to parse AI response as JSON: {ai_response}")
            # フォールバックとして既存の関数を使用
            return generate_comments(stats, scores)
            
    except Exception as e:
        print(f"OpenAI API call failed: {e}")
        # エラーの場合はフォールバック
        return generate_comments(stats, scores)

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