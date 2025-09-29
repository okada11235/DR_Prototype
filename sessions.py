# sessions.py
from flask import Blueprint, request, jsonify
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
        doc_ref = db.collection('sessions').add({
            'user_id': current_user.id,
            'start_time': firestore.SERVER_TIMESTAMP,
            'status': 'active',
            'reflection': ''
        })
        return jsonify({'session_id': doc_ref[1].id})
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

    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()

    if not session_doc.exists:
        return jsonify({'status': 'error', 'message': 'Session not found'}), 404

    if session_doc.to_dict().get('user_id') != current_user.id:
        return jsonify({'status': 'error', 'message': 'Permission denied'}), 403

    try:
        session_ref.update({
            'end_time': firestore.SERVER_TIMESTAMP,
            'status': 'completed',
            'distance': float(data.get('distance', 0.0)),
            'sudden_accels': int(data.get('sudden_accels', 0)),
            'sudden_brakes': int(data.get('sudden_brakes', 0)),
            'sharp_turns': int(data.get('sharp_turns', 0)),
            'stability': float(data.get('stability', 0.0)),
            'speed_violations': int(data.get('speed_violations', 0))
        })
        return jsonify({'status': 'ok'})
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
    print("Received GPS logs:", data)
    session_id = data.get('session_id')
    gps_logs = data.get('gps_logs', [])

    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        return jsonify({'status': 'error', 'message': 'Permission denied or session not found'}), 403

    try:
        batch = db.batch()
        gps_collection = session_ref.collection('gps_logs')
        for log in gps_logs:
            ts_ms = log.get('timestamp')  # 端末から送られてきたUNIX時間（ミリ秒）
            if ts_ms:
                ts_dt = datetime.fromtimestamp(ts_ms / 1000.0, JST)
            else:
                ts_dt = datetime.now(JST)

            doc_ref = gps_collection.document()
            batch.set(doc_ref, {
                'latitude': log.get('latitude', 0.0),
                'longitude': log.get('longitude', 0.0),
                'speed': log.get('speed', 0.0),
                'g_x': log.get('g_x', 0.0),
                'g_y': log.get('g_y', 0.0),
                'g_z': log.get('g_z', 0.0),
                'event': log.get('event', 'normal'),
                'timestamp': ts_dt,       # Firestore標準のTimestamp型
                'timestamp_ms': ts_ms     # スマホ内部のミリ秒値をそのまま保存
            })
        batch.commit()
        return jsonify({'status': 'ok'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

# Gログ一括保存（既存）
@sessions_bp.route('/log_g_only', methods=['POST'])
@login_required
def log_g_only():
    data = request.get_json()
    print("Received G logs:", data)
    session_id = data.get('session_id')
    g_logs = data.get('g_logs', [])

    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        return jsonify({'status': 'error', 'message': 'Permission denied or session not found'}), 403

    try:
        batch = db.batch()
        g_collection = session_ref.collection('g_logs')
        for log in g_logs:
            ts_ms = log.get('timestamp')
            if ts_ms:
                ts_dt = datetime.fromtimestamp(ts_ms / 1000.0, JST)
            else:
                ts_dt = datetime.now(JST)

            doc_ref = g_collection.document()
            batch.set(doc_ref, {
                'g_x': log.get('g_x', 0.0),
                'g_y': log.get('g_y', 0.0),
                'g_z': log.get('g_z', 0.0),
                'timestamp': ts_dt,       # Firestore標準のTimestamp型
                'timestamp_ms': ts_ms     # スマホ内部のミリ秒値をそのまま保存
            })
        batch.commit()
        return jsonify({'status': 'ok'})
    except Exception as e:
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