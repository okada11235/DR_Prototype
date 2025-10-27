# transcribe.py
from flask import Blueprint, request, jsonify
from firebase_admin import firestore, initialize_app, storage
import tempfile, openai, os, traceback
from datetime import timedelta
from dotenv import load_dotenv

transcribe_bp = Blueprint('transcribe', __name__)

# --- 初期化 ---
load_dotenv()
# .env に記載されたパスを取得
key_path = os.getenv("OPENAI_API_KEY")

# ファイルに書かれているキーを読み込む
if key_path and os.path.exists(key_path):
    with open(key_path, "r", encoding="utf-8") as f:
        openai.api_key = f.read().strip()
else:
    raise FileNotFoundError(f"OpenAI APIキーのファイルが見つかりません: {key_path}")

try:
    initialize_app()
except ValueError:
    pass  # すでに初期化済み

@transcribe_bp.route("/transcribe", methods=["POST"])
def transcribe_audio():
    try:
        # 🔹 音声ファイルとセッションIDの取得
        file = request.files.get("audio")
        session_id = request.form.get("session_id", "unknown_session")
        storage_path = request.form.get("storage_path")  # JS側で送るようにする（オプション）

        if not file:
            return jsonify({"status": "error", "message": "No audio file provided"}), 400

        # 🔹 一時ファイルとして保存
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
            file.save(tmp.name)
            tmp_path = tmp.name

        # 🔹 Whisperで文字起こし
        with open(tmp_path, "rb") as audio_file:
            result = openai.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                response_format="text"
            )

        transcript_text = result.strip()
        print(f"✅ Whisper成功: {transcript_text[:50]}...")

        # transcribe.py（/transcribe の中の保存部分を置き換え）

        db = firestore.client()
        session_id = request.form.get("session_id", "unknown_session")
        record_id  = request.form.get("record_id")          # ★ 受け取る
        storage_path = request.form.get("storage_path")

        # ... Whisper で result を得たあと ...

        audio_col = db.collection("sessions").document(session_id).collection("audio_records")

        if record_id:
            # ★ 直接そのドキュメントに追記
            audio_col.document(record_id).set({
                "transcript": result,
                "created_at": firestore.SERVER_TIMESTAMP
            }, merge=True)
        else:
            # 保険: storage_path が一致する doc を探して更新
            target_id = None
            if storage_path:
                qs = audio_col.where("storage_path", "==", storage_path).limit(1).stream()
                for d in qs:
                    target_id = d.id
                    break

            if target_id:
                audio_col.document(target_id).set({
                    "transcript": result,
                    "created_at": firestore.SERVER_TIMESTAMP
                }, merge=True)
            else:
                # 最後の保険: 見つからなければ新規（URLなしのdocを作る）
                audio_col.add({
                    "transcript": result,
                    "created_at": firestore.SERVER_TIMESTAMP
                })

        return jsonify({"status": "ok", "transcript": transcript_text})

    except Exception as e:
        error_msg = traceback.format_exc()
        print("❌ Whisperエラー詳細:\n", error_msg)
        return jsonify({"status": "error", "message": str(e)})
