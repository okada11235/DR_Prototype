# transcribe.py
from flask import Blueprint, request, jsonify
from firebase_admin import firestore, initialize_app, storage
import tempfile, os, traceback
from datetime import timedelta
from dotenv import load_dotenv

# OpenAI SDKはオプションとして読み込み
try:
    import openai
except Exception:
    openai = None

transcribe_bp = Blueprint('transcribe', __name__)

# --- 初期化 ---
load_dotenv()
# OPENAI_API_KEY は以下のどちらかを想定
# 1) そのままキー文字列
# 2) キーが書かれたファイルパス
raw_key = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_ENABLED = False
if openai is not None and raw_key:
    if os.path.exists(raw_key):
        try:
            with open(raw_key, "r", encoding="utf-8") as f:
                openai.api_key = f.read().strip()
                OPENAI_ENABLED = bool(openai.api_key)
        except Exception:
            OPENAI_ENABLED = False
    else:
        # 直接キー指定
        try:
            openai.api_key = raw_key
            OPENAI_ENABLED = True
        except Exception:
            OPENAI_ENABLED = False
else:
    OPENAI_ENABLED = False

try:
    initialize_app()
except ValueError:
    pass  # すでに初期化済み

def _looks_like_valid_audio(path: str) -> bool:
    """最低限のコンテナヘッダ確認。自己完結していない断片を早期スキップする。"""
    try:
        with open(path, 'rb') as f:
            head = f.read(64)
        if len(head) < 16:
            return False
        # OGG: 'OggS'
        if head.startswith(b'OggS'):
            return True
        # WEBM/MKV(EBML): 0x1A 0x45 0xDF 0xA3
        if head.startswith(b"\x1a\x45\xdf\xa3"):
            return True
        # WAV: 'RIFF' .... 'WAVE'
        if head.startswith(b'RIFF') and b'WAVE' in head[8:16]:
            return True
        # MP3: 'ID3' または フレームシンク 0xFFEx/0xFFFx
        if head.startswith(b'ID3'):
            return True
        if head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
            return True
        # MP4/M4A: 'ftyp' が先頭近くに現れることが多い
        if b'ftyp' in head[:16]:
            return True
        return False
    except Exception:
        return False


@transcribe_bp.route("/transcribe", methods=["POST"])
def transcribe_audio():
    try:
        if not OPENAI_ENABLED or openai is None:
            return jsonify({
                "status": "error",
                "message": "transcription service disabled (OPENAI_API_KEY missing or openai not installed)"
            }), 503
        # 🔹 音声ファイルとセッションIDの取得
        file = request.files.get("audio")
        session_id = request.form.get("session_id", "unknown_session")
        storage_path = request.form.get("storage_path")  # JS側で送るようにする（オプション）

        if not file:
            return jsonify({"status": "error", "message": "No audio file provided"}), 400

        # 🔹 一時ファイルとして保存（アップロード拡張子/Content-Typeに合わせる）
        orig_name = (file.filename or '').strip()
        orig_ct   = (getattr(file, 'content_type', '') or '').lower()
        base, ext = os.path.splitext(orig_name)
        ext = (ext or '').lower()
        # 拡張子の推定
        if ext not in {'.webm', '.ogg', '.m4a', '.mp3', '.wav', '.mp4'}:
            ct_map = {
                'audio/webm': '.webm',
                'audio/ogg': '.ogg',
                'audio/mp4': '.m4a',
                'audio/m4a': '.m4a',
                'audio/aac': '.m4a',
                'audio/mpeg': '.mp3',
                'audio/wav': '.wav',
                'video/mp4': '.mp4',
            }
            ext = ct_map.get(orig_ct, '.webm')
        print(f"=== /transcribe upload === name={orig_name} ct={orig_ct} -> ext={ext}")
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext or '.webm') as tmp:
            file.save(tmp.name)
            tmp_path = tmp.name

        # 🔹 ヘッダ確認（自己完結していない断片はスキップ扱いで200返却）
        if not _looks_like_valid_audio(tmp_path):
            try: os.unlink(tmp_path)
            except Exception: pass
            return jsonify({"status": "skip", "message": "invalid or incomplete chunk"}), 200

        # 🔹 Whisperで文字起こし
        with open(tmp_path, "rb") as audio_file:
            # Whisper API（v1）互換
            result = openai.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                response_format="text"
            )

        transcript_text = str(result).strip()
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
                "transcript": transcript_text,
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
                    "transcript": transcript_text,
                    "created_at": firestore.SERVER_TIMESTAMP
                }, merge=True)
            else:
                # 最後の保険: 見つからなければ新規（URLなしのdocを作る）
                audio_col.add({
                    "transcript": transcript_text,
                    "created_at": firestore.SERVER_TIMESTAMP
                })

        try: os.unlink(tmp_path)
        except Exception: pass
        return jsonify({"status": "ok", "transcript": transcript_text})

    except Exception as e:
        # OpenAIのInvalid file formatはskip扱いに変換して 200 を返す
        if 'Invalid file format' in str(e):
            try: os.unlink(tmp_path)
            except Exception: pass
            return jsonify({"status": "skip", "message": "invalid file format from OpenAI"}), 200
        error_msg = traceback.format_exc()
        print("❌ Whisperエラー詳細:\n", error_msg)
        try: os.unlink(tmp_path)
        except Exception: pass
        return jsonify({"status": "error", "message": str(e)})
