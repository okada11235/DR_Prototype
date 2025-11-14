# views.py
from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import login_required, current_user
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from models import db
from datetime import datetime, timezone, timedelta


JST = timezone(timedelta(hours=9))


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
    
def get_avg_g_logs_for_session(session_id):
    """セッションの平均Gログ(avg_g_logs)を取得"""
    try:
        logs_ref = db.collection('sessions').document(session_id).collection('avg_g_logs')
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
                "g_z": log_data.get('g_z', 0.0),
                "speed": log_data.get('speed', 0.0),
                "event": log_data.get('event', 'normal')
            })

        print(f"avg_g_logs for session {session_id}: {len(result)} records")
        if len(result) > 0:
            print(f"First avg_g_log: {result[0]}")

        return result
    except Exception as e:
        print(f"Error getting avg_g_logs for session {session_id}: {e}")
        return []


# メインページ（ホーム画面にリダイレクト）
@views_bp.route('/')
@login_required
def index():
    return redirect(url_for('views.home'))

# ホーム画面
@views_bp.route('/home')
@login_required
def home():
    return render_template('home.html')

# 説明ページ
@views_bp.route('/explain')
@login_required
def explain():
    return render_template('explain.html')

# 記録開始画面
@views_bp.route('/recording/start')
@login_required
def recording_start():
    return render_template('recording_start.html', user_id=current_user.id)

# 記録中画面
@views_bp.route('/recording/active')
@login_required
def recording_active():
    db_ref = firestore.client()

    # 最新セッションを取得
    session_ref = (
        db_ref.collection("sessions")
        .where("user_id", "==", current_user.id)
        .order_by("start_time", direction=firestore.Query.DESCENDING)
        .limit(1)
        .stream()
    )

    session_id = None
    for doc in session_ref:
        session_id = doc.id
        break

    # ⚠️ セッションが存在しない場合の安全対策
    if not session_id:
        print("⚠️ recording_active: セッションが見つかりません。recording_startから開始してください。")
        return render_template(
            "recording_active.html",
            session_id="",
            error_message="セッションが存在しません。運転を開始してから記録を行ってください。"
        )

    print(f"✅ recording_active session_id={session_id}")
    return render_template("recording_active.html", session_id=session_id)

# 記録完了画面（直前のセッション情報付き）
@views_bp.route('/recording/completed')
@login_required
def recording_completed():
    db_ref = firestore.client()
    # 直近のセッション（最新の start_time を持つ completed 状態）
    latest_session = (
        db_ref.collection('sessions')
        .where('user_id', '==', current_user.id)
        .where('status', '==', 'completed')
        .order_by('end_time', direction=firestore.Query.DESCENDING)
        .limit(1)
        .stream()
    )

    session_obj = None
    for doc in latest_session:
        data = doc.to_dict()
        data['id'] = doc.id
        session_obj = data
        break

    if not session_obj:
        # セッションが見つからない場合のフォールバック
        return render_template('recording_completed.html', session=None)

    return render_template('recording_completed.html', session=session_obj)


# セッション一覧
@views_bp.route('/sessions')
@login_required
def sessions():
    from datetime import timezone, timedelta
    JST = timezone(timedelta(hours=9))
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

        # 🔹 基本データ
        data['distance'] = data.get('distance', None)
        data['sudden_accels'] = data.get('sudden_accels', 0)
        data['sudden_brakes'] = data.get('sudden_brakes', 0)
        data['sharp_turns'] = data.get('sharp_turns', 0)
        data['speed_violations'] = data.get('speed_violations', 0)
        data['status'] = data.get('status', 'unknown')

        # 🔹 GPSログとGログの取得
        data['gps_logs'] = get_gps_logs_for_session(session_doc.id)
        data['g_logs'] = get_g_logs_for_session(session_doc.id)
        data['avg_g_logs'] = get_avg_g_logs_for_session(session_doc.id)

        # 🔹 audio_records（音声記録）を取得
        audio_records_ref = (
            db.collection('sessions')
            .document(session_doc.id)
            .collection('audio_records')
        )

        audio_records = []
        for audio_doc in audio_records_ref.stream():
            audio_data = audio_doc.to_dict()

            # JST変換
            from datetime import datetime, timezone, timedelta
            JST = timezone(timedelta(hours=9))
            if 'created_at' in audio_data and audio_data['created_at']:
                ts = audio_data['created_at']
                try:
                    audio_data['created_at'] = ts.astimezone(JST)
                except Exception:
                    audio_data['created_at'] = datetime.fromtimestamp(ts / 1000, JST)

            # 🔹 transcriptをクライアントに送らない（Firestoreには残す）
            if 'transcript' in audio_data:
                del audio_data['transcript']
            
            # 🔹 URLが存在するデータのみ追加
            if 'url' in audio_data and audio_data['url']:
                audio_records.append(audio_data)

        # 🔹 時間降順でソート
        data['audio_records'] = sorted(
            audio_records,
            key=lambda a: a.get('created_at', None) or 0,
            reverse=True
        )

        # 🔹 時刻をUTCから日本時間（JST）に補正
        if 'start_time' in data and data['start_time']:
            data['start_time'] = data['start_time'].astimezone(JST)
        if 'end_time' in data and data['end_time']:
            data['end_time'] = data['end_time'].astimezone(JST)


        print(f"Session {session_doc.id}: distance={data.get('distance')}, status={data.get('status')}")
        print(f"GPS logs: {len(data['gps_logs'])}, G logs: {len(data['g_logs'])}, avg_G logs: {len(data['avg_g_logs'])}, Audio: {len(audio_records)}")

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
        return redirect(url_for('sessions.results_page'))

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
    return redirect(url_for('sessions.results_page'))

# === 追記: 再生ページ ===
@views_bp.route('/result/<session_id>/replay')
@login_required
def detail_result_play(session_id):
    return render_template('detail_result_play.html', session_id=session_id)

# === 追記: 範囲データAPI（eventつきavg_g_logsを返す） ===
from flask import jsonify

@views_bp.route('/api/replay_data/<session_id>')
@login_required
def api_replay_data(session_id):
    start = request.args.get("start", type=int)
    end   = request.args.get("end", type=int)

    # avg_g_logs を取得
    logs = get_avg_g_logs_for_session(session_id)
    if start and end:
        logs = [l for l in logs if (l.get("timestamp_ms") or 0) >= start and (l.get("timestamp_ms") or 0) <= end]

    # gps_logs も取得
    gps = get_gps_logs_for_session(session_id)
    if start and end:
        gps = [g for g in gps if (g.get("timestamp") or 0) >= start and (g.get("timestamp") or 0) <= end]

    # timestamp を揃える
    gps_sorted = sorted(gps, key=lambda g: g.get("timestamp", 0))
    avg_sorted = sorted(logs, key=lambda l: l.get("timestamp_ms", 0))

    return jsonify({
        "avg_g_logs": avg_sorted,
        "gps_logs": gps_sorted
    })

@views_bp.route('/replay_active/<session_id>')
@login_required
def replay_active(session_id):
    start = request.args.get('start', type=int)
    end = request.args.get('end', type=int)

    # === Firestoreからセッション全体の最初のtimestamp_msを取得 ===
    from google.cloud import firestore
    db = firestore.Client()

    logs_ref = db.collection(f"sessions/{session_id}/avg_g_logs") \
                 .order_by("timestamp_ms") \
                 .limit(1)
    docs = list(logs_ref.stream())
    if docs:
        session_start = docs[0].to_dict().get("timestamp_ms", 0)
    else:
        session_start = 0

    # === テンプレートに渡す ===
    return render_template(
        'recording_active_re.html',
        session_id=session_id,
        start=start,
        end=end,
        session_start=session_start
    )

# === ピン管理ページ ===
@views_bp.route('/map_editor')
@login_required
def map_editor():
    return render_template('map_editor.html')

# === 🗣 ユーザー別読み上げレベル設定 取得API ===
@views_bp.route('/api/user_speak_settings')
@login_required
def get_user_speak_settings():
    try:
        doc_ref = db.collection('user_settings').document(str(current_user.id))
        snap = doc_ref.get()
        if not snap.exists:
            # デフォルト作成
            default_settings = {
                'speak_levels': {
                    '1': True,
                    '2': True,
                    '3': True
                },
                'updated_at': datetime.now(JST)
            }
            doc_ref.set(default_settings)
            return jsonify({'status': 'success', 'settings': default_settings})
        data = snap.to_dict()
        # フィールド欠損時補完
        if 'speak_levels' not in data or not isinstance(data['speak_levels'], dict):
            data['speak_levels'] = {'1': True, '2': True, '3': True}
        for lvl in ['1','2','3']:
            if lvl not in data['speak_levels']:
                data['speak_levels'][lvl] = True
        return jsonify({'status': 'success', 'settings': data})
    except Exception as e:
        return jsonify({'status': 'error', 'error': str(e)}), 500

# === 🗣 ユーザー別読み上げレベル設定 更新API ===
@views_bp.route('/api/user_speak_settings/update', methods=['POST'])
@login_required
def update_user_speak_settings():
    try:
        payload = request.get_json(force=True) or {}
        speak_levels = payload.get('speak_levels')
        if not isinstance(speak_levels, dict):
            return jsonify({'status':'error','error':'speak_levels must be object'}), 400
        cleaned = {}
        for lvl in ['1','2','3']:
            val = speak_levels.get(lvl)
            if isinstance(val, bool):
                cleaned[lvl] = val
            else:
                return jsonify({'status':'error','error':f'invalid value for level {lvl}'}), 400
        doc_ref = db.collection('user_settings').document(str(current_user.id))
        doc_ref.set({
            'speak_levels': cleaned,
            'updated_at': datetime.now(JST)
        }, merge=True)
        return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({'status': 'error', 'error': str(e)}), 500


# === Firestore API: ピン保存 ===
@views_bp.route('/api/save_pin', methods=['POST'])
@login_required
def save_pin():
    data = request.json
    if not data:
        return jsonify({"error": "Invalid data"}), 400

    try:
        new_pin = {
            "user_id": current_user.id,
            "lat": data.get("lat"),
            "lng": data.get("lng"),
            "label": data.get("label", ""),
            "speak_enabled": True,   # 🔊 デフォルトON
            "created_at": datetime.now(JST)
        }
        db.collection("pins").add(new_pin)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# === Firestore API: ピン一覧取得 ===
@views_bp.route('/api/get_pins')
@login_required
def get_pins():
    try:
        pins = []
        docs = db.collection("pins").where("user_id", "==", current_user.id).stream()
        for doc in docs:
            d = doc.to_dict()
            d["id"] = doc.id
            pins.append(d)
        return jsonify({"status": "success", "pins": pins})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500
    
@views_bp.route('/api/get_pins_all')
@login_required
def get_pins_all():
    try:
        pins = []
        user_cache = {}

        # 🔹 pins を全件取得
        docs = db.collection("pins").stream()

        for doc in docs:
            d = doc.to_dict()
            d["id"] = doc.id
            uid = d.get("user_id", None)
            # 既定値補完（後方互換）
            if "priority_level" not in d:
                d["priority_level"] = 1
            if "speak_time_windows" not in d:
                d["speak_time_windows"] = []

            # 🔹 user_id → user_name をキャッシュ経由で取得
            if uid:
                if uid not in user_cache:
                    user_doc = db.collection("users").document(uid).get()
                    user_cache[uid] = user_doc.to_dict().get("username") if user_doc.exists else "不明なユーザー"
                d["user_name"] = user_cache[uid]
            else:
                d["user_name"] = "匿名ユーザー"

            pins.append(d)

        return jsonify({"status": "success", "pins": pins})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500
    
# === Firestore API: ピン削除 ===
@views_bp.route('/api/delete_pin', methods=['POST'])
@login_required
def delete_pin():
    data = request.json
    pin_id = data.get("id")
    if not pin_id:
        return jsonify({"error": "Missing pin ID"}), 400

    try:
        db.collection("pins").document(pin_id).delete()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# === Firestore API: ピン編集 ===
@views_bp.route('/api/update_pin', methods=['POST'])
@login_required
def update_pin():
    data = request.json
    pin_id = data.get("id")
    if not pin_id:
        return jsonify({"error": "Missing pin ID"}), 400

    try:
        update_data = {}
        if "label" in data:
            update_data["label"] = data["label"]
        if "speak_enabled" in data:
            update_data["speak_enabled"] = bool(data["speak_enabled"])
        # --- priority_level (1..3) ---
        if "priority_level" in data:
            try:
                lvl = int(data.get("priority_level"))
                if lvl not in (1,2,3):
                    return jsonify({"error": "priority_level must be 1,2,3"}), 400
                update_data["priority_level"] = lvl
            except (TypeError, ValueError):
                return jsonify({"error": "priority_level invalid"}), 400
        # --- speak_time_windows: list[{start:"HH:mm", end:"HH:mm", days?:[0-6]}] ---
        if "speak_time_windows" in data:
            stw = data.get("speak_time_windows") or []
            if not isinstance(stw, list):
                return jsonify({"error": "speak_time_windows must be list"}), 400
            validated = []
            for w in stw:
                if not isinstance(w, dict):
                    return jsonify({"error": "Each time window must be object"}), 400
                start = w.get("start"); end = w.get("end")
                if not (isinstance(start, str) and isinstance(end, str) and len(start)==5 and len(end)==5):
                    return jsonify({"error": "time window start/end must be HH:mm"}), 400
                # basic HH:mm format check
                try:
                    sh, sm = map(int, start.split(":")); eh, em = map(int, end.split(":"))
                    if not (0<=sh<24 and 0<=sm<60 and 0<=eh<24 and 0<=em<60):
                        raise ValueError
                except Exception:
                    return jsonify({"error": "Invalid HH:mm in time window"}), 400
                days = w.get("days")
                if days is not None:
                    if not (isinstance(days, list) and all(isinstance(d, int) and 0<=d<=6 for d in days)):
                        return jsonify({"error": "days must be [0-6]"}), 400
                validated.append({k:v for k,v in (("start",start),("end",end),("days",days)) if v is not None})
            update_data["speak_time_windows"] = validated
        # (optional) speak_radius_m
        if "speak_radius_m" in data:
            try:
                radius = int(data.get("speak_radius_m"))
                if not (10 <= radius <= 300):
                    return jsonify({"error": "speak_radius_m must be 10-300"}), 400
                update_data["speak_radius_m"] = radius
            except (TypeError, ValueError):
                return jsonify({"error": "speak_radius_m invalid"}), 400
        # ピンが編集されたことを記録
        update_data["edited"] = True
        db.collection("pins").document(pin_id).update(update_data)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# === 🚗 走行中のピン設置API（pins直下に保存） ===
@views_bp.route('/api/add_drive_pin', methods=['POST'])
@login_required
def add_voice_pin():
    """
    走行中の画面でピンを設置したときに呼ばれるAPI。
    Firestoreの pins コレクション直下に保存。
    """
    data = request.json
    try:
        lat = data.get("lat")
        lng = data.get("lng")
        label = data.get("label", "")

        pin_data = {
            "user_id": current_user.id,
            "lat": lat,
            "lng": lng,
            "label": label,
            "speak_enabled": True,
            "created_at": datetime.now(JST),
            "source": "driving",  # ← 区別したいなら追加（任意）
        }

        # ✅ pinsコレクション直下に保存
        doc_ref, _ = db.collection("pins").add(pin_data)
        pin_id = doc_ref.id

        return jsonify({"status": "success", "pin_id": pin_id})
    except Exception as e:
        print("Error in add_voice_pin:", e)
        return jsonify({"status": "error", "error": str(e)}), 500

# === 🎙 音声録音時のピン設置API ===
@views_bp.route('/api/add_voice_pin', methods=['POST'])
@login_required
def add_voice_recording_pin():
    """
    音声録音時にピンを設置するAPI。
    speak_enabledパラメータに対応。
    """
    data = request.json
    try:
        lat = data.get("lat")
        lng = data.get("lng")
        label = data.get("label", "")
        speak_enabled = data.get("speak_enabled", True)  # デフォルトはTrue
        source = data.get("source", "voice")  # デフォルトは"voice"

        pin_data = {
            "user_id": current_user.id,
            "lat": lat,
            "lng": lng,
            "label": label,
            "speak_enabled": speak_enabled,
            "created_at": datetime.now(JST),
            "source": source,
            "edited": False,  # 初期状態は未編集
            "priority_level": int(data.get("priority_level", 1)),
            "speak_time_windows": data.get("speak_time_windows", []),
        }

        # ✅ pinsコレクション直下に保存
        doc_ref, _ = db.collection("pins").add(pin_data)
        pin_id = doc_ref.id

        return jsonify({"status": "success", "pin_id": pin_id})
    except Exception as e:
        print("Error in add_voice_recording_pin:", e)
        return jsonify({"status": "error", "error": str(e)}), 500

# === 🗺️ マップ画面ピン追加API ===
@views_bp.route('/api/add_manual_pin', methods=['POST'])
@login_required
def add_manual_pin():
    """
    マップ画面で直接ピンを追加したときに呼ばれるAPI。
    Firestoreの pins コレクション直下に保存。
    """
    try:
        data = request.get_json(force=True)
        lat = float(data.get("lat"))
        lng = float(data.get("lng"))
        label = data.get("label", "")

        pin_data = {
            "user_id": current_user.id,
            "lat": lat,
            "lng": lng,
            "label": label,
            "speak_enabled": True,
            "created_at": datetime.now(JST),
            "source": "manual",
            "priority_level": int(data.get("priority_level", 1)),
            "speak_time_windows": data.get("speak_time_windows", []),
        }

        doc_ref = db.collection("pins").add(pin_data)[1]
        pin_id = doc_ref.id

        # ✅ username を users コレクションから取得
        user_doc = db.collection("users").document(current_user.id).get()
        user_name = "不明なユーザー"
        if user_doc.exists:
            user_data = user_doc.to_dict()
            user_name = user_data.get("username", "不明なユーザー")

        print(f"✅ add_manual_pin: 新しいピンを追加 ID={pin_id} by {user_name}")

        # 👇 user_id と user_name も返す
        return jsonify({
            "status": "success",
            "pin_id": pin_id,
            "user_id": current_user.id,
            "user_name": user_name
        }), 200

    except Exception as e:
        print("❌ Error in add_manual_pin:", e)
        import traceback
        traceback.print_exc()
        return jsonify({"status": "error", "error": str(e)}), 500

# === Firestore API: セッション内の音声ピン一覧取得 ===
@views_bp.route('/api/get_voice_pins')
@login_required
def get_voice_pins():
    try:
        session_id = request.args.get("session_id", "unknown_session")
        pins_ref = db.collection("sessions").document(session_id).collection("voice_pins")
        docs = pins_ref.stream()

        pins = []
        for doc in docs:
            pin_data = doc.to_dict()
            pin_data["id"] = doc.id
            pins.append(pin_data)

        return jsonify({"status": "success", "pins": pins}), 200
    except Exception as e:
        print("Error in /api/get_voice_pins:", e)
        return jsonify({"status": "error", "error": str(e)}), 500

# === Firestore API: ピン確定・メモ更新 ===
@views_bp.route('/api/confirm_voice_pin', methods=['POST'])
@login_required
def confirm_voice_pin():
    try:
        data = request.get_json()
        session_id = data.get("session_id", "unknown_session")
        pin_id = data.get("id")
        label = data.get("label", "")
        confirmed = data.get("confirmed", True)

        if not pin_id:
            return jsonify({"status": "error", "error": "Missing pin ID"}), 400

        pin_ref = (
            db.collection("sessions")
            .document(session_id)
            .collection("voice_pins")
            .document(pin_id)
        )

        pin_ref.update({
            "label": label,
            "confirmed": confirmed,
            "updated_at": datetime.now(JST)
        })

        return jsonify({"status": "success"}), 200
    except Exception as e:
        print("Error in /api/confirm_voice_pin:", e)
        return jsonify({"status": "error", "error": str(e)}), 500

@views_bp.route('/api/get_all_pins', methods=['GET'])
@login_required
def get_all_pins():
    try:
        pins_ref = db.collection("pins").where("user_id", "==", current_user.id).stream()
        pins = []
        for p in pins_ref:
            d = p.to_dict()
            pins.append({
                "id": p.id,
                "lat": d.get("lat"),
                "lng": d.get("lng"),
                "label": d.get("label", ""),
                "speak_enabled": d.get("speak_enabled", True),
                "priority_level": d.get("priority_level", 1),
                "speak_time_windows": d.get("speak_time_windows", []),
            })
        return jsonify({"status": "success", "pins": pins})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500
    
from flask import render_template, request
#from ai_evaluation import generate_feedback  # あなたのAI評価関数を使用

@views_bp.route('/recording/completed_re/<session_id>')
@login_required
def recording_completed_re(session_id):
    start = request.args.get('start')
    end = request.args.get('end')

    # 🔹 Firestoreなどから再生範囲のavg_g_logsを取得
    from sessions import get_avg_g_logs_for_session
    logs = get_avg_g_logs_for_session(session_id)
    logs = [l for l in logs if (l.get("timestamp_ms") or 0) >= int(start) and (l.get("timestamp_ms") or 0) <= int(end)]

    return render_template(
        'recording_completed_re.html',
        session_id=session_id,
        start=start,
        end=end,
    )

# === フィードバック生成API ===
@views_bp.route('/api/focus_feedback/<session_id>', methods=['POST'])
@login_required
def api_focus_feedback(session_id):
    from ai_evaluation import analyze_focus_points_for_session # analyze_focus_points_for_sessionをインポート
    db = firestore.client()

    try:
        # セッション取得
        session_ref = db.collection("sessions").document(session_id)
        session_doc = session_ref.get()
        if not session_doc.exists:
            return jsonify({"error": "Session not found"}), 404

        user_id = session_doc.to_dict().get("user_id")

        # 🚀 ai_evaluation.py の新しい関数を呼び出し、解析と保存を一括実行
        results = analyze_focus_points_for_session(session_id, user_id)

        # 成功したピンの数をカウントして返す
        return jsonify({"status": "success", "count": len(results)})
    except Exception as e:
        print(f"❌ focus_feedback生成中エラー: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# === リザルト→詳細フィードバック表示ページ ===
@views_bp.route('/feedback_detail_result/<session_id>/<pin_id>')
@login_required
def feedback_detail_result(session_id, pin_id):
    db = firestore.client()
    feedback = None

    try:
        # ✅ focus_feedbacks から該当フィードバックを取得
        ref = (
            db.collection("sessions")
            .document(session_id)
            .collection("focus_feedbacks")
            .document(pin_id)
        )
        doc = ref.get()

        if doc.exists:
            feedback = doc.to_dict()
            print(f"✅ フィードバック取得成功: session={session_id}, pin={pin_id}")
        else:
            print(f"⚠️ feedback_detail_result: 該当する feedback が見つかりません: {session_id}/{pin_id}")
    except Exception as e:
        print(f"❌ Firestoreクエリ中にエラー発生: {e}")
        import traceback
        traceback.print_exc()

    if not feedback:
        return render_template(
            "feedback_detail_result.html",
            feedback=None,
            session_id=session_id,
            error_message="該当するフィードバックが見つかりませんでした。"
        )

    return render_template(
        "feedback_detail_result.html",
        feedback=feedback,
        session_id=session_id
    )

# === 記録終了→詳細フィードバック表示ページ ===
@views_bp.route('/feedback_detail_completed/<session_id>/<pin_id>')
@login_required
def feedback_detail_completed(session_id, pin_id):
    db = firestore.client()
    feedback = None

    try:
        # ✅ focus_feedbacks からピンポイントで取得
        doc_ref = (
            db.collection("sessions")
            .document(session_id)
            .collection("focus_feedbacks")
            .document(pin_id)
        )
        doc = doc_ref.get()

        if doc.exists:
            feedback = doc.to_dict()
            print(f"✅ 取得成功: session={session_id}, pin={pin_id}")
        else:
            print(f"⚠️ 該当フィードバックが存在しません: {session_id}/{pin_id}")
    except Exception as e:
        print(f"❌ Firestoreアクセス中にエラー発生: {e}")
        import traceback; traceback.print_exc()

    if not feedback:
        return render_template(
            "feedback_detail_completed.html",
            feedback=None,
            session_id=session_id,
            error_message="該当するフィードバックが見つかりませんでした。"
        )

    return render_template(
        "feedback_detail_completed.html",
        feedback=feedback,
        session_id=session_id
    )

# === フィードバックページ（ユーザー入力フォーム） ===
@views_bp.route("/feedback", methods=["GET", "POST"], endpoint="feedback")
@login_required
def feedback_page():
    from datetime import datetime
    import base64
    if request.method == "POST":
        real_name = request.form.get("real_name", "").strip()
        device_type = request.form.get("device_type", "")  # iPhone / Android
        browser = request.form.get("browser", "")
        browser_other = request.form.get("browser_other", "").strip() if browser == "その他" else ""
        
        # 運転時間の複数取得（配列形式）
        drive_start_dates = request.form.getlist("drive_start_date[]")
        drive_start_times = request.form.getlist("drive_start_time[]")
        drive_end_times = request.form.getlist("drive_end_time[]")
        
        # 運転時間リストを作成
        drive_times = []
        for i in range(len(drive_start_dates)):
            if drive_start_dates[i] and drive_start_times[i] and drive_end_times[i]:
                drive_times.append({
                    'start_datetime': f"{drive_start_dates[i]} {drive_start_times[i]}",
                    'end_datetime': f"{drive_start_dates[i]} {drive_end_times[i]}"
                })
        
        satisfaction = request.form.get("satisfaction", "")  # 数値 or テキスト

        # 評価カテゴリ（キーは英語化）
        eval_map = {
            'hard_brake': request.form.get('eval_hard_brake', ''),
            'hard_curve': request.form.get('eval_hard_curve', ''),
            'hard_accel': request.form.get('eval_hard_accel', ''),
            'good_decel': request.form.get('eval_good_decel', ''),
            'good_curve': request.form.get('eval_good_curve', ''),
            'good_accel': request.form.get('eval_good_accel', ''),
        }

        # 運転後フィードバック評価
        post_fb_map = {
            'overall': request.form.get('post_fb_overall', ''),
            'clarity': request.form.get('post_fb_clarity', ''),
            'accuracy': request.form.get('post_fb_accuracy', ''),
            'helpfulness': request.form.get('post_fb_helpfulness', ''),
        }

        # 重点ポイント設置評価
        focus_point_map = {
            'ease_view': request.form.get('focus_ease_view', ''),
            'ease_edit': request.form.get('focus_ease_edit', ''),
            'ease_check': request.form.get('focus_ease_check', ''),
        }

        # マップピン評価
        map_pin_map = {
            'ease_add': request.form.get('pin_ease_add', ''),
            'ease_edit': request.form.get('pin_ease_edit', ''),
            'speak_useful': request.form.get('pin_speak_useful', ''),
            'advanced_settings': request.form.get('pin_advanced_settings', ''),
        }

        # 課題解決評価
        solution_map = {
            'focus_awareness': request.form.get('solution_focus_awareness', ''),
            'realtime_improvement': request.form.get('solution_realtime_improvement', ''),
            'pin_reference': request.form.get('solution_pin_reference', ''),
        }

        good_points = request.form.get("good_points", "").strip()
        improvement = request.form.get("improvement", "").strip()
        desired_features = request.form.get("desired_features", "").strip()
        other_comments = request.form.get("other_comments", "").strip()

        image_file = request.files.get("feedback_image")
        image_base64 = ""
        if image_file and image_file.filename:
            try:
                image_bytes = image_file.read()
                image_base64 = base64.b64encode(image_bytes).decode('utf-8')
            except Exception:
                image_base64 = ""

        # Firestoreへ保存
        try:
            feedback_doc = {
                'user_id': current_user.id,
                'real_name': real_name,
                'device_type': device_type,
                'browser': browser,
                'browser_other': browser_other,
                'drive_times': drive_times,  # 複数の運転時間を配列で保存
                'evaluations': eval_map,
                'post_drive_feedback': post_fb_map,
                'focus_point_evaluation': focus_point_map,
                'map_pin_evaluation': map_pin_map,
                'solution_evaluation': solution_map,
                'good_points': good_points,
                'improvement_points': improvement,
                'desired_features': desired_features,
                'other_comments': other_comments,
                'satisfaction': satisfaction,
                'image_base64': image_base64,
                'created_at': datetime.now(JST)
            }
            db.collection('user_feedback').add(feedback_doc)
            flash('フィードバックを送信しました。ありがとうございます。', 'success')
            return redirect(url_for('views.feedback'))
        except Exception as e:
            flash(f'送信中にエラーが発生しました: {e}', 'danger')
            return redirect(url_for('views.feedback'))

    return render_template("user_feedback.html")

# === フィードバック集計ページ ===
@views_bp.route("/feedback_log", methods=["GET"])
@login_required
def feedback_log():
    from collections import Counter
    try:
        # Firestoreから全フィードバック取得
        feedbacks_ref = db.collection('user_feedback').order_by('created_at', direction=firestore.Query.DESCENDING).stream()
        feedbacks = []
        for doc in feedbacks_ref:
            data = doc.to_dict()
            data['id'] = doc.id
            # created_atをJSTに変換
            if 'created_at' in data and data['created_at']:
                data['created_at'] = data['created_at'].astimezone(JST)
            feedbacks.append(data)
        
        # 集計処理
        total_count = len(feedbacks)
        device_counts = Counter(fb.get('device_type','') for fb in feedbacks if fb.get('device_type'))
        browser_counts = Counter(fb.get('browser','') for fb in feedbacks if fb.get('browser'))
        # ブラウザ「その他」の詳細リスト
        browser_other_list = [fb.get('browser_other','') for fb in feedbacks if fb.get('browser') == 'その他' and fb.get('browser_other')]
        satisfaction_counts = Counter(fb.get('satisfaction','') for fb in feedbacks if fb.get('satisfaction'))
        
        # 評価項目集計（リアルタイムアドバイス）
        eval_summary = {}
        eval_keys = ['hard_brake','hard_curve','hard_accel','good_decel','good_curve','good_accel']
        for key in eval_keys:
            eval_summary[key] = Counter(fb.get('evaluations',{}).get(key,'') for fb in feedbacks if fb.get('evaluations',{}).get(key))
        
        # 運転後フィードバック集計
        post_fb_summary = {}
        post_keys = ['overall','clarity','accuracy','helpfulness']
        for key in post_keys:
            post_fb_summary[key] = Counter(fb.get('post_drive_feedback',{}).get(key,'') for fb in feedbacks if fb.get('post_drive_feedback',{}).get(key))
        
        # 重点ポイント集計
        focus_summary = {}
        focus_keys = ['ease_view','ease_edit','ease_check']
        for key in focus_keys:
            focus_summary[key] = Counter(fb.get('focus_point_evaluation',{}).get(key,'') for fb in feedbacks if fb.get('focus_point_evaluation',{}).get(key))
        
        # マップピン集計
        pin_summary = {}
        pin_keys = ['ease_add','ease_edit','speak_useful','advanced_settings']
        for key in pin_keys:
            pin_summary[key] = Counter(fb.get('map_pin_evaluation',{}).get(key,'') for fb in feedbacks if fb.get('map_pin_evaluation',{}).get(key))
        
        # 課題解決集計
        solution_summary = {}
        solution_keys = ['focus_awareness','realtime_improvement','pin_reference']
        for key in solution_keys:
            solution_summary[key] = Counter(fb.get('solution_evaluation',{}).get(key,'') for fb in feedbacks if fb.get('solution_evaluation',{}).get(key))
        
        return render_template(
            "feedback_log.html",
            feedbacks=feedbacks,
            total_count=total_count,
            device_counts=device_counts,
            browser_counts=browser_counts,
            browser_other_list=browser_other_list,
            satisfaction_counts=satisfaction_counts,
            eval_summary=eval_summary,
            post_fb_summary=post_fb_summary,
            focus_summary=focus_summary,
            pin_summary=pin_summary,
            solution_summary=solution_summary
        )
    except Exception as e:
        print(f"Error in feedback_log: {e}")
        import traceback
        traceback.print_exc()
        return render_template("feedback_log.html", feedbacks=[], total_count=0, error=str(e))

# === 個別フィードバック詳細ページ ===
@views_bp.route("/feedback_detail/<feedback_id>", methods=["GET"])
@login_required
def feedback_detail(feedback_id):
    try:
        doc_ref = db.collection('user_feedback').document(feedback_id)
        doc = doc_ref.get()
        if not doc.exists:
            flash('指定されたフィードバックが見つかりません。', 'warning')
            return redirect(url_for('views.feedback_log'))
        
        feedback = doc.to_dict()
        feedback['id'] = doc.id
        # created_atをJSTに変換
        if 'created_at' in feedback and feedback['created_at']:
            feedback['created_at'] = feedback['created_at'].astimezone(JST)
        
        return render_template("feedback_detail.html", feedback=feedback)
    except Exception as e:
        print(f"Error in feedback_detail: {e}")
        import traceback
        traceback.print_exc()
        flash(f'エラーが発生しました: {e}', 'danger')
        return redirect(url_for('views.feedback_log'))
