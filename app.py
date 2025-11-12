# app.py
from config import create_app, init_firebase, init_login_manager, init_bcrypt
from models import User
from auth import auth_bp, init_auth
from sessions import sessions_bp
from views import views_bp
try:
    from transcribe import transcribe_bp  # 利用可能なら登録
except Exception as e:
    transcribe_bp = None
    print("[WARN] transcribe blueprint is not available:", e)

# Flaskアプリとサービスの初期化
app = create_app()
db = init_firebase()
login_manager = init_login_manager(app)
bcrypt = init_bcrypt(app)

# 認証モジュールの初期化（bcryptインスタンスを渡す）
init_auth(bcrypt)

# Blueprintの登録
app.register_blueprint(auth_bp)
app.register_blueprint(sessions_bp)
app.register_blueprint(views_bp)
if transcribe_bp is not None:
    app.register_blueprint(transcribe_bp)

# Flask-Loginのユーザーローダー
@login_manager.user_loader
def load_user(user_id):
    return User.get(user_id)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
