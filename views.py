# views.py
from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import login_required, current_user
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from datetime import datetime
from models import db

# Blueprintの作成
views_bp = Blueprint('views', __name__)

def get_gps_logs_for_session(session_id):
    """セッションのGPSログを取得"""
    try:
        logs_ref = db.collection('sessions').document(session_id).collection('gps_logs')
        logs = logs_ref.order_by('timestamp').stream()
        result = []
        
        for log_doc in logs:
            log_data = log_doc.to_dict()
            if 'latitude' in log_data and 'longitude' in log_data:
                # timestamp_msを優先して使用
                timestamp_value = 0
                if 'timestamp_ms' in log_data and log_data['timestamp_ms']:
                    timestamp_value = log_data['timestamp_ms']
                elif 'timestamp' in log_data and log_data['timestamp']:
                    timestamp_value = log_data['timestamp'].timestamp() * 1000
                
                result.append({
                    "timestamp": timestamp_value,
                    "timestamp_ms": timestamp_value,  # 互換性のため
                    "latitude": log_data.get('latitude'),
                    "longitude": log_data.get('longitude'),
                    "speed": log_data.get('speed', 0.0),
                    "g_x": log_data.get('g_x', 0.0),
                    "g_y": log_data.get('g_y', 0.0),
                    "g_z": log_data.get('g_z', 0.0),
                    "event": log_data.get('event', 'normal')
                })
        
        print(f"GPS logs for session {session_id}: {len(result)} records")
        if len(result) > 0:
            print(f"First GPS log: {result[0]}")
        
        return result
    except Exception as e:
        print(f"Error getting GPS logs for session {session_id}: {e}")
        return []

def get_g_logs_for_session(session_id):
    """セッションのGログを取得"""
    try:
        logs_ref = db.collection('sessions').document(session_id).collection('g_logs')
        logs = logs_ref.order_by('timestamp').stream()
        result = []
        
        for log_doc in logs:
            log_data = log_doc.to_dict()
            # timestamp_msを優先して使用
            timestamp_value = 0
            if 'timestamp_ms' in log_data and log_data['timestamp_ms']:
                timestamp_value = log_data['timestamp_ms']
            elif 'timestamp' in log_data and log_data['timestamp']:
                timestamp_value = log_data['timestamp'].timestamp() * 1000
            
            result.append({
                "timestamp": timestamp_value,
                "timestamp_ms": timestamp_value,  # 互換性のため
                "g_x": log_data.get('g_x', 0.0),
                "g_y": log_data.get('g_y', 0.0),
                "g_z": log_data.get('g_z', 0.0)
            })
        
        print(f"G logs for session {session_id}: {len(result)} records")
        if len(result) > 0:
            print(f"First G log: {result[0]}")
        
        return result
    except Exception as e:
        print(f"Error getting G logs for session {session_id}: {e}")
        return []

# メインページ（記録開始画面にリダイレクト）
@views_bp.route('/')
@login_required
def index():
    return redirect(url_for('views.recording_start'))

# 記録開始画面
@views_bp.route('/recording/start')
@login_required
def recording_start():
    return render_template('recording_start.html')

# 記録中画面
@views_bp.route('/recording/active')
@login_required
def recording_active():
    return render_template('recording_active.html')

# 記録完了画面
@views_bp.route('/recording/completed')
@login_required
def recording_completed():
    return render_template('recording_completed.html')

# セッション一覧
@views_bp.route('/sessions')
@login_required
def sessions():
    sessions_query_result = (
        db.collection('sessions')
        .where(filter=FieldFilter('user_id', '==', current_user.id))
        .order_by('start_time', direction=firestore.Query.DESCENDING)
        .stream()
    )

    sessions_list = []
    for session_doc in sessions_query_result:
        data = session_doc.to_dict()
        data['id'] = session_doc.id
        data['reflection'] = data.get('reflection', '')
        
        # セッションデータにデフォルト値を設定
        data['distance'] = data.get('distance', None)
        data['sudden_accels'] = data.get('sudden_accels', 0)
        data['sudden_brakes'] = data.get('sudden_brakes', 0)
        data['sharp_turns'] = data.get('sharp_turns', 0)
        data['speed_violations'] = data.get('speed_violations', 0)
        data['status'] = data.get('status', 'unknown')

        data['gps_logs'] = get_gps_logs_for_session(session_doc.id)
        data['g_logs'] = get_g_logs_for_session(session_doc.id)

        if 'start_time' in data and data['start_time']:
            data['start_time'] = data['start_time'].astimezone(datetime.utcnow().tzinfo)
        if 'end_time' in data and data['end_time']:
            data['end_time'] = data['end_time'].astimezone(datetime.utcnow().tzinfo)

        # セッションデータをリストに追加（distanceの有無にかかわらず）
        # デバッグ情報を追加
        print(f"Session {session_doc.id}: distance={data.get('distance')}, status={data.get('status')}")
        print(f"GPS logs count: {len(data['gps_logs'])}, G logs count: {len(data['g_logs'])}")
        
        sessions_list.append(data)

    return render_template('sessions.html', sessions=sessions_list)

# セッションG力表示
@views_bp.route('/session_gforce')
@login_required
def session_gforce():
    session_id = request.args.get('session_id')
    if not session_id:
        return "Session ID が指定されていません", 400

    session_doc = db.collection('sessions').document(session_id).get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        flash('このセッションへのアクセス権限がありません。')
        return redirect(url_for('views.sessions'))

    gps_logs = get_gps_logs_for_session(session_id)
    return render_template('session_gforce.html', session_id=session_id, gps_logs=gps_logs)

# セッション削除
@views_bp.route('/delete_session/<string:sid>', methods=['POST'])
@login_required
def delete_session(sid):
    session_ref = db.collection('sessions').document(sid)
    session_doc = session_ref.get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        flash('削除権限がありません')
        return redirect(url_for('views.sessions'))

    try:
        # GPSログを削除
        gps_logs_ref = session_ref.collection('gps_logs')
        batch = db.batch()
        for log_doc in gps_logs_ref.stream():
            batch.delete(log_doc.reference)
        
        # Gログも削除
        g_logs_ref = session_ref.collection('g_logs')
        for log_doc in g_logs_ref.stream():
            batch.delete(log_doc.reference)
        
        batch.commit()

        # セッション本体を削除
        session_ref.delete()
        flash('セッションを削除しました')
    except Exception as e:
        flash(f'セッション削除中にエラーが発生しました: {e}')
    return redirect(url_for('views.sessions'))