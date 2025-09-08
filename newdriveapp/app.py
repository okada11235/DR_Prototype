# ver 2.0

import os
from flask import Flask, render_template, request, redirect, url_for, jsonify, flash
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from datetime import datetime
import json
import uuid

import firebase_admin
from firebase_admin import credentials, firestore, auth
from flask_bcrypt import Bcrypt

from google.cloud.firestore_v1.base_query import FieldFilter
from dotenv import load_dotenv  # ← 追加

# --- 環境変数をロード ---
load_dotenv()

# --- Firebase Admin SDK の初期化 ---
cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
if not firebase_admin._apps:  # ← 二重初期化を防止
    cred = credentials.Certificate(cred_path)
    firebase_admin.initialize_app(cred)

db = firestore.client()

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_super_secret_key_change_this_in_production'

login_manager = LoginManager(app)
login_manager.login_view = 'login'
bcrypt = Bcrypt(app)

# Flask-LoginのUserMixinを使用しつつ、データはFirestoreから取得するように変更
class User(UserMixin):
    def __init__(self, uid, username):
        self.id = uid
        self.username = username

    @staticmethod
    def get(user_id):
        user_doc = db.collection('users').document(user_id).get()
        if user_doc.exists:
            user_data = user_doc.to_dict()
            return User(user_doc.id, user_data['username'])
        return None

@login_manager.user_loader
def load_user(user_id):
    return User.get(user_id)

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']

        users_ref = db.collection('users')
        existing_user_query = users_ref.where(filter=FieldFilter('username', '==', username)).limit(1).stream()
        existing_users = list(existing_user_query)

        if existing_users:
            flash('ユーザー名は既に使われています')
            return redirect(url_for('register'))

        try:
            user_record = auth.create_user(
                email=f"{username}@example.com",
                password=password,
                display_name=username
            )
            user_uid = user_record.uid

            hashed_password = bcrypt.generate_password_hash(password).decode('utf-8')

            db.collection('users').document(user_uid).set({
                'username': username,
                'email': f"{username}@example.com",
                'created_at': firestore.SERVER_TIMESTAMP,
                'password_hash': hashed_password
            })

            flash('登録成功。ログインしてください')
            return redirect(url_for('login'))
        except Exception as e:
            print(f"Error creating user in Firebase Auth or Firestore: {e}")
            flash('ユーザー登録に失敗しました。' + str(e))
            return redirect(url_for('register'))

    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']

        try:
            users_ref = db.collection('users')
            user_query = users_ref.where(filter=FieldFilter('username', '==', username)).limit(1).stream()
            user_doc = next(user_query, None)

            if user_doc:
                user_data = user_doc.to_dict()
                user_uid = user_doc.id

                if 'password_hash' in user_data and bcrypt.check_password_hash(user_data['password_hash'], password):
                    user = User(user_uid, username)
                    login_user(user)
                    return redirect(url_for('index'))
                else:
                    flash('ログインに失敗しました')
                    return redirect(url_for('login'))
            else:
                flash('ログインに失敗しました')
                return redirect(url_for('login'))

        except Exception as e:
            print(f"Error during login: {e}")
            flash('ログインに失敗しました。' + str(e))
            return redirect(url_for('login'))

    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

@app.route('/')
@login_required
def index():
    return render_template('index.html')

@app.route('/start', methods=['POST'])
@login_required
def start():
    try:
        doc_ref = db.collection('sessions').add({
            'user_id': current_user.id,
            'start_time': firestore.SERVER_TIMESTAMP,
            'status': 'active',
            'reflection': '' # 新しくreflectionフィールドを追加
        })
        return jsonify({'session_id': doc_ref[1].id})
    except Exception as e:
        print(f"Error starting session: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/end', methods=['POST'])
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

@app.route('/log_gps', methods=['POST'])
@login_required
def log_gps():
    data = request.get_json()
    print(f"Received GPS log data: {data}")

    session_id = data.get('session_id')
    if not session_id:
        print("Error: session_id missing in GPS log data.")
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()

    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        print(f"Permission denied or session not found for session_id: {session_id}")
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
        print(f"Successfully added GPS log for session {session_id}.")
        return jsonify({'status': 'ok'})
    except Exception as e:
        print(f"Error logging GPS for session {session_id}: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

def get_gps_logs_for_session(session_id):
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

@app.route('/sessions')
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

        # reflectionフィールドがなければ空文字列を設定
        data['reflection'] = data.get('reflection', '')

        data['gps_logs'] = get_gps_logs_for_session(session_doc.id)

        if 'start_time' in data and data['start_time']:
            data['start_time'] = data['start_time'].astimezone(datetime.utcnow().tzinfo)
        if 'end_time' in data and data['end_time']:
            data['end_time'] = data['end_time'].astimezone(datetime.utcnow().tzinfo)

        # 🔽 distance が Firestore に保存されていて None じゃないデータだけ追加
        if data.get('distance') is not None:
            sessions_list.append(data)

    return render_template('sessions.html', sessions=sessions_list)


# ★反省文を保存する新しいルート
@app.route('/save_reflection', methods=['POST'])
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
        session_ref.update({
            'reflection': reflection_text
        })
        return jsonify({'status': 'ok', 'message': '反省文が保存されました'})
    except Exception as e:
        print(f"Error saving reflection: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/session_gforce')
@login_required
def session_gforce():
    session_id = request.args.get('session_id')
    if not session_id:
        return "Session ID が指定されていません", 400

    session_doc = db.collection('sessions').document(session_id).get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        flash('このセッションへのアクセス権限がありません。')
        return redirect(url_for('sessions'))

    gps_logs = get_gps_logs_for_session(session_id)

    return render_template('session_gforce.html', session_id=session_id, gps_logs=gps_logs)

@app.route('/delete_session/<string:sid>', methods=['POST'])
@login_required
def delete_session(sid):
    session_ref = db.collection('sessions').document(sid)
    session_doc = session_ref.get()

    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        flash('削除権限がありません')
        return redirect(url_for('sessions'))

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
    return redirect(url_for('sessions'))

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)