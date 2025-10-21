# sessions.py
from flask import Blueprint, request, jsonify, render_template
from flask_login import login_required, current_user
from firebase_admin import firestore
from datetime import datetime
from config import JST
from models import db

# Blueprintの作成
sessions_bp = Blueprint('sessions', __name__)

# セッション開始
@sessions_bp.route('/start', methods=['POST'])
@login_required
def start():
    try:
        # ユーザーIDを一意のキーとして使用
        user_id = current_user.id
        print(f"Session start request from user: {user_id}")
        
        # トランザクションを使用して原子的にチェック&作成
        @firestore.transactional
        def create_session_if_not_exists(transaction):
            # 既存のアクティブセッションをチェック
            sessions_ref = db.collection('sessions')
            query = sessions_ref.where('user_id', '==', user_id).where('status', '==', 'active')
            existing_sessions = list(query.stream(transaction=transaction))
            
            if existing_sessions:
                existing_session_id = existing_sessions[0].id
                print(f"Active session already exists for user {user_id}: {existing_session_id}")
                return {
                    'status': 'warning', 
                    'message': '既にアクティブなセッションがあります',
                    'session_id': existing_session_id
                }
            
            # 新しいセッションを作成
            new_session_ref = sessions_ref.document()
            transaction.set(new_session_ref, {
                'user_id': user_id,
                'start_time': firestore.SERVER_TIMESTAMP,
                'status': 'active',
                'reflection': '',
                'created_at': firestore.SERVER_TIMESTAMP
            })
            
            new_session_id = new_session_ref.id
            print(f"New session created: {new_session_id} for user {user_id}")
            print(f"Session data will be saved with SERVER_TIMESTAMP")
            return {'session_id': new_session_id}
        
        # トランザクションを実行
        transaction = db.transaction()
        result = create_session_if_not_exists(transaction)
        
        return jsonify(result)
        
    except Exception as e:
        print(f"Error starting session: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

# セッション終了
@sessions_bp.route('/end', methods=['POST'])
@login_required
def end():
    data = request.get_json()
    session_id = data.get('session_id')
    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    try:
        # トランザクションを使用してセッション終了
        @firestore.transactional
        def end_session(transaction):
            session_ref = db.collection('sessions').document(session_id)
            session_doc = session_ref.get(transaction=transaction)

            if not session_doc.exists:
                return {'status': 'error', 'message': 'Session not found'}

            session_data = session_doc.to_dict()
            if session_data.get('user_id') != current_user.id:
                return {'status': 'error', 'message': 'Permission denied'}
            
            if session_data.get('status') != 'active':
                print(f"Session {session_id} is already ended (status: {session_data.get('status')})")
                return {'status': 'ok', 'message': 'Session already ended'}

            # ステータスをcompletedに更新
            print(f"Ending session {session_id} for user {current_user.id}")
            transaction.update(session_ref, {
                'end_time': firestore.SERVER_TIMESTAMP,
                'status': 'completed',
                'distance': float(data.get('distance', 0.0)),
                'sudden_accels': int(data.get('sudden_accels', 0)),
                'sudden_brakes': int(data.get('sudden_brakes', 0)),
                'sharp_turns': int(data.get('sharp_turns', 0)),
                'stability': float(data.get('stability', 0.0)),
                'speed_violations': int(data.get('speed_violations', 0))
            })
            
            print(f"Session {session_id} ended successfully")
            return {'status': 'ok'}
        
        # トランザクションを実行
        transaction = db.transaction()
        result = end_session(transaction)
        
        return jsonify(result)
        
    except Exception as e:
        print(f"DB update error: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

# GPSログ（単発：既存）
@sessions_bp.route('/log_gps', methods=['POST'])
@login_required
def log_gps():
    data = request.get_json()
    session_id = data.get('session_id')
    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        return jsonify({'status': 'error', 'message': 'Permission denied or session not found'}), 403

    try:
        session_ref.collection('gps_logs').add({
            'latitude': data.get('latitude', 0.0),
            'longitude': data.get('longitude', 0.0),
            'speed': data.get('speed', 0.0),
            'g_x': data.get('g_x', 0.0),
            'g_y': data.get('g_y', 0.0),
            'g_z': data.get('g_z', 0.0),
            'event': data.get('event', 'normal'),
            'timestamp': firestore.SERVER_TIMESTAMP
        })
        return jsonify({'status': 'ok'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

# GPSログ（まとめ保存：新規追加）
@sessions_bp.route('/log_gps_bulk', methods=['POST'])
@login_required
def log_gps_bulk():
    data = request.get_json()
    session_id = data.get('session_id')
    gps_logs = data.get('gps_logs', [])
    
    print(f"=== GPS BULK SAVE REQUEST ===")
    print(f"User ID: {current_user.id}")
    print(f"Session ID: {session_id}")
    print(f"GPS logs count: {len(gps_logs)}")
    print(f"Raw request data: {data}")
    
    if gps_logs:
        print(f"First GPS log sample: {gps_logs[0]}")

    if not session_id:
        print("ERROR: Missing session_id")
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists:
        print(f"ERROR: Session {session_id} not found")
        return jsonify({'status': 'error', 'message': 'Session not found'}), 403
        
    session_data = session_doc.to_dict()
    if session_data.get('user_id') != current_user.id:
        print(f"ERROR: Permission denied. Session user: {session_data.get('user_id')}, Current user: {current_user.id}")
        return jsonify({'status': 'error', 'message': 'Permission denied'}), 403

    print(f"Session validation passed. Processing {len(gps_logs)} GPS logs...")

    try:
        batch = db.batch()
        gps_collection = session_ref.collection('gps_logs')
        saved_count = 0
        
        for log in gps_logs:
            print(f"Processing GPS log: {log}")  # 各ログを詳細に出力
            
            # 緯度経度が有効かチェック
            latitude = log.get('latitude')
            longitude = log.get('longitude')
            
            print(f"GPS coordinates: lat={latitude}, lng={longitude}")
            
            if latitude is None or longitude is None:
                print(f"Skipping GPS log due to None values: lat={latitude}, lng={longitude}")
                continue
                
            # 緯度経度が0の場合もログに出力するが保存はする
            if latitude == 0 and longitude == 0:
                print(f"Warning: GPS log has zero coordinates: lat={latitude}, lng={longitude}")
                # 0座標でも保存を続行する
            
            ts_ms = log.get('timestamp')  # 端末から送られてきたUNIX時間（ミリ秒）
            if ts_ms:
                ts_dt = datetime.fromtimestamp(ts_ms / 1000.0, JST)
            else:
                ts_dt = datetime.now(JST)

            doc_ref = gps_collection.document()
            batch.set(doc_ref, {
                'latitude': float(latitude),
                'longitude': float(longitude),
                'speed': float(log.get('speed', 0.0)),
                'event': log.get('event', 'normal'),
                'timestamp': ts_dt,       # Firestore標準のTimestamp型
                'timestamp_ms': ts_ms     # スマホ内部のミリ秒値をそのまま保存
            })
            saved_count += 1
            print(f"Added GPS log {saved_count} to batch: lat={latitude}, lng={longitude}")
        
        if saved_count > 0:
            print(f"Committing batch with {saved_count} GPS logs...")
            batch.commit()
            print(f"Successfully saved {saved_count} GPS logs to session {session_id}")
        else:
            print(f"No valid GPS logs to save for session {session_id}")
            
        print(f"=== GPS BULK SAVE COMPLETED: {saved_count} logs saved ===")
        return jsonify({'status': 'ok', 'saved_count': saved_count})
    except Exception as e:
        print(f"Error saving GPS logs: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

# Gログ一括保存（既存）
@sessions_bp.route('/log_g_only', methods=['POST'])
@login_required
def log_g_only():
    data = request.get_json()
    session_id = data.get('session_id')
    g_logs = data.get('g_logs', [])
    
    print(f"Received G bulk save request for session {session_id}")
    print(f"G logs count: {len(g_logs)}")
    if g_logs:
        print(f"First G log sample: {g_logs[0]}")

    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        return jsonify({'status': 'error', 'message': 'Permission denied or session not found'}), 403

    try:
        batch = db.batch()
        g_collection = session_ref.collection('g_logs')
        saved_count = 0
        
        for log in g_logs:
            ts_ms = log.get('timestamp')
            if ts_ms:
                ts_dt = datetime.fromtimestamp(ts_ms / 1000.0, JST)
            else:
                ts_dt = datetime.now(JST)

            doc_ref = g_collection.document()
            batch.set(doc_ref, {
                'g_x': float(log.get('g_x', 0.0)),
                'g_y': float(log.get('g_y', 0.0)),
                'g_z': float(log.get('g_z', 0.0)),
                'speed': float(log.get('speed', 0.0)),
                'event': log.get('event', 'normal'),
                'timestamp': ts_dt,       # Firestore標準のTimestamp型
                'timestamp_ms': ts_ms     # スマホ内部のミリ秒値をそのまま保存
            })
            saved_count += 1
            
        batch.commit()
        print(f"Successfully saved {saved_count} G logs to session {session_id}")
        return jsonify({'status': 'ok', 'saved_count': saved_count})
    except Exception as e:
        print(f"Error saving G logs: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500
    
# 平滑化Gログ一括保存（avg_g_logs）
@sessions_bp.route('/log_avg_g_bulk', methods=['POST'])
@login_required
def log_avg_g_bulk():
    data = request.get_json()
    session_id = data.get('session_id')
    avg_g_logs = data.get('avg_g_logs', [])
    
    print(f"Received AVG-G bulk save request for session {session_id}")
    print(f"Avg G logs count: {len(avg_g_logs)}")
    if avg_g_logs:
        print(f"First avg G log sample: {avg_g_logs[0]}")

    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    # セッション確認
    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        return jsonify({'status': 'error', 'message': 'Permission denied or session not found'}), 403

    try:
        batch = db.batch()
        avg_collection = session_ref.collection('avg_g_logs')
        saved_count = 0
        
        for log in avg_g_logs:
            ts_ms = log.get('timestamp')
            if ts_ms:
                ts_dt = datetime.fromtimestamp(ts_ms / 1000.0, JST)
            else:
                ts_dt = datetime.now(JST)

            doc_ref = avg_collection.document()
            batch.set(doc_ref, {
                'g_x': float(log.get('g_x', 0.0)),
                'g_y': float(log.get('g_y', 0.0)),
                'g_z': float(log.get('g_z', 0.0)),
                'speed': float(log.get('speed', 0.0)),
                'event': log.get('event', 'normal'),
                'timestamp': ts_dt,
                'timestamp_ms': ts_ms
            })
            saved_count += 1
        
        batch.commit()
        print(f"✅ Successfully saved {saved_count} avg G logs to session {session_id}")
        return jsonify({'status': 'ok', 'saved_count': saved_count})
    except Exception as e:
        print(f"Error saving avg G logs: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

# 反省文保存
@sessions_bp.route('/save_reflection', methods=['POST'])
@login_required
def save_reflection():
    data = request.get_json()
    session_id = data.get('session_id')
    reflection_text = data.get('reflection_text', '')

    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        return jsonify({'status': 'error', 'message': 'Permission denied'}), 403

    try:
        session_ref.update({'reflection': reflection_text})
        return jsonify({'status': 'ok', 'message': '反省文が保存されました'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

# デバッグ用：セッションデータ確認エンドポイント
@sessions_bp.route('/debug_session/<session_id>')
@login_required
def debug_session(session_id):
    """デバッグ用：セッションのGPSとGログの詳細を確認"""
    try:
        session_ref = db.collection('sessions').document(session_id)
        session_doc = session_ref.get()
        
        if not session_doc.exists:
            return jsonify({'error': 'Session not found'}), 404
            
        session_data = session_doc.to_dict()
        if session_data.get('user_id') != current_user.id:
            return jsonify({'error': 'Permission denied'}), 403
        
        # GPS ログを取得
        gps_logs_ref = session_ref.collection('gps_logs')
        gps_logs = list(gps_logs_ref.stream())
        
        # G ログを取得
        g_logs_ref = session_ref.collection('g_logs')
        g_logs = list(g_logs_ref.stream())
        
        debug_info = {
            'session_id': session_id,
            'session_data': session_data,
            'gps_logs_count': len(gps_logs),
            'g_logs_count': len(g_logs),
            'gps_logs_sample': [doc.to_dict() for doc in gps_logs[:3]] if gps_logs else [],
            'g_logs_sample': [doc.to_dict() for doc in g_logs[:3]] if g_logs else []
        }
        
        return jsonify(debug_info)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# テスト用：GPSログの保存確認
@sessions_bp.route('/test_gps_save/<session_id>')
@login_required
def test_gps_save(session_id):
    """テスト用：GPSログを1件追加して保存確認"""
    try:
        session_ref = db.collection('sessions').document(session_id)
        session_doc = session_ref.get()
        
        if not session_doc.exists:
            return jsonify({'error': 'Session not found'}), 404
            
        session_data = session_doc.to_dict()
        if session_data.get('user_id') != current_user.id:
            return jsonify({'error': 'Permission denied'}), 403
        
        # テスト用GPSデータを追加
        gps_collection = session_ref.collection('gps_logs')
        test_gps_data = {
            'latitude': 35.681236,
            'longitude': 139.767125,
            'speed': 10.0,
            'g_x': 0.1,
            'g_y': 0.2,
            'g_z': 9.8,
            'event': 'test',
            'timestamp': datetime.now(JST),
            'timestamp_ms': int(datetime.now().timestamp() * 1000)
        }
        
        doc_ref = gps_collection.add(test_gps_data)
        print(f"Test GPS data added to session {session_id}: {doc_ref[1].id}")
        
        # 現在のGPSログ数を確認
        gps_logs = list(gps_collection.stream())
        
        return jsonify({
            'status': 'ok',
            'message': f'Test GPS data added to session {session_id}',
            'gps_logs_count': len(gps_logs),
            'test_data': test_gps_data
        })
        
    except Exception as e:
        print(f"Error in test_gps_save: {e}")
        return jsonify({'error': str(e)}), 500
    
# 既存importに追加
from flask import render_template
import random

# ==== 一覧（全体スコア＆セッション一覧） ====
from datetime import timezone, timedelta
JST = timezone(timedelta(hours=9))

@sessions_bp.route('/results')
@login_required
def results_page():
    # Firestoreなどからセッション一覧を取得
    sessions_ref = firestore.client().collection('sessions').where('user_id', '==', current_user.id)
    docs = sessions_ref.order_by('start_time', direction=firestore.Query.DESCENDING).stream()

    sessions = []
    for doc in docs:
        data = doc.to_dict()
        data['id'] = doc.id

        # 🔸 Firestore Timestamp → Python datetime（JST変換）
        if data.get('start_time'):
            data['start_time'] = data['start_time'].astimezone(JST)
        if data.get('end_time'):
            data['end_time'] = data['end_time'].astimezone(JST)

        sessions.append(type('SessionObj', (object,), data))

    # 🔸 平均スコアなどを計算 or ダミー生成
    overall_scores = {
        "減速": 80,
        "加速": 78,
        "旋回": 83,
        "直進": 85,
        "総評": 82
    }

    return render_template(
        'result.html',
        sessions=sessions,
        overall_scores=overall_scores
    )

# ==== 詳細（個別セッション：実データでグラフ＆地図を描画） ====
@sessions_bp.route('/results/<session_id>')
@login_required
def detail_result_page(session_id):
    """
    個別セッションのGPS/avg_g_logsを取得して、detail_result.html へ。
    グラフ・地図・イベントマーカー・同期ズームを完全動作させる。
    """
    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists:
        return render_template('detail_result.html',
                               session=None,
                               gps_logs=[],
                               avg_g_logs=[],
                               display_error="このセッションは存在しません。")

    s = session_doc.to_dict()
    if s.get('user_id') != current_user.id:
        return render_template('detail_result.html',
                               session=None,
                               gps_logs=[],
                               avg_g_logs=[],
                               display_error="権限がありません。")
    
    # 🔹 ここで JST 変換を追加！
    if s.get('start_time'):
        s['start_time'] = s['start_time'].astimezone(JST)
    if s.get('end_time'):
        s['end_time'] = s['end_time'].astimezone(JST)

    # GPSログ
    gps_logs = []
    for gdoc in session_ref.collection('gps_logs').order_by('timestamp').stream():
        gd = gdoc.to_dict()
        gps_logs.append({
            "latitude": float(gd.get("latitude", 0.0)),
            "longitude": float(gd.get("longitude", 0.0)),
            "speed": float(gd.get("speed", 0.0)),
            "event": gd.get("event", "normal"),
            # Firestore Timestamp と 端末msを両方運ぶ（描画側は timestamp_ms を優先）
            "timestamp": int(gd.get("timestamp").timestamp()*1000) if gd.get("timestamp") else None,
            "timestamp_ms": gd.get("timestamp_ms"),
        })

    # 平滑化Gログ（avg_g_logs）
    avg_g_logs = []
    for adoc in session_ref.collection('avg_g_logs').order_by('timestamp').stream():
        ad = adoc.to_dict()
        avg_g_logs.append({
            "g_x": float(ad.get("g_x", 0.0)),
            "g_y": float(ad.get("g_y", 0.0)),
            "g_z": float(ad.get("g_z", 0.0)),
            "speed": float(ad.get("speed", 0.0)),
            "event": ad.get("event", "normal"),
            "timestamp": int(ad.get("timestamp").timestamp()*1000) if ad.get("timestamp") else None,
            "timestamp_ms": ad.get("timestamp_ms"),
        })

    # 画面ヘッダ表示用（未保存値はN/Aに）
    session_view = {
        "id": session_id,
        "start_time": s.get("start_time"),
        "end_time": s.get("end_time"),
        "distance": s.get("distance"),
        "status": s.get("status", "unknown"),
        "sudden_brakes": s.get("sudden_brakes"),
        "sudden_accels": s.get("sudden_accels"),
        "sharp_turns": s.get("sharp_turns"),
    }

    # コメント（擬似）
    comment_text = "全体的に安定した運転でした！特に直進の安定感が素晴らしいです👏 旋回時のG変化をもう少し抑えれば、さらに上級者レベルです🔥"

    # スコア（擬似）
    detail_scores = {"減速": 80, "加速": 75, "旋回": 70, "直進": 90, "総評": 79}

    # 🔹 録音音声を取得
    audio_records = get_audio_records(session_id)

    return render_template('detail_result.html',
                           session=session_view,
                           gps_logs=gps_logs,
                           avg_g_logs=avg_g_logs,
                           audio_records=audio_records,
                           detail_scores=detail_scores,
                           comment_text=comment_text,
                           display_error=None)

def get_audio_records(session_id):
    """セッションに紐づく録音音声一覧を取得"""
    audio_records_ref = db.collection("sessions").document(session_id).collection("audio_records")
    audio_records = []
    for doc in audio_records_ref.stream():
        data = doc.to_dict()
        if data.get("url"):
            # JST補正
            if "created_at" in data:
                ts = data["created_at"]
                if not isinstance(ts, datetime):
                    try:
                        data["created_at"] = datetime.fromtimestamp(ts / 1000, JST)
                    except Exception:
                        data["created_at"] = datetime.now(JST)
                else:
                    data["created_at"] = ts.astimezone(JST)
            audio_records.append(data)
    # 時刻降順
    audio_records.sort(key=lambda a: a.get("created_at", datetime.min), reverse=True)
    return audio_records
