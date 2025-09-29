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
    logs_ref = db.collection('sessions').document(session_id).collection('gps_logs')
    logs = logs_ref.order_by('timestamp').stream()
    result = []
    for log_doc in logs:
        log_data = log_doc.to_dict()
        if 'latitude' in log_data and 'longitude' in log_data:
            result.append({
                "timestamp": log_data.get('timestamp').timestamp() * 1000 if 'timestamp' in log_data and log_data['timestamp'] else 0,
                "latitude": log_data.get('latitude'),
                "longitude": log_data.get('longitude'),
                "speed": log_data.get('speed', 0.0),
                "g_x": log_data.get('g_x', 0.0),
                "g_y": log_data.get('g_y', 0.0),
                "g_z": log_data.get('g_z', 0.0),
                "event": log_data.get('event', 'normal')
            })
    return result

def get_g_logs_for_session(session_id):
    """セッションのGログを取得"""
    logs_ref = db.collection('sessions').document(session_id).collection('g_logs')
    logs = logs_ref.order_by('timestamp').stream()
    result = []
    for log_doc in logs:
        log_data = log_doc.to_dict()
        result.append({
            "timestamp": log_data['timestamp'].timestamp() * 1000 if log_data.get('timestamp') else 0,
            "g_x": log_data.get('g_x', 0.0),
            "g_y": log_data.get('g_y', 0.0),
            "g_z": log_data.get('g_z', 0.0)
        })
    return result

# メインページ
@views_bp.route('/')
@login_required
def index():
    return render_template('index.html')

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

        data['gps_logs'] = get_gps_logs_for_session(session_doc.id)
        data['g_logs'] = get_g_logs_for_session(session_doc.id)

        if 'start_time' in data and data['start_time']:
            data['start_time'] = data['start_time'].astimezone(datetime.utcnow().tzinfo)
        if 'end_time' in data and data['end_time']:
            data['end_time'] = data['end_time'].astimezone(datetime.utcnow().tzinfo)

        if data.get('distance') is not None:
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
        logs_ref = session_ref.collection('gps_logs')
        batch = db.batch()
        for log_doc in logs_ref.stream():
            batch.delete(log_doc.reference)
        batch.commit()

        session_ref.delete()
        flash('セッションを削除しました')
    except Exception as e:
        flash(f'セッション削除中にエラーが発生しました: {e}')
    return redirect(url_for('views.sessions'))