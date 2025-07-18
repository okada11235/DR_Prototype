from flask import Flask, render_template, request, redirect, url_for, jsonify, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from datetime import datetime
import json

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_secret_key'  # 任意の強力な文字列に変更してください
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///drive_data_auth.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'


class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False)
    password = db.Column(db.String(150), nullable=False)


class DriveSession(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    start_time = db.Column(db.DateTime, default=datetime.utcnow)
    end_time = db.Column(db.DateTime)
    sudden_accels = db.Column(db.Integer, default=0)
    sudden_brakes = db.Column(db.Integer, default=0)
    sharp_turns = db.Column(db.Integer, default=0)
    stability = db.Column(db.Float, default=0.0)
    speed_violations = db.Column(db.Integer, default=0)
    distance = db.Column(db.Float, default=0.0)
    gps_logs = db.relationship('GPSLog', backref='session', lazy=True)


class GPSLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer, db.ForeignKey('drive_session.id'), nullable=False)
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    event = db.Column(db.String(50), default='normal')
    g_y = db.Column(db.Float, default=0.0)


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        if User.query.filter_by(username=username).first():
            flash('ユーザー名は既に使われています')
            return redirect(url_for('register'))
        user = User(username=username, password=password)
        db.session.add(user)
        db.session.commit()
        flash('登録成功。ログインしてください')
        return redirect(url_for('login'))
    return render_template('register.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        user = User.query.filter_by(username=username, password=password).first()
        if user:
            login_user(user)
            return redirect(url_for('index'))
        flash('ログインに失敗しました')
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
    session = DriveSession(user_id=current_user.id)
    db.session.add(session)
    db.session.commit()
    return jsonify({'session_id': session.id})


@app.route('/end', methods=['POST'])
@login_required
def end():
    data = request.get_json()
    print("受け取ったデータ:", data)

    session_id = data.get('session_id')
    if not session_id:
        print("セッションIDがありません")
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400

    session = DriveSession.query.get(session_id)
    if not session:
        print(f"セッションが見つかりません: {session_id}")
        return jsonify({'status': 'error', 'message': 'Session not found'}), 404

    if session.user_id != current_user.id:
        print("ユーザー不一致")
        return jsonify({'status': 'error', 'message': 'Permission denied'}), 403

    # すでに終了しているセッションは無視
    if session.end_time:
        print("すでに終了済みのセッション")
        return jsonify({'status': 'ok', 'message': 'Already ended'})

    # セッションのデータを更新
    try:
        session.end_time = datetime.utcnow()
        session.distance = float(data.get('distance', 0.0))
        session.sudden_accels = int(data.get('sudden_accels', 0))
        session.sudden_brakes = int(data.get('sudden_brakes', 0))
        session.sharp_turns = int(data.get('sharp_turns', 0))
        session.stability = float(data.get('stability', 0.0))
        session.speed_violations = int(data.get('speed_violations', 0))

        db.session.commit()
        print("セッションを正常に終了しました")
        return jsonify({'status': 'ok'})
    except Exception as e:
        print("DB更新エラー:", e)
        return jsonify({'status': 'error', 'message': str(e)}), 500




@app.route('/log_gps', methods=['POST'])
@login_required
def log_gps():
    data = request.get_json()
    session_id = data['session_id']
    lat = data['latitude']
    lng = data['longitude']
    g_y = data.get('g_y', 0.0)  # 追加
    session = DriveSession.query.get(session_id)
    if session and session.user_id == current_user.id:
        log = GPSLog(session_id=session_id, latitude=lat, longitude=lng, g_y=g_y)
        db.session.add(log)
        db.session.commit()
    return jsonify({'status': 'ok'})

def get_gps_logs_for_session(session_id):
    logs = GPSLog.query.filter_by(session_id=session_id).order_by(GPSLog.timestamp.asc()).all()
    result = []
    for log in logs:
        # timestampはUTC datetimeなので、JavaScriptで扱いやすいミリ秒に変換
        timestamp_ms = int(log.timestamp.timestamp() * 1000)
        result.append({
            "timestamp": timestamp_ms,
            "g_y": log.g_y
        })
    return result


@app.route('/sessions')
@login_required
def sessions():
    sessions = DriveSession.query.filter_by(user_id=current_user.id).order_by(DriveSession.start_time.desc()).all()
    return render_template('sessions.html', sessions=sessions)

# G加速度グラフページ
@app.route('/session_gforce')
def session_gforce():
    session_id = request.args.get('session_id')
    if not session_id:
        return "Session ID が指定されていません", 400
    
    # DBから該当セッションのGPSログを取得。gps_logsは
    # 例：[{"timestamp": 123456789, "g_y": 0.1}, ...]
    gps_logs = get_gps_logs_for_session(session_id)

    # 取得したgps_logsをテンプレートへ渡す
    return render_template('session_gforce.html', session_id=session_id, gps_logs=gps_logs)


@app.route('/delete_session/<int:sid>', methods=['POST'])
@login_required
def delete_session(sid):
    session = DriveSession.query.get(sid)
    if session and session.user_id == current_user.id:
        GPSLog.query.filter_by(session_id=sid).delete()
        db.session.delete(session)
        db.session.commit()
        flash('セッションを削除しました')
    else:
        flash('削除権限がありません')
    return redirect(url_for('sessions'))


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(host='0.0.0.0', port=5000, debug=True)
